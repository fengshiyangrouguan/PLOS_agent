/**
 * 出网**自我限速 ＋ 同族模型均衡** —— 让 429 不再打穿她，同时不牺牲响应速度。
 *
 * ## 为什么需要它（实测 2026-10-15）
 *
 * 硅基流动的限速**按模型**给，而官方文档明说 `DeepSeek R1` / `DeepSeek V3`
 * 这一类**限速是固定的**（花月消费也提不上去）。L0 档实测：
 *
 *     主模型 deepseek-ai/DeepSeek-V3.2   RPM 1,000   TPM **100,000**
 *     识图   Qwen/Qwen3-VL-…             RPM 1,000   TPM  **80,000**
 *
 * ★ **RPM 一千完全不是瓶颈，TPM 才是墙。** 探针量到请求体约 **162 KB**
 * ⇒ 按 4 字符/令牌估，**一条约 40,000 令牌**：
 *
 *     100,000 ÷ 40,000 ≈ **每分钟 2.5 个请求**
 *
 * 而她的一个回合要发 5~10 条 ⇒ **必然撞墙**。撞墙之后：
 *
 *     429(code 50602) → pi-ai 退避重试 6 次（+1/2/5/7 秒）→ **放弃**
 *       探针原样：`消息=175` 连续 6 次、全 429；最后一次 11:33:44 之后
 *       **到 11:37:46 一个请求都没有** ⇒「发了消息她半天不理」
 *
 * ## 两半挂在**两个不同的 seam**（这一条是被真机故障逼出来的）
 *
 * | | seam | 为什么是它 |
 * |:--|:--|:--|
 * | **均衡（选模型）** | **`agent/request`** | ★ 它**就是**决定 `provider`/`model` 的地方（`tcb.apply` 在同一个瀑布里设 temperature），返回**覆盖字段**是这个 seam 的**文档化用法**；而且它**不需要知道是谁在问** |
 * | **限速（排队等）** | **`llm/stream`** | ★ 它有 **`sessionId`** ⇒ 才能实现"配额让给她"。而它在这里**只推迟、绝不改写** |
 *
 * ⚠️ **第一版把两件都放在 `llm/stream` 里、并改写 `options.provider/model`** ——
 * **那是错的，而且错得很贵**：真机上表现为「`attention: 已交付` 成功两次、
 * VLM 两次调用都 200、**但主模型一条请求都没到网络**」⇒ 她醒了却不说话。
 *
 * 从探针**一条记录都没有**（连失败的都没有）能看出：请求**在出网之前**就构造不出来。
 * 根因是我把 `llm/stream` 的 `options` 当成可改的了 —— 那个先例
 * （`account-routing` 的 `ctx.on('llm/stream', r => adapter.stream(r))`）是**换掉整个流**，
 * **不是改 `options`**。DSH 的规矩也写着 **"new behavior goes on documented extension points"**。
 *
 * ## 模型组只配在 TCB 里
 *
 * `data/tcb.json` 的 `models`（**第一个是默认**，后面轮换）是
 * "某个 agent 用哪些模型"的**唯一真相源**；本插件读 `ctx.tcb.groups()`。
 * 在插件里再写一份映射就是同一个事实两处，必然分叉。
 *
 * ★ **组内必须可互换**（同一份 messages / tools 都得吃得下）。
 *
 * @module llm-throttle
 */

import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'

/** 插件名。 */
export const name = 'llm-throttle'

/** `llm`（限速：`llm/stream`）、`tcb`（模型组的唯一来源）。 */
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
   * ★ 常驻会话（她）的 `sessionId`：**它不排队**。
   *
   * 配额紧张时先扣后台那几路（VLM / planner / 快照）——
   * 它们晚一点没关系，"她在说话"那条路晚一点就是"她不回人"。
   *
   * ★ 但她**照样参与均衡**（那是她不变慢的唯一手段）—— 优待只是"不排队"。
   */
  residentSessionId: string
  /** 默认桶（`buckets` 里没写到的模型用它）。 */
  defaults: BucketConfig
  /** ★ **按 `provider/model` 的覆盖** —— 硅基是**按模型**限速的。 */
  buckets: Record<string, BucketConfig>
  /** 被 429 拒过的模型**冷却多久**（毫秒）。 */
  cooldownMs: number
  /** 单次排队的上限（毫秒）—— 超过就**放行**（宁可冒险，也不许把人卡死）。 */
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
 *
 * @param options - 带 `messages` 的载荷。
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
  /** 剩余余量（0~1，越大越宽裕）。 */
  readonly headroom: number
  /** 是否在 429 冷却里。 */
  readonly cooling: boolean
}

/**
 * 挑一个候选：**先排除在冷却里的，再取等得最少的，并列时取余量最大的**。
 *
 * ★ **并列时保留最先的那个** ⇒ 没有理由时**不换模型**（第一个就是默认，
 * 所以行为与不装均衡器时一致）。
 *
 * **纯函数** ⇒ 能离线自检。
 *
 * @param offers - 每个候选此刻的报价，顺序与候选列表一致。
 * @returns 选中的下标；空数组返回 `undefined`。
 */
export function pickBest(offers: readonly Offer[]): number | undefined {
  if (offers.length === 0) return undefined
  const warm = offers.map((offer, index) => ({ offer, index })).filter(entry => !entry.offer.cooling)
  // ★ 全在冷却里 ⇒ **不挑等于不发**：退回到全部候选（宁可碰一次，也不要卡住人）。
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
   * 还剩多少余量（0~1）。用**剩余 TPM 比例** —— TPM 才是那堵墙。
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
 * 认不出只是**不冷却**（退化成纯轮转），不会更坏。
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

  // ── ① **均衡**：挂 `agent/request`（文档化的"决定用哪个模型"的 seam）────
  //
  //   返回**覆盖字段**是它的用法（`tcb.apply` 就在同一个瀑布里设 temperature）。
  //   ★ 这里**不需要知道是谁在问** —— 所以它不碰 `sessionId`
  //   （那正是它该待在 `agent/request` 而不是 `llm/stream` 的原因之一）。
  ctx.on('agent/request', async (_payload, next) => {
    const resolved = await next()
    try {
      const group = ctx.tcb.groups().get(keyOf(resolved.provider, resolved.model))
      if (group === undefined || group.length < 2) return resolved

      const now = Date.now()
      const offers = group.map((candidate): Offer => {
        const key = keyOf(candidate.provider, candidate.model)
        const bucket = bucketFor(candidate.provider, candidate.model)
        const at = cooling.get(key)
        return {
          key,
          // 这里只需要"谁更宽裕"，用估算令牌 0 问（真正的预算在 `llm/stream` 扣）。
          waitMs: bucket.check(0, now).waitMs,
          headroom: bucket.headroom(now),
          cooling: at !== undefined && now - at < config.cooldownMs,
        }
      })
      const index = pickBest(offers)
      if (index === undefined) return resolved
      const picked = group[index]
      if (picked === undefined) return resolved
      if (picked.provider === resolved.provider && picked.model === resolved.model) return resolved

      // ★★ **每次都记一行** —— 第一版失败时**一点痕迹都没有**，
      //   那本身就是缺陷（因为"没发请求"和"发了但没记录"分不开）。
      ctx.logger.info(
        `llm-throttle: 均衡 ${keyOf(resolved.provider, resolved.model)} → ${keyOf(picked.provider, picked.model)}`
        + `（余量 ${String(Math.round((offers[index]?.headroom ?? 0) * 100))}%）`,
      )
      return { ...resolved, provider: picked.provider, model: picked.model }
    } catch (error) {
      // ★★ 均衡器自己出问题 ⇒ **用原来的模型继续**（绝不阻断）。
      ctx.logger.warn(
        'llm-throttle: 均衡失败，用原模型继续：%o',
        error instanceof Error ? error.message : String(error),
      )
      return resolved
    }
  })

  // ── ② **限速**：挂 `llm/stream`，**只推迟、绝不改写** ─────────────────
  ctx.on('llm/stream', (options: GenerateOptions, next): AsyncIterable<StreamChunk> => {
    return (async function* (): AsyncIterable<StreamChunk> {
      let tokens = 0
      try {
        tokens = estimateTokens(options)
      } catch {
        // 估不出来就算了 —— 当作 0 令牌，仍然会被 RPM 闸住。
      }

      // ★★ **她优先、不排队**；后台那几路排队等。
      const isResident = options.sessionId === config.residentSessionId
      const bucket = bucketFor(options.provider, options.model)
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
            // ★★ 限速器自己出问题必须放行（绝不许阻断出网）。
            break
          }
          if (waitMs === 0) break
          if (Date.now() + waitMs > deadline) {
            ctx.logger.warn(
              `llm-throttle: 排队超上限放行（${blockedBy ?? '?'}，${keyOf(options.provider, options.model)}）`,
            )
            break
          }
          ctx.logger.debug(
            `llm-throttle: 排队 ${String(waitMs)}ms（${blockedBy ?? '?'}，${keyOf(options.provider, options.model)}）`,
          )
          await sleep(waitMs)
        }
      }

      // ★ **她也要计数** —— 不排队不等于不占额度。
      bucket.enter(tokens, Date.now())
      try {
        for await (const chunk of next()) {
          // ★ 429 ⇒ 把这个模型**关进冷却**，别马上再碰它。
          if (chunk.type === 'finish' && chunk.reason !== undefined && chunk.reason.kind === 'error') {
            if (isRateLimited(chunk.reason.failure)) {
              cooling.set(keyOf(options.provider, options.model), Date.now())
              ctx.logger.warn(
                `llm-throttle: ${keyOf(options.provider, options.model)} 被限速，冷却 ${String(config.cooldownMs)}ms`,
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
