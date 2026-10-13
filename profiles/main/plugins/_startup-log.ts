/**
 * 启动自述的收集与补打。
 *
 * ## 为什么需要它
 *
 * 设施的 `Service.init` 跑在**挂载早期**，那一刻 DSH 里**没有任何终端出口**。
 * 实测（`db` 的 `Service.init` 执行时 `ctx.logger.exporters` 只有 2 个）：
 *
 * | 出口 | 它做什么 | 为什么看不见 |
 * |:--|:--|:--|
 * | `#1` cordis 内置 buffer | `self.buffer.push(message)` | **从不打印**；不完整（吞 warn/debug、只留最近 1000 条、不可配） |
 * | `#2` DSH 的 `startupLogs` | 只收 `warn`/`error` | 只在**启动失败**时挂到异常上（`app-boot/src/index.ts:1021`） |
 *
 * **一个都不通终端。** 而且这是 DSH 的设计取向 —— 它为启动期专门做的收集器
 * **只认 warn/error**，说明它**没打算让"启动成功的自述"出现在终端上**。
 *
 * 所以本模块不跟它对抗，而是**顺着它**：
 *
 * ```
 * Service.init 期   →  recordStartupLine(...)   只登记，不打印
 * 挂载完成之后       →  flushStartupLines(...)   由那时已就绪的出口打出去
 * ```
 *
 * ## 谁负责 flush
 *
 * **补丁层的最后一行**（`qq-resident`）—— 它建完常驻 agent 就是"系统起来了"的时刻，
 * 那时日志出口已经就绪（实测：`qq-tools` / `qq-resident` 的日志都能出来）。
 *
 * **这是个约定，不是自动的。** 换掉最后一行时要跟着改（那里有注释指明）。
 *
 * ## 为什么不各设施自己 `setTimeout`
 *
 * 那样要靠"延后多久才够"的猜测，而挂载顺序是 DSH 的实现细节。
 * 由"最后一个已知行"显式 flush，失败模式是**看得见的**（日志整批不出现），
 * 而不是时好时坏。
 *
 * @module _startup-log
 */

/** 待补打的自述。 */
const pending: string[] = []

/** 是否已经补打过。 */
let flushed = false

/**
 * 登记一行启动自述。**此时不打印**（那一刻没有终端出口）。
 *
 * 若已经在补打之后调用（例如 HMR 重载某个设施），**立即交给 logger**。
 *
 * @param text - 要登记的自述。
 */
export function recordStartupLine(text: string): void {
  if (flushed) {
    // 补打之后才登记的（重载场景）：直接交给 logger，它有出口。
    startupLogger?.info(text)
    return
  }
  pending.push(text)
}

/**
 * 补打全部登记过的自述。
 *
 * @param logger - 补打时用的 logger（调用方从自己的 `ctx` 上取）。
 * @returns 补打的条数。
 */
export function flushStartupLines(logger: { info: (message: string) => void }): number {
  flushed = true
  startupLogger = logger
  const lines = pending.splice(0)
  for (const line of lines) logger.info(line)
  return lines.length
}

/** 补打之后登记的走它（重载场景）。 */
let startupLogger: { info: (message: string) => void } | undefined
