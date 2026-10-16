/**
 * 待交付队列：感知条目的排队与仲裁。
 *
 * ## 为什么单独一层
 *
 * 纯逻辑、不认识 cordis —— 可离线自检（`tests/queue.spec.ts`）。
 * 服务在 `index.ts`。
 *
 * ## 不变量的来源（用户定案）
 *
 * > 信号排队列表里，**0 级信号最多只有 1 个**，而且是**保留最新的**那条。
 *
 * 理由：0 级是"不太有用的信息"，天生就是闲时定时的语义。定时器不重置，
 * 她在忙的时候照常走，所以这类条目会**反复产生**；攒一队没有意义 ——
 * 第二条起都是过时的同一件事（`pull()` 返回的是"当前状态"而不是增量日志）。
 *
 * ## 仲裁规则（docs/design.md §4.3）
 *
 * **严格优先级 + 同级 FIFO**：
 * - **任意优先级差** → 高的排前面（不排队）
 * - **同优先级** → 按到达顺序排队
 * - `priority: 0` → 最多一条，新的顶掉旧的
 *
 * ## ★ 同来源合并（用户定案）
 *
 * 入队时若已有条目与它**共享来源**，则**整条换成新的、位置留在旧的那儿**。
 *
 * - **内容取最新**：理由见下面那条 —— 拉取返回的是**当前状态**，
 *   所以新条目**本身已包含**旧条目里那些来源的未读状态，换新不丢东西。
 * - **位置留旧**：谁先来谁先被服务。一个话多的会话不能靠持续发言改变自己的位置。
 * - 于是队列**按会话数增长，不按消息量增长**。
 *
 * 注意这里只做**排序**，不做"要不要叫醒她"的决定 —— 那是调用方的事。
 * 打断的判定（`deliver` / `queue` / `steer` / `cancel`）也不在这里，
 * 见 `preempt.ts` 与 `docs/m5-preemption.md` §20。
 *
 * （这里曾写"抢占（fork / resume / 合并）见 M5" —— **那些概念已经不存在了**：
 * M5 定案的是**注意力转移**，一个主 agent、一个会话，不 fork、不合并。）
 *
 * @module attention/queue
 */

import { PRIORITY_PASSIVE, type PerceptionNotice } from '../perception/types.ts'

/**
 * 两条条目是否来自同一个来源。
 *
 * 来源取**交集**：一条通知可以带多个来源的信号（`perception` 一次拉取会覆盖
 * 所有有未读的会话），任意一个重合就算同来源。
 *
 * @param left - 一条已排队的通知。
 * @param right - 新到的通知。
 * @returns 是否共享至少一个来源。
 */
function sharesSource(left: PerceptionNotice, right: PerceptionNotice): boolean {
  return left.signals.some(signal => right.signals.some(other => other.source === signal.source))
}

/** 队列里的一个待交付项。 */
export interface PendingItem {
  /** 感知条目。 */
  readonly notice: PerceptionNotice
  /** 入队时间（毫秒），同级 FIFO 用它。 */
  readonly queuedAt: number
}

/**
 * 待交付队列。
 *
 * 容量上限是**防呆**：正常工况下调用方每轮都会取走，队列不会长。
 * 真长起来说明投放链路堵了，那时丢掉最旧的比无限增长好。
 */
export class PendingQueue {
  readonly #items: PendingItem[] = []
  readonly #capacity: number

  /**
   * @param capacity - 队列上限，超出时丢最旧的（**0 级除外**，它本来就只留一条）。
   */
  constructor(capacity = 32) {
    this.#capacity = Math.max(1, capacity)
  }

  /**
   * 入队。
   *
   * **0 级条目最多一条**：已有 0 级时，新的**顶掉**旧的（保留最新）。
   * 非 0 级按正常入队。
   *
   * @param notice - 感知条目。
   * @param now - 入队时间（毫秒）。注入以便自检。
   */
  push(notice: PerceptionNotice, now: number = Date.now()): void {
    // ★ ① 同来源合并（用户定案）：命中已有条目就**整条换新、位置留旧的**。
    //
    //   "换新不丢内容"的理由：`pull()` 返回的是**当前状态**而不是增量日志
    //   （见 `qq/signals` 的 `collect()` 注释），所以新的一次拉取**本身就已经包含**
    //   旧条目里那些来源的未读状态。
    //
    //   "位置留旧" = 谁先来谁先被服务；一个话多的会话不能靠持续发言改变自己的位置。
    const merged = this.#items.findIndex(item => sharesSource(item.notice, notice))
    if (merged >= 0) {
      const previous = this.#items[merged]
      if (previous !== undefined) this.#items[merged] = { notice, queuedAt: previous.queuedAt }
      return
    }

    // ② 0 级条目最多一条：已有 0 级时，新的**顶掉**旧的（保留最新）。
    if (notice.quiet) {
      const index = this.#items.findIndex(item => item.notice.quiet)
      const item: PendingItem = { notice, queuedAt: now }
      if (index >= 0) this.#items[index] = item
      else this.#items.push(item)
      return
    }

    // ③ 其余按正常入队。
    this.#items.push({ notice, queuedAt: now })
    if (this.#items.length > this.#capacity) {
      // 丢最旧的**非 0 级**项；0 级只有一条且是"最新的"，不动它。
      const victim = this.#items.findIndex(item => !item.notice.quiet)
      if (victim >= 0) this.#items.splice(victim, 1)
      else this.#items.shift()
    }
  }

  /**
   * 看下一个该交付的项，**不取走**。
   *
   * 排序：优先级降序，同级按入队时间升序（FIFO）。
   *
   * @returns 队首项；队列为空时 `undefined`。
   */
  peek(): PendingItem | undefined {
    let best: PendingItem | undefined
    for (const item of this.#items) {
      if (best === undefined) { best = item; continue }
      if (item.notice.highest > best.notice.highest) { best = item; continue }
      if (item.notice.highest === best.notice.highest && item.queuedAt < best.queuedAt) best = item
    }
    return best
  }

  /**
   * 取走下一个该交付的项。
   * @returns 被取走的项；队列为空时 `undefined`。
   */
  drain(): PendingItem | undefined {
    const best = this.peek()
    if (best === undefined) return undefined
    const index = this.#items.indexOf(best)
    if (index >= 0) this.#items.splice(index, 1)
    return best
  }

  /** 当前排队数量。 */
  get size(): number {
    return this.#items.length
  }

  /** 清空。 */
  clear(): void {
    this.#items.length = 0
  }

  /** 是否全是 0 级（等价于"下一个该交付的也是 0 级"）。 */
  get allQuiet(): boolean {
    return this.#items.every(item => item.notice.highest === PRIORITY_PASSIVE)
  }
}
