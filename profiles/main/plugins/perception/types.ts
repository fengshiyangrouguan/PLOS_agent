/**
 * 感知层的类型面。
 *
 * **只有类型，没有运行时代码** —— DSH 的约定（`src/types.ts` contains only types）。
 * 渲染逻辑在 `render.ts`，服务在 `index.ts`。
 *
 * ## 词汇（见 docs/decisions.md §11）
 *
 * 「信号」是**注册侧**的词，不贯穿到底：
 *
 * ```
 * 注册侧   状态信号（感知层拉）/ 唤醒信号（领域推、带优先级）
 *             ↓
 * 感知层   采集 + 渲染【不含内容】+ 落库 → 产物叫【感知条目】
 *             ↓
 * 响应侧   attention 订阅条目、分配注意力、唤醒 agent
 * ```
 *
 * @module perception/types
 */

/** 优先级：0 = 永不唤醒（只在闲时定时拉时出现）。 */
export const PRIORITY_PASSIVE = 0
/** 优先级：≥ 此值 = 紧急（抢占时**不给**收尾机会）。 */
export const PRIORITY_URGENT = 80
/** 优先级上限。 */
export const PRIORITY_MAX = 100

/** 一条待渲染的信号。领域 `pull()` 返回的就是它。 */
export interface Signal {
  /**
   * 信号种类，对应领域 `templates` 里的键。
   * 用它查模板，所以**拼错会渲染失败**（我们把拼错当成错误暴露，不静默吞掉）。
   */
  readonly kind: string
  /** 模板占位符的取值。值全部转成字符串后再代入。 */
  readonly data: Readonly<Record<string, string | number>>
  /**
   * 来源标识，进感知历史用（如 `group:728636404`）。
   * **不参与渲染** —— 渲染是模板的事。
   */
  readonly source: string
  /**
   * 本条信号的优先级。省略时用领域注册的 `priority`。
   * **`0` 表示永不唤醒** —— 这条就是"不太有用的信息"，只在闲时定时拉时出现。
   */
  readonly priority?: number
  /** 时间戳（毫秒）。省略时用感知层的当前时间。 */
  readonly at?: number
}

/**
 * 一个领域注册的信号源。
 *
 * **领域不生产文本** —— 它给的是 `Signal[]`（结构化数据）+ `templates`（模板），
 * 由感知层拼装成简报。这条边界是设计的核心（docs/design.md §4.1）。
 */
export interface SignalSource {
  /** 领域名，渲染成 `【域名】`。 */
  readonly domain: string
  /** 该领域的基准优先级；被 `Signal.priority` 覆盖。 */
  readonly priority?: number
  /**
   * 该领域的模板表，键是 `Signal.kind`。
   *
   * 占位符写 `{key}`，用 `Signal.data[key]` 代入。
   * 允许各领域用自己的话术（手表的"浅睡眠阶段" vs QQ 的"有人 @ 了你"），
   * 但**统一性由感知层保证**（时间戳、`【域名】` 分节、行序）。
   */
  readonly templates: Readonly<Record<string, string>>
  /**
   * 拉取当前状态。
   *
   * **必须是"当前状态"而不是"增量日志"** —— 这是 `priority: 0` 去重能成立的前提：
   * 闲时定时器在忙时会触发好几次，每次都拿到当前状态，所以只需保留最新的一份
   * （docs/design.md §4.6）。
   */
  readonly pull: () => Promise<readonly Signal[]> | readonly Signal[]
}

/**
 * 本轮拉取是谁发起的。
 *
 * **这条区分是必要的**，否则 `priority: 0` 的条目无法交付：
 * 它"永不唤醒"，可它又只在闲时定时拉时出现 —— 如果闲时那次也不唤醒，
 * 她就永远看不到它。
 *
 * 所以 `priority: 0` 的准确含义是「**不因它自己而唤醒**」：
 * - `idle`：闲时定时器发起 → **要唤醒**（这就是"她定期四处看看"）
 * - `signal`：领域主动推的唤醒信号 → 只有 `highest > 0` 才唤醒
 */
export type NoticeTrigger = 'idle' | 'signal'

/** 渲染好的一条简报，也是 `perception/notice` 事件的载荷。 */
export interface PerceptionNotice {
  /** 生成时间（毫秒）。 */
  readonly at: number
  /** 本轮是谁发起的。响应侧靠它决定 `priority: 0` 的条目要不要交付。 */
  readonly trigger: NoticeTrigger
  /** 渲染好的简报正文（含时间戳与 `【域名】` 分节）。 */
  readonly text: string
  /** 参与本次简报的信号，已按领域分组、组内保持 `pull` 返回的顺序。 */
  readonly signals: readonly ResolvedSignal[]
  /**
   * 本次简报里的最高优先级。**0 表示全是 0 级**（纯闲时内容，不该唤醒）。
   * 响应侧（`attention`）用它做仲裁，感知层自己不做决定。
   */
  readonly highest: number
  /** 是否全部是 `priority: 0`。等价于 `highest === 0`，单列出来是为了读起来清楚。 */
  readonly quiet: boolean
}

/** 信号 + 解析后的优先级与领域归属。 */
export interface ResolvedSignal extends Signal {
  /** 渲染出的那一行文本。 */
  readonly line: string
  /** 生效的优先级（`Signal.priority` 覆盖领域基准后的结果）。 */
  readonly priority: number
  /** 所属领域。 */
  readonly domain: string
}
