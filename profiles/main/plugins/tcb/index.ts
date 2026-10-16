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
 * 2. **人设段落** —— 注册成 `deployment:persona-prefix`（`PERSONA_PREFIX_SECTION`，
 *    ★ **order 0 ＝ 最前** ✓ —— ★ 2026-10-16 曾在 `persona-suffix` 上试过一轮，
 *    实测**无效** ⇒ 已改回 ✓，原因见下面那个常量的注释 ✓）。
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

import { recordStartupLine } from '../_startup-log.ts'
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Config as ConfigSchema, type Config } from './config.ts'
import { parseCatalog, resolveTcb, type ModelConfig, type Tcb, type TcbCatalog } from './catalog.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 身份 + 配置目录。 */
    tcb: TcbRegistry
  }
}

/** 人设槽的段落名 —— **用常量，别写字面量**。 */
/**
 * 人设槽的名字 —— ★★ **回到最开始的位置** ✗（`SECTION_ORDERS.DEPLOYMENT_PERSONA_PREFIX = 0` ✓）。
 *
 * ## 走过的一段弯路（2026-10-16，留作记录 ✓）
 *
 * ★ 先是从这里挪到了 `deployment:persona-suffix`（order **10200** ＝ 最后 ✗），
 * 理由是"**V3 系模型对靠近末尾的指令更服从**"✗ —— ★ 而实测**无效** ✓：
 * 挪位前后各抽两组思考，措辞**没有可辨的变化** ✗（★ 助手腔依旧 ✓）。
 *
 * ★★ 真正的原因后来才看清 ✗（★ 见 `PLOS/docs/thinking-audit-2026-10-16.md` ✓）：
 * ★ 她有一个**固定的思考模板** ✗ —— 「描述群里发生什么」＋「作为AI，我应该避免参与」＋
 * 「今天的工作总结」＋「时间播报」＋「待办列表」✓ —— ★ 而那**不是位置能改的** ✗✓。
 * ★★ 更根本的是**信息比例** ✗：★ 模型每轮看到**工具 schema 16,343 字符** ✗ ＋
 * **提示词里 2,454 字符的工具契约** ✗，★ 而**人设只有 1,397 字符** ✓
 * ⇒ ★★★ **约 13 : 1** ✗✓ —— ★ 那才是"她像助手"的来源 ✓。
 *
 * ⇒ ★ **所以：位置改回来** ✓（★ 用户在看过 dump 之后定的 ✓），
 * ★★ **真正的对策是削减工具信息 ＋ 把人设写得更可执行** ✓✓。
 */
const PERSONA_PREFIX_SECTION = 'deployment:persona-prefix'

/** 人设槽的 order。★ 对应 `SECTION_ORDERS.DEPLOYMENT_PERSONA_PREFIX` ✓ —— **在最前** ✓。 */
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
    recordStartupLine(
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
   * ★★ **模型组索引**：`provider/model` → 它所在的组。
   *
   * 均衡器（`llm-throttle`）拿一个请求的 `provider/model` 来查，
   * 就知道"它属于哪个组、可以在组内换成谁" —— ★ **所以组只在 TCB 里配这一处**，
   * 插件里不再写第二份映射（那必然分叉）。
   *
   * ⚠️ 一个模型可能出现在**多个** TCB 的组里（例如 `main` 与 `planner` 都用 V3.2）：
   * 这时取**组更大的那个**，一样大取 id 排序在前的 —— **确定性的**，
   * 不看 `Map` 的插入顺序（那会随配置书写顺序变，排障时极难看出来）。
   *
   * 单模型 TCB（`models.length < 2`）**不进索引** —— 没有可轮换的，
   * 查不到就等于"用请求里原来那个模型"，与不装均衡器时一致。
   *
   * @returns 索引。**每次调用重建** —— 规模只有几个 TCB，而换来的是
   *   "改了 `data/tcb.json` 立刻生效"（不必重启或清缓存）。
   */
  groups(): ReadonlyMap<string, readonly ModelConfig[]> {
    const index = new Map<string, readonly ModelConfig[]>()
    for (const id of [...this.catalog.tcbs.keys()].sort()) {
      const tcb = this.catalog.tcbs.get(id)
      if (tcb === undefined || tcb.models.length < 2) continue
      for (const candidate of tcb.models) {
        const key = `${candidate.provider}/${candidate.model}`
        const existing = index.get(key)
        if (existing === undefined || tcb.models.length > existing.length) index.set(key, tcb.models)
      }
    }
    return index
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

    // ② 采样参数（temperature / maxTokens / stop）：走 `agent/request` 瀑布。
    //
    // ★ **为什么不走 `agentOptions`**：`AgentOptions`
    //   （`core/agent/src/runtime-types.ts:26-35`）只有
    //   provider / model / reasoningEffort / **maxTokens** ——
    //   **没有 `temperature`，也没有 `stop`**。那条路最多修好三分之一。
    //
    //   而 `agent/request` 是一个**返回 `LlmCallConfig` 的瀑布**（同文件 `:337`），
    //   这三个字段 `LlmCallConfig` 里都有（`catalog.ts` 的 `ModelConfig` 就是照它抄的）。
    //   于是**一个监听器让三个一起生效**。
    //
    //   作用域是 `agentCtx`，所以只影响这个 agent —— 白羽和 planner 各是各的。
    //
    //   在接上它之前，`data/tcb.json` 里的 `temperature` 是**空设置**：
    //   解析了、存下了、**没有任何消费方**。
    const sampling = {
      ...tcb.model.temperature === undefined ? {} : { temperature: tcb.model.temperature },
      ...tcb.model.maxTokens === undefined ? {} : { maxTokens: tcb.model.maxTokens },
      // `ModelConfig.stop` 是 `readonly string[]`，而 `LlmCallConfig.stop` 是 `string[]`
      // —— 在这一步复制，别把只读视图漏进可变的请求配置。
      ...tcb.model.stop === undefined ? {} : { stop: [...tcb.model.stop] },
    }
    if (Object.keys(sampling).length > 0) {
      agentCtx.on('agent/request', async (_payload, next) => ({ ...await next(), ...sampling }))
    }

    // ③ 人设：注册成 `deployment:persona-prefix`（**order 0 ＝ 最前** ✓）——
    //    同名才会替换而不是重复 ✓；★ 曾在 `persona-suffix` 上试过一轮，实测无效 ⇒ 改回 ✓。
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
