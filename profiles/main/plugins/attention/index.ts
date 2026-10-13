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
 * ## `priority: 0` 怎么交付（**不需要区分"谁发起的拉取"**）
 *
 * `0` 的语义是「**不产生它自己的那次唤醒**」，不是「永不交付」——
 * 0 级的领域**根本没有推唤醒信号的路径**（推信号就得带 > 0 的优先级），
 * 它的内容只搭下一次唤醒的便车。
 *
 * 而拉取永远返回**全部当前信号**，所以：
 *
 * ```
 * 信号发起的拉取  ⟹  那条被推的信号必在结果里且 priority > 0  ⟹  highest > 0
 * highest === 0   ⟹  不可能是信号发起的  ⟹  只可能是定时器（那次"四处看看"本来就要叫她）
 * ```
 *
 * **所以交付规则里不需要"谁发起的"这个信息 —— 它可以由 `highest` 推出来。**
 * 给条目塞一个 `trigger` 字段是把可推导的东西又存了一份，是冗余。
 * 规则因此化简成一句：**收到条目就尝试交付队首**。
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
import { planPreemption, withWrapupHint } from './preempt.ts'
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

  /** 依赖感知层（订阅事件）、agent 注册表（唤醒）、指针栈（找当前会话）。 */
  static inject = ['perception', 'agents', 'pointer']

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
      : this.ctx.pointer.current?.sessionId

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
   * 交付一条：按抢占计划决定要不要带收尾提示。
   *
   * @param item - 队首待交付项。
   * @param withHint - 是否在正文末尾拼上收尾提示。
   * @returns 真的交付了返回 `true`。
   */
  private deliver(item: PendingItem, withHint: boolean): boolean {
    const agent = this.targetAgent()
    if (agent === undefined) return false

    const text = withHint ? withWrapupHint(item.notice.text) : item.notice.text
    agent.followup(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'perception', domain: item.notice.signals[0]?.domain ?? 'perception' },
    }))
    return true
  }

  /**
   * 收一条感知条目：入队，然后按忙闲与优先级决定怎么处理。
   *
   * **不区分"谁发起的拉取"** —— 那个信息可由 `highest` 推出（见模块注释）。
   * 但**要区分她忙不忙**：忙的时候 0 级不抢占（`planPreemption` 返回 `queue`），
   * 因为抢占也是一种唤醒，而 0 级的语义就是不产生自己的唤醒。
   *
   * @param notice - 感知条目。
   */
  private onNotice(notice: PerceptionNotice): void {
    if (notice.signals.length === 0) return
    this.queue.push(notice)

    const peeked = this.queue.peek()
    if (peeked === undefined) return

    const agent = this.targetAgent()
    // 找不到目标时不动队列 —— 留着，等有 agent 了再投。
    if (agent === undefined) return

    const plan = planPreemption(agent.status, peeked.notice.highest)
    if (plan.kind === 'queue') return

    const item = this.queue.drain()
    if (item === undefined) return

    const withHint = plan.kind === 'wrapup-then-preempt'
    if (this.deliver(item, withHint)) {
      this.ctx.logger.info(
        `attention: 已交付（${plan.kind}，highest=${String(item.notice.highest)}，`
        + `收尾提示=${withHint ? '有' : '无'}，剩 ${String(this.queue.size)} 条待交付）`,
      )
    } else {
      // 目标中途消失 —— 把条目放回去，别丢。
      this.queue.push(item.notice, item.queuedAt)
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
