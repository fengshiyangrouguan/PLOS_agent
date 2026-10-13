/**
 * 感知层的配置面。
 *
 * @module perception/config
 */

import z from '@deepseek-ai/schemastery'

/** 默认闲时间隔：30 分钟（docs/design.md §4.6 定案）。 */
export const DEFAULT_IDLE_INTERVAL_MS = 30 * 60 * 1000
/** AI 可调范围下限：5 分钟。 */
export const MIN_IDLE_INTERVAL_MS = 5 * 60 * 1000
/** AI 可调范围上限：24 小时。 */
export const MAX_IDLE_INTERVAL_MS = 24 * 60 * 60 * 1000

/** `ctx.perception` 的配置。 */
export interface Config {
  /**
   * 闲时定时器间隔（毫秒）。
   *
   * **不重置** —— 她在忙的时候照常走（docs/design.md §4.6）。所以忙 1 小时
   * 会触发好几次，每次都拿到"当前状态"；由于 `pull()` 必须返回当前状态
   * 而不是增量日志，重复触发不会累积出错误的历史。
   */
  idleIntervalMs: number
  /** 是否把每次感知写进感知历史表（`ctx.db`）。 */
  persist: boolean
}

/** 配置 schema。 */
export const Config: z<Config> = z.object({
  idleIntervalMs: z.natural().min(MIN_IDLE_INTERVAL_MS).max(MAX_IDLE_INTERVAL_MS)
    .default(DEFAULT_IDLE_INTERVAL_MS),
  persist: z.boolean().default(true),
})
