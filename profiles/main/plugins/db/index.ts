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
import { MessageStore, PerceptionStore } from './stores.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 持久化设施。领域无关 —— 表结构通用（`platform` 是列不是库）。 */
    db: Db
  }
}

/**
 * SQLite 数据库设施，注册为 `ctx.db`。
 */
export class Db extends Service {
  static Config: z<Config> = ConfigSchema

  /** 完整消息存档 —— 搜索工具的数据源。 */
  readonly messages: MessageStore
  /** 感知历史。 */
  readonly perception: PerceptionStore

  /**
   * 原始句柄。给需要写自定义查询的领域用（比如将来的记忆 / 媒体表）。
   * 大部分调用方应该用上面三个 store。
   */
  readonly handle: DatabaseSync

  /** 配置。`init` 里打日志时还要用，所以留成字段。 */
  private readonly config: Config

  /**
   * @param ctx - 本插件的上下文。
   * @param config - 配置。
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'db')

    this.config = config
    mkdirSync(dirname(config.path), { recursive: true })
    const handle = new DatabaseSync(config.path)
    this.handle = handle

    // 迁移必须在这里跑完：`ctx.db` 一旦被 provide，别人就可能立刻用，表得先存在。
    // 它是幂等 DDL（`IF NOT EXISTS`），重装无害。
    migrate(handle)

    this.messages = new MessageStore(handle)
    this.perception = new PerceptionStore(handle)
  }

  /**
   * 构造完成之后运行 —— **类插件的激活期工作放这里**，`yield` 出来的是 disposer。
   *
   * 已实测确认这个钩子**会被调用**（往表里写一行诊断数据验证过），
   * 也确认它**晚于**构造函数 —— 见下面那条日志的说明。
   */
  async *[Service.init](): AsyncGenerator<() => void, void, void> {
    // 只关连接、**不删表** —— HMR 会让插件在改文件时反复重装，
    // 删表等于每改一次代码清空一次库。
    yield () => { this.handle.close() }

    const result = migrate(this.handle)

    // 启动自述。
    //
    // ⚠️ **这一行在这里打，终端上看不见 —— 但这不是 bug，也不是"logger 取不到"。**
    //
    // 完整因果（已闭合，见 PLOS/docs/logger-issue.md）：
    //
    //   Service.init 执行 → ctx.logger.info(...)  ← 完全合法，记录真的产生了
    //     ↓
    //   cordis 内置 buffer 收到它
    //     ↓
    //   dsh-logbook 声明了 `inject = ['commands']`，所以它【还在等 commands 服务】
    //     → 它的 stderr exporter 尚未注册
    //     ↓
    //   当时没有任何"终端出口" → 终端看不到
    //     ↓
    //   logbook 激活后只是把旧 buffer 铺进 `/logs` 的 ring，**不重放到 stderr**
    //
    // 对照：`qq-tools` / `qq-resident` 的日志在 **apply 之后**打，那时 logbook 已激活。
    //
    // **所以这里保持直接调用，不要用可选链**：
    //   · `ctx.logger` 是 Context 的自有属性（vendor/cordis/src/context.ts:81），
    //     不是可选服务；它不存在属于框架严重异常，该炸就炸
    //   · 可选链会把真正的框架问题静默掉，还会让后来人误以为 logger 真的可能不存在
    //
    // 正确的修法在 logbook 侧（让 stderr exporter 不依赖 commands），
    // 不该让每个业务设施自己加 `console.log` 绕。
    if (this.config.verbose) {
      this.ctx.logger.info(`db：${this.config.path} —— ${result.applied.length === 0
        ? `已是最新（v${String(result.to)}）`
        : `v${String(result.from)} → v${String(result.to)}：${result.applied.join('、')}`}`)
    }
  }
}

export default Db
