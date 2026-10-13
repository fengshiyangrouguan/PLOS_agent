/**
 * `attention` 能力 seam：响应侧 —— 订阅感知条目，决定什么值得把她的注意力牵走。
 *
 * ## 它是什么 / 不是什么
 *
 * **是**：注意力分配器。订阅 `perception/notice`，按优先级仲裁，然后叫醒 agent。
 *
 * **不是**：
 * - **不做采集也不做渲染** —— 那是 `perception` 的事。这里只拿到渲染好的文本
 * - **不认识任何具体领域** —— 它不知道 QQ 存在。这正是它从 `qq/` 搬出来的原因
 * - **不做 fork / 结清 / 中断交代** —— 那整套是旧模型，**已被取代**
 *
 * ## ★ 模型已换成"注意力转移"（docs/m5-preemption.md §20）
 *
 * 旧模型照搬 RTOS：中断 = 抢占，父层结束 turn → fork 新层 → 逐层结清 →
 * 回来时注入一句交代。**它把一个罕见的情形当成了主路径**：
 *
 * > RTOS 的中断处理程序**必须短**，所以"存上下文 / 恢复上下文"值这个钱。
 * > **而人的高优先级事务恰恰是长的** —— 写代码、处理急症 ——
 * > **它们几乎不会被打断。**
 *
 * 新模型的支点是一句话：**优先级 = 注意力大小。** 于是：
 *
 * - **不再 fork** —— 一个主 agent、一个会话，她自己在同一个上下文里切换注意力
 * - **不再有"交代"** —— 交代是"看不到下层"的补丁；**没有 fork 就没有"看不到"**
 * - **`steer` 是软的** —— 交到她手上，答一句就回来是自然的
 * - **`≥ m` 才硬切** —— 系统出问题那一类必须打断，走 `cancel`
 *
 * **回来的保证交给了另一条路**：`> n` 的原任务被中断时记一条**待办**
 * （`record` 标志，见 `preempt.ts`），超时没回来就把待办浮进上下文。
 * **用一条恢复路径换掉了整套上下文冻结机制。**
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
 * 给条目塞一个 `trigger` 字段是把可推导的东西又存了一份。
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
import {
  URGENT_HINT, WRAPUP_HINT, planTransfer, withHint, type TransferPlan,
} from './preempt.ts'
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

  /** 依赖感知层（订阅事件）、agent 注册表（叫醒）、注意力焦点（找当前那个 agent）。 */
  static inject = ['perception', 'agents', 'pointer']

  private readonly config: Config
  private readonly queue: PendingQueue

  /**
   * **激活当前 turn 的那个信号的优先级** —— 也就是"她手上这件事的注意力大小"。
   *
   * `decisions §14` A1：**turn 继承激活它的信号的优先级**。它是 `n` 那条线的判据
   * （原任务 `> n` 才记待办）。
   *
   * ⚠️ **只在内存里**：重启后回落到 `0`。后果是"重启后的第一次中断可能少记一条待办"
   * —— 只会漏记，不会丢事，所以不值得为它加持久化。
   */
  private currentPriority = 0

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

  /** 当前 turn 的注意力大小（诊断用）。 */
  get priority(): number {
    return this.currentPriority
  }

  /**
   * 找一个可以投递的 agent。
   *
   * 顺序：配置的 `sessionId` → 注意力焦点（`ctx.pointer`）→ 恰好一个在册 agent。
   * 都不成立时返回 `undefined`（并记日志），**不抛错** —— 启动早期没人可投
   * 是正常状态，不是故障。
   *
   * **为什么要先读焦点**：写待办的**快照 subagent 也是一个在册 agent**，
   * 所以 `agents.list()` 不是单义的。
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
        + '请配 sessionId 或让注意力焦点指向一个在册的',
      )
    }
    return undefined
  }

  /**
   * 交付一条。
   *
   * ## 三种做法，对应三种"注意力会不会被牵走"
   *
   * | 档 | 用什么 | 效果 |
   * |:--|:--|:--|
   * | `deliver` | `followup` | 她闲着 —— 开一个新 turn |
   * | `steer` | `steer` | **软**：插进当前 turn 的下一个 step，她可以选择答一句就回来 |
   * | `cancel` | `cancel` + `steer` | **硬**：先中止她的 turn，再把内容交给她 |
   *
   * **`cancel` 之后仍然要投递**，否则那条紧急信息就没送到。
   * DSH 的语义正好支持："Waking input submitted after active cancellation is
   * queued for the next turn and runs when the aborted activity converges to idle."
   *
   * **取消原因是 `hook` 而不是 `disposed`** —— `disposed` 会把这个 agent 停掉，
   * 而我们要的只是中止这一轮。
   *
   * @param item - 队首待交付项。
   * @param plan - `planTransfer` 的结果。
   * @returns 真的交付了返回 `true`。
   */
  private deliver(item: PendingItem, plan: TransferPlan): boolean {
    const agent = this.targetAgent()
    if (agent === undefined) return false

    const domain = item.notice.signals[0]?.domain ?? 'perception'
    const message = (text: string): ReturnType<typeof createUserMessage> => createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'perception', domain },
    })

    if (plan.kind === 'cancel') {
      agent.cancel({
        kind: 'hook',
        reason: `attention: 紧急中断（highest=${String(item.notice.highest)}）`,
      })
      agent.steer(message(withHint(item.notice.text, URGENT_HINT)))
    } else if (plan.kind === 'steer') {
      agent.steer(message(withHint(item.notice.text, WRAPUP_HINT)))
    } else {
      agent.followup(message(item.notice.text))
    }

    // 这一轮（或接下来这一轮）的注意力大小就是本条目的优先级。
    this.currentPriority = item.notice.highest
    return true
  }

  /**
   * 收一条感知条目：入队，然后按忙闲与优先级决定怎么处理。
   *
   * **不区分"谁发起的拉取"** —— 那个信息可由 `highest` 推出（见模块注释）。
   * 但**要区分她忙不忙**：忙的时候 0 级不牵走注意力（`planTransfer` 返回 `queue`），
   * 因为牵走注意力也是一种唤醒，而 0 级的语义就是不产生自己的唤醒。
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

    const plan = planTransfer(
      agent.status,
      this.currentPriority,
      peeked.notice.highest,
      { pendingThreshold: this.config.pendingThreshold, urgentThreshold: this.config.urgentThreshold },
    )
    if (plan.kind === 'queue') return

    const item = this.queue.drain()
    if (item === undefined) return

    if (this.deliver(item, plan)) {
      const record = plan.kind === 'deliver' ? false : plan.record
      this.ctx.logger.info(
        `attention: 已交付（${plan.kind}${record ? '，该记待办' : ''}，`
        + `highest=${String(item.notice.highest)}，原任务=${String(this.currentPriority)}，`
        + `剩 ${String(this.queue.size)} 条待交付）`,
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
