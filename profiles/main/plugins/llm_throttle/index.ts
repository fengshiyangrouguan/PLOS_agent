/**
 * 出网**自我限速** —— 让 429 不再打穿她。
 *
 * ## 为什么需要它（实测 2026-10-15）
 *
 * 硅基流动的限速是**按模型**的（RPM / TPM），而且官方文档明说
 * **`DeepSeek R1` / `DeepSeek V3` 这一类"限速是固定的"** —— 花月消费也提不上去。
 * 于是配额紧张时的真实链条是：
 *
 * ```
 * 一个逻辑请求 → 429 → pi-ai 退避重试 6 次（+1/2/5/7 秒）→ **放弃**
 *             ⇒ 那一步失败，之后**几分钟没有请求**
 *             ⇒ 你那边看到「发了消息她半天不理」
 *             ⇒ 再发一条，新回合恰好赶上配额恢复 ⇒「再发一条就全收到了」
 * ```
 *
 * 探针里抓到的原样：`消息=175` 连续 6 次、间隔 0.5~7 秒、全 429，
 * 最后一次 `11:33:44` 之后**到 `11:37:46` 一个请求都没有**。
 *
 * ⇒ **我们的目标不是"守规矩"，是"不再被 429 打穿"**：把请求**排在本地**，
 * 让它慢一点但**每次都成**。
 *
 * ## 四条取舍
 *
 * | # | 取舍 | 理由 |
 * |:--|:--|:--|
 * | 1 | 超预算**排队等**，不是拒绝 | 拒绝 = 又是一次失败重试，正是病灶 |
 * | 2 | ★ **配额让给她**（常驻会话不排队） | VLM / planner / 快照都是后台的，不该挤掉"她在说话"那条路 |
 * | 3 | ★ **限速器自己出问题必须放行** | 与探针同一条纪律：**绝不许阻断出网** |
 * | 4 | 数字全进 `Config` | 限额**按账号档位**变，写死就是错的 |
 *
 * ## 一个容易搞错的地方
 *
 * ⚠️ 硅基是**按模型**限速的，而我们的 `llm-pi-ai` 里 **VLM 与主模型共用同一个
 * provider 条目** ⇒ 额度要按 **`provider + model`** 分桶，**不能只按 provider**。
 *
 * @module llm-throttle
 */

import type { Context } from '@deepseek-ai/cordis'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'

/** 插件名。 */
export const name = 'llm-throttle'

/** 只要 `llm` 这个 seam —— 它提供 `llm/stream` 瀑布。 */
export const inject = ['llm']

/** 一个桶（provider + model）的预算。 */
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
   * ★★ **开关**：`false` ⇒ 一个监听器都不挂，**彻底不介入**。
   *
   * 这是"可打开"的实现方式 —— 默认关着，因为我们**不知道你的账号档位**；
   * 打开之前请先从硅基控制台抄你那一档的 RPM/TPM 进来。
   */
  enabled: boolean
  /**
   * ★ 常驻会话（她）的 `sessionId`：**它不排队**。
   *
   * 配额紧张时先扣后台那几路（VLM / planner / 快照）——
   * 它们晚一点没关系，"她在说话"那条路晚一点就是"她不回人"。
   */
  residentSessionId: string
  /** 默认桶。 */
  defaults: BucketConfig
  /**
   * ★ **按 `provider/model` 的覆盖** —— 硅基是**按模型**限速的。
   *
   * 键写成 `provider/model`（例如 `siliconflow/Qwen/Qwen3-VL-32B-Instruct`）。
   */
  buckets: Record<string, BucketConfig>
  /**
   * 单次排队的上限（毫秒）—— 超过就**放行**（宁可冒险，也不许把她卡死）。
   */
  maxWaitMs: number
}

/** 配置 schema。 */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
  residentSessionId: z.string().default('plos'),
  defaults: z.object({
    perMinute: z.natural().default(30),
    tokensPerMinute: z.natural().default(60_000),
    maxConcurrent: z.natural().default(4),
  }).default({ perMinute: 30, tokensPerMinute: 60_000, maxConcurrent: 4 }),
  buckets: z.dict(z.object({
    perMinute: z.natural(),
    tokensPerMinute: z.natural(),
    maxConcurrent: z.natural(),
  })).default({}),
  maxWaitMs: z.natural().default(20_000),
})

/**
 * 估算一次请求的令牌数。
 *
 * 不求精确 —— 我们要的是**量级正确**（决定"这一分钟还能不能再塞一个"）。
 * 用字符数 / 4 是业界常用粗估：中文偏低估、英文偏准，而 TPM 预算本来就留余量。
 *
 * @param options - `llm/stream` 的载荷。
 * @returns 估算的令牌数。
 */
export function estimateTokens(options: { messages?: readonly unknown[] }): number {
  const chars = JSON.stringify(options.messages ?? []).length
  return Math.ceil(chars / 4)
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
      // 并发满了：等最短的那条出窗口（用 RPM 窗口当上界，实际由调用方重试）。
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

/** 睡一会儿。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/**
 * 装好限速器。
 *
 * @param ctx - 插件上下文。
 * @param config - 见 {@link Config}。
 */
export function apply(ctx: Context, config: Config): void {
  // ★ 关掉就是**彻底不介入** —— 连监听器都不挂。
  if (!config.enabled) return

  const buckets = new Map<string, Bucket>()

  /** 取这个 `provider/model` 的桶（**按模型分** —— 见模块注释那个坑）。 */
  const bucketFor = (provider: string, model: string): Bucket => {
    const key = `${provider}/${model}`
    let bucket = buckets.get(key)
    if (bucket === undefined) {
      bucket = new Bucket(config.buckets[key] ?? config.defaults)
      buckets.set(key, bucket)
    }
    return bucket
  }

  ctx.on('llm/stream', (options, next): AsyncIterable<StreamChunk> => {
    return (async function* (): AsyncIterable<StreamChunk> {
      // ★★ **常驻会话不排队** —— 配额让给她（取舍 2）。
      const isResident = options.sessionId === config.residentSessionId
      if (isResident) {
        yield* next()
        return
      }

      const tokens = estimateTokens(options)
      const bucket = bucketFor(options.provider, options.model)
      const deadline = Date.now() + config.maxWaitMs

      // ★ 排队等，而不是拒绝（取舍 1）。
      for (;;) {
        let verdict: { waitMs: number, blockedBy: string | undefined }
        try {
          verdict = bucket.check(tokens, Date.now())
        } catch {
          // ★★ **限速器自己出问题必须放行**（取舍 3）—— 绝不许阻断出网。
          break
        }
        if (verdict.waitMs === 0) break
        if (Date.now() + verdict.waitMs > deadline) {
          // 等太久了 ⇒ **放行**（宁可冒险，也不许把她卡死）。
          ctx.logger.warn(
            `llm-throttle: 排队超上限放行（${verdict.blockedBy ?? '?'}，${options.provider}/${options.model}）`,
          )
          break
        }
        await sleep(verdict.waitMs)
      }

      bucket.enter(tokens, Date.now())
      try {
        yield* next()
      } finally {
        bucket.leave()
      }
    })()
  })
}
