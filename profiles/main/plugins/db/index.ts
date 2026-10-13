/**
 * `db` 能力 seam：一个 SQLite 数据库设施。
 *
 * ## 它是什么 / 不是什么
 *
 * **是**：一个**领域无关**的持久化设施。它 `provide('db')`，对上层暴露 `this.ctx.db`，
 * 提供三样存储：完整消息存档（搜索工具的数据源）、感知历史、当前会话指针。
 *
 * **不是**：它**不认识 QQ，也不认识任何领域**。表结构是通用的
 * （`platform` 是列而不是库），谁需要谁调。这是用户明确要求的
 * ——「把数据库做成一个**非 qq 插件内部调用的单独的插件设施**」。
 *
 * ## 为什么用 `node:sqlite`
 *
 * Node 24 内置，**零依赖**。而且 DSH 自己就用它
 * （`packages/session/session-query-sqlite/src/index.ts` 里
 * `import type { DatabaseSync } from 'node:sqlite'`，dependencies 里没有任何 SQLite 驱动）。
 * 跟着上游走，不引第三方绑定。
 *
 * ## 生命周期：`ctx.effect` 管连接，**不管表**
 *
 * 计划 §6.1 写的是「建表 = effect」。**但这里刻意不删表** ——
 * 我们的补丁层开着 HMR（`root: ['./plugins']`），改一次插件文件就会卸载重装。
 * 若 disposer 去 `DROP TABLE`，等于**每改一次代码清空一次数据库**。
 *
 * 所以：
 * - **迁移在激活时跑**（幂等，`IF NOT EXISTS`）
 * - **disposer 只关连接**（连接是真资源；表是持久数据）
 *
 * 见 `schema.ts` 的模块注释。
 *
 * ## 导出形态
 *
 * 遵守 DSH 的 service 包约定：`export class ... extends Service` + `static Config`
 * + `export default`。**不具名导出** —— 服务包与函数插件的导出形态不同，
 * 混用会让 Loader 丢掉插件的命名空间。
 *
 * @module db
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { Config as ConfigSchema, type Config } from './config.ts'
import { migrate } from './schema.ts'
import { MessageStore, PerceptionStore, SessionPointer } from './stores.ts'

/**
 * SQLite 数据库设施，注册为 `ctx.db`。
 */
export class Db extends Service {
  static Config: z<Config> = ConfigSchema

  /** 完整消息存档 —— 搜索工具的数据源。 */
  readonly messages: MessageStore
  /** 感知历史。 */
  readonly perception: PerceptionStore
  /** 当前会话指针（单行）。 */
  readonly sessionPointer: SessionPointer

  /**
   * 原始句柄。给需要写自定义查询的领域用（比如将来的记忆 / 媒体表）。
   * 大部分调用方应该用上面三个 store。
   */
  readonly handle: DatabaseSync

  /**
   * @param ctx - 本插件的上下文。
   * @param config - 配置。
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'db')

    mkdirSync(dirname(config.path), { recursive: true })
    const handle = new DatabaseSync(config.path)
    this.handle = handle

    // 迁移在**构造时**跑：它是幂等 DDL（`IF NOT EXISTS`），重装无害。
    const result = migrate(handle)

    // ⚠️ 已知问题：Service 插件在构造期间拿不到自己的 logger 作用域 ——
    // `this.ctx.logger` 在这里是 `undefined`（实测：推迟到 setTimeout 里也一样）。
    // 详见 docs/design.md 的实施记录。先用可选访问，**日志失败不让设施失效**。
    const logger = (this.ctx as { logger?: { info: (message: string) => void } }).logger
    logger?.info(`db：${config.path} —— ${result.applied.length === 0
      ? `已是最新（v${String(result.to)}）`
      : `v${String(result.from)} → v${String(result.to)}：${result.applied.join('、')}`}`)

    // effect 只管**连接**这个真资源。**不删表** —— HMR 会让插件在改文件时
    // 卸载重装，disposer 去 DROP TABLE 等于每改一次代码清空一次库。
    ctx.effect(() => () => { handle.close() })

    this.messages = new MessageStore(handle)
    this.perception = new PerceptionStore(handle)
    this.sessionPointer = new SessionPointer(handle)
  }
}

export default Db
