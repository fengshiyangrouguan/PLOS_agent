/**
 * `attention` 的配置面。
 *
 * @module attention/config
 */

import z from '@deepseek-ai/schemastery'
import { DEFAULT_THRESHOLDS } from './preempt.ts'

/** `ctx.attention` 的配置。 */
export interface Config {
  /**
   * 目标会话 id。**留空时自动**：先读注意力焦点（`ctx.pointer`），
   * 再退到"恰好一个在册 agent"。
   *
   * 留空是常态。旧模型里会话 id 会随结清一直变，所以配置值会失效；
   * **注意力模型没有结清，会话 id 是稳定的** —— 但这个 seam 仍然先读焦点，
   * 因为写待办的快照 subagent 也是一个在册 agent，`list()` 不是单义的。
   */
  sessionId: string
  /** 待交付队列容量。正常工况下每轮都会被取走，长起来说明投放链路堵了。 */
  queueCapacity: number
  /**
   * `n` —— **待办阈值**：原任务优先级 **> n** 才记待办。
   *
   * 默认 `0` 对上用户定案："0 级任务（群聊）被中断**不需要**待办，
   * `> 0` 的才记录"—— 群里那段早聊过去了，记下来毫无意义
   * （docs/m5-preemption.md §20.3 情形①）。
   */
  pendingThreshold: number
  /**
   * `m` —— **硬取消阈值**：打断信号的优先级 **≥ m** 时走硬 `cancel`，
   * 不给收尾机会（系统出问题、用户遇到很紧急的情况）。
   *
   * 默认 `80`，沿用既有的"紧急"线（`PRIORITY_URGENT`）。
   */
  urgentThreshold: number
}

/** 配置 schema。 */
export const Config: z<Config> = z.object({
  sessionId: z.string().default(''),
  queueCapacity: z.natural().min(1).default(32),
  pendingThreshold: z.natural().default(DEFAULT_THRESHOLDS.pendingThreshold),
  urgentThreshold: z.natural().default(DEFAULT_THRESHOLDS.urgentThreshold),
})
