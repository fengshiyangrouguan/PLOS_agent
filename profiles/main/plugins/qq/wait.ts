/**
 * "等某个会话的下一条消息" —— **纯 qq 内部逻辑**（用户定案）。
 *
 * ## 它是什么
 *
 * Tulpa 那条「尾部静默」的**模型主动版**：她可以调工具**专门等**某个会话多久，
 * 用来**把话头留着** —— 「对方可能还有话要说所以先不结束／对方还没说完所以先不接话」。
 *
 * 与固定计时器的区别在**谁决定等多久**：Tulpa 那个是服务端拍 N 秒，
 * 这个是**模型按情境自己拍**。所以它不是"又多了一层时间轴"，而是一个新能力
 * （`PLOS/docs/decisions.md` 的「T7 改判」那一段）。
 *
 * ## 短路（这是它的关键机制）
 *
 * 等待期间该会话的**唤醒被短路**：消息不再产生唤醒信号（判在 `qq/signals` 里），
 * 而是**直接回传给等待者**。
 *
 * - **回传即已读** —— 由等待者负责 `drain()`（不是 `peek()`）
 * - **别的会话照常唤醒** —— 她只是把 A 的话头留着，不是把自己锁死
 *
 * ## 为什么是模块级单例，不是 cordis 服务
 *
 * 两个消费者（`qq/signals` 的短路、工具的注册等待）**都在 qq 域内、同一个进程**，
 * 而它没有第二个领域会用它的可能。**若将来出现第三个消费者，再提成服务。**
 *
 * HMR 重载会重置这张表 —— 但在等的那个 promise 挂着的是 `setTimeout`（不随模块走），
 * 所以最坏情况是**超时返回**，不会永远挂住。
 *
 * @module qq/wait
 */

/** 一次等待的句柄。 */
interface Waiter {
  /** 有消息来了就调它。 */
  readonly onMessage: () => void
}

/** 会话 id → 正在等它的那个等待者。同一会话同时只允许一个。 */
const waiting = new Map<string, Waiter>()

/**
 * 有人在等这个会话吗？
 * @param conversation - 会话 id（`group:<id>` / `private:<id>`）。
 * @returns 若有等待者返回 `true` —— 调用方据此**短路唤醒**。
 */
export function isWaiting(conversation: string): boolean {
  return waiting.has(conversation)
}

/**
 * 一条消息到达这个会话。
 *
 * **有等待者就唤醒它并返回 `true`** —— 调用方据此**不产生唤醒信号**（短路）。
 * 消息本身不由这里取走：等待者醒来后自己 `drain()`，那一步才是"已读"。
 *
 * @param conversation - 会话 id。
 * @returns 是否交给了等待者。
 */
export function offer(conversation: string): boolean {
  const waiter = waiting.get(conversation)
  if (waiter === undefined) return false
  // 先摘掉再回调：醒来后若立刻再等一次，不该被这次的回调重入。
  waiting.delete(conversation)
  waiter.onMessage()
  return true
}

/**
 * 等这个会话的下一条消息。
 *
 * @param conversation - 会话 id。
 * @param timeoutMs - 最多等多久（调用方负责夹到上限内）。
 * @returns `true` = 有消息来了；`false` = 超时，没人说话。
 */
export function beginWait(conversation: string, timeoutMs: number): Promise<boolean> {
  // 同一会话前一个等待者先收掉 —— 否则它会永远挂着（`offer` 只唤醒第一个）。
  waiting.delete(conversation)
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      waiting.delete(conversation)
      resolve(false)
    }, timeoutMs)
    waiting.set(conversation, {
      onMessage: () => {
        clearTimeout(timer)
        resolve(true)
      },
    })
  })
}

/** 当前有几个会话在被等（诊断用）。 */
export function waitingCount(): number {
  return waiting.size
}
