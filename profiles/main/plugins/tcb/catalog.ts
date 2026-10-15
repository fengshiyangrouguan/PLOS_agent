/**
 * TCB 目录：**一个身份 + 一套配置**。
 *
 * ## TCB 是什么
 *
 * 用户的原话（docs/m5-preemption.md §12.2）：
 *
 * > 我们给一个**稳定的 agent 身份 id** 就行……**白羽自己单独的 TCB**，按 TCB，
 * > **一个 TCB 分配一套模型配置、系统提示词**；**任务总结用小模型**单独产生一个 TCB
 * > 一个配置；**专用的解决复杂问题的 dsh agent** 一个 TCB 一个配置。
 * > **一口气收拢了两个边界**。
 *
 * 它同时解掉两件事：
 *
 * | | 原本 | 被 TCB 收拢后 |
 * |:--|:--|:--|
 * | **身份** | 会话 id 一直在变，"白羽"的身份跟着漂 | **身份在 TCB 上，与会话解耦** |
 * | **路由** | 要另造一个"路由器"判日常/复杂 | **路由 = 选哪个 TCB** |
 *
 * **所以：指针（SP）是会话 id，会变；TCB 是身份，稳定。** RTOS 里它们本来就分开
 * （任务 = TCB，SP 是 TCB 里的一个字段）。
 *
 * ## ★ 白名单，不是"插入人设"
 *
 * 用户定案：
 *
 * > 我们的 TCB 理论上可以**直接设置系统提示词中哪些东西应该进**，
 * > **而不是插入 identity**。
 *
 * 所以 TCB 的核心是 `sections` —— **哪些段落进系统提示词**。
 * **默认关闭**：没列出来的就不进。这正是渐进式披露要的语义（"没给 = 以后再给"）。
 *
 * **`HARNESS_IDENTITY` 要不要列，本身就表达了"保不保留 DSH 的身份"** ——
 * 所以不需要另一个 `complete` 概念（那是我先前的多余设计）。
 *
 * 实测：`harness:identity` 的全文只有一句
 * `You are an AI agent powered by DeepSeek Harness.`，**不含任何行为准则** ——
 * 所以丢掉零损失，而它跟"我是白羽"直接顶撞。
 *
 * 可筛选的段落名见 `PLOS/docs/tcb-sections.md`（含**运行时实测**名单）。
 *
 * ## 纯逻辑
 *
 * 不认识 cordis、不碰文件系统 —— 可离线自检（`tests/catalog.spec.ts`）。
 * 持久化与装配在 `index.ts`。
 *
 * @module tcb/catalog
 */

/** 模型配置 —— **照 `LlmCallConfig`**，不另造一套再映射。 */
export interface ModelConfig {
  readonly provider: string
  readonly model: string
  /** 推理强度。 */
  readonly reasoningEffort?: string | undefined
  readonly temperature?: number | undefined
  readonly maxTokens?: number | undefined
  readonly stop?: readonly string[] | undefined
}

/** 一个 TCB。 */
export interface Tcb {
  /** **稳定身份 id** —— 指针栈的帧上带的就是它。 */
  readonly id: string
  /**
   * ★★ **模型组** —— 配置里**唯一的模型键**。
   *
   * **第一个是默认**（没有余量、或没配组时就用它），**后面的都是轮换候选** ——
   * 均衡器（`llm-throttle`）**读这个组**，在组内挑"还有余量"的那个。
   *
   * ★ **组内必须可互换**：同一份 messages / tools 都得吃得下。不满足的话，
   * 会**在换过去那一瞬间**失败，而症状看起来像"模型坏了"。
   */
  readonly models: readonly ModelConfig[]
  /**
   * `= models[0]` —— ★ **派生值**，**不是**配置里的第二个键（配置只写 `models`）。
   *
   * 留着是给"只需要一个模型"的消费方读（`vlm2text` 拿它调 VLM、
   * `interrupt_plan` 拿它起快照 subagent），这样那几处一行都不用改。
   */
  readonly model: ModelConfig
  /**
   * 人设文本的来源（相对 `$DSH_HOME` 的路径）。
   *
   * 内容会注册成 `deployment:persona-prefix` —— **那条槽位的"同名即替换"机制**
   * （`PERSONA_PREFIX_SECTION` 的注释：两边用同一个名字才让它变成替换而不是重复）。
   */
  readonly identity?: string | undefined
  /**
   * **哪些段落进系统提示词**（白名单）。
   *
   * 没列出来的**不进**。空数组 = 一个段落都不给（只有一个光秃秃的请求）。
   */
  readonly sections: readonly string[]
}

/** 整个目录。 */
export interface TcbCatalog {
  /** 默认 TCB 的 id —— 用在"第一个 agent"。 */
  readonly defaultId: string
  readonly tcbs: ReadonlyMap<string, Tcb>
}

/** 解析结果。 */
export type CatalogParse =
  | { readonly ok: true, readonly catalog: TcbCatalog }
  | { readonly ok: false, readonly error: string }

/**
 * 解析 `data/tcb.json` 的内容。
 *
 * **坏配置要响**（DSH 的规矩：`Misconfiguration fails loud`）——
 * 一个名字拼错的 TCB 不该静默退回默认，那会让人以为"改了配置但没生效"。
 *
 * @param raw - `JSON.parse` 出来的值。
 * @returns 目录，或一条可读的错误。
 */
export function parseCatalog(raw: unknown): CatalogParse {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: '顶层不是对象' }
  const top = raw as Record<string, unknown>

  const defaultId = top['default']
  if (typeof defaultId !== 'string' || defaultId === '') {
    return { ok: false, error: '缺少 "default"（默认 TCB 的 id）' }
  }

  const entries = top['tcbs']
  if (typeof entries !== 'object' || entries === null) return { ok: false, error: '缺少 "tcbs"' }

  const tcbs = new Map<string, Tcb>()
  for (const [id, value] of Object.entries(entries as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) return { ok: false, error: `TCB "${id}" 不是对象` }
    const entry = value as Record<string, unknown>

    // ★ **模型组**。`models` 是配置里**唯一的键**；老的 `model`（单数）
    //   仍然接受 ⇒ 内部当成 `models: [model]`（现有 `data/tcb.json` 一行都不用改）。
    const rawModels = entry['models'] ?? (entry['model'] === undefined ? undefined : [entry['model']])
    if (!Array.isArray(rawModels) || rawModels.length === 0) {
      return { ok: false, error: `TCB "${id}" 缺少 "models"（或兼容的 "model"）` }
    }
    const models: ModelConfig[] = []
    for (const item of rawModels) {
      if (typeof item !== 'object' || item === null) {
        return { ok: false, error: `TCB "${id}" 的 models 里有一项不是对象` }
      }
      const m = item as Record<string, unknown>
      if (typeof m['provider'] !== 'string' || m['provider'] === '') {
        return { ok: false, error: `TCB "${id}" 的 models[].provider 缺失或不是字符串` }
      }
      if (typeof m['model'] !== 'string' || m['model'] === '') {
        return { ok: false, error: `TCB "${id}" 的 models[].model 缺失或不是字符串` }
      }
      models.push({
        provider: m['provider'],
        model: m['model'],
        reasoningEffort: typeof m['reasoningEffort'] === 'string' ? m['reasoningEffort'] : undefined,
        temperature: typeof m['temperature'] === 'number' ? m['temperature'] : undefined,
        maxTokens: typeof m['maxTokens'] === 'number' ? m['maxTokens'] : undefined,
        stop: Array.isArray(m['stop']) ? m['stop'].filter((x): x is string => typeof x === 'string') : undefined,
      })
    }
    const first = models[0]
    if (first === undefined) return { ok: false, error: `TCB "${id}" 的 models 是空的` }

    const sections = entry['sections']
    if (!Array.isArray(sections) || sections.some(item => typeof item !== 'string')) {
      return { ok: false, error: `TCB "${id}" 的 "sections" 必须是字符串数组` }
    }

    const identity = entry['identity']
    if (identity !== undefined && typeof identity !== 'string') {
      return { ok: false, error: `TCB "${id}" 的 "identity" 必须是字符串路径` }
    }

    tcbs.set(id, {
      id,
      models,
      model: first,
      identity,
      sections: sections as string[],
    })
  }

  if (!tcbs.has(defaultId)) {
    return { ok: false, error: `默认 TCB "${defaultId}" 不在 "tcbs" 里` }
  }

  return { ok: true, catalog: { defaultId, tcbs } }
}

/**
 * 取一个 TCB。
 * @param catalog - 目录。
 * @param id - 想要的 id；省略用默认。
 * @returns TCB；id 不存在时 `undefined`。
 */
export function resolveTcb(catalog: TcbCatalog, id?: string | undefined): Tcb | undefined {
  return catalog.tcbs.get(id ?? catalog.defaultId)
}
