/**
 * 指针栈：抢占式嵌套的"当前注意力指针"。
 *
 * ## 为什么是栈
 *
 * 对齐 RTOS（docs/m5-preemption.md §6）：
 *
 * | RTOS | 我们 |
 * |:--|:--|
 * | **压栈**（帧留在栈上，移动 SP） | **fork**（被中断的层留在栈上，指针下沉） |
 * | **弹栈**（逐层回到外层） | **内层完成 → 指针上浮** |
 * | **SP** | **指针**（本模块的 `running` 下标） |
 *
 * **关键同构**：RTOS 压栈时**被中断的帧原封不动**——这和"append-only log 停止写入
 * 就是快照"是同一件事。所以"保存快照"不是一个操作，**它就是不再写**。
 *
 * ## 操作规则（从设计的推演表反推出来的）
 *
 * 栈按时间自下而上排；`running` 指向**当前正在跑的那一层**。
 *
 * ```
 * 中断   新层成为 running（旧层原封不动留在下面）
 * 完成   running 那层【与它上面所有已完成的层】结清成一个产物，放在当前位置
 *        running 上浮一格
 * 结束   running 落到栈底之下 → 产物就是最终的 M，栈空
 * ```
 *
 * **推演用户的例子**（A 跑 → B 中断 → C 中断 → C 完成 → B 完成 → A 完成）：
 *
 * | 时刻 | frames | running | 动作 |
 * |:--|:--|:--|:--|
 * | A 跑 | `[A]` | 0 | |
 * | B 中断 | `[A, B]` | 1 | |
 * | C 中断 | `[A, B, C]` | 2 | |
 * | C 完成 | `[A, B, C]` | 1 | **上面没有东西可结清** → 只上浮 |
 * | B 完成 | `[A, B1]` | 0 | **B 与其上的 C 结清为 B1** → 上浮 |
 * | A 完成 | `[]` | — | **A 与其上的 B1 结清为 M** → 栈空 |
 *
 * 每一步都与用户给的括号结构 `【A 【B中断 C中断 B恢复】BC合并为B1 A恢复】A和B1合并`
 * 一一对应。
 *
 * ## 纯逻辑
 *
 * 不认识 cordis、不碰文件系统 —— 可离线自检（`tests/stack.spec.ts`）。
 * 持久化在 `index.ts`。
 *
 * @module pointer/stack
 */

/** 栈里的一层。 */
export interface PointerFrame {
  /**
   * 会话 id —— **这就是"指针的值"（SP）**。
   *
   * 注意它**不是身份**：结清会产出新会话、换新 id。身份在 `tcb` 上（见下）。
   */
  readonly sessionId: string
  /**
   * 这一层属于哪个 TCB（稳定身份）。
   *
   * **嵌套不跨 TCB**（docs/m5-preemption.md §13.3），所以一段连续嵌套里
   * 这个值是同一个。跨 TCB 走的是**阻塞式工具调用**，不进这个栈。
   */
  readonly tcb: string
  /** 压栈时间（毫秒）。 */
  readonly pushedAt: number
  /** 为什么压上来（诊断用，例如 `'preempt by priority 20'`）。 */
  readonly reason: string
}

/** 完成一层之后该做什么。 */
export type SettleAction =
  /** 上面还有已完成的层 —— 先与它们结清，产物放在当前位置，然后上浮。 */
  | { readonly kind: 'settle', readonly sessionIds: readonly string[], readonly at: number }
  /** 上面没有东西可结清 —— 只上浮。 */
  | { readonly kind: 'pop', readonly at: number }
  /** 这是最后一层 —— 产物就是最终的 M，栈清空。 */
  | { readonly kind: 'final', readonly sessionId: string }

/**
 * 指针栈。
 *
 * 不可变风格的读、显式的写 —— 每次写都返回新状态由调用方持久化。
 */
export class PointerStack {
  #frames: PointerFrame[]
  #running: number

  /**
   * @param frames - 初始帧（自下而上）。默认空栈。
   * @param running - 初始 running 下标。默认指向栈顶。
   */
  constructor(frames: readonly PointerFrame[] = [], running?: number) {
    this.#frames = [...frames]
    this.#running = running ?? this.#frames.length - 1
  }

  /** 全部帧（自下而上）。 */
  get frames(): readonly PointerFrame[] {
    return this.#frames
  }

  /** 当前正在跑的那一层；栈空时为 `undefined`。 */
  get current(): PointerFrame | undefined {
    return this.#running >= 0 ? this.#frames[this.#running] : undefined
  }

  /** 当前 running 下标（诊断用）。 */
  get runningIndex(): number {
    return this.#running
  }

  /** 被冻结在下面的层（自下而上）；栈空或只有一层时为空。 */
  get frozen(): readonly PointerFrame[] {
    return this.#running > 0 ? this.#frames.slice(0, this.#running) : []
  }

  /** 层数。 */
  get depth(): number {
    return this.#frames.length
  }

  /**
   * 中断：压入新层，它成为 running。
   *
   * **不碰下面的帧** —— 被中断的层原封不动（这就是"快照"）。
   *
   * @param frame - 新层。
   */
  push(frame: PointerFrame): void {
    // 中断发生在 running 那层；它上面的已完成层要保留。
    const above = this.#frames.slice(this.#running + 1)
    this.#frames = [...this.#frames.slice(0, this.#running + 1), frame, ...above]
    this.#running += 1
  }

  /**
   * 完成一层之后该怎么走 —— **只算，不改**。
   *
   * @returns 该做什么。
   */
  planSettle(): SettleAction {
    if (this.#running < 0) return { kind: 'final', sessionId: '' }
    const mine = this.#frames[this.#running]
    /* v8 ignore next -- running 与 frames 由本类共同维护，不会脱节。 */
    if (mine === undefined) return { kind: 'final', sessionId: '' }

    const above = this.#frames.slice(this.#running + 1)
    if (above.length === 0) {
      return this.#running === 0
        ? { kind: 'final', sessionId: mine.sessionId }
        : { kind: 'pop', at: mine.pushedAt }
    }
    return {
      kind: 'settle',
      sessionIds: [mine.sessionId, ...above.map(frame => frame.sessionId)],
      at: mine.pushedAt,
    }
  }

  /**
   * 应用一次完成：按 `planSettle()` 的结果改写状态。
   *
   * @param plan - `planSettle()` 的返回值。
   * @param product - 结清产物的会话 id（`kind === 'final'` 或 `'settle'` 时必需）。
   * @param tcb - 产物的 TCB（沿用被结清层的）。
   * @param now - 时间戳（毫秒）。注入以便自检。
   * @returns 结清后成为 running 的帧；栈已空时 `undefined`。
   */
  applySettle(
    plan: SettleAction,
    product: string,
    tcb: string,
    now: number = Date.now(),
  ): PointerFrame | undefined {
    if (plan.kind === 'pop') {
      this.#running -= 1
      return this.current
    }

    if (plan.kind === 'final') {
      this.#frames = []
      this.#running = -1
      return undefined
    }

    // settle：把 running 及其上所有层压成一个产物，放在 running 的位置
    const kept = this.#frames.slice(0, this.#running)
    const frame: PointerFrame = {
      sessionId: product,
      tcb,
      pushedAt: now,
      reason: `settled ${String(plan.sessionIds.length)} frames`,
    }
    this.#frames = [...kept, frame]
    // 下面没有层时，产物**自己就是当前指针** —— 所以 running 落在它身上（0），
    // 而不是越界到 -1。
    //
    // 与设计推演表的一处**有意偏差**：表里写的是「A 完成 → 栈 []，指针 → M」，
    // 这里保留成「栈 [M]，running=0」。语义等价（栈深 1 = 没有嵌套），
    // 但 `current` 永远有值，不必在空栈时另设一个"当前"字段。
    this.#running = Math.max(0, kept.length - 1)
    return this.current
  }

  /** 序列化成可持久化的普通对象。 */
  toJSON(): { frames: PointerFrame[], running: number } {
    return { frames: this.#frames.map(frame => ({ ...frame })), running: this.#running }
  }

  /**
   * 从持久化形状恢复。
   *
   * **容错**：形状不对时返回空栈而不是抛错 —— 指针坏了不该让进程起不来，
   * 但调用方应当记警告（说明栈丢了）。
   *
   * @param raw - 反序列化出来的值。
   * @returns 栈，以及是否成功恢复。
   */
  static fromJSON(raw: unknown): { stack: PointerStack, restored: boolean } {
    if (typeof raw !== 'object' || raw === null) return { stack: new PointerStack(), restored: false }
    const candidate = raw as { frames?: unknown, running?: unknown }
    if (!Array.isArray(candidate.frames)) return { stack: new PointerStack(), restored: false }

    const frames: PointerFrame[] = []
    for (const item of candidate.frames) {
      if (typeof item !== 'object' || item === null) return { stack: new PointerStack(), restored: false }
      const frame = item as Record<string, unknown>
      if (typeof frame['sessionId'] !== 'string' || typeof frame['tcb'] !== 'string') {
        return { stack: new PointerStack(), restored: false }
      }
      frames.push({
        sessionId: frame['sessionId'],
        tcb: frame['tcb'],
        pushedAt: typeof frame['pushedAt'] === 'number' ? frame['pushedAt'] : 0,
        reason: typeof frame['reason'] === 'string' ? frame['reason'] : '',
      })
    }

    const running = typeof candidate.running === 'number' && Number.isInteger(candidate.running)
      ? candidate.running
      : frames.length - 1
    const clamped = Math.max(-1, Math.min(running, frames.length - 1))
    return { stack: new PointerStack(frames, clamped), restored: true }
  }
}
