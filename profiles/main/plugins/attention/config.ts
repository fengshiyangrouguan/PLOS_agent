/**
 * `attention` 的配置面。
 *
 * @module attention/config
 */

import z from '@deepseek-ai/schemastery'

/** `ctx.attention` 的配置。 */
export interface Config {
  /**
   * 目标会话 id。**留空时自动**：先读数据库里的"当前会话指针"，
   * 再退到"恰好一个在册 agent"。
   *
   * 留空是常态 —— 合并会换 `sessionId`（新会话），所以固定的配置值会失效，
   * 真正可靠的是那个指针（docs/design.md §8.4）。
   */
  sessionId: string
  /** 待交付队列容量。正常工况下每轮都会被取走，长起来说明投放链路堵了。 */
  queueCapacity: number
}

/** 配置 schema。 */
export const Config: z<Config> = z.object({
  sessionId: z.string().default(''),
  queueCapacity: z.natural().min(1).default(32),
})
