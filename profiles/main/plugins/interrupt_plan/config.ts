/**
 * `interrupt_plan` 的配置面。
 *
 * 四个字段全部对应 `docs/m5-preemption.md` §20.5 的表 —— **部署可变的都进 `Config`**，
 * 插件里不留硬编码可调项。
 *
 * `T`（超时）在 §20.5 表里标的是**待定**，所以这里的默认值只是**起点值**，
 * 等实测调（§19.5 给 `preemptionTimeoutMs` 的起点也是 60 秒，同一条思路）。
 *
 * @module interrupt_plan/config
 */

import z from '@deepseek-ai/schemastery'

/** `ctx.interruptPlan` 的配置。 */
export interface Config {
  /**
   * **`T` —— 超时**（毫秒）：中断持续 **< T 丢弃待办**；**> T 待办文本进入上下文**。
   *
   * §20.4 的三个台阶里它是那一横。起点 2 分钟：短于它的中断（"开个空调"）
   * 上下文距离近，天然就处理了，不该留待办（情形③）。
   */
  timeoutMs: number
  /**
   * **`planTtlMs` —— 待办生命周期**（毫秒）。
   *
   * §20.4 定案一天。到期还没被处理的待办**丢掉**（`state = 'dropped'`）——
   * 那件事已经过去了，端上来只会让她对着一条死事发呆（§20.3 情形①）。
   */
  planTtlMs: number
  /**
   * 用哪个 TCB 起写待办的快照 subagent。
   *
   * §12.2 定案"**任务总结用小模型**单独产生一个 TCB 一个配置"，所以这是一个
   * **可切换的名字**，换小模型只改 `data/tcb.json`（或这里）。
   */
  plannerTcb: string
  /**
   * TTL 清扫周期（毫秒）。
   *
   * 过期本身**不影响正确性**：`list()` 只列 `settled_at IS NULL` 的行，而
   * `renderPlan` 之前会先 `expire()`。清扫只是让库里的 `state` 早点如实
   * —— 排障时直接看表不会被一堆死行干扰。
   */
  sweepIntervalMs: number
}

/** 配置 schema。 */
export const Config: z<Config> = z.object({
  timeoutMs: z.natural().min(1).default(120_000),
  planTtlMs: z.natural().min(1).default(24 * 60 * 60 * 1000),
  plannerTcb: z.string().min(1).default('planner'),
  sweepIntervalMs: z.natural().min(1000).default(10 * 60 * 1000),
})
