/**
 * `tcb` 的配置面。
 *
 * @module tcb/config
 */

import z from '@deepseek-ai/schemastery'

/** `ctx.tcb` 的配置。 */
export interface Config {
  /**
   * TCB 目录的路径。
   *
   * **放 `data/` 而【不进数据库】**（用户定案，docs/m5-preemption.md §13.1）：
   * 数据库存会话记录 / 图片 / 表情包等大批量内容；**TCB 只是一份配置**，
   * **显式在外 `data/` 里方便修改**。
   */
  path: string
}

/** 配置 schema。 */
export const Config: z<Config> = z.object({
  path: z.string(),
})
