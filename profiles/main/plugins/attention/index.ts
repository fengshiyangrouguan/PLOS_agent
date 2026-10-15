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
/**
 * ★★ **该不该把它补进她正跑的那一轮**（同源补充的判断）。
 *
 * **纯函数**（不碰 agent、不碰时间、不碰队列）⇒ 能离线自检。
 *
 * 两条判据都要满足：
 *
 *   1. ★ **同源**：这条消息的会话 == **她这一轮被唤醒的那个会话**。
 *      这正是必须记 `currentSource` 的原因 —— **优先级说不出是哪个会话** ✗
 *   2. **不更高级**：更高级的东西**可能要中断她**，那是 `planTransfer` 那条路的事，
 *      不是"补一句"
 *
 * @param current - 她当前这一轮的基准；`undefined` = 没有正在跑的一轮。
 * @param source - 这条消息所属会话。
 * @param priority - 这条消息的优先级。
 * @returns 该补返回 `true`。
 */
export function shouldSupplement(
  current: { readonly source: string | undefined, readonly priority: number } | undefined,
  source: string,
  priority: number,
): boolean {
  if (current?.source === undefined) return false
  if (current.source !== source) return false
  return priority <= current.priority
}

export class Attention extends Service {
  static Config: z<Config> = ConfigSchema

  /** 依赖感知层（订阅事件）、agent 注册表（叫醒）、注意力焦点（找当前那个 agent）、
   * 中断待办（`> n` 的原任务被中断时记一条）。 */
  static inject = ['perception', 'agents', 'pointer', 'interruptPlan']

  private readonly config: Config
  private readonly queue: PendingQueue

  /**
   * **她手上这件事的注意力大小** —— 也就是 `n` 那条线（要不要记待办）的基准。
   *
   * ## ⚠️ 它**不**是 `decisions §14` A1 的"turn 继承激活它的信号的优先级"
   *
   * A1 是**旧（fork）模型**的规矩：那时中断会**开一个新的 turn / 一个新层**，
   * 所以"这一轮的优先级"有定义。**无 fork 之后 `steer` 根本不开始新 turn**，
   * 它插进正在跑的那一轮 —— 所以"这一轮"的定义没变，变的只是她同时在处理两件事。
   *
   * 于是这里的取值规则是：**只有真正开了新 turn 才更新**（`deliver` / `cancel`），
   * **`steer` 不更新**。理由是语义的：`n` 问的是「**被打断的那件事**是不是
   * 低注意力的事」，而 `steer` 进来的中断**没有改变那件事是什么**，只是叠在上面。
   *
   * 曾经写成"每次交付都更新"，那是错的 —— 而它恰好在代码自己的提示词制造的
   * 情形里必定错：`WRAPUP_HINT` 明说「**你可以选择不管他**」。她一旦不管、继续干
   * 原来的事，基准却已经变成中断的优先级了。后果是 §20.3 情形① 会复活：
   * 一个 **0 级**原任务吸收过一次 80 级中断并拒绝了它，之后 `n = 20` 时来一条
   * 20 级信号就会记待办 —— 而情形① 说这种**不该记**。
   *
   * （仍然只是估算：她"实际上手了没有"这个判据眼下不存在，见
   * `interrupt_plan` 的 §21.2 ①。但"基准停在原任务上"至少不会主动跑偏。）
   *
   * ⚠️ **只在内存里**：重启后回落到 `0`。DSH 在 SIGINT/SIGTERM 上会优雅关闭
   * （`apps/cli/src/profile-boot.ts:280`），所以那次 turn 确实结束了 ——
   * 回落是对的，代价只是"重启后的第一次中断可能少记一条待办"（只漏不丢）。
   */
  private currentPriority = 0

  /**
   * ★★ **这一轮是被哪个源唤醒的**（`group:<id>` / `private:<id>`）。
   *
   * ★ 这正是当初被我删掉的 `trigger` 字段**该在的地方** —— 当时的理由是
   * "它能从 `highest` 推出来"，**那是错的**：优先级说不出**是哪个会话** ✗。
   * 同源补充（{@link supplement}）全靠它判断。
   *
   * 与 `currentPriority` **同生同死**：只在真的开始/切换一轮的地方赋值。
   */
  private currentSource: string | undefined

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
      // 硬切**结束**了这一轮；下面这句 steer 开的是**新一轮** —— 基准换成它。
      this.currentPriority = item.notice.highest
      this.currentSource = item.notice.signals[0]?.source
    } else if (plan.kind === 'steer') {
      agent.steer(message(withHint(item.notice.text, WRAPUP_HINT)))
      // ★ **不更新基准**：`steer` 不开始新 turn，被打断的那件事没有变
      //   （她甚至可以「不管他」）。判据见 `currentPriority` 的注释。
    } else {
      agent.followup(message(item.notice.text))
      this.currentPriority = item.notice.highest
      this.currentSource = item.notice.signals[0]?.source
    }

    // ★ `> n` 的原任务被中断 —— 记一条待办（§20.4）。
    //
    // **必须在这里、同步地做**：`note` 内部要立刻 `snapshotEvents()` 取边界，
    // 而再晚一点中断消息就进了 log，快照会变成"被打断【之后】"的状态（§20.4 的全部分量）。
    // 已查实 `steer()` 自己一条 log 都不写、`kick` 是 async 所以推迟到微任务
    // （`agent-loop/src/agent.ts:154-161, 214-234`），所以此刻取到的边界
    // 与 `steer` 之前**完全相同**。
    //
    // 位置在投递**之后**：目标不在册时上面已经 return，那次中断根本没发生，
    // 就不该留下一条待办。
    if (plan.kind === 'steer' || plan.kind === 'cancel') {
      if (plan.record) {
        this.ctx.interruptPlan.note({
          agent,
          why: item.notice.text,
          priority: item.notice.highest,
        })
      }
    }

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
  /**
   * ★★ **同源补充**：把一条**消息原文**直接补进她正在跑的那一轮。
   *
   * 与 `onNotice` 那条路不同 —— 那边是"全体 `pull()` ⇒ 每个会话一段**梗概**"；
   * 这里**不拉取、不做梗概**，交过去的就是**消息本身**。
   *
   * ## 什么情况下接
   *
   * `source` 与她**这一轮被唤醒的那个源**相同、且优先级**不高于**当前基准 ——
   * 也就是"**同一个会话里她又说了一句**"。这时：
   *
   *   · **不该排队** —— 排队要等下一条通知才被取（实测表现：「发了消息她半天不理，
   *     我再说一句就全收到了」）
   *   · **也不该整套重拉** —— 那样她只拿到一份梗概，**看不到原文**
   *
   * ⇒ **直接 `steer` 进去** ✓
   *
   * ## 两条边界（用户定案）
   *
   *   · ★ **补即已读**：**调用方**负责 `drain`。不 drain 的话下次 `pull()` 会再带上它
   *     ⇒ 她收到两遍。
   *   · ★ **必须在 `archive` 之后调**：否则她读到的是**没渲染**的内容
   *     （图片会渲染成空描述）。
   *
   * @param domain - 信号域（写进消息来源，排障用）。
   * @param source - 消息所属会话（`group:<id>` / `private:<id>`）。
   * @param text - **消息原文**（已经渲染好的）。
   * @param priority - 这条消息的优先级。
   * @returns 接下了返回 `true`（调用方**不要**再 `wake()`）；不接返回 `false`。
   */
  supplement(domain: string, source: string, text: string, priority: number): boolean {
    const accept = shouldSupplement(
      { source: this.currentSource, priority: this.currentPriority },
      source,
      priority,
    )
    if (!accept) return false
    const agent = this.targetAgent()
    if (agent === undefined) return false

    // ★ **不加 `WRAPUP_HINT`** —— 她是"接着说"，不是被打断，**不该收尾**。
    //   `WRAPUP_HINT` 的语义正是"答一句就回来"，那是对**中断**说的。
    //
    // ★ **不更新 `currentPriority` / `currentSource`** —— `steer` 不开始新 turn，
    //   与 `deliver` 里 `steer` 那一支同理（她甚至可以不管他）。
    agent.steer(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'perception', domain },
    }))
    // ★ 记一行 —— 没有它，"补进去了"与"根本没走这条路"在日志上分不开，
    //   而这个功能**默认不可见**（她那边只表现为"一次答全了"）。
    this.ctx.logger.info(
      `attention: 同源补充（${source}，priority=${String(priority)}，`
      + `基准=${String(this.currentPriority)}，${String(text.length)} 字）`,
    )
    return true
  }

  private onNotice(notice: PerceptionNotice): void {
    if (notice.signals.length === 0) return
    this.queue.push(notice)
    this.attempt()
  }

  /**
   * 试一次投递**队首**。
   *
   * ★★ **两个触发源都要调它**：
   *
   * | 触发 | 含义 |
   * |:--|:--|
   * | `perception/notice` | 有新东西进来了 |
   * | `agent/status → idle` | **她刚空下来** —— 这个曾经**没有** |
   *
   * ★ 缺第二个的后果（实测，真 QQ）：她忙的时候条目进队列，之后**没有任何东西会来取它** ——
   * 队列要等下一条 `perception/notice` 才被重新看一眼。表现是
   * 「**发了消息她半天不理，我再说一句就全收到了**」（因为 `pull()` 返回的是**当前状态**，
   * 那次通知把两条一起带上了）。
   *
   * ⚠️ `agent/status` 每次 turn 结束都会来一次，所以**开头必须先判空队列** ——
   * 否则每次 turn 结束都白跑一次 `targetAgent()`。
   */
  private attempt(): void {
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

    const delivery = this.deliver(item, plan)
    if (delivery) {
      this.ctx.logger.info(
        `attention: 已交付（${plan.kind}${plan.kind === 'deliver' ? '' : `，${plan.record ? '已记待办' : '不记待办'}`}，`
        + `highest=${String(item.notice.highest)}，原任务=${String(this.currentPriority)}，`
        + `剩 ${String(this.queue.size)} 条待交付）`,
      )
    } else {
      // 目标中途消失 —— 把条目放回去，别丢。
      this.queue.push(item.notice, item.queuedAt)
    }
  }

  /**
   * 构造完成之后运行：订阅感知条目**与她的忙闲**。
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

    // ★ **她空下来时再试一次队列** —— 与 `interrupt_plan` 那处同构
    //   （那边早就订了 `agent/status → idle` 来投递待办，`attention` 一直缺）。
    const offIdle = this.ctx.on('agent/status', ({ status }) => {
      if (status !== 'idle') return
      try {
        this.attempt()
      } catch (error) {
        this.ctx.logger.warn(
          'attention: 空闲时投递队列失败：%o',
          error instanceof Error ? error.message : String(error),
        )
      }
    })

    // ★★ **同源补充的接收方** —— 把"同一个会话里她又说了一句"**直接补进她那一轮**。
    //
    //   为什么需要它（两条都是实测过的坏结果）：
    //     · 走正常路（全体 `pull()`）⇒ 她收到的是**梗概**，**看不到原文**
    //     · 排进队列 ⇒ 要等下一条通知才被取 ⇒「发了消息她半天不理，
    //       我再说一句就全收到了」
    //
    //   ★ 判断在**这里**做（不在域里）：只有 attention 知道"她这一轮被谁唤醒的"。
    const offSupplement = this.ctx.perception.onSupplement(
      (domain, source, text, priority) => this.supplement(domain, source, text, priority),
    )

    yield () => {
      off()
      offIdle()
      offSupplement()
    }
  }
}

export default Attention
