/**
 * `interrupt_plan` 能力 seam：**被中断的任务的待办** —— 注意力转移模型的恢复路径。
 *
 * ## 它是什么 / 不是什么
 *
 * **是**：§20.7 那条恢复路径的落地。原任务优先级 `> n`（`attention` 判的）时，
 * 在**中断那一刻**起一个快照 subagent 看住"她当时在干什么"；
 * 中断超过 `T` 还没回来，就让那个 subagent 把它写成一条待办，
 * **浮进她下一次唤醒的上下文**，于是她想起来还有件事没做完。
 *
 * **不是**：
 * - **不做仲裁** —— 要不要记待办、用 `steer` 还是 `cancel`，都是 `attention` 的事
 * - **不 fork 上下文** —— 快照 subagent 只是一个"看住现场"的观察者，
 *   它既不是白羽、也不参与她的会话（旧模型的 fork/结清/合并已随 §20 一起死掉）
 * - **不搬上下文回来** —— 只给 `sessionId` + turn/seq 坐标，细节她自己调工具取（§20.10）
 *
 * ## ★ 为什么是"中断那一刻"起 subagent，而不是等超时
 *
 * §20.4 的原话：**"写待办的 subagent 在【中断那一刻】启动 —— subagent 的上下文在
 * 启动时取定，所以它拿到的正是'中断前'的状态。"**
 *
 * 这是 §7.2 那条洞见的搬运：**必须在上下文还完整时生成**。
 * 等 `T` 到了再让她回忆，中断自己的过程已经把上下文搅了，
 * 而且她可能已经不记得刚刚在干什么了。**同一条原则，换了个便宜得多的位置。**
 *
 * 代价是"每次都起一个 subagent"，但 `T` 内回来了就**一次模型调用都不花**
 * （那个 subagent 只是建好了坐在那里，没被叫过）。
 *
 * ## ★ 那条边界必须是【同步】取的（这一步的坑）
 *
 * `attention` 先 `steer` 再把条目交给这里，所以 `note` 跑的时候
 * **中断消息可能已经进了主会话的 log**。真那样，快照就变成"被打断之后"的状态，
 * 整个机制的意义反过来了。
 *
 * 已查实（`agent-loop/src/agent.ts:154-161, 214-234`）：
 * `steer()` 只是 `inbox.splice` + 唤醒，**它自己一条 log 都不写**；
 * 而 `wakeDriver` 的 `this.kick()` 虽然当场调用，但 `kick` 是 async 函数
 * ——**函数体推迟到微任务**。所以同一个同步块里 `snapshotEvents()`
 * 拿到的事件数与 `steer` 之前**完全相同**。
 *
 * 结论：`note` 里的 `snapshotEvents()` 必须**在本函数内同步执行**
 * （不是丢进 `queueMicrotask`、也不是先 `await` 任何东西），
 * 否则边界就可能落到那一步之后。
 *
 * ## ★ 为什么不动 `ctx.pointer`
 *
 * `pointer` 回答的是"**哪个才是白羽**"（`agents.list()` 因为有本插件的快照 subagent
 * 而不再是单义的）。**快照 subagent 不是白羽** —— 它是本插件造的一个工具。
 * 所以这里**只建 agent、不动焦点**，那份焦点在整个待办窗口里始终指着白羽。
 *
 * ## 生命周期
 *
 * 一个待办要照看三件东西：**定时器**（`T`）、**创建的 promise**、**subagent 的句柄**。
 * 三个都可能在"创建还没返回"时就被卸载，所以卸载时先清定时器、再等创建落定、
 * 最后 dispose —— 不留孤儿 agent（照 `qq/resident` 的写法）。
 *
 * ## 导出形态
 *
 * 遵守 DSH 的 service 包约定。**不具名导出**。
 *
 * @module interrupt_plan
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { randomUUID } from 'node:crypto'
import { markOf, type SessionMark } from '../_session-mark.ts'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { Config as ConfigSchema, type Config } from './config.ts'
import { parseWhat, renderPlan, writerTaskFor, type PlanCoordinates } from './render.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** 由本插件浮进上下文的一条待办。 */
    'interrupt-plan': { kind: 'interrupt-plan', planId: string }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 中断待办：注意力转移模型的恢复路径。 */
    interruptPlan: InterruptPlan
  }
}

/** 一次中断里要记的东西。 */
export interface InterruptNote {
  /** 被打断的那个 agent（白羽）。 */
  readonly agent: Agent
  /**
   * **中断的原因** —— 感知层渲染好的简报正文。
   *
   * 必须由调用方给：快照 subagent 的上下文取定于中断之前，**那条中断消息不在里面**
   * （它读到的是"她当时在干什么"，读不到"什么事打断了她"）。
   */
  readonly why: string
  /** 打断信号的优先级（诊断用）。 */
  readonly priority: number
}

/** 一个进行中的待办。 */
interface Pending {
  /** 被打断的那个 agent（白羽）—— 待办最后要浮进它的上下文。 */
  readonly agent: Agent
  /** 中断那一刻的坐标与原因。 */
  readonly coordinates: PlanCoordinates
  readonly why: string
  readonly priority: number
}

/**
 * ⚠️ **"坐标 + seed 必须一起取定"这条不变量现在住在共享模块里。**
 *
 * 它原先在这里是一个 `Snapshot` 接口 —— 为的是把"`note()` 算坐标、
 * `createChild()` 又重算一遍"这条**跨函数的隐式时序约束**变成显式的。
 * 那在今天是对的，**只因为 `createChild` 的第一个 `await` 恰好排在那之后** ——
 * 有人在它前面插一个 `await`（或一个 `void` 掉的 promise），边界就静默后移，
 * **快照变成"被打断【之后】"的状态，整个机制的意义反过来**，而且不报错。
 *
 * 现在 `last_shutdown` 也要用同一份坐标，于是它搬到了
 * [`markOf()`](../_session-mark.ts)：那边一次 `snapshotEvents()` 把
 * **坐标和 seed 一起**返回，**调用方无法把它拆开**。
 *
 * 本文件只需要记住一条：**`markOf()` 必须同步调**（不要在 `await` 之后）。
 */

/**
 * 中断待办设施，注册为 `ctx.interruptPlan`。
 */
export class InterruptPlan extends Service {
  static Config: z<Config> = ConfigSchema

  /**
   * 依赖 agent 注册表（建快照 subagent）、数据库（写待办）、TCB（拿 planner 的模型）、
   * 注意力焦点（**临死前要知道"哪个才是白羽"才能记坐标**）。
   */
  static inject = ['agents', 'db', 'tcb', 'pointer']

  private readonly config: Config

  /** 进行中的待办：`id` → 中断那一刻取定的东西。 */
  private readonly pending = new Map<string, Pending>()
  /** 各自的 `T` 定时器。 */
  private readonly timers = new Map<string, NodeJS.Timeout>()
  /** 各自"建快照 subagent"的 promise（**已吞掉失败**，卸载时才 await）。 */
  private readonly creating = new Map<string, Promise<void>>()
  /** 各自的 subagent 句柄；创建落定后才有。 */
  private readonly children = new Map<string, AgentHandle>()
  /** 卸载后到达的定时器 / 创建结果一律作废。 */
  private disposed = false

  /**
   * @param ctx - 本插件的上下文。
   * @param config - 配置。
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'interruptPlan')
    this.config = config
  }

  /** 当前有几条待办窗口开着（诊断用）。 */
  get open(): number {
    return this.pending.size
  }

  /**
   * 构造完成之后运行：起 TTL 清扫定时器，并交出卸载清理。
   *
   * 两个定时器都在 `yield` **之前**建好 —— 这样"创建了却没被清理"的窗口为零。
   * 清扫只是卫生（过期本来就由 `list()` 的 `settled_at IS NULL` 与
   * `renderPlan` 自己兜住），所以它放在 `yield` 之后也无所谓。
   */
  async *[Service.init](): AsyncGenerator<() => void | Promise<void>, void, void> {
    const sweep = setInterval(() => {
      try {
        const dropped = this.ctx.db.interruptPlans.expire(Date.now())
        if (dropped > 0) this.ctx.logger.info(`interrupt-plan: 清扫掉 ${String(dropped)} 条过期待办`)
      } catch (error) {
        this.ctx.logger.warn(
          'interrupt-plan: TTL 清扫失败：%o',
          error instanceof Error ? error.message : String(error),
        )
      }
    }, this.config.sweepIntervalMs)

    // ★ 这里**故意不订阅 `agent/status`**。
    //
    // 一度想过"她回到 `idle` 就把待办收掉"，那是**错的**：§20.3 情形② 明说
    // 「就简发个消息，然后就回来继续聊天了……**AI 自己思维链注入了性格后
    // 选不选回来就是他的问题了**」。也就是说**"她空下来了"不等于"她回去做那件事了"**
    // —— 她完全可能答一句就停在那里，那件被打断的事仍然没做完。
    // 真收了待办，"她想起来还有件事没做完"这条恢复路径就断了。
    //
    // 所以"这次中断结没结"只能靠 `T` 之外的**真实判据**，而眼下没有那个判据
    // —— 留给下一轮（一个已知的粗糙处，见 `note` 的说明）。

    yield async () => {
      this.disposed = true
      clearInterval(sweep)

      // 每条待办各自照看三样东西（定时器 / 创建中的 promise / subagent 句柄），
      // 而它们的状态在"创建还没返回"时是分裂的 —— 所以逐条撤。
      // 先 `await` 掉在途的创建，下面收回来的句柄才齐；`#createChild` 里那句
      // `!this.pending.has(id)` 兜住的是"等这一刻才浮出来的"那一批。
      await Promise.allSettled([...this.creating.values()])
      for (const id of [...this.timers.keys(), ...this.pending.keys(), ...this.children.keys()]) {
        this.cancel(id)
      }
      this.timers.clear()
      this.pending.clear()
      this.creating.clear()
    }

    this.ctx.logger.info(
      `interrupt-plan: 就绪（T=${String(Math.round(this.config.timeoutMs / 1000))}s，`
      + `TTL=${String(Math.round(this.config.planTtlMs / 3_600_000))}h，`
      + `planner=${this.config.plannerTcb}）`,
    )
  }

  /**
   * 记一次中断：**同步取边界**，然后异步起快照 subagent 并等 `T`。
   *
   * ## ⚠️ 一处已知的粗糙：`T` 只看时间，不看"这次中断结没结"
   *
   * §20.4 的台阶是「**中断 < T 丢弃**」。严格读它需要"这次中断什么时候结束"这个
   * 判据，而眼下**没有**：`agent/status` 回到 `idle` 不等于她回去做原来那件事了
   * （§20.3 情形② 明说"选不选回来是他自己的问题"）。
   *
   * 所以现状是：**`T` 到点就写**。好处是"她答一句就停在那里"这种情形
   * 一定会被提醒到（这正是要的）；代价是"她真回去做完了、然后闲下来"
   * 也会多出一条待办 —— 那时待办还躺在表里，但**它浮进上下文之后她自己会判断**
   * （`renderPlan` 结尾那句"要不要接着做由你决定"就是给这个留的），而且
   * TTL 一天后会过期清掉。**不做无谓的机制**，等实测看到真问题时再补判据。
   *
   * @param note - 被打断的 agent、中断的原因、那一刻的优先级。
   * @returns 这次中断的编号。
   */
  note(note: InterruptNote): string {
    // ★ **这一句**里取定一切：坐标 + seed，一次 `snapshotEvents()`。
    //   那条不变量现在住在 `markOf()` 里 —— 见文件顶部那段说明。**必须同步调。**
    const mark = markOf(note.agent)
    const id = randomUUID()
    this.pending.set(id, {
      agent: note.agent,
      coordinates: { sessionId: mark.sessionId, turn: mark.turn, seq: mark.seq },
      why: note.why,
      priority: note.priority,
    })

    // 起快照 subagent。存的是"已经吞掉失败"的那一条 ——
    // 卸载时 `await` 它不会因为失败而炸。
    const creating = this.createChild(id, note.agent, mark)
      .catch((error: unknown) => {
        // 建不起来只损失这一次待办 —— 她的会话本来就还留着那件被打断的事（§20.7）。
        this.ctx.logger.warn(
          `interrupt-plan: 快照 subagent 创建失败（${id}）：%o`,
          error instanceof Error ? error.message : String(error),
        )
      })
      .finally(() => {
        this.creating.delete(id)
      })
    this.creating.set(id, creating)

    const timer = setTimeout(() => {
      void this.fire(id)
    }, this.config.timeoutMs)
    this.timers.set(id, timer)

    this.ctx.logger.info(
      `interrupt-plan: 已记下中断（${id}，第 ${String(mark.turn)} 轮，`
      + `seq=${String(mark.seq)}，priority=${String(note.priority)}）`
      + `—— ${String(Math.round(this.config.timeoutMs / 1000))}s 后写待办`,
    )
    return id
  }

  /**
   * 撤掉一条还没到点的待办，并尽量收掉它已经建出来的快照 subagent。
   *
   * **眼下唯一的调用方是卸载路径**（`Service.init` 的 disposer）。刻意留成一个
   * 具名私有方法而不是把清理摊在 disposer 里，是因为清理有两条分支
   * （句柄已出 / 句柄还没出）—— 摊开会让 disposer 变成一段它自己都读不清的循环。
   *
   * ⚠️ 它**不是**留给"这次中断结了"用的：那个判据眼下不存在，见 {@link note}。
   *
   * 句柄未出时不能只靠 `#createChild` 里那句 `!this.pending.has(id)` 兜底 ——
   * 那个检查发生在 `create` 落定之后，中间隔着一次完整 await。
   *
   * @param id - {@link note} 返回的编号。
   */
  private cancel(id: string): void {
    const timer = this.timers.get(id)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.timers.delete(id)
    }
    this.pending.delete(id)

    const handle = this.children.get(id)
    if (handle !== undefined) {
      this.children.delete(id)
      void handle.dispose().catch((error: unknown) => {
        this.ctx.logger.warn(
          'interrupt-plan: 撤销时销毁快照 subagent 失败：%o',
          error instanceof Error ? error.message : String(error),
        )
      })
      return
    }

    // 句柄还没出来 —— 让创建路径落定后自己认领。
    const creating = this.creating.get(id)
    if (creating !== undefined) {
      void creating.then(() => { this.reap(id) })
    }
  }

  /**
   * 建快照 subagent。
   *
   * `seed` = 中断那一刻的主会话前缀 + 合成收尾（`buildForkSeed`，在 `markOf()` 里做）。
   * 它 `meta.isSeeded` 且 `inheritedEventCount = boundary + 1`，
   * 形状照 `session-controller/src/commands.ts:266-284`。
   *
   * **模型走 planner TCB**（§12.2"任务总结用小模型单独产生一个 TCB 一个配置"）。
   * TCB 的段落白名单只留最小一份，**不给 identity** —— 它是工具，不是白羽。
   *
   * @param id - 这次中断的编号。
   * @param parent - 白羽。
   * @param mark - **中断那一刻**取定的坐标与 seed（不由本函数重算）。
   */
  private async createChild(id: string, parent: Agent, mark: SessionMark): Promise<void> {
    const tcb = this.ctx.tcb.get(this.config.plannerTcb)
    if (tcb === undefined) {
      this.ctx.logger.warn(
        `interrupt-plan: TCB "${this.config.plannerTcb}" 不在目录里，`
        + '快照 subagent 回落到没有模型选项（那一轮会构造不出请求）',
      )
    }

    const created = await this.ctx.agents.create({
      sessionId: SessionId(`interrupt-plan-${id}`),
      seed: [...mark.seed],
      inheritedEventCount: SessionLogOffset(mark.boundary + 1),
      parentAgent: parent,
      meta: { isSeeded: true, parentSession: parent.session.id },
      ...tcb === undefined ? {} : {
        agentOptions: {
          provider: tcb.model.provider,
          model: tcb.model.model,
          ...tcb.model.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: ReasoningEffortId(tcb.model.reasoningEffort) },
        },
      },
      ...tcb === undefined ? {} : { setup: (agentCtx: Context) => { this.ctx.tcb.apply(agentCtx, tcb) } },
    })

    this.children.set(id, created)

    // 撤销 / 卸载发生在创建返回之前 —— 立刻收掉，别留孤儿。
    //
    // **不 `return`、也不提前 `children.delete`**：让句柄留在表里，卸载那边
    // （`Promise.allSettled` 掉 `creating` 之后）才会把它一并 await 掉。
    // 在这里摘了它，这次 dispose 就变成没人等的浮空 promise。
    if (this.disposed || !this.pending.has(id)) {
      this.children.delete(id)
      await created.dispose()
    }
  }

  /**
   * 收掉一个"撤销之后才浮出来"的句柄。
   *
   * 它是 {@link cancel} 在"句柄未出"那条分支上的补位：那条分支只挂了个
   * `creating.then(...)`，而创建落定后是否真的需要收，得看那一刻 `pending` 还在不在
   * —— 那个判断在 `createChild` 里（它已经 `await created.dispose()` 了），
   * **所以这里多数时候什么都不做**，只有"`children` 里还留着一个该收的句柄"
   * 那一瞬才有活干。
   *
   * @param id - 这次中断的编号。
   */
  private reap(id: string): void {
    if (this.pending.has(id) && !this.disposed) return
    const handle = this.children.get(id)
    if (handle === undefined) return
    this.children.delete(id)
    void handle.dispose().catch((error: unknown) => {
      this.ctx.logger.warn(
        'interrupt-plan: 补收快照 subagent 失败：%o',
        error instanceof Error ? error.message : String(error),
      )
    })
  }

  /**
   * `T` 到点：让快照 subagent 把待办写出来，然后浮进她的上下文。
   *
   * 这里**才发生第一次模型调用**。`T` 内回来了的话，`cancel` 已经把定时器清掉了，
   * 这条路径根本不会跑。
   *
   * @param id - 这次中断的编号。
   */
  private async fire(id: string): Promise<void> {
    this.timers.delete(id)
    const pending = this.pending.get(id)
    if (pending === undefined) return

    // ★ **先等创建落定，再删 `pending`** —— 顺序反了会把这单静默丢掉。
    //
    // `createChild` 末尾用 `!this.pending.has(id)` 判断"这次中断还有效吗"，
    // 所以先删 `pending` 的话，它会立刻把刚建好的孩子 dispose 掉，
    // 下面 `children.get(id)` 就永远拿不到句柄。
    await this.creating.get(id)
    this.pending.delete(id)

    const handle = this.children.get(id)
    if (handle === undefined) {
      this.ctx.logger.warn(
        `interrupt-plan: 待办写不成（${id}）—— 快照 subagent 没建起来（原因见创建时那条告警）`,
      )
      return
    }

    try {
      const child = handle.agent
      child.followup(createUserMessage({
        content: [{ type: 'text', text: writerTaskFor(pending.coordinates) }],
        source: { kind: 'interrupt-plan', planId: id },
      }))
      await child.whenIdle()

      // ★ `what` 来自快照 subagent；`why` **直接用中断那一刻的原话**。
      //   不绕模型一圈 —— 理由见 `render.ts` 的 `WRITER_TASK`。
      const what = parseWhat(this.lastAssistantText(child))
      const now = Date.now()
      const expiresAt = now + this.config.planTtlMs

      // 落定之前先清一遍过期的 —— 别把一条已经没意义的待办端上去。
      this.ctx.db.interruptPlans.expire(now)
      this.ctx.db.interruptPlans.insert({
        ...pending.coordinates,
        priority: pending.priority,
        what,
        why: pending.why,
        ttlMs: this.config.planTtlMs,
      }, now)

      const plan = renderPlan({
        ...pending.coordinates,
        what,
        why: pending.why,
        createdAt: now,
        expiresAt,
      }, now)

      if (plan !== undefined) {
        // `inject` **不唤醒** —— 她闲时等下一次唤醒（`perception` 的闲时定时器，
        // 或下一条信号），正合用（§20.7 的恢复路径就是那么走的）。
        pending.agent.inject(createUserMessage({
          content: [{ type: 'text', text: plan }],
          source: { kind: 'interrupt-plan', planId: id },
        }))
      }

      this.ctx.logger.info(
        `interrupt-plan: 待办已浮进上下文（${id}）—— ${what}`,
      )
    } catch (error) {
      this.ctx.logger.warn(
        `interrupt-plan: 写待办失败（${id}）：%o`,
        error instanceof Error ? error.message : String(error),
      )
    } finally {
      this.children.delete(id)
      await handle.dispose().catch((error: unknown) => {
        this.ctx.logger.warn(
          'interrupt-plan: 销毁快照 subagent 失败：%o',
          error instanceof Error ? error.message : String(error),
        )
      })
    }
  }

  /**
   * 取子会话里**最后一条** assistant 消息的纯文本。
   *
   * @param agent - 快照 subagent。
   * @returns 纯文本；一条都没有时是空串（`parseDraft` 会给占位说明）。
   */
  private lastAssistantText(agent: Agent): string {
    const events = agent.session.snapshotEvents()
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event === undefined || event.type !== 'assistant/message') continue
      return event.data.message.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('\n')
    }
    return ''
  }
}

export default InterruptPlan
