/**
 * 注意力转移决策：**要不要把她的注意力从手上的事挪开，以及怎么挪**。
 *
 * ## 这一层为什么叫"注意力转移"而不是"抢占"
 *
 * 旧模型照搬 RTOS：中断 = 抢占（四档计划、fork、逐层结清、中断交代）。
 * **它已被取代**（docs/m5-preemption.md §20）。根因一句话：
 *
 * > RTOS 的中断处理程序**必须短**（否则丢中断），所以"存上下文 / 恢复上下文"
 * > 值这个钱。**而人的高优先级事务恰恰是长的** —— 写代码、处理急性病症 ——
 * > **它们几乎不会被打断。**
 *
 * 于是旧模型把一个**罕见的**情形当成主路径，为它建了栈、fork、合并、平移、
 * 守恒校验。
 *
 * ## ★ 支点：**优先级 = 注意力大小**
 *
 * `decisions §14` 的三条轴**不用重做**，只要换个读法：
 *
 * | 轴 | 旧读法（RTOS） | ★ 新读法（注意力） |
 * |:--|:--|:--|
 * | `0` | 唤不唤醒 | **不产生自己的唤醒** —— 低注意力，搭便车（**原样成立**） |
 * | `m` | 收不收尾 | **要不要立刻放下手上的事** |
 * | 任意差 | 抢不抢占 | **注意力会不会被牵走** |
 *
 * ## 四档
 *
 * | 情形 | 用什么 | 效果 |
 * |:--|:--|:--|
 * | 她闲着 | `followup` | 开一个新 turn |
 * | 她忙着，条目是 **0 级** | 排队 | 0 级不产生自己的唤醒，搭便车 |
 * | 她忙着，且 `< m` | **`steer`** | 插进当前 turn 的下一个 step（**软**） |
 * | 她忙着，且 `≥ m` | **`cancel`** | 硬切，**不给收尾机会** |
 *
 * **`steer` 是软的 —— 这是刻意的**：它只是把消息交到她手上，
 * 她可以继续干、也可以答一句就回来。这正是要的行为（§20.3 情形②③）。
 *
 * **`≥ m` 不一样**：那是"系统出问题了"那一类，**必须**打断，
 * 所以她自己也可能是被硬切掉的那一方 —— 走 `cancel`，不经软路径。
 *
 * ## 待办：`> n` 的原任务被中断才记
 *
 * 用户定案：**0–n 的（低注意力）任务被中断不记待办**，`> n` 的才记
 * ——"20 级的任务基本都是要记一下的场合，但 0 级在群聊被打断，记下来毫无意义"。
 *
 * 判据是"**当时的原任务优先级**"，也就是**激活当前 turn 的那个信号的优先级**
 * （`decisions §14` A1：**turn 继承激活它的信号的优先级**）。
 *
 * @module attention/preempt
 */

import { PRIORITY_URGENT } from '../perception/types.ts'

/**
 * 收尾提示的原文。
 *
 * **用户定的措辞，不要改。**
 *
 * ⚠️ 它刚从 fork 模型搬到注意力模型，改过两处：
 *
 * 1. **删掉结尾的「结束该 turn」** —— 那句是**为 fork 模型写的**（父层结束 turn
 *    才会 fork 出新层）。无 fork 之后，那句正好是最怕她做的事：她一停，
 *    手上那件事就只剩待办兜底了。
 * 2. **加上「（你可以选择不管他）」** —— 把"不管"这个分支**明说出来**。
 *    `steer` 是软的，她本来就有权继续干手上的事；旧版没这句，
 *    实际上是在暗示她"必须让位"。
 *
 * 它承担四件事：
 * 1. 「判断该信号是否有必要打断你」把判断权交回给她，并**把判断对象钉死**
 *    —— 判断的是"值不值得让位"，不是"要不要应答它"（否则她会顺手把中断做了）
 * 2. 「（你可以选择不管他）」明确"不管"是允许的
 * 3. 「你可以选择先做…收尾行为」明确这不是命令，并举两个例子落到动作上
 * 4. 「处理完**可以**接着做原来的事」—— **许可式，不是命令式**。
 *    机制上**没有任何东西强制她回来**（待办只是兜底），所以这里是邀请而非要求。
 */
export const WRAPUP_HINT = '判断该信号是否有必要打断你（你可以选择不管他）：有必要时，你可以选择先做一次简单/重要的收尾行为（比如道别/保存……），再去处理新信号；处理完可以接着做原来的事。'

/** 硬取消时给她的说明。`≥ m` 走这条路，她的 turn 会被中止。 */
export const URGENT_HINT = '这是紧急中断：请立刻处理，不必收尾，也不必回顾之前的任务。'

/** agent 的忙闲。 */
export type AgentStatus = 'running' | 'idle'

/** 注意力转移的决策结果。 */
export type TransferPlan =
  /** 她闲着 —— 直接把条目交给她，开一个新 turn，没有"转移"可言。 */
  | { readonly kind: 'deliver' }
  /**
   * 她忙着，而条目是 **0 级** —— **排队等她空下来**。
   *
   * 0 级的语义是「不产生自己的唤醒」；**转移注意力也是唤醒的一种**，
   * 所以它同样不产生。队列那边保证 0 级最多留一条（保留最新），不会积压。
   */
  | { readonly kind: 'queue' }
  /** 她忙着，中断**不紧急** —— 软转移：插进当前 turn 的下一个 step。 */
  | { readonly kind: 'steer', readonly record: boolean }
  /** 她忙着，中断**紧急** —— 硬切她的 turn，不给收尾机会。 */
  | { readonly kind: 'cancel', readonly record: boolean }

/** 两个可配置阈值。 */
export interface TransferThresholds {
  /** `n`：原任务优先级 **> n** 才记待办。 */
  readonly pendingThreshold: number
  /** `m`：打断信号的优先级 **≥ m** 走硬 `cancel`。 */
  readonly urgentThreshold: number
}

/** 默认阈值。`n = 0` 对上"0 级任务不记待办"；`m = 80` 是既有的"紧急"线。 */
export const DEFAULT_THRESHOLDS: TransferThresholds = {
  pendingThreshold: 0,
  urgentThreshold: PRIORITY_URGENT,
}

/**
 * 决定怎么处理一条条目。
 *
 * @param status - 目标 agent 当前忙闲。
 * @param currentPriority - **激活当前 turn 的信号的优先级**；她闲着时无意义。
 * @param highest - 本条目的最高优先级。
 * @param thresholds - 两个可配置阈值。默认见 {@link DEFAULT_THRESHOLDS}。
 * @returns 该怎么做，以及要不要给她记一条待办。
 */
export function planTransfer(
  status: AgentStatus,
  currentPriority: number,
  highest: number,
  thresholds: TransferThresholds = DEFAULT_THRESHOLDS,
): TransferPlan {
  if (status === 'idle') return { kind: 'deliver' }
  // ★ **不高于原任务的一律只排队**：0 级、同级、更低。
  //
  //   `highest <= PRIORITY_PASSIVE`（0 级）曾经是这里唯一的一条，那是不够的：
  //   同优先级与更低优先级会一路走到下面去 `steer`，等于**谁的信号都能插进她正在做的事**。
  //   而设计是"**不同**优先级之间才是高的立即接管"（`design.pre-m5.md:170-171`）：
  //
  //     | 同优先级（如都是 30）     | **排队**（FIFO，轮流）      |
  //     | 不同优先级（如 30 与 31） | **不排队** —— 高的立即接管 |
  //
  //   0 级"只搭便车"仍成立 —— 它是本式在 `currentPriority >= 0` 下的特例。
  //   （`status === 'idle'` 时 `currentPriority` 无意义，已在上一行返回。）
  //
  //   历史：自检里曾经用 `planTransfer('running', 20, 20) → steer` 钉住过相反的行为，
  //   但那条的标签借的是 `m5-preemption.md:1031` 的「情形②：20 级被**更高级**打断」
  //   —— 情形对不上（这里是**相等**），所以它钉错了。
  if (highest <= currentPriority) return { kind: 'queue' }

  // 原任务是低注意力的（<= n）就不记待办：记下来也没有意义
  // —— 群里那段早聊过去了（§20.3 情形①）。
  const record = currentPriority > thresholds.pendingThreshold

  return highest >= thresholds.urgentThreshold
    ? { kind: 'cancel', record }
    : { kind: 'steer', record }
}

/**
 * 把提示拼到条目正文**末尾**。
 *
 * **放末尾**是因为它是"对当前中断的最后一句交代"，紧邻模型要做的决定；
 * 放中间会被前面的信号内容淹没。
 *
 * @param text - 渲染好的条目正文。
 * @param hint - 要拼上去的提示（`WRAPUP_HINT` 或 `URGENT_HINT`）。
 * @returns 拼上提示的正文。
 */
export function withHint(text: string, hint: string): string {
  return `${text.trimEnd()}\n\n${hint}`
}
