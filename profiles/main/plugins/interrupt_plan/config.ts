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

import type { ShutdownRecord } from './render.ts'

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
  /**
   * **优雅关闭记录**的存档路径。
   *
   * 跟 `pointer` / `tcb` 同一层、同一个判据（"**要不要给人改**"）：放 `data/`
   * 的一个文件，不进数据库 —— 它小、显式、排障时要直接看。
   *
   * 内容是"上次进程停止时她停在哪个坐标"（{@link ShutdownRecord}）：
   * **临死前写、启动时注入一次、然后删掉**。
   */
  statePath: string
  /**
   * 是否启用**优雅关闭记账**（"上次是停下来的"）。
   *
   * ⚠️ **当前部署把它关掉了**（`cordis.patch.yml` 里 `shutdown: false`）。
   *
   * 为什么关：它的触发判据是**启发式的** —— 分不出"进程真的停了"和
   * "**HMR 重载了本插件**"（见 `recordShutdown`）。开发期改文件频繁，
   * 误报会往她的上下文里塞一条假的"上次停下来了"，**干扰实验**。
   * 要根治得有一个真正的"应用正在关闭"信号，而 DSH 把 SIGINT/SIGTERM
   * 收敛成同一个 `interrupt(code)`（`apps/cli/src/profile-boot.ts:280-281`），
   * 插件侧看不出区别 —— **那是上游面的事**（TODO）。
   *
   * **没有默认值**：它是个已知不可靠的功能，宁可让部署显式表态，
   * 也不要"悄悄开着"（DSH：配置要显式，不静默用一个不可靠的值）。
   */
  shutdown: boolean
}

/** 配置 schema。 */
export const Config: z<Config> = z.object({
  timeoutMs: z.natural().min(1).default(120_000),
  planTtlMs: z.natural().min(1).default(24 * 60 * 60 * 1000),
  plannerTcb: z.string().min(1).default('planner'),
  sweepIntervalMs: z.natural().min(1000).default(10 * 60 * 1000),
  statePath: z.string(),
  shutdown: z.boolean(),
})
