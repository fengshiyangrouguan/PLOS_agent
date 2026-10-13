/**
 * 数据存储层：完整消息、感知历史、当前会话指针。
 *
 * ## 为什么单独一层
 *
 * 和 `schema.ts` 一样，**不认识 cordis** —— 只吃一个 `DatabaseSync`。
 * 所以能用内存库离线自检（`tests/stores.spec.ts`）。
 *
 * ## 搜索为什么要"带上下文区间"
 *
 * 设计 §7.3 定案：搜索命中 **5 条**，每条带**上下各 10 条**，**区间重合直接合并**。
 *
 * 为什么必须带上下文：一条消息脱离上下文往往没有意义 ——
 * 「那个不行」只有配上前后几句才知道"那个"指什么。所以搜索**不是**返回孤立命中，
 * 而是返回命中所在的**一段连续区间**。
 *
 * 为什么要合并：两条命中靠得近时（间隔 < 20 条），它们的区间会重叠。
 * 不合并就会把同一段消息返回两遍 —— 既费 token 又让模型以为"这里有两条线索"。
 *
 * @module db/stores
 */

import type { DatabaseSync } from 'node:sqlite'

/** 一条存档消息。 */
export interface MessageRow {
  readonly platform: string
  readonly messageId: string
  /** 规范化会话 id，如 `group:728636404` / `private:1234567`。 */
  readonly conversationId: string
  readonly conversationType: string
  readonly conversationName?: string | undefined
  readonly senderId?: string | undefined
  readonly senderName?: string | undefined
  /** 毫秒时间戳。 */
  readonly time: number
  /** 渲染后的纯文本（搜索用）。 */
  readonly content: string
  /** 原始段的 JSON（唯一真相是 segments，保留原文以备重渲染）。 */
  readonly segments?: string | undefined
}

/** 搜索命中所在的连续区间。 */
export interface MessageRange {
  readonly conversationId: string
  readonly conversationName?: string | undefined
  /** 区间内全部消息，按时间升序。 */
  readonly messages: readonly MessageRow[]
  /** 区间内包含的命中消息 id（`context` 提供上下文，只有这些才是"命中"）。 */
  readonly hitIds: readonly string[]
}

/** 搜索结果。 */
export interface SearchResult {
  readonly ranges: readonly MessageRange[]
  /** 命中总数（截断前）。 */
  readonly hits: number
  /** 是否因总量上限被截断。 */
  readonly truncated: boolean
}

/** 搜索选项。 */
export interface SearchOptions {
  /** 关键词（`LIKE %q%`，对 content 匹配）。省略则只按时间/会话过滤。 */
  readonly query?: string | undefined
  /** 限定平台，如 `'qq'`。 */
  readonly platform?: string | undefined
  /** 限定会话。 */
  readonly conversationId?: string | undefined
  /** **搜索时间范围**下限（毫秒）—— "最近多久"的可选项（设计 §7.3）。 */
  readonly since?: number | undefined
  /** 命中条数上限，默认 5。 */
  readonly hitLimit?: number | undefined
  /** 每条命中携带的上下文条数（上下各），默认 10。 */
  readonly context?: number | undefined
  /** 返回消息总量上限，默认 200。超出截断并置 `truncated`。 */
  readonly maxMessages?: number | undefined
}

/** 默认命中条数（设计 §7.3 定案）。 */
export const DEFAULT_HIT_LIMIT = 5
/** 默认上下文条数：上下各 10（设计 §7.3 定案，原 20 已改）。 */
export const DEFAULT_CONTEXT = 10
/** 默认返回总量上限。 */
export const DEFAULT_MAX_MESSAGES = 200

/** 数据库里的行形状（snake_case）。 */
interface MessageDbRow {
  platform: string
  message_id: string
  conversation_id: string
  conversation_type: string
  conversation_name: string | null
  sender_id: string | null
  sender_name: string | null
  time: number
  content: string
  segments: string | null
}

/** 把数据库行转成领域形状。 */
function toMessage(row: MessageDbRow): MessageRow {
  return {
    platform: row.platform,
    messageId: row.message_id,
    conversationId: row.conversation_id,
    conversationType: row.conversation_type,
    conversationName: row.conversation_name ?? undefined,
    senderId: row.sender_id ?? undefined,
    senderName: row.sender_name ?? undefined,
    time: row.time,
    content: row.content,
    segments: row.segments ?? undefined,
  }
}

/**
 * 完整消息存档。
 *
 * 设计 §6.5：**后台每一条消息都进库**（完整），进上下文的只有最新若干条；
 * 搜索是唯一的回看通道。
 */
export class MessageStore {
  readonly #db: DatabaseSync

  /** @param db - 已迁移到最新版的数据库句柄。 */
  constructor(db: DatabaseSync) {
    this.#db = db
  }

  /**
   * 存一条消息。同 `(platform, messageId)` 重复时**覆盖** ——
   * 平台重推同一 id 时以最新渲染结果为准。
   * @param row - 消息。
   */
  insert(row: MessageRow): void {
    this.#db.prepare(`
      INSERT INTO messages (
        platform, message_id, conversation_id, conversation_type, conversation_name,
        sender_id, sender_name, time, content, segments
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (platform, message_id) DO UPDATE SET
        conversation_id   = excluded.conversation_id,
        conversation_type = excluded.conversation_type,
        conversation_name = excluded.conversation_name,
        sender_id         = excluded.sender_id,
        sender_name       = excluded.sender_name,
        time              = excluded.time,
        content           = excluded.content,
        segments          = excluded.segments
    `).run(
      row.platform, row.messageId, row.conversationId, row.conversationType,
      row.conversationName ?? null, row.senderId ?? null, row.senderName ?? null,
      row.time, row.content, row.segments ?? null,
    )
  }

  /** 已有多少条。 */
  count(): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }
    return row.n
  }

  /**
   * 搜索，返回命中所在的**合并后区间**。
   *
   * 算法：
   * 1. 按条件查命中（时间降序，取 `hitLimit` 条）
   * 2. 每条命中求出 `[start, end]` 时间区间（同会话内上下各 `context` 条）
   * 3. **同会话内区间重合/相邻就合并**
   * 4. 按合并区间取全部消息，总量超过 `maxMessages` 则截断并标记
   *
   * @param options - 搜索条件。
   * @returns 合并后的区间与截断标记。
   */
  search(options: SearchOptions = {}): SearchResult {
    const hitLimit = options.hitLimit ?? DEFAULT_HIT_LIMIT
    const context = options.context ?? DEFAULT_CONTEXT
    const maxMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES

    // ── 1. 找命中 ──────────────────────────────────────────────────
    const where: string[] = []
    const args: (string | number)[] = []
    if (options.query !== undefined && options.query !== '') {
      where.push('content LIKE ?')
      args.push(`%${options.query}%`)
    }
    if (options.platform !== undefined) { where.push('platform = ?'); args.push(options.platform) }
    if (options.conversationId !== undefined) { where.push('conversation_id = ?'); args.push(options.conversationId) }
    if (options.since !== undefined) { where.push('time >= ?'); args.push(options.since) }

    const clause = where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`
    const hitRows = this.#db.prepare(
      `SELECT * FROM messages ${clause} ORDER BY time DESC LIMIT ?`,
    ).all(...args, hitLimit) as unknown as MessageDbRow[]
    const hits = hitRows.map(toMessage)
    if (hits.length === 0) return { ranges: [], hits: 0, truncated: false }

    // ── 2..3. 求区间并合并（按会话分组） ────────────────────────────
    const byConversation = new Map<string, { start: number, end: number, hitIds: Set<string>, name?: string | undefined }[]>()
    for (const hit of hits) {
      const before = this.#db.prepare(
        'SELECT time FROM messages WHERE conversation_id = ? AND time < ? ORDER BY time DESC LIMIT ?',
      ).all(hit.conversationId, hit.time, context) as { time: number }[]
      const after = this.#db.prepare(
        'SELECT time FROM messages WHERE conversation_id = ? AND time >= ? ORDER BY time ASC LIMIT ?',
      ).all(hit.conversationId, hit.time, context + 1) as { time: number }[]
      const times = [...before, ...after].map(row => row.time)
      const start = Math.min(...times)
      const end = Math.max(...times)

      const list = byConversation.get(hit.conversationId) ?? []
      list.push({ start, end, hitIds: new Set([hit.messageId]), name: hit.conversationName })
      byConversation.set(hit.conversationId, list)
    }

    const ranges: MessageRange[] = []
    let total = 0
    let truncated = false

    for (const [conversationId, list] of byConversation) {
      // 按起点升序，重合或相接（end >= next.start）就并入前一段。
      list.sort((a, b) => a.start - b.start)
      const merged: typeof list = []
      for (const item of list) {
        const last = merged[merged.length - 1]
        if (last !== undefined && item.start <= last.end) {
          last.end = Math.max(last.end, item.end)
          for (const id of item.hitIds) last.hitIds.add(id)
          last.name ??= item.name
        } else {
          merged.push({ ...item, hitIds: new Set(item.hitIds) })
        }
      }

      for (const span of merged) {
        const rows = this.#db.prepare(
          'SELECT * FROM messages WHERE conversation_id = ? AND time >= ? AND time <= ? ORDER BY time ASC',
        ).all(conversationId, span.start, span.end) as unknown as MessageDbRow[]
        const remaining = maxMessages - total
        if (rows.length > remaining) {
          truncated = true
          if (remaining > 0) {
            ranges.push({
              conversationId,
              conversationName: span.name,
              messages: rows.slice(0, remaining).map(toMessage),
              hitIds: [...span.hitIds],
            })
            total += remaining
          }
          break
        }
        ranges.push({
          conversationId,
          conversationName: span.name,
          messages: rows.map(toMessage),
          hitIds: [...span.hitIds],
        })
        total += rows.length
      }
      if (truncated) break
    }

    return { ranges, hits: hits.length, truncated }
  }
}

/** 一条感知历史。 */
export interface PerceptionRow {
  readonly time: number
  readonly domain: string
  readonly source: string
  readonly summary: string
}

/**
 * 感知历史（设计 §6.4：极简）。
 *
 * 注意 `pulled` 是**感知层是否拉过**，不是模型是否读过 ——
 * 模型层的已读语义由领域自己的读游标管（设计 §4.7）。
 */
export class PerceptionStore {
  readonly #db: DatabaseSync

  /** @param db - 已迁移到最新版的数据库句柄。 */
  constructor(db: DatabaseSync) {
    this.#db = db
  }

  /**
   * 记一条感知。
   * @param row - 感知内容。
   */
  record(row: PerceptionRow): void {
    this.#db.prepare(
      'INSERT INTO perception_history (time, domain, source, summary, pulled) VALUES (?, ?, ?, ?, 0)',
    ).run(row.time, row.domain, row.source, row.summary)
  }

  /** 最近的若干条，时间降序。 */
  recent(limit = 20): (PerceptionRow & { readonly id: number, readonly pulled: boolean })[] {
    const rows = this.#db.prepare(
      'SELECT id, time, domain, source, summary, pulled FROM perception_history ORDER BY time DESC LIMIT ?',
    ).all(limit) as { id: number, time: number, domain: string, source: string, summary: string, pulled: number }[]
    return rows.map(row => ({
      id: row.id,
      time: row.time,
      domain: row.domain,
      source: row.source,
      summary: row.summary,
      pulled: row.pulled !== 0,
    }))
  }

  /** 把若干条标记为"已被感知层拉取过"。 */
  markPulled(ids: readonly number[]): void {
    const stmt = this.#db.prepare('UPDATE perception_history SET pulled = 1 WHERE id = ?')
    for (const id of ids) stmt.run(id)
  }
}
