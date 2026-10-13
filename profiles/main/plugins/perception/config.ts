/**
 * 感知层的配置面。
 *
 * @module perception/config
 */

import z from '@deepseek-ai/schemastery'

/** 默认闲时间隔：30 分钟（docs/design.md §4.6 定案）。 */
export const DEFAULT_IDLE_INTERVAL_MS = 30 * 60 * 1000
/** 防呆下限：1 秒。比这更小会把定时器打成忙等。 */
export const FLOOR_INTERVAL_MS = 1000
/** 默认下限：5 分钟。 */
export const DEFAULT_MIN_INTERVAL_MS = 5 * 60 * 1000
/** 默认上限：24 小时。 */
export const DEFAULT_MAX_INTERVAL_MS = 24 * 60 * 60 * 1000

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
  /** AI 调整间隔时允许的**下限**。低于它会被夹住。 */
  minIntervalMs: number
  /** AI 调整间隔时允许的**上限**。高于它会被夹住。 */
  maxIntervalMs: number
  /** 是否把每次感知写进感知历史表（`ctx.db`）。 */
  persist: boolean
}

/**
 * 配置 schema。
 *
 * **上下限是配置项，不是常量** —— DSH 的规矩：
 * 「No hardcoded tunables in plugins: deployment-varying choices are validated
 * `Config` fields changeable from cordis.yml」。
 *
 * 所以 `idleIntervalMs` 在这里**不写死范围**：真正的夹取在运行时按
 * `minIntervalMs`/`maxIntervalMs` 做。这里只保一个防呆下限，
 * 避免 0 或负数把定时器打成忙等。
 */
export const Config: z<Config> = z.object({
  idleIntervalMs: z.natural().min(FLOOR_INTERVAL_MS).default(DEFAULT_IDLE_INTERVAL_MS),
  minIntervalMs: z.natural().min(FLOOR_INTERVAL_MS).default(DEFAULT_MIN_INTERVAL_MS),
  maxIntervalMs: z.natural().min(FLOOR_INTERVAL_MS).default(DEFAULT_MAX_INTERVAL_MS),
  persist: z.boolean().default(true),
})
