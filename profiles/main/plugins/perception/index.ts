/**
 * `perception` 能力 seam：把各领域的状态**统一渲染**成感知条目。
 *
 * ## 它是什么 / 不是什么
 *
 * **是**：一个**领域无关**的采集与渲染设施。领域 `register()` 一个信号源
 * （`pull()` + `templates`），感知层按闲时定时器拉、渲染、落库、发事件。
 *
 * **不是**：
 * - **不做"要不要叫醒她"的决定** —— 那是 `attention` 的事。这里只在条目上
 *   标出 `highest` 与 `quiet`，供它仲裁（docs/design.md §4.2/§4.3）。
 * - **不做抢占** —— fork / resume / 合并是 M5 的事。
 * - **不认识任何具体领域** —— 它只知道"有个领域注册了信号源"。
 *
 * ## 方向：领域暴露状态，感知层统一渲染
 *
 * 领域 `pull()` 返回的是**结构化信号**（`Signal[]`），**不是文本**；
 * 文本由 `templates` + `render.ts` 拼出来。这条边界是设计的核心
 * （docs/design.md §4.1）—— 它让"不写大量提示词"成为可能：
 * 简报只说"有人 @ 了你"，不说"你该回话"。
 *
 * ## `pull()` 必须是"当前状态"，不能是"增量日志"
 *
 * 这是 `priority: 0` 去重能成立的前提。定时器不重置，忙 1 小时会触发好几次；
 * 每次都拿到当前状态，所以重复触发不会累积出错误的历史（docs/design.md §4.6）。
 *
 * ## 导出形态
 *
 * 遵守 DSH 的 service 包约定：`export class ... extends Service` + `static Config`
 * + `export default`。**不具名导出**。
 *
 * @module perception
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Config as ConfigSchema, MAX_IDLE_INTERVAL_MS, MIN_IDLE_INTERVAL_MS, type Config } from './config.ts'
import { renderNotice, type DomainGroup } from './render.ts'
import type { PerceptionNotice, SignalSource } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * 感知层渲染好一条简报。
     *
     * **同步广播**：cordis 的 `emit` 用 `Array.map`，**一个监听器抛错会饿死后面的**
     * （`LlmRuntime` 源码里有这条注释）。所以监听器**必须自己包 try/catch**。
     *
     * @mode emit
     * @param notice - 渲染好的感知条目。
     */
    'perception/notice'(notice: PerceptionNotice): void
  }
}

/**
 * 感知设施，注册为 `ctx.perception`。
 */
export class Perception extends Service {
  static Config: z<Config> = ConfigSchema

  /** 依赖数据库设施：感知历史要落库（设计 §6.4）。 */
  static inject = ['db']

  private readonly config: Config

  /** 已注册的信号源，**保持注册顺序** —— 渲染时按这个顺序分节。 */
  private readonly sources: SignalSource[] = []

  /** 闲时间隔，AI 可通过工具调整。 */
  private currentIntervalMs: number

  /**
   * @param ctx - 本插件的上下文。
   * @param config - 配置。
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'perception')
    this.config = config
    this.currentIntervalMs = config.idleIntervalMs
  }

  /**
   * 注册一个领域的信号源。
   *
   * 注册即 effect：返回的注销函数随 owning fiber 卸载，或由调用方显式调用。
   * 同一个领域重复注册是**允许**的（各自独立注销）。
   *
   * @param source - 领域信号源。
   * @returns 注销函数。
   */
  register(source: SignalSource): () => void {
    this.sources.push(source)
    return () => {
      const index = this.sources.indexOf(source)
      if (index >= 0) this.sources.splice(index, 1)
    }
  }

  /** 当前已注册的领域名（按注册顺序）。 */
  domains(): string[] {
    return this.sources.map(source => source.domain)
  }

  /** 当前闲时间隔（毫秒）。 */
  get idleIntervalMs(): number {
    return this.currentIntervalMs
  }

  /**
   * 调整闲时间隔（给 AI 用的工具调）。
   *
   * 超出 `MIN..MAX` 时**夹住而不是报错** —— 她调一个 3 分钟或 48 小时，
   * 意图是清楚的（更勤/更懒），没必要时失败。
   *
   * @param ms - 期望的间隔（毫秒）。
   * @returns 实际生效的间隔。
   */
  setIdleIntervalMs(ms: number): number {
    if (!Number.isFinite(ms)) return this.currentIntervalMs
    this.currentIntervalMs = Math.min(MAX_IDLE_INTERVAL_MS, Math.max(MIN_IDLE_INTERVAL_MS, Math.trunc(ms)))
    return this.currentIntervalMs
  }

  /**
   * 拉一轮：**并行**拉所有领域，渲染成条目。
   *
   * 单个领域 `pull()` 抛错时**跳过该领域并记日志** —— 一个领域坏了
   * 不该让整轮感知失效（比如手表没连上，不该连带 QQ 也不报）。
   *
   * @param at - 本轮时间戳（毫秒）。省略用当前时间。
   * @returns 渲染好的感知条目；没有任何信号时 `text` 为空串。
   */
  async collect(at: number = Date.now()): Promise<PerceptionNotice> {
    const groups = await Promise.all(this.sources.map(async (source): Promise<DomainGroup> => {
      try {
        return { source, signals: await source.pull() }
      } catch (error) {
        // 可选服务式降级：一个领域的采集失败不影响其它领域。
        this.ctx.logger.warn(
          `perception: 领域 "${source.domain}" 拉取失败，本轮跳过：%o`,
          error instanceof Error ? error.message : String(error),
        )
        return { source, signals: [] }
      }
    }))
    return renderNotice(at, groups)
  }

  /**
   * 跑一轮完整流程：拉 → 渲染 → 落库 → 发事件。
   *
   * `Service.init` 里的定时器调它；领域也可以主动调它（那就是"唤醒信号"的语义）。
   *
   * @returns 本轮渲染出的条目。
   */
  async tick(): Promise<PerceptionNotice> {
    const notice = await this.collect()
    if (notice.signals.length === 0) return notice

    if (this.config.persist) {
      for (const signal of notice.signals) {
        this.ctx.db.perception.record({
          time: signal.at ?? notice.at,
          domain: signal.domain,
          source: signal.source,
          summary: signal.line,
        })
      }
    }

    this.ctx.emit('perception/notice', notice)
    return notice
  }

  /**
   * 构造完成之后运行：起闲时定时器，`yield` 出来的函数负责清掉它。
   *
   * **定时器不重置** —— 她在忙时照常走（docs/design.md §4.6）。
   * 注意这里**不判断 agent 闲不闲**：那是 `attention` 的状态，
   * 由它决定收到条目后叫不叫醒她。感知层只按点报事实。
   */
  async *[Service.init](): AsyncGenerator<() => void, void, void> {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined

    // 每轮结束后按**当时的**间隔排下一轮（而不是 `setInterval` 的固定周期）——
    // 这样 AI 通过工具改了间隔能立刻生效，不必重启插件。
    const loop = (): void => {
      if (stopped) return
      timer = setTimeout(() => {
        void this.tick()
          .catch(() => { /* tick 内部已对单个领域的失败记过日志 */ })
          .finally(() => { loop() })
      }, this.currentIntervalMs)
    }
    loop()

    yield () => {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }
}

export default Perception
