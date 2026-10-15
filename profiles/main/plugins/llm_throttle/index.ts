/**
 * 出网**自我限速 ＋ 同族模型均衡** —— 让 429 不再打穿她，同时不牺牲响应速度。
 *
 * ## 为什么需要它（实测 2026-10-15）
 *
 * 硅基流动的限速**按模型**给，而官方文档明说 `DeepSeek R1` / `DeepSeek V3`
 * 这一类**限速是固定的**（花月消费也提不上去）。L0 档的实测数字：
 *
 *     主模型 deepseek-ai/DeepSeek-V3.2   RPM 1,000   TPM **100,000**
 *     识图   Qwen/Qwen3-VL-…             RPM 1,000   TPM  **80,000**
 *
 * ★ **RPM 一千完全不是瓶颈，TPM 才是墙。** 而探针里量到的请求体约 **162 KB**
 * ⇒ 按 4 字符/令牌估，**一条请求约 40,000 令牌**：
 *
 *     100,000 ÷ 40,000 ≈ **每分钟 2.5 个请求**
 *
 * 而她的一个回合要发 5~10 条请求 ⇒ **必然撞墙**。撞墙之后的真实链条是：
 *
 *     429(code 50602) → pi-ai 退避重试 6 次（+1/2/5/7 秒）→ **放弃**
 *       探针原样：`消息=175` 连续 6 次、全 429；最后一次 11:33:44 之后
 *       **到 11:37:46 一个请求都没有**
 *       ⇒ 你那边看到「发了消息她半天不理」
 *       ⇒ 再发一条，新回合恰好赶上配额恢复 ⇒「再发一条就全收到了」
 *
 * ## 两半，缺一不可
 *
 * | | 作用 |
 * |:--|:--|
 * | **限速** | 把请求**排在本地** ⇒ 慢一点，但**每次都成**（不再触发那条重试死路） |
 * | **均衡** | 限速是**按模型**算的 ⇒ **同族多模型 = TPM 直接翻倍** ⇒ 不牺牲速度 |
 *
 * ★ 单靠限速只能让她**变慢**；加上均衡才能"**保持响应速度的同时不被限速**"。
 *
 * ## 四条取舍
 *
 * | # | 取舍 | 理由 |
 * |:--|:--|:--|
 * | 1 | 超预算**排队等**，不是拒绝 | 拒绝 = 又一次失败重试，正是病灶 |
 * | 2 | ★ **配额让给她**（`residentSessionId` 不排队） | VLM / planner / 快照都是后台的，不该挤掉"她在说话"那条路 |
 * | 3 | ★ **限速器自己出问题必须放行** | 与探针同一条纪律：**绝不许阻断出网** |
 * | 4 | 数字全进 `Config` | 限额**按账号档位**变，写死就是错的 |
 *
 * ## 模型组怎么给
 *
 * `groups` 把**TCB 点名的那个模型**映射到它的**等价候选**：
 *
 * ```jsonc
 * "groups": {
 *   "siliconflow/deepseek-ai/DeepSeek-V3.2": [
 *     { "provider": "siliconflow", "model": "deepseek-ai/DeepSeek-R1" },
 *     { "provider": "siliconflow", "model": "deepseek-ai/DeepSeek-V3.2" },
 *     { "provider": "siliconflow", "model": "deepseek-ai/DeepSeek-V3" }
 *   ]
 * }
 * ```
 *
 * ★ **组内必须可互换**：同一份 messages / tools 都得吃得下。不满足就会在
 * "换过去那一瞬间"报错，而且**看起来像模型坏了**。
 *
 * ⚠️ **按 `provider/model` 分桶** —— 硅基是**按模型**限速的，而我们的 `llm-pi-ai` 里
 * **VLM 与主模型共用同一个 provider 条目**，只按 provider 分会算错。
 *
 * ## 为什么改模型这件事是安全的
 *
 * `llm/stream` 的终端 `next()` 闭包捕获的是**同一个 `options` 对象**
 * （`llm/src/index.ts:1136-1141`）⇒ 在 `next()` 之前改 `options.model`，
 * 适配器用的就是改过的那个。
 *
 * ★ 而 **"模型可见 ⟺ 进 log"**：这次用的是哪个模型由 `request/header` 记下来 ✓
 * ⇒ 均衡**不破坏**"请求是 session log 的纯函数"。
 *
 * @module llm-throttle
 */

import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'

/** 插件名。 */
export const name = 'llm-throttle'

/** 只要 `llm`（`llm/stream` 瀑布）与 `tcb`（**模型组的唯一来源**）。 */
export const inject = ['llm', 'tcb']

/** 一个桶（`provider/model`）的预算。 */
export interface BucketConfig {
  /** 每分钟请求数上限。 */
  perMinute: number
  /** 每分钟令牌数上限（估算值，见 {@link estimateTokens}）。 */
  tokensPerMinute: number
  /** 同时在飞的请求数上限。 */
  maxConcurrent: number
}

/** 一个候选模型。 */
export interface Candidate {
  /** provider 名（`llm-pi-ai` 的 providers 键）。 */
  provider: string
  /** 模型名。 */
  model: string
}

/** 配置。 */
export interface Config {
  /**
   * ★★ **总开关**：`false` ⇒ 一个监听器都不挂，**彻底不介入**。
   *
   * 默认关着，因为限额**按账号档位**变。打开之前先把 {@link buckets} 填成
   * 你自己那一档的真数字（硅基控制台的模型页会写"您当前的用量级别为 L0…"）。
   */
  enabled: boolean
  /**
   * ★ 常驻会话（她）的 `sessionId`：**它不排队、也不换模型**。
   *
   * 配额紧张时先扣后台那几路（VLM / planner / 快照）——
   * 它们晚一点没关系，"她在说话"那条路晚一点就是"她不回人"。
   */
  residentSessionId: string
  /** 默认桶（`buckets` 里没写到的模型用它）。 */
  defaults: BucketConfig
  /** ★ **按 `provider/model` 的覆盖** —— 硅基是**按模型**限速的。 */
  buckets: Record<string, BucketConfig>
  /** 被 429 拒过的模型**冷却多久**（毫秒）。 */
  cooldownMs: number
  /** 单次排队的上限（毫秒）—— 超过就**放行**（宁可冒险，也不许把她卡死）。 */
  maxWaitMs: number
}

/** 配置 schema。 */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
  residentSessionId: z.string().default('plos'),
  defaults: z.object({
    // L0 档的实测数字（硅基控制台）—— 换档位请覆盖它。
    perMinute: z.natural().default(1_000),
    tokensPerMinute: z.natural().default(100_000),
    maxConcurrent: z.natural().default(8),
  }).default({ perMinute: 1_000, tokensPerMinute: 100_000, maxConcurrent: 8 }),
  buckets: z.dict(z.object({
    perMinute: z.natural(),
    tokensPerMinute: z.natural(),
    maxConcurrent: z.natural(),
  })).default({}),
  // 60 秒：实测被限之后同一模型短时间内再碰还是 429。
  cooldownMs: z.natural().default(60_000),
  maxWaitMs: z.natural().default(20_000),
})

/**
 * 估算一次请求的令牌数。
 *
 * 不求精确 —— 要的是**量级正确**（决定"这一分钟还能不能再塞一个"）。
 * 字符数 / 4 是常用粗估；TPM 预算本来就留余量。
 *
 * @param options - `llm/stream` 的载荷。
 * @returns 估算的令牌数。
 */
export function estimateTokens(options: { messages?: readonly unknown[] }): number {
  const chars = JSON.stringify(options.messages ?? []).length
  return Math.ceil(chars / 4)
}

/** 一个候选此刻的报价。 */
export interface Offer {
  /** `provider/model` —— 也是桶的键。 */
  readonly key: string
  /** 要等多久才能发。 */
  readonly waitMs: number
  /** 剩余余量（越大越宽裕），用于并列时的比较。 */
  readonly headroom: number
  /** 是否在 429 冷却里。 */
  readonly cooling: boolean
}

/**
 * 挑一个候选：**先排除在冷却里的，再取等得最少的，并列时取余量最大的**。
 *
 * **纯函数**（不碰时间源、不碰桶）⇒ 能离线自检。
 *
 * @param offers - 每个候选此刻的报价，顺序与候选列表一致。
 * @returns 选中的下标；空数组返回 `undefined`。
 */
export function pickBest(offers: readonly Offer[]): number | undefined {
  if (offers.length === 0) return undefined
  const warm = offers.map((offer, index) => ({ offer, index })).filter(entry => !entry.offer.cooling)
  // ★ 全在冷却里 ⇒ **不挑等于不发**：退回到全部候选（宁可碰一次，也不要卡住她）。
  const pool = warm.length > 0 ? warm : offers.map((offer, index) => ({ offer, index }))
  let best = pool[0]
  if (best === undefined) return undefined
  for (const entry of pool) {
    const better = entry.offer.waitMs < best.offer.waitMs
      || (entry.offer.waitMs === best.offer.waitMs && entry.offer.headroom > best.offer.headroom)
    if (better) best = entry
  }
  return best.index
}

/** 一分钟窗口里的一条记录。 */
interface WindowEntry {
  at: number
  tokens: number
}

/**
 * 一个桶的滑动窗口。
 *
 * **纯逻辑、不碰时间源**（`now` 从外面传）—— 所以能离线自检。
 */
export class Bucket {
  readonly #config: BucketConfig
  #entries: WindowEntry[] = []
  #inflight = 0

  constructor(config: BucketConfig) {
    this.#config = config
  }

  /**
   * 这一条现在能不能发；不能的话要等多久。
   *
   * @param tokens - 这一条估算的令牌数。
   * @param now - 当前时间（毫秒）。
   * @returns `waitMs = 0` 表示可以发。
   */
  check(tokens: number, now: number): { waitMs: number, blockedBy: 'rpm' | 'tpm' | 'concurrency' | undefined } {
    this.#prune(now)

    if (this.#inflight >= this.#config.maxConcurrent) {
      // 并发满了：等一会儿再问（真正的等待由调用方的循环决定）。
      return { waitMs: 1_000, blockedBy: 'concurrency' }
    }
    if (this.#entries.length >= this.#config.perMinute) {
      const oldest = this.#entries[0]
      return { waitMs: oldest === undefined ? 0 : Math.max(1, oldest.at + 60_000 - now), blockedBy: 'rpm' }
    }
    const used = this.#entries.reduce((sum, entry) => sum + entry.tokens, 0)
    if (used + tokens > this.#config.tokensPerMinute && this.#entries.length > 0) {
      const oldest = this.#entries[0]
      return { waitMs: oldest === undefined ? 0 : Math.max(1, oldest.at + 60_000 - now), blockedBy: 'tpm' }
    }
    return { waitMs: 0, blockedBy: undefined }
  }

  /**
   * 这个桶还剩多少余量（0~1，越大越宽裕）。
   *
   * 用**剩余 TPM 比例**当余量 —— TPM 才是那堵墙（见模块注释）。
   *
   * @param now - 当前时间（毫秒）。
   * @returns 0~1。
   */
  headroom(now: number): number {
    this.#prune(now)
    const used = this.#entries.reduce((sum, entry) => sum + entry.tokens, 0)
    const left = this.#config.tokensPerMinute - used
    return Math.max(0, Math.min(1, left / this.#config.tokensPerMinute))
  }

  /**
   * 记下"发出去了一条"，并占一个并发位。
   *
   * @param tokens - 估算令牌数。
   * @param now - 当前时间。
   */
  enter(tokens: number, now: number): void {
    this.#entries.push({ at: now, tokens })
    this.#inflight += 1
  }

  /** 那一条结束了，还回并发位。 */
  leave(): void {
    this.#inflight = Math.max(0, this.#inflight - 1)
  }

  /** 丢掉窗口外的记录。 */
  #prune(now: number): void {
    const cutoff = now - 60_000
    this.#entries = this.#entries.filter(entry => entry.at > cutoff)
  }
}

/**
 * 这个失败是不是"被限速"。
 *
 * ⚠️ 是**启发式**：pi-ai 把适配器的错误归一成 `failure`，里面可能只有一段文本。
 * 认不出也只是**不冷却**（退化成纯轮转），不会更坏。
 *
 * @param failure - 归一化后的失败描述。
 * @returns 命中返回 true。
 */
export function isRateLimited(failure: unknown): boolean {
  return /429|rate.?limit|50602/i.test(JSON.stringify(failure ?? ''))
}

/** 睡一会儿。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/** `provider/model` 键。 */
function keyOf(provider: string, model: string): string {
  return `${provider}/${model}`
}

/**
 * 装好限速器与均衡器。
 *
 * @param ctx - 插件上下文。
 * @param config - 见 {@link Config}。
 */
export function apply(ctx: Context, config: Config): void {
  // ★ 关掉就是**彻底不介入** —— 连监听器都不挂。
  if (!config.enabled) return

  const buckets = new Map<string, Bucket>()
  /** 被 429 拒过的模型 → 那次的时间戳。 */
  const cooling = new Map<string, number>()

  /** 取 `provider/model` 的桶（**按模型分** —— 见模块注释那个坑）。 */
  const bucketFor = (provider: string, model: string): Bucket => {
    const key = keyOf(provider, model)
    let bucket = buckets.get(key)
    if (bucket === undefined) {
      bucket = new Bucket(config.buckets[key] ?? config.defaults)
      buckets.set(key, bucket)
    }
    return bucket
  }

  ctx.on('llm/stream', (options: GenerateOptions, next): AsyncIterable<StreamChunk> => {
    return (async function* (): AsyncIterable<StreamChunk> {
      // ★★ **常驻会话（她）照样参与均衡。**
      //
      //   我第一版让她**整个跳过**了 —— 那是错的：用户要的正是
      //   「**main** 同时使用 R1 / V3.2 / V3」，而**她一个回合发 5~10 条**、
      //   是最容易撞 TPM 的那个 ⇒ **她才是最需要均衡的人**。
      //
      //   她得到的优待是**不排队**（下面那处），不是"不换模型"。
      const isResident = options.sessionId === config.residentSessionId
      const tokens = estimateTokens(options)

      // ── ① 均衡：在等价候选里挑一个（没配组 ⇒ 只有自己）────────────
      //
      // ★★ **组从 TCB 读** —— 那是"某个 agent 用哪些模型"的**唯一真相源**。
      //   在插件里再写一份映射就是同一个事实两处，必然分叉。
      //   `groups()` 每次调用重建索引（只有几个 TCB），所以**改了 tcb.json 立刻生效**。
      const group = ctx.tcb.groups().get(keyOf(options.provider, options.model))
      const candidates: readonly Candidate[] = group ?? [{ provider: options.provider, model: options.model }]
      let picked: Candidate = { provider: options.provider, model: options.model }
      try {
        const now = Date.now()
        const offers = candidates.map((candidate): Offer => {
          const key = keyOf(candidate.provider, candidate.model)
          const bucket = bucketFor(candidate.provider, candidate.model)
          const at = cooling.get(key)
          return {
            key,
            waitMs: bucket.check(tokens, now).waitMs,
            headroom: bucket.headroom(now),
            cooling: at !== undefined && now - at < config.cooldownMs,
          }
        })
        const index = pickBest(offers)
        if (index !== undefined) picked = candidates[index] ?? picked
      } catch {
        // ★★ 均衡器出问题 ⇒ 用原来的模型继续（取舍 3）。
      }

      // ★ 换模型：`llm/stream` 的终端 `next()` 闭包捕获的是**同一个 options 对象**
      //   （`llm/src/index.ts:1136-1141`）⇒ 在 `next()` 之前改就生效。
      //   而"这次用了哪个模型"由 `request/header` 进 log ⇒ 不破坏可重放性。
      options.provider = picked.provider
      options.model = picked.model

      // ── ② 限速：**她优先、不排队**；后台那几路排队等（取舍 1、2）────
      const bucket = bucketFor(picked.provider, picked.model)
      if (!isResident) {
        const deadline = Date.now() + config.maxWaitMs
        for (;;) {
          let waitMs = 0
          let blockedBy: string | undefined
          try {
            const verdict = bucket.check(tokens, Date.now())
            waitMs = verdict.waitMs
            blockedBy = verdict.blockedBy
          } catch {
            // ★★ 限速器自己出问题必须放行（取舍 3）—— 绝不许阻断出网。
            break
          }
          if (waitMs === 0) break
          if (Date.now() + waitMs > deadline) {
            // 等太久了 ⇒ **放行**：宁可冒险，也不许把后台那几路卡死。
            ctx.logger.warn(
              `llm-throttle: 排队超上限放行（${blockedBy ?? '?'}，${keyOf(picked.provider, picked.model)}）`,
            )
            break
          }
          await sleep(waitMs)
        }
      }

      // ★ **她也要计数** —— 不排队不等于不占额度。少算她那一份的话，
      //   后台那几路会以为还有余量，于是**替她**把 429 招来。
      bucket.enter(tokens, Date.now())
      try {
        // ── ③ 盯住流：429 ⇒ 把这个模型**关进冷却**，别马上再碰它 ────
        for await (const chunk of next()) {
          if (chunk.type === 'finish' && chunk.reason !== undefined && chunk.reason.kind === 'error') {
            const failure = chunk.reason.failure
            if (isRateLimited(failure)) {
              cooling.set(keyOf(picked.provider, picked.model), Date.now())
              ctx.logger.warn(
                `llm-throttle: ${keyOf(picked.provider, picked.model)} 被限速，冷却 ${String(config.cooldownMs)}ms`,
              )
            }
          }
          yield chunk
        }
      } finally {
        bucket.leave()
      }
    })()
  })
}
