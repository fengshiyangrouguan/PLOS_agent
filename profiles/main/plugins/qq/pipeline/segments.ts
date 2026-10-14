/**
 * 原始 OneBot 消息段 → `ResolvedSegment[]`。
 *
 * 这是流水线的**异步那一半**：所有 I/O 都在这里，`render.ts` 那半是纯的。
 * 分工的理由见 `segment.ts` 的模块注释。
 *
 * ## 一条铁律：单段失败不丢整条消息
 *
 * 每个可能失败的段都自己吞掉异常并降级成一个**可读的占位**，绝不向上抛。
 * 一条消息里有一张图挂了、一个引用查不到，其余文本仍然要完整送到模型面前。
 * 这条规则来自实验期的降级表，逐条实现在下文各 `resolve*` 里。
 *
 * @module qq/segments
 */

import { parseJsonCard } from './card.ts'
import { faceToText } from './face.ts'
import { ForwardExpander, extractForwardXml } from './forward.ts'
import type { RawEvent, Segment } from '../protocol/index.ts'
import type {
  ResolveContext,
  ResolvedImage,
  ResolvedSegment,
} from './segment.ts'

/** 卡片完全解析不出来时的占位。 */
const CARD_FALLBACK = '暂时无法处理该类型的消息'

/** 解析一条消息的输入。 */
export interface ResolveRequest {
  /** 原始消息段。 */
  segments: readonly Segment[]
  /** 原始事件——转发的 XML 摘要兜底要从这里抠。 */
  raw: RawEvent
}

/** 安全地跑一段可能抛错的异步逻辑，失败返回 undefined。 */
async function attempt<T>(run: () => Promise<T>): Promise<T | undefined> {
  try {
    return await run()
  } catch {
    return undefined
  }
}

/**
 * 给一个 Promise 套超时。超时或抛错都返回 undefined。
 * @param promise - 待观察的 Promise。
 * @param ms - 超时毫秒数。
 * @returns 结果或 undefined。
 */
async function withTimeout<T>(promise: Promise<T | undefined>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms)
      }),
    ])
  } catch {
    return undefined
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * 解析顶层的一条图片段。
 *
 * 顶层图片**总是尝试下载**（不像转发内受 `imageMode` 约束），因为顶层图片通常就是消息主体。
 * @param data - `image` 段的 data。
 * @param ctx - 解析上下文。
 * @returns 已解析的图片段。
 */
async function resolveImage(data: Record<string, unknown>, ctx: ResolveContext): Promise<ResolvedImage> {
  // OneBot 用 `sub_type === 1` 表示动画表情；也可能是字符串 "1"。
  const rawSubType = data['sub_type']
  const sticker = String(rawSubType ?? '') === '1'
  const url = data['url']
  if (typeof url !== 'string' || url === '') {
    return { kind: 'image', sticker, description: '', failed: true }
  }
  const fetched = await attempt(() => ctx.fetchImage(url))
  if (fetched === undefined) {
    return { kind: 'image', sticker, description: '', failed: true }
  }
  if (ctx.describe === undefined) {
    return { kind: 'image', sticker, description: '', failed: false }
  }
  const description = await attempt(() => ctx.describe!({
    base64: fetched.base64,
    mimeType: fetched.mimeType,
    sticker,
  }))
  // 描述失败用固定占位，且**不入库**——实验期也是这个语义。
  return { kind: 'image', sticker, description: description ?? '(解析失败)', failed: false }
}

/**
 * 解析一条引用回复段。
 *
 * 只筛被引消息里的 `text` 段——多模态段或嵌套转发会撑爆上下文（实验期决定）。
 * @param data - `reply` 段的 data。
 * @param ctx - 解析上下文。
 * @returns 已解析的引用段。
 */
async function resolveReply(
  data: Record<string, unknown>,
  ctx: ResolveContext,
): Promise<ResolvedSegment> {
  const messageId = String(data['id'] ?? '')
  const detail = await withTimeout(ctx.getMessage(messageId), ctx.options.expandTimeoutMs)
  if (detail === undefined) {
    // 查不到：只留 id，`senderName`/`preview` 都空，渲染成 `回复消息(msg_id=…)`。
    return { kind: 'reply', messageId, senderName: undefined, preview: undefined }
  }
  const parts: string[] = []
  for (const segment of detail.segments) {
    if (segment.type !== 'text') continue
    const text = segment.data['text']
    if (typeof text === 'string' && text.trim() !== '') parts.push(text)
  }
  const preview = parts.length === 0 ? undefined : parts.join(' ')
  return { kind: 'reply', messageId, senderName: detail.senderName, preview }
}

/**
 * 解析一条合并转发段。
 * @param data - `forward` 段的 data。
 * @param raw - 原始事件，用于 XML 兜底。
 * @param ctx - 解析上下文。
 * @returns 已解析的转发段。
 */
async function resolveForward(
  data: Record<string, unknown>,
  raw: RawEvent,
  ctx: ResolveContext,
): Promise<ResolvedSegment> {
  const id = data['id']
  const token = String(id ?? '')
  const xmlSummary = extractForwardXml(raw)

  if (token === '') return { kind: 'forward', block: undefined, xmlSummary }

  // 展开器实例**每个转发段一个**：计数器与 first 标志都挂在它身上。
  const expander = new ForwardExpander(
    {
      getMessage: ctx.getMessage,
      getForward: ctx.getForward,
      fetchImage: ctx.fetchImage,
      ...ctx.describe === undefined ? {} : { describe: ctx.describe },
    },
    {
      imageMode: ctx.options.imageMode,
      maxDepth: ctx.options.maxDepth,
      maxTotal: ctx.options.maxTotal,
      expandTimeoutMs: ctx.options.expandTimeoutMs,
    },
  )
  // ★ 渲染成 `(msg_id = …)` 的是**外层那条消息的真实 id**，不是这坨 token。
  //   那个位置的契约是"可拿来引用的消息号"（`reply_to`），而 token 当 `message_id`
  //   用会被协议端回 `retcode 1400 · "message_id: expected a message id"`。
  const outerId = raw['message_id']
  const block = await attempt(() => expander.expand(
    token,
    undefined,
    outerId === undefined ? '' : String(outerId),
  ))
  return { kind: 'forward', block, xmlSummary }
}

/**
 * 解析一条 `at` 段。
 *
 * 旧版教训：**先入列表再查昵称**——昵称查询失败不能让 `AT_ME` 判定失效。
 * 但那条规则属于适配器的 `mentionsSelf` 计算（已经在 `adapter.ts` 里落定），
 * 这里只负责"显示成什么"。
 * @param data - `at` 段的 data。
 * @param ctx - 解析上下文。
 * @returns 已解析的提及段。
 */
async function resolveMention(
  data: Record<string, unknown>,
  ctx: ResolveContext,
): Promise<ResolvedSegment> {
  const qq = String(data['qq'] ?? '')
  if (qq === 'all') return { kind: 'mention', display: '全体成员', userId: 'all' }
  const nickname = await attempt(() => ctx.lookupNickname(qq))
  // 查不到就用 `user_id=xx` —— 至少模型知道"这里 @ 了某个具体的人"。
  return { kind: 'mention', display: nickname ?? `user_id=${qq}`, userId: qq }
}

/**
 * 解析一个段。所有降级都在这里收口。
 * @param raw - 原始段。
 * @param request - 整条消息的输入（转发需要 raw）。
 * @param ctx - 解析上下文。
 * @returns 已解析的段。
 */
async function resolveSegment(
  raw: Segment,
  request: ResolveRequest,
  ctx: ResolveContext,
): Promise<ResolvedSegment> {
  const data = raw.data ?? {}
  switch (raw.type) {
    case 'text': {
      const text = data['text']
      return { kind: 'text', text: typeof text === 'string' ? text : '' }
    }
    case 'image':
      return await resolveImage(data, ctx)
    case 'face':
      return { kind: 'face', label: faceToText(data['id']) }
    case 'at':
      return await resolveMention(data, ctx)
    case 'reply':
      return await resolveReply(data, ctx)
    case 'forward':
      return await resolveForward(data, request.raw, ctx)
    case 'video':
      return {
        kind: 'video',
        url: typeof data['url'] === 'string' ? data['url'] : undefined,
        localPath: typeof data['local_path'] === 'string' ? data['local_path'] : undefined,
      }
    case 'json': {
      const text = parseJsonCard(data['data'])
      // 解析不出来时**不留 undefined**：渲染器需要知道这里有个卡片。
      return { kind: 'card', text: text ?? CARD_FALLBACK }
    }
    default:
      return { kind: 'unknown', type: raw.type }
  }
}

/**
 * 把一条消息的原始段全部解析成结构化表示。
 *
 * **不会抛错**：任何单段的失败都降级成占位，返回的数组长度与输入一一对应
 * （唯一例外是转发内部的图片可能被 `imageMode: 'skip'` 省略，但那只影响块内）。
 * @param request - 消息的段与原始事件。
 * @param ctx - 解析上下文。
 * @returns 已解析的段，顺序与输入一致。
 */
export async function resolveMessage(
  request: ResolveRequest,
  ctx: ResolveContext,
): Promise<ResolvedSegment[]> {
  const resolved: ResolvedSegment[] = []
  for (const raw of request.segments) {
    if (raw === null || typeof raw !== 'object') continue
    resolved.push(await resolveSegment(raw, request, ctx))
  }
  return resolved
}
