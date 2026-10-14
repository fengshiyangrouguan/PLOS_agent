/**
 * `last_shutdown` 的配置面。
 *
 * @module last_shutdown/config
 */

import z from '@deepseek-ai/schemastery'

/** `ctx.lastShutdown` 的配置。 */
export interface Config {
  /**
   * 关闭记录存档路径。
   *
   * 放 `data/` **不进数据库** —— 跟 `pointer` / `tcb` 同一个判据
   * （"**要不要给人改**"）：数据库存大批量内容，这个是小的、显式的、
   * 排障时要直接看的。
   */
  statePath: string
}

/** 配置 schema。 */
export const Config: z<Config> = z.object({
  statePath: z.string(),
})
