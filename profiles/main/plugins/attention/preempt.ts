/**
 * 抢占决策：**什么时候打断她正在做的事，以及要不要让她先收个尾**。
 *
 * ## 为什么单独一层
 *
 * 纯逻辑、不认识 cordis —— 可离线自检（`tests/preempt.spec.ts`）。
 * fork / resume / 合并那些机制在 `index.ts`。
 *
 * ## 三条轴，各自一个职责（docs/design.md §4.2/§4.3）
 *
 * | 阈值 | 职责 |
 * |:--|:--|
 * | **0** | 唤不唤醒（0 级不产生自己的唤醒，只搭便车） |
 * | **80** | **收不收尾** |
 * | 任意优先级差 | **抢不抢占** |
 *
 * 注意 80 **不是**"能不能抢占"那条线 —— 任意优先级差都能抢占。它管的是
 * **抢占时要不要给被中断的任务留收尾机会**：
 *
 * - `< 80`：先给她一句提示，**她可以选择**做点收尾再走（QQ 里说一声先走、写代码先存盘）
 * - `≥ 80`：**立即执行**，不给收尾机会（系统出问题了、用户遇到紧急情况、手表显示身体出问题）
 *
 * ## 收尾提示为什么是"可以"而不是"必须"
 *
 * 用户原话：
 *
 * > 这不是铁律，我的意思只是**不要滥用**。这个利用好了是个好的设计，
 * > 会引导模型做出更好的选择而不是每次都判断，**影响期望行为正确率**。
 *
 * 所以措辞是「**你可以选择**」—— 她有权判断这次没必要收尾，直接走。
 *
 * ## 收尾发生在 fork 之前
 *
 * ```
 * 原任务上下文 ──[插入收尾提示]──▶ 模型做收尾 ────▶ fork ──▶ 中断任务
 *                                                          （看不到收尾过程）
 * ```
 *
 * 三个好处：收尾动作留在原任务的上下文里（它本来就属于那个任务）；
 * 中断任务拿到的是已经收好尾的干净状态；恢复原任务时上下文自洽，
 * 不会出现"说到一半被切断"。
 *
 * @module attention/preempt
 */

import { PRIORITY_PASSIVE, PRIORITY_URGENT } from '../perception/types.ts'

/**
 * 收尾提示的原文。
 *
 * **用户定的措辞，不要改** —— 它同时承担三件事：
 * 1. 「判断当前任务中断情况」把判断权交回给她（不是无脑收尾）
 * 2. 「你可以选择」明确这不是命令
 * 3. 「比如道别/保存……」给两个具体例子，把抽象规则落到动作上
 */
export const WRAPUP_HINT = '判断当前任务中断情况，有必要时，你可以选择先做简单/重要收尾行为再走（比如道别/保存……）'

/** agent 的忙闲。 */
export type AgentStatus = 'running' | 'idle'

/** 抢占决策的结果。 */
export type PreemptPlan =
  /** 她闲着 —— 直接把条目交给她，没有抢占可言。 */
  | { readonly kind: 'deliver' }
  /**
   * 她忙着，而条目是 **0 级** —— **排队等她空下来，不抢占**。
   *
   * 0 级的语义是「不产生自己的唤醒」；抢占也是唤醒的一种，所以它同样不产生。
   * 队列那边保证 0 级最多留一条（保留最新），所以等下去不会积压。
   */
  | { readonly kind: 'queue' }
  /**
   * 她忙着，且中断**不紧急** —— 先把条目连同收尾提示交给她。
   *
   * 她会在**原任务的上下文里**看到它，可以选择做点收尾。
   * fork 发生在她这一轮结束之后。
   */
  | { readonly kind: 'wrapup-then-preempt' }
  /** 她忙着，且中断**紧急** —— 立即接管，不给收尾机会。 */
  | { readonly kind: 'preempt-now' }

/**
 * 决定怎么处理一条条目。
 *
 * @param status - 目标 agent 当前忙闲。
 * @param highest - 条目的最高优先级。
 * @returns 该怎么做。
 */
export function planPreemption(status: AgentStatus, highest: number): PreemptPlan {
  if (status === 'idle') return { kind: 'deliver' }
  // 忙的时候，0 级不抢占 —— 它只搭便车，等下一次空闲。
  if (highest <= PRIORITY_PASSIVE) return { kind: 'queue' }
  return highest >= PRIORITY_URGENT ? { kind: 'preempt-now' } : { kind: 'wrapup-then-preempt' }
}

/**
 * 把收尾提示拼到条目正文**末尾**。
 *
 * **放末尾**是因为它是"对当前中断的最后一句交代"，紧邻模型要做的决定；
 * 放中间会被前面的信号内容淹没。
 *
 * @param text - 渲染好的条目正文。
 * @returns 拼上收尾提示的正文。
 */
export function withWrapupHint(text: string): string {
  return `${text.trimEnd()}\n\n${WRAPUP_HINT}`
}
