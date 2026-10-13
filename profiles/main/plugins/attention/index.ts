/**
 * `attention` 能力 seam：响应侧 —— 订阅感知条目，决定什么值得打断她。
 *
 * ## 它是什么 / 不是什么
 *
 * **是**：注意力分配器。订阅 `perception/notice`，按优先级仲裁，
 * 然后唤醒 agent（`followup`）。
 *
 * **不是**：
 * - **不做采集也不做渲染** —— 那是 `perception` 的事。这里只拿到渲染好的文本
 * - **不认识任何具体领域** —— 它不知道 QQ 存在。这正是它从 `qq/` 搬出来的原因
 * - **不做抢占** —— fork / resume / 合并是 M5。这里只有"唤醒"与"排队"
 *
 * ## 它曾经错在哪（重写的原因）
 *
 * 旧版 `qq/attention` 订阅的是 `ctx.on('qq/message')` —— **QQ 领域的原始事件**，
 * 完全绕过了感知层。所以它天生只能服务 QQ，新闻/手表/手机推上来的东西全收不到，
 * 而且它自己渲染消息正文、往正文里硬塞行为指令。
 *
 * ## `priority: 0` 怎么交付（这里的关键判断）
 *
 * `0` 的语义是"**不因它自己而唤醒**"，不是"永不交付"。所以：
 *
 * | 本轮由谁发起 | 怎么做 |
 * |:--|:--|
 * | `idle`（闲时定时器） | **要唤醒** —— 这就是"她定期四处看看"。0 级内容随这次交付 |
 * | `signal`（领域推的唤醒信号） | 只有 `highest > 0` 才唤醒；纯 0 级就留在队列里，等下次闲时 |
 *
 * 没有 `trigger` 这个区分，0 级条目就永远交付不出去（它不唤醒，而它又只能
 * 从闲时拉取里产生）。
 *
 * ## 队列不变量
 *
 * 0 级条目**最多一条、保留最新**（用户定案）。见 `queue.ts`。
 *
 * ## 导出形态
 *
 * 遵守 DSH 的 service 包约定。**不具名导出**。
 *
 * @module attention
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Config as ConfigSchema, type Config } from './config.ts'
import { PendingQueue, type PendingItem } from './queue.ts'
import type { PerceptionNotice } from '../perception/types.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** 由感知层渲染的简报推进来的消息。 */
    perception: { kind: 'perception', domain: string }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 响应侧：注意力分配。 */
    attention: Attention
  }
}

/**
 * 注意力分配器，注册为 `ctx.attention`。
 */
export class Attention extends Service {
  static Config: z<Config> = ConfigSchema

  /** 依赖感知层（要订阅它的事件）、agent 注册表（要唤醒）、数据库（读会话指针）。 */
  static inject = ['perception', 'agents', 'db']

  private readonly config: Config
  private readonly queue: PendingQueue

  /**
   * @param ctx - 本插件的上下文。
   * @param config - 配置。
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'attention')
    this.config = config
    this.queue = new PendingQueue(config.queueCapacity)
  }

  /** 当前排队数量（诊断用）。 */
  get pending(): number {
    return this.queue.size
  }

  /**
   * 找一个可以投递的 agent。
   *
   * 顺序：配置的 `sessionId` → 数据库里的当前会话指针 → 恰好一个在册 agent。
   * 都不成立时返回 `undefined`（并记日志），**不抛错** —— 启动早期没人可投
   * 是正常状态，不是故障。
   *
   * @returns 目标 agent；找不到时 `undefined`。
   */
  private targetAgent(): Agent | undefined {
    const all = this.ctx.agents.list()
    const wanted = this.config.sessionId !== ''
      ? this.config.sessionId
      : this.ctx.db.sessionPointer.get()

    if (wanted !== undefined && wanted !== '') {
      const found = all.find(agent => agent.id === wanted)
      if (found !== undefined) return found
      this.ctx.logger.warn(
        `attention: 配置/记录的会话 "${wanted}" 不在册，跳过投递（在册 ${String(all.length)} 个）`,
      )
      return undefined
    }

    if (all.length === 1) return all[0]
    if (all.length > 1) {
      this.ctx.logger.warn(
        `attention: 期望恰好一个 agent，实际 ${String(all.length)} 个；`
        + '请配 sessionId 或让数据库里的当前会话指针指向一个在册的',
      )
    }
    return undefined
  }

  /**
   * 决定要不要交付，要则唤醒 agent。
   *
   * @param item - 队首待交付项。
   * @returns 真的交付了返回 `true`。
   */
  private deliver(item: PendingItem): boolean {
    const agent = this.targetAgent()
    if (agent === undefined) return false

    agent.followup(createUserMessage({
      content: [{ type: 'text', text: item.notice.text }],
      source: { kind: 'perception', domain: item.notice.signals[0]?.domain ?? 'perception' },
    }))
    return true
  }

  /**
   * 收一条感知条目：入队，然后按 `trigger` 与优先级决定要不要现在交付。
   *
   * @param notice - 感知条目。
   */
  private onNotice(notice: PerceptionNotice): void {
    if (notice.signals.length === 0) return
    this.queue.push(notice)

    // 闲时定时器发起的那次**要交付** —— 0 级内容正是靠它送达。
    // 领域推的唤醒信号只有在真的有非 0 级时才叫醒她。
    if (notice.trigger === 'signal' && notice.highest === 0) return

    const item = this.queue.drain()
    if (item === undefined) return
    if (this.deliver(item)) {
      this.ctx.logger.info(
        `attention: 已交付（trigger=${notice.trigger}，highest=${String(notice.highest)}，`
        + `剩 ${String(this.queue.size)} 条待交付）`,
      )
    }
  }

  /**
   * 构造完成之后运行：订阅感知条目。
   *
   * 监听器**自己包 try/catch** —— cordis 的 `emit` 用 `Array.map`，
   * 一个监听器抛错会饿死后面的（`LlmRuntime` 源码里有这条注释）。
   */
  async *[Service.init](): AsyncGenerator<() => void, void, void> {
    const off = this.ctx.on('perception/notice', (notice) => {
      try {
        this.onNotice(notice)
      } catch (error) {
        // 一个条目投递失败不该影响后续条目。
        this.ctx.logger.warn(
          'attention: 处理感知条目失败：%o',
          error instanceof Error ? error.message : String(error),
        )
      }
    })
    yield off
  }
}

export default Attention
