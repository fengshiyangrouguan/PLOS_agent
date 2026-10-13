/**
 * `tcb` 能力 seam：**一个身份 + 一套配置**，以及"哪些段落进系统提示词"的白名单。
 *
 * 概念与设计理由见 `catalog.ts` 的模块注释。这里只讲**它怎么接进系统提示词**。
 *
 * ## 接法：`system-prompt/assemble` 这个瀑布
 *
 * 原文（`core/system-prompt/src/index.ts:19`）：
 *
 * > Expert waterfall over the assembled sections, contexts, tools, and variables.
 * > **The returned value is authoritative.**
 * > Scope-filtered dispatch: **scoped listeners receive only that scope's assemblies.**
 *
 * 所以 `apply(agentCtx, tcb)` 在**那个 agent 自己的 scope** 上挂两个贡献：
 *
 * 1. **白名单过滤器** —— 过滤 `assembly.sections`。**没列出来的就不进。**
 * 2. **人设段落** —— 注册成 `deployment:persona-prefix`（`PERSONA_PREFIX_SECTION`）。
 *    **同名才顶得掉**，这是 DSH 自己让 preset 覆盖部署人设的机制。
 *
 * **不需要改 DSH，也不需要另造机制。**
 *
 * ## 为什么不用 `complete`
 *
 * 曾经的设想是"`complete: true` 独占整份提示词，覆盖 `HARNESS_IDENTITY`，
 * 避免左右互搏"。**白名单本身就表达了那件事** —— 不列 `harness:identity` 就是不给它。
 * 实测那句话的全文只有 `You are an AI agent powered by DeepSeek Harness.`，
 * 不含任何行为准则，丢掉零损失。**少一个概念。**
 *
 * ## 导出形态
 *
 * 遵守 DSH 的 service 包约定。**不具名导出**。
 *
 * @module tcb
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Config as ConfigSchema, type Config } from './config.ts'
import { parseCatalog, resolveTcb, type Tcb, type TcbCatalog } from './catalog.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 身份 + 配置目录。 */
    tcb: TcbRegistry
  }
}

/** 人设槽的段落名 —— **用常量，别写字面量**。 */
const PERSONA_PREFIX_SECTION = 'deployment:persona-prefix'
/** 人设槽的 order。`SECTION_ORDERS.DEPLOYMENT_PERSONA_PREFIX`。 */
const PERSONA_PREFIX_ORDER = 0

/**
 * TCB 目录设施，注册为 `ctx.tcb`。
 */
export class TcbRegistry extends Service {
  static Config: z<Config> = ConfigSchema

  private readonly config: Config
  private catalog: TcbCatalog = { defaultId: '', tcbs: new Map() }

  /**
   * @param ctx - 本插件的上下文。
   * @param config - 配置。
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'tcb')
    this.config = config
  }

  /**
   * 构造完成之后运行：载入目录。
   *
   * **坏配置要响**（DSH：`Misconfiguration fails loud`）—— 名字拼错的 TCB
   * 不该静默退回默认，那会让人以为"改了配置但没生效"。所以这里**抛错**，
   * 让插件不激活。
   */
  async *[Service.init](): AsyncGenerator<() => void, void, void> {
    yield () => { /* 目录是只读的，没有待清理的资源 */ }

    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(this.config.path, 'utf8')) as unknown
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') {
        this.ctx.logger.warn(`tcb: 目录不存在（${this.config.path}），TCB 不可用`)
        return
      }
      throw new Error(`tcb: 读取目录失败（${this.config.path}）：${error instanceof Error ? error.message : String(error)}`)
    }

    const parsed = parseCatalog(raw)
    if (!parsed.ok) throw new Error(`tcb: 目录不合法（${this.config.path}）：${parsed.error}`)

    this.catalog = parsed.catalog
    this.ctx.logger.info(
      `tcb: 已载入 ${String(this.catalog.tcbs.size)} 个（默认 ${this.catalog.defaultId}）：`
      + [...this.catalog.tcbs.keys()].join(', '),
    )
  }

  /** 默认 TCB 的 id；目录没载入时是空串。 */
  get defaultId(): string {
    return this.catalog.defaultId
  }

  /** 全部 TCB 的 id。 */
  ids(): string[] {
    return [...this.catalog.tcbs.keys()]
  }

  /**
   * 取一个 TCB。
   * @param id - 想要的 id；省略用默认。
   * @returns TCB；不存在时 `undefined`。
   */
  get(id?: string | undefined): Tcb | undefined {
    return resolveTcb(this.catalog, id)
  }

  /**
   * 把某个 TCB 接到一个 agent 上。
   *
   * **在 agent 自己的 scope 上注册**（`agentCtx`）—— 所以不需要去解析 scope 反查 TCB，
   * **注册的作用域本身就是答案**。
   *
   * @param agentCtx - 该 agent 的上下文（`agents.create({ setup })` 收到的那一个）。
   * @param tcb - 要应用的 TCB。
   */
  apply(agentCtx: Context, tcb: Tcb): void {
    const allowed = new Set(tcb.sections)

    // ① 白名单：过滤掉没列的段落。瀑布监听器**必须调 next()** 委派。
    agentCtx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const result = await next()
      return { ...result, sections: result.sections.filter(section => allowed.has(section.name)) }
    })

    // ② 人设：注册成 `deployment:persona-prefix` —— 同名才会替换而不是重复。
    if (tcb.identity !== undefined && tcb.identity !== '') {
      let text: string
      try {
        text = readFileSync(resolve(process.env['DSH_HOME'] ?? '.', tcb.identity), 'utf8')
      } catch (error) {
        // 人设读不到**不该让 agent 起不来** —— 只是没有那张脸而已。
        agentCtx.logger.warn(
          `tcb: 人设文件读不到（${tcb.identity}），该 TCB 本次没有人设：%o`,
          error instanceof Error ? error.message : String(error),
        )
        return
      }
      agentCtx.systemPrompt.section({
        name: PERSONA_PREFIX_SECTION,
        order: PERSONA_PREFIX_ORDER,
        text,
      })
    }
  }
}

export default TcbRegistry
