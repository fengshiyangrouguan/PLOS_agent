/**
 * `perception` 的**模型可见消费者**：让她自己调"多久主动醒一次"。
 *
 * ## 为什么是独立插件，而不是塞进 `perception/index.ts`
 *
 * 能力 seam 的三段式：Service Definition + Provider 是 `perception/` 自己，
 * **Consumer（模型化）是这一层** —— 跟 `tool-session-query` 那一行同一个道理
 * （那边补丁注释写的是"服务侧本来就在装配里，缺的只是这个**模型可见的消费者**"）。
 *
 * 塞进 `perception/index.ts` 的代价是具体的：那个设施就得**注入 `tools`**、
 * 认识"工具"这个概念，而别的领域（新闻 / 手表）只是想注册一个信号源。
 *
 * ## 它调的是什么（引擎侧早就写好了）
 *
 * `ctx.perception.setIdleIntervalMs(ms)`。当年就是为这个工具准备的，两处证据：
 *
 * > `perception/index.ts`：「调整闲时间隔（**给 AI 用的工具调**）」
 * > `perception/index.ts`：循环**刻意不用 `setInterval`**，而是"每轮结束后按
 * >   **当时的**间隔排下一轮……这样 **AI 通过工具改了间隔能立刻生效，不必重启插件**"
 *
 * ## 不持久化（用户定案）
 *
 * 值只在内存里，**重启回到 `config.idleIntervalMs`**。跟 `currentPriority` 同一条思路：
 * 运行时旋钮，不为它加状态。**所以工具描述里必须讲清**，否则她会以为自己设过的值一直在。
 *
 * ## 命名：从**她的**视角起，不用实现词汇
 *
 * 不叫 `perception_*` —— "感知层"是我们这边的实现词汇，模型眼里只有
 * "没人理我的时候，我多久自己四处看一次"。所以是 `set_idle_wake_interval`。
 *
 * @module perception/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { recordStartupLine } from '../_startup-log.ts'

/** 插件名。 */
export const name = 'perception-tools'

/** 要工具运行时（注册工具）与感知服务（真正干活的那个）。 */
export const inject = ['tools', 'perception']

/** 毫秒 → 分钟。**对外只用分钟** —— 模型读"每 30 分钟看一次"比读 1800000 好。 */
const MINUTE_MS = 60_000

/**
 * 装好工具。
 * @param ctx - 插件上下文。
 */
export function apply(ctx: Context): void {
  /**
   * 当前上下限（分钟）。
   *
   * **每次调用现取**，不缓存在闭包里 —— 上下限来自 `Config`，而补丁层可以被
   * 热改；缓存了就会在她改完配置之后继续报旧范围。
   *
   * @returns 下限与上限（分钟，已取整）。
   */
  const rangeMinutes = (): { min: number, max: number } => ({
    min: Math.round(ctx.perception.minIntervalMs / MINUTE_MS),
    max: Math.round(ctx.perception.maxIntervalMs / MINUTE_MS),
  })

  ctx.tools.register(defineTool({
    name: 'set_idle_wake_interval',
    description: [
      'Set how often you wake up on your own to look around while nobody is talking to you.',
      'This is your own idle rhythm: it does NOT reset when messages arrive —'
      + ' you look once every N minutes regardless, so a busy hour means several looks.',
      'Omit `minutes` to only read the current interval without changing it.',
      'A value outside the accepted range is clamped to the nearest bound instead of being rejected.',
      'The change takes effect immediately, but it is NOT persisted:'
      + ' a restart returns to the deployment default.',
    ].join(' '),
    parameters: {
      minutes: {
        type: 'integer',
        description: 'Minutes between idle wake-ups. Omit to read the current value without changing it.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          intervalMinutes: { type: 'integer', required: true },
          applied: { type: 'boolean', required: true },
          clamped: { type: 'boolean', required: true },
          minMinutes: { type: 'integer', required: true },
          maxMinutes: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.applied
          ? `Idle wake interval is now ${String(value.intervalMinutes)} minutes`
            + (value.clamped
              ? ` — your value was clamped to the accepted ${String(value.minMinutes)}–${String(value.maxMinutes)} minutes range.`
              : '.')
            + ' This is not persisted: a restart returns to the deployment default.'
          : `Idle wake interval is ${String(value.intervalMinutes)} minutes`
            + ` (accepted range ${String(value.minMinutes)}–${String(value.maxMinutes)} minutes).`,
      }],
    },
    execute(args) {
      const { min, max } = rangeMinutes()
      const requested = args.minutes
      if (requested === undefined) {
        return Promise.resolve({
          intervalMinutes: Math.round(ctx.perception.idleIntervalMs / MINUTE_MS),
          applied: false,
          clamped: false,
          minMinutes: min,
          maxMinutes: max,
        })
      }
      const intervalMinutes = Math.round(ctx.perception.setIdleIntervalMs(requested * MINUTE_MS) / MINUTE_MS)
      return Promise.resolve({
        intervalMinutes,
        applied: true,
        // 「夹过没有」按**生效值**和请求值比 —— 所以它反映的是事实，不是我们猜的意图。
        clamped: intervalMinutes !== requested,
        minMinutes: min,
        maxMinutes: max,
      })
    },
  }))

  // 启动自述：这个口以前是"引擎写好了但没人接"，所以值得点出来它现在接上了、
  // 以及范围是多少（范围来自 Config，配错了在这一行就能看出来）。
  const { min, max } = rangeMinutes()
  recordStartupLine(
    `perception-tools: 已注册 1 个工具 set_idle_wake_interval`
    + `（${String(min)}~${String(max)} 分钟，不持久化）—— 她可以自己调多久醒一次`,
  )
}
