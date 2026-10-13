/**
 * `pointer` 的配置面。
 *
 * @module pointer/config
 */

import z from '@deepseek-ai/schemastery'

/** `ctx.pointer` 的配置。 */
export interface Config {
  /**
   * 指针栈存档路径。
   *
   * 放在 `data/`（**不是数据库**）—— 判据是"要不要给人改"：
   * 数据库存大批量内容，指针栈是小的、显式的、排障时要直接看的。
   */
  path: string
}

/** 配置 schema。 */
export const Config: z<Config> = z.object({
  path: z.string(),
})
