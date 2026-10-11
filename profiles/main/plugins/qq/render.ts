/**
 * `ResolvedSegment[]` → LLM 友好文本。
 *
 * **纯函数，没有 I/O。** 这一侧不下载、不查询、不调模型——需要的数据必须已经在段里。
 * VLM 描述也属于"数据"，由解析阶段填进 `ResolvedImage.description`。
 *
 * ## 与实验期格式的对照
 *
 * 格式串绝大部分**逐字沿用** `PLOS/Shiraha_OS/src/core/context_system/render.py`，
 * 因为那些括号和冒号是模型已经见过几百轮的形状。有三处**刻意不同**，都在下文标注。
 *
 * @module qq/render
 */

import type { ForwardBlock, ForwardSubMessage, ResolvedImage, ResolvedSegment } from './segment.ts'

/** 嵌套转发被省略时的占位。 */
const NESTED_OMITTED = '[嵌套转发已省略]'
/** 转发完全解析不出来时的占位。 */
const FORWARD_FAILED = '[聊天记录(解析失败)]'
/** 转发缩进步长。 */
const INDENT = '  '

/** 生成 `indent` 层缩进。 */
function pad(indent: number): string {
  return INDENT.repeat(indent)
}

/**
 * 渲染一条图片/表情类段。
 * @param segment - 已解析的图片段。
 * @param wrapped - 是否加 `[图片:…]` 包裹。转发内的图片**不加**（沿用实验期行为）。
 * @returns 渲染结果；无描述且未失败时返回 undefined（转发内会被过滤掉）。
 */
function renderImage(segment: ResolvedImage, wrapped: boolean): string | undefined {
  const label = segment.sticker ? '动画表情' : '图片'
  if (segment.failed) return wrapped ? `[${label}:(下载失败)]` : '(下载失败)'
  if (segment.description === '') return wrapped ? `[${label}]` : undefined
  return wrapped ? `[${label}:${segment.description}]` : segment.description
}

/**
 * 渲染一条引用回复段的正文（不含外层方括号）。
 * @param segment - 已解析的引用段。
 * @returns 形如 `回复张三的消息:早上好(msg_id=123)` 的文本。
 */
function replyText(segment: Extract<ResolvedSegment, { kind: 'reply' }>): string {
  if (segment.senderName === undefined) return `回复消息(msg_id=${segment.messageId})`
  if (segment.preview === undefined) return `回复${segment.senderName}的消息:[消息(msg_id=${segment.messageId})]`
  return `回复${segment.senderName}的消息:${segment.preview}(msg_id=${segment.messageId})`
}

/**
 * 渲染一个转发块。
 *
 * 输出形如：
 * ```text
 * [群聊的聊天记录(msg_id = 123)]
 *   张三: 早上好
 *   李四: 早
 *   …（已达展开上限 50 条，其余省略）
 * ```
 * @param block - 转发块；undefined 表示已省略或解析失败。
 * @param indent - 当前缩进层数。
 * @param failed - `block` 为 undefined 时，是否属于"解析失败"（区别于"超深度省略"）。
 * @returns 渲染文本。
 */
export function renderForwardBlock(block: ForwardBlock | undefined, indent: number, failed = false): string {
  if (block === undefined) {
    return pad(indent) + (failed ? FORWARD_FAILED : NESTED_OMITTED)
  }
  const lines: string[] = [`${pad(indent)}[${block.title}(msg_id = ${block.messageId})]`]
  for (const message of block.messages) {
    const line = renderForwardSubMessage(message, indent + 1)
    if (line !== undefined) lines.push(line)
  }
  if (block.truncated > 0) {
    lines.push(`${pad(indent + 1)}…（已达展开上限 ${block.messages.length + block.truncated} 条，其余省略）`)
  }
  return lines.join('\n')
}

/**
 * 渲染转发块里的一条子消息。
 * @param message - 子消息。
 * @param indent - 该子消息的缩进层数。
 * @returns 一行文本；内容为空时返回 undefined（不占行）。
 */
function renderForwardSubMessage(message: ForwardSubMessage, indent: number): string | undefined {
  const parts: string[] = []
  for (const segment of message.segments) {
    if (segment.kind === 'image') {
      const text = renderImage(segment, false)
      if (text !== undefined) parts.push(text)
      continue
    }
    if (segment.kind === 'video') {
      parts.push('[视频消息]')
      continue
    }
    if (segment.kind === 'forward') {
      // 转发内的转发由 `nested` 单独承载，这里跳过避免重复。
      continue
    }
    const text = renderInline(segment)
    if (text !== undefined) parts.push(text)
  }
  // 空格连接、过滤空串——沿用实验期 `" ".join(p for p in parts if p).strip()`。
  const body = parts.filter(part => part !== '').join(' ').trim()
  if (body === '') return undefined
  // 英文冒号 + 空格，沿用实验期格式。
  return `${pad(indent)}${message.senderName}: ${body}`
}

/**
 * 渲染一个非转发、非图片的段为行内文本。
 * @param segment - 已解析的段。
 * @returns 文本；该段不产生文本时返回 undefined。
 */
function renderInline(segment: ResolvedSegment): string | undefined {
  switch (segment.kind) {
    case 'text':
      return segment.text
    case 'face':
      // 表里的值本身已是 `[表情：笑哭]` 形态，直接拼。
      return segment.label
    case 'mention':
      // 尾随一个空格是刻意的——`@张三 你好` 比 `@张三你好` 可读。
      return `@${segment.display} `
    case 'reply':
      return `[${replyText(segment)}]:`
    case 'video':
      return '[视频消息]'
    case 'card':
      return `[卡片: ${segment.text ?? '暂时无法处理该类型的消息'}]`
    case 'unknown':
      return `[${segment.type}]`
    case 'image': {
      const text = renderImage(segment, true)
      return text
    }
    case 'forward':
      return undefined
    default:
      return undefined
  }
}

/**
 * 把一条消息的段渲染成 LLM 文本。
 *
 * 段间**无分隔符**，直接拼接——沿用实验期 `"".join(texts)`。
 * 转发块内部自带换行与缩进，所以整体可能多行。
 * @param segments - 已解析的消息段，按原顺序。
 * @returns 渲染文本。
 */
export function renderSegments(segments: readonly ResolvedSegment[]): string {
  const chunks: string[] = []
  for (const segment of segments) {
    if (segment.kind === 'forward') {
      const failed = segment.block === undefined && segment.xmlSummary === undefined
      // XML 摘要是**兜底**：整段原样输出，不缩进、不包标题（沿用实验期行为）。
      chunks.push(segment.xmlSummary ?? renderForwardBlock(segment.block, 0, failed))
      continue
    }
    const text = renderInline(segment)
    if (text !== undefined && text !== '') chunks.push(text)
  }
  return chunks.join('')
}
