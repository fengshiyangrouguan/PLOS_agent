/**
 * 跨插件的共享小工具：**一个会话的"尾巴"在哪**。
 *
 * ## 它为什么是普通模块，不是服务
 *
 * 跟 `_startup-log.ts` 同一个形状（那个有 4 个消费者）。这里的判据是
 * DSH 的"**只有一个内部调用方的公开服务方法**是反向信号"—— 但反过来也成立：
 * 一个**纯函数**、无状态、无生命周期、无拓扑，就没有理由做成 service
 * （做成 service 要多一行补丁、还要处理激活顺序）。
 *
 * ## ★ 为什么坐标和 seed 必须**一起**返回
 *
 * 这是本模块存在的**唯一理由**，也是它不能拆成两个函数的原因。
 *
 * 中断那一刻必须取定两样东西：**坐标**（给待办、给检索工具）和 **seed**
 * （给快照 subagent）。它们来自**同一份 log**，而"同一份"这件事是**时序敏感**的：
 * `steer()` 之后主会话会继续写，晚一步取到的就是"被打断【之后】"的状态
 * —— **整个机制的意义反过来**，而且不报错。
 *
 * 早先的写法把这两件事分在两个函数里，靠"`createChild` 的第一个 `await`
 * 恰好排在那之后"维持正确。**那是隐式的**：任何人插一个 `await`，边界就静默后移。
 *
 * 现在 `markOf()` 一口气全取（内部一次 `snapshotEvents()`），调用方**无法**把它拆开。
 *
 * ⚠️ **调用方必须同步调它**（不要在 `await` 之后）。这是它唯一的契约。
 *
 * @module _session-mark
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionSeq, buildForkSeed, type SessionEvent } from '@deepseek-ai/dsh-session'

/** 一个会话在某一刻的坐标 + fork seed。 */
export interface SessionMark {
  /** 焦点所在的会话。 */
  readonly sessionId: string
  /**
   * **最后一个 `turn/end` 的编号** —— 也就是"她没写完的那一轮"。
   *
   * 取 `turn/end` 而不是把 turn 记成事件序号，因为一轮可以有几十个事件，
   * 而"人说的'轮'就是 turn"（§20.10）。
   *
   * 一个 `turn/end` 都没有时（会话刚起来）落到 `0`：坐标里 `seq` 仍然是对的，
   * **错的那个不致命**。
   */
  readonly turn: number
  /** 最后一个事件的序号。**给工具用**（DSH 原生的 `session_event_read` 收 `seq`）。 */
  readonly seq: number
  /** 中断那一刻的事件前缀 + 合成收尾（`end-seed` 与开着的 turn 的 forked 收尾）。 */
  readonly seed: readonly SessionEvent[]
  /** `seed` 覆盖到的最后一个事件序号。 */
  readonly boundary: number
}

/**
 * **同步**取一个 agent 当前会话的"尾巴"。
 *
 * @param agent - 要取的 agent。
 * @returns 坐标 + seed + boundary。
 */
export function markOf(agent: Agent): SessionMark {
  const events = agent.session.snapshotEvents()
  const last = events.at(-1)
  const boundary = last?.seq ?? SessionSeq(0)

  let turn = 0
  for (const event of events) {
    if (event.type === 'turn/end') turn = event.data.turn
  }

  return {
    sessionId: String(agent.session.id),
    turn,
    seq: last === undefined ? 0 : Number(last.seq),
    seed: buildForkSeed(events, boundary),
    boundary: Number(boundary),
  }
}
