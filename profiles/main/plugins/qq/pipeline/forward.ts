/**
 * 合并转发（聊天记录）的递归展开。
 *
 * 迁移自实验期 `utils/forward.py` 的 `ForwardExpander`。核心事实（旧版实测确认）：
 *
 * > `get_msg` 回传的 forward `content` 是**递归完整消息树**（嵌套已内联），
 * > 全程**只需一次 `get_msg`** —— 不要按层递归请求。
 *
 * 所以展开是一次取回 + 本地递归，唯一的异步工作是下载图片和调 VLM。
 *
 * ## 三个上限，一个共享计数器
 *
 * - `maxDepth` 控制嵌套深度，超出给 `[嵌套转发已省略]`
 * - `maxTotal` 是**跨嵌套共享**的总条数上限，超出后整个块停止展开并记 `truncated`
 * - `imageMode` 决定图片下不下：`skip` / `first`（整棵树的第一张）/ `all`
 *
 * ## 与实验期的一处语义修正
 *
 * 旧版把 `skip` 与"下载失败"都变成 `None`，渲染时不可区分（注释里自己标了这个瑕疵）。
 * 这里分开：**`skip` 静默省略**（默认模式，标出来只是噪音）；**下载失败标 `(下载失败)`**
 * （那是真的出了问题，值得让模型知道）。
 *
 * @module qq/forward
 */

import { faceToText } from './face.ts'
import { parseJsonCard } from './card.ts'
import type { Segment } from '../protocol/index.ts'
import type { ForwardBlock, ForwardSubMessage, ImageDescriber, ResolvedImage, ResolvedSegment } from './segment.ts'

/** 转发内出现 `reply` 段时的占位。 */
const REPLY_PLACEHOLDER = '[回复]'
/** 卡片解析失败的占位（与顶层消息的措辞不同，沿用实验期）。 */
const CARD_PLACEHOLDER = '[卡片消息]'
/** 默认标题。 */
const DEFAULT_TITLE = '聊天记录'
const GROUP_TITLE = '群聊的聊天记录'

/** 展开时需要的适配器能力。 */
export interface ForwardContext {
  /** 取一条消息的原始段；失败返回 undefined。 */
  getMessage: (messageId: string) => Promise<{ segments: Segment[], senderName: string | undefined } | undefined>
  /** 下载图片并转 base64；失败返回 undefined。 */
  fetchImage: (url: string) => Promise<{ base64: string, mimeType: string } | undefined>
  /** VLM 描述器。 */
  describe?: ImageDescriber
}

/** 展开参数。 */
export interface ForwardOptions {
  imageMode: 'skip' | 'first' | 'all'
  maxDepth: number
  maxTotal: number
  /** 单次 `get_msg` 的超时（毫秒）。 */
  expandTimeoutMs: number
}

/**
 * 一次转发展开的**状态持有者**。
 *
 * 计数器与"第一张图已下载"标志都挂在实例上，所以**一次顶层展开必须用同一个实例**——
 * `first` 语义是"整棵转发树的第一张"，不是"每个块的第一张"。
 * 这也是它是个类而不是一组纯函数的原因。
 */
export class ForwardExpander {
  private count = 0
  private firstImageDone = false

  /**
   * @param ctx - 适配器能力。
   * @param options - 展开参数。
   */
  constructor(
    private readonly ctx: ForwardContext,
    private readonly options: ForwardOptions,
  ) {}

  /**
   * 展开一个转发消息。
   *
   * 失败（查不到 / 超时 / 没有 forward 段）返回 `undefined`，由调用方回退到 XML 摘要。
   * @param messageId - 转发消息的 id。
   * @param rawTitle - 从事件 XML 里抠出的标题；没有就按子消息类型推断。
   * @returns 转发块；无法展开时 undefined。
   */
  async expand(messageId: string, rawTitle: string | undefined): Promise<ForwardBlock | undefined> {
    const detail = await this.withTimeout(this.ctx.getMessage(messageId), this.options.expandTimeoutMs)
    if (detail === undefined) return undefined

    // 取**第一个**携带非空 content 的 forward 段。一条消息里出现多个是异常的，不处理。
    for (const segment of detail.segments) {
      if (segment.type !== 'forward') continue
      const content = segment.data['content']
      if (!Array.isArray(content) || content.length === 0) continue
      const title = rawTitle ?? this.inferTitle(content)
      return await this.buildBlock(content as Segment[], title, messageId, 0)
    }
    return undefined
  }

  /** 按子消息的 `message_type` 推断标题。 */
  private inferTitle(content: readonly unknown[]): string {
    for (const node of content) {
      const type = this.nodeType(node)
      if (type === 'group') return GROUP_TITLE
      if (type === 'private') return DEFAULT_TITLE
    }
    return DEFAULT_TITLE
  }

  /** 读一个转发子节点的 `message_type`。 */
  private nodeType(node: unknown): string | undefined {
    if (node === null || typeof node !== 'object') return undefined
    const data = (node as { data?: unknown }).data
    if (data === null || typeof data !== 'object') return undefined
    const type = (data as { message_type?: unknown }).message_type
    return typeof type === 'string' ? type : undefined
  }

  /** 构造一个转发块。 */
  private async buildBlock(
    content: readonly Segment[],
    title: string,
    messageId: string,
    depth: number,
  ): Promise<ForwardBlock> {
    const messages: ForwardSubMessage[] = []
    let truncated = 0
    for (const node of content) {
      if (this.count >= this.options.maxTotal) {
        // 到上限就停**整个块**，不再展开兄弟节点（沿用实验期行为）。
        truncated = content.length - messages.length
        break
      }
      const sub = await this.buildSub(node, depth)
      if (sub === undefined) continue
      messages.push(sub)
      this.count += 1
    }
    return { title, messageId, messages, truncated }
  }

  /** 构造一条子消息。 */
  private async buildSub(node: unknown, depth: number): Promise<ForwardSubMessage | undefined> {
    if (node === null || typeof node !== 'object') return undefined
    const data = (node as { data?: unknown }).data
    if (data === null || typeof data !== 'object') return undefined
    const record = data as Record<string, unknown>

    const senderName = this.senderName(record)
    const rawSegments = record['content'] ?? record['message']
    const segments: ResolvedSegment[] = []
    let nested: ForwardBlock | undefined

    if (Array.isArray(rawSegments)) {
      for (const raw of rawSegments as Segment[]) {
        if (raw === null || typeof raw !== 'object') continue
        if (raw.type === 'sender') continue // 发送者已单独取，跳过
        if (raw.type === 'forward') {
          nested = await this.buildNested(raw.data, depth)
          continue
        }
        const resolved = await this.resolveSubSegment(raw)
        if (resolved !== undefined) segments.push(resolved)
      }
    }

    return { senderName, segments, nested }
  }

  /** 从子节点里取发送者显示名。 */
  private senderName(record: Record<string, unknown>): string {
    const sender = record['sender']
    if (sender !== null && typeof sender === 'object') {
      const nickname = (sender as { nickname?: unknown }).nickname
      if (typeof nickname === 'string' && nickname !== '') return nickname
    }
    const nickname = record['nickname']
    if (typeof nickname === 'string' && nickname !== '') return nickname
    const userId = record['user_id']
    if (typeof userId === 'string' && userId !== '') return userId
    if (typeof userId === 'number') return String(userId)
    return '未知'
  }

  /** 解析转发内的一个段。`undefined` 表示该段不产生内容（例如被 skip 的图片）。 */
  private async resolveSubSegment(raw: Segment): Promise<ResolvedSegment | undefined> {
    const data = raw.data
    switch (raw.type) {
      case 'text': {
        const text = data['text']
        return { kind: 'text', text: typeof text === 'string' ? text : '' }
      }
      case 'image': {
        return await this.prepareImage(data)
      }
      case 'face':
        // 转发内用统一格式（实验期这里是 `[未知表情]`，与主消息的 `[未知表情:{id}]` 不一致）。
        return { kind: 'face', label: faceToText(data['id']) }
      case 'at': {
        const qq = data['qq']
        if (String(qq) === 'all') return { kind: 'mention', display: '全体成员', userId: 'all' }
        // 转发内**不查昵称**——旧版注释：避免 N+1 请求。直接用 QQ 号。
        return { kind: 'mention', display: String(qq), userId: String(qq) }
      }
      case 'reply':
        // 不递归查询被引消息。旧版注释：避免 N+1 请求。
        return { kind: 'text', text: REPLY_PLACEHOLDER }
      case 'video':
        return {
          kind: 'video',
          url: typeof data['url'] === 'string' ? data['url'] : undefined,
          localPath: undefined,
        }
      case 'json': {
        const text = parseJsonCard(data['data'])
        return { kind: 'card', text: text ?? CARD_PLACEHOLDER }
      }
      default:
        return { kind: 'unknown', type: raw.type }
    }
  }

  /** 展开嵌套转发。 */
  private async buildNested(data: Record<string, unknown>, depth: number): Promise<ForwardBlock | undefined> {
    if (depth + 1 > this.options.maxDepth) return undefined
    const content = data['content']
    if (!Array.isArray(content) || content.length === 0) return undefined
    // 嵌套块**只用推断标题**（实验期不传 rawTitle）。
    const title = this.inferTitle(content)
    const id = data['id']
    return await this.buildBlock(content as Segment[], title, String(id ?? ''), depth + 1)
  }

  /** 按 `imageMode` 处理转发内的图片。 */
  private async prepareImage(data: Record<string, unknown>): Promise<ResolvedImage | undefined> {
    const base = { kind: 'image', sticker: false } as const
    if (this.options.imageMode === 'skip') return undefined
    if (this.options.imageMode === 'first' && this.firstImageDone) return undefined
    const url = data['url']
    if (typeof url !== 'string' || url === '') return undefined
    const fetched = await this.ctx.fetchImage(url)
    if (fetched === undefined) {
      // 下载失败**要标出来**（区别于被 skip 的静默省略）。
      return { ...base, description: '', failed: true }
    }
    this.firstImageDone = true
    const description = this.ctx.describe === undefined
      ? ''
      : await this.describeSafely(fetched.base64, fetched.mimeType)
    return { ...base, description, failed: false }
  }

  /** 调描述器，失败不抛出——描述是锦上添花，不该让整条转发展开失败。 */
  private async describeSafely(base64: string, mimeType: string): Promise<string> {
    try {
      return await this.ctx.describe!({ base64, mimeType, sticker: false })
    } catch {
      return '(解析失败)'
    }
  }

  /** 给一个 Promise 套超时；超时或抛错都返回 undefined。 */
  private async withTimeout<T>(promise: Promise<T | undefined>, ms: number): Promise<T | undefined> {
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
}

/** XML 实体还原。只处理 QQ 实际会产出的几种。 */
function unescapeXml(text: string): string {
  return text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', '\'')
    .replaceAll('&apos;', '\'')
    .replaceAll('&nbsp;', ' ')
    // `&amp;` 必须最后做，否则 `&amp;lt;` 会被二次还原成 `<`。
    .replaceAll('&amp;', '&')
}

/**
 * 从原始事件的 XML 里抠出转发摘要 —— **兜底路径**。
 *
 * 只在"有 forward 段但 `get_msg` 拿不到内容"时用得上（消息太旧、已过期、协议端未缓存）。
 * 此时 XML 里的 `<title>` / `<summary>` 是唯一线索。
 *
 * 旧版注释：**不要用 XML 解析器**——QQ 产出的转发 XML 常不规范、转义异常，
 * 正则 + 实体还原反而稳。这里沿用这一点。
 * @param raw - 原始 OneBot 事件。
 * @returns 摘要文本；抠不出来返回 undefined。
 */
export function extractForwardXml(raw: unknown): string | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const elements = (raw as { elements?: unknown }).elements
  if (!Array.isArray(elements)) return undefined

  let xml: string | undefined
  for (const element of elements) {
    if (element === null || typeof element !== 'object') continue
    const candidate = (element as { multiForwardMsgElement?: { xmlContent?: unknown } }).multiForwardMsgElement
    if (candidate !== undefined && typeof candidate.xmlContent === 'string' && candidate.xmlContent !== '') {
      xml = candidate.xmlContent
      break
    }
  }
  if (xml === undefined) return undefined

  const titles = [...xml.matchAll(/<title\b[^>]*>([^<]*)<\/title>/gi)].map(match => unescapeXml(match[1] ?? ''))
  const summary = xml.match(/<summary\b[^>]*>([^<]*)<\/summary>/i)

  const parts: string[] = []
  titles.forEach((title, index) => {
    // 第一条以「的聊天记录」结尾的 title 是转发卡片自身的标题，不是内容。
    if (index === 0 && title.endsWith('的聊天记录')) return
    if (title !== '') parts.push(title)
  })
  if (summary !== null && (summary[1] ?? '') !== '') parts.push(unescapeXml(summary[1] ?? ''))
  return parts.length === 0 ? undefined : parts.join('\n')
}
