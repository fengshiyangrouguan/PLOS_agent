/**
 * 数据库设施的配置面。
 *
 * 设计 §6.1：**共用一个 db 文件**，各领域用各自的表。
 * 路径从补丁层注入（照 `credentials` 那一行的写法）：
 *
 * ```yaml
 * path: !!js "process.env.DSH_HOME + '/data/plos.db'"
 * ```
 *
 * 这样密钥/路径都不进版本库，且换 profile 就是换库。
 *
 * @module db/config
 */

import z from '@deepseek-ai/schemastery'

/** `ctx.db` 的配置。 */
export interface Config {
  /** 数据库文件路径。父目录不存在会自动创建。 */
  path: string
  /** 是否打印建库 / 迁移日志。排障时有用，默认开。 */
  verbose: boolean
}

/** 配置 schema。 */
export const Config: z<Config> = z.object({
  path: z.string(),
  verbose: z.boolean().default(true),
})
