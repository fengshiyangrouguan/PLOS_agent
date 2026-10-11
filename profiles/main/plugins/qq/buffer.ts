/**
 * 消息缓冲：每个会话一个环形缓冲 + 一个读游标。
 *
 * ## 为什么需要它
 *
 * 适配器把每条消息 `emit('qq/message')` 出去，但**事件是瞬时的**——没有监听器就没了。
 * 而"推"和"拉"两条路都需要一个能回头看的东西：
 *
 * | | 取什么 | 靠缓冲的哪个能力 |
 * |:--|:--|:--|
 * | **推** | 刚到的这条 | `push` + 事件本身 |
 * | **拉** | 上次看过之后累积的那些 | `drain` 的读游标 |
 *
 * 拉必须有游标：白羽"打开手机"应该看到**新增**的消息，而不是每次重读全部历史。
 *
 * ## 存的是引用，不是文本
 *
 * 缓冲只持有 `QqIncoming`（段 + 元数据），**不预先渲染**。渲染要下图片、查引用、
 * 展开转发——对每条群消息都做一遍纯属浪费。谁要看谁调 `ctx.qq.render()`，
 * 那边的解析缓存会挡住重复开销。
 *
 * 代价是图片的 rkey 可能过期（缓冲时的图，过一会儿下不动了）。可接受：
 * 拉是"刚发生的事"，不是考古。
 *
 * ## 游标与溢出
 *
 * 每个会话的条目带一个**单调递增的序号**，游标记"已读到的序号"。
 * 缓冲满了丢最旧的，游标不受影响——它记的是序号，不是下标。
 *
 * 本模块**只 import 类型**，运行时零依赖，所以能离网自检（见 `buffer.spec.ts`）。
 *
 * @module qq/buffer
 */

import type { QqIncoming } from './adapter.ts'

/** 缓冲里的一条消息。 */
interface Entry {
  /** 会话内单调递增序号。 */
  readonly seq: number
  readonly incoming: QqIncoming
}

/** 缓冲参数。 */
export interface BufferOptions {
  /** 每个会话保留的条数上限。 */
  perConversation: number
  /** 保留的会话数上限（超出按最久未活动淘汰）。 */
  conversations: number
}

/** 一个会话的状态。 */
interface Conversation {
  entries: Entry[]
  /** 下一个要分配的序号。 */
  nextSeq: number
  /** 已读到的序号；`0` 表示还没读过任何一条。 */
  cursor: number
}

/**
 * 从入站消息推出会话键。
 *
 * 群和私聊各自成会话——同一个 QQ 号在群 A 和群 B 是两段独立的对话。
 * @param incoming - 入站消息。
 * @returns `group:<群号>` 或 `private:<QQ号>`。
 */
export function conversationOf(incoming: QqIncoming): string {
  return incoming.groupId === undefined ? `private:${incoming.userId}` : `group:${incoming.groupId}`
}

/** 把 `group:<id>` / `private:<id>` 解析回目标；不合法返回 undefined。 */
export function parseConversation(
  conversation: string,
): { kind: 'group' | 'private', id: string } | undefined {
  const separator = conversation.indexOf(':')
  if (separator <= 0) return undefined
  const kind = conversation.slice(0, separator)
  const id = conversation.slice(separator + 1).trim()
  if (id === '') return undefined
  if (kind !== 'group' && kind !== 'private') return undefined
  return { kind, id }
}

/**
 * 每会话环形缓冲 + 读游标。
 *
 * 不做并发控制：`push` / `drain` 都是同步的纯内存操作，且只被适配器的单线程事件回调触碰。
 */
export class MessageBuffer {
  private readonly conversations = new Map<string, Conversation>()
  private readonly options: BufferOptions

  /**
   * @param options - 容量参数。
   */
  constructor(options: BufferOptions) {
    this.options = options
  }

  /**
   * 记一条消息。
   * @param incoming - 入站消息。
   * @returns 该消息的会话键。
   */
  push(incoming: QqIncoming): string {
    const key = conversationOf(incoming)
    let conversation = this.conversations.get(key)
    if (conversation === undefined) {
      conversation = { entries: [], nextSeq: 1, cursor: 0 }
      this.conversations.set(key, conversation)
      this.evictConversations()
    } else {
      // 重新插入让它变成 Map 里最新的，淘汰时按最久未活动算。
      this.conversations.delete(key)
      this.conversations.set(key, conversation)
    }
    conversation.entries.push({ seq: conversation.nextSeq, incoming })
    conversation.nextSeq += 1
    while (conversation.entries.length > this.options.perConversation) {
      conversation.entries.shift()
    }
    return key
  }

  /** 会话数超限时淘汰最久未活动的。 */
  private evictConversations(): void {
    while (this.conversations.size > this.options.conversations) {
      const oldest = this.conversations.keys().next()
      if (oldest.done === true) break
      this.conversations.delete(oldest.value)
    }
  }

  /** 已知的会话键，最久未活动的在前。 */
  known(): string[] {
    return [...this.conversations.keys()]
  }

  /**
   * 未读条数。
   * @param conversation - 会话键。
   * @returns 游标之后的消息数量。
   */
  unread(conversation: string): number {
    const state = this.conversations.get(conversation)
    if (state === undefined) return 0
    return state.entries.filter(entry => entry.seq > state.cursor).length
  }

  /**
   * 只看不推进游标。
   * @param conversation - 会话键。
   * @param limit - 最多返回几条（取最近的）。
   * @returns 游标之后的消息，按时间升序。
   */
  peek(conversation: string, limit?: number): QqIncoming[] {
    const state = this.conversations.get(conversation)
    if (state === undefined) return []
    let pending = state.entries.filter(entry => entry.seq > state.cursor)
    if (limit !== undefined && pending.length > limit) pending = pending.slice(-limit)
    return pending.map(entry => entry.incoming)
  }

  /**
   * 取增量并**推进游标**。
   *
   * 这是"拉"的语义：读过就算看过了，下次只给新的。想重读用 {@link peek}。
   * @param conversation - 会话键。
   * @returns 游标之后的消息，按时间升序。
   */
  drain(conversation: string): QqIncoming[] {
    const state = this.conversations.get(conversation)
    if (state === undefined) return []
    const pending = state.entries.filter(entry => entry.seq > state.cursor)
    if (pending.length > 0) {
      state.cursor = pending[pending.length - 1]?.seq ?? state.cursor
    }
    return pending.map(entry => entry.incoming)
  }

  /**
   * 把游标退回到最早保留的位置，让所有保留的消息重新算未读。
   * @param conversation - 会话键。
   */
  rewind(conversation: string): void {
    const state = this.conversations.get(conversation)
    if (state === undefined) return
    const first = state.entries[0]
    state.cursor = first === undefined ? 0 : first.seq - 1
  }
}
