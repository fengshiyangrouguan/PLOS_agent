/**
 * `pointer` 能力 seam：**当前注意力指针**（抢占式嵌套的栈）。
 *
 * ## 为什么是 `data/` 里的文件，不进数据库
 *
 * 用户定案（docs/m5-preemption.md §13.1）：
 *
 * > **`data/` 的一个文件，不需要进数据库。** 数据库是存**会话记录、图片、表情包等
 * > 大批量内容**用的；**TCB 只是一个配置**，最好**显式在外 `data/` 里保存方便修改**。
 *
 * 判据是"**要不要给人改**"，不是"是不是状态"。指针栈和 TCB 落在同一层。
 *
 * ## 它不认识 TCB
 *
 * 帧上**带** `tcb` 字段（诊断与将来的路由用），但**本插件不解释它** ——
 * TCB 的语义（一份配置 = 一个身份）属于另一块。这里只负责"栈的存取"。
 *
 * ## 崩溃安全
 *
 * 每次改动**立即**落盘（写临时文件再改名，避免半截文件）。
 * 指针丢了等于"忘了自己在干什么"，比一次多余的 IO 贵得多。
 *
 * ## 导出形态
 *
 * 遵守 DSH 的 service 包约定。**不具名导出**。
 *
 * @module pointer
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { Config as ConfigSchema, type Config } from './config.ts'
import { PointerStack, type PointerFrame, type SettleAction } from './stack.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 当前注意力指针（抢占式嵌套的栈）。 */
    pointer: Pointer
  }
}

/**
 * 指针栈设施，注册为 `ctx.pointer`。
 */
export class Pointer extends Service {
  static Config: z<Config> = ConfigSchema

  private readonly config: Config
  private stack: PointerStack

  /**
   * @param ctx - 本插件的上下文。
   * @param config - 配置。
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'pointer')
    this.config = config
    // 先空栈；`load()` 在 Service.init 里跑（那时 logger 才可用）。
    this.stack = new PointerStack()
  }

  /**
   * 构造完成之后运行：载入存档，`yield` 出的函数无事可做（每次改动即时落盘）。
   */
  async *[Service.init](): AsyncGenerator<() => void, void, void> {
    yield () => { /* 每次改动已即时落盘，没有待清理的资源 */ }
    this.load()
  }

  /** 全部帧（自下而上，栈顶=当前）。 */
  get frames(): readonly PointerFrame[] {
    return this.stack.frames
  }

  /** 当前正在跑的那一层。 */
  get current(): PointerFrame | undefined {
    return this.stack.current
  }

  /** 被冻结在下面的层。 */
  get frozen(): readonly PointerFrame[] {
    return this.stack.frozen
  }

  /** 嵌套深度。 */
  get depth(): number {
    return this.stack.depth
  }

  /**
   * 中断：压入新层，它成为当前。
   * @param frame - 新层。
   */
  push(frame: PointerFrame): void {
    this.stack.push(frame)
    this.persist()
  }

  /**
   * 完成当前层：算出该做什么。
   * @returns 结清计划。
   */
  planSettle(): SettleAction {
    return this.stack.planSettle()
  }

  /**
   * 应用一次完成并落盘。
   *
   * @param plan - `planSettle()` 的返回值。
   * @param product - 结清产物的会话 id。
   * @param tcb - 产物的 TCB。
   * @returns 结清后成为当前的帧。
   */
  settle(plan: SettleAction, product: string, tcb: string): PointerFrame | undefined {
    const current = this.stack.applySettle(plan, product, tcb)
    this.persist()
    return current
  }

  /** 清空（测试 / 重置用）。 */
  clear(): void {
    this.stack = new PointerStack()
    this.persist()
  }

  /** 从存档载入；坏数据记警告并留空栈。 */
  private load(): void {
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(this.config.path, 'utf8')) as unknown
    } catch (error) {
      // 文件不存在是**正常**的（首次运行）；其它错误说明存档坏了。
      const code = (error as { code?: string }).code
      if (code !== 'ENOENT') {
        this.ctx.logger.warn(
          'pointer: 存档读取失败，按空栈继续：%o',
          error instanceof Error ? error.message : String(error),
        )
      }
      return
    }

    const { stack, restored } = PointerStack.fromJSON(raw)
    if (!restored) {
      this.ctx.logger.warn(`pointer: 存档形状不对（${this.config.path}），按空栈继续`)
      return
    }
    this.stack = stack
    this.ctx.logger.info(
      `pointer: 已恢复 ${String(stack.depth)} 层，当前 = ${stack.current?.sessionId ?? '(无)'}`,
    )
  }

  /** 落盘（临时文件 + 改名，避免半截文件）。 */
  private persist(): void {
    const body = `${JSON.stringify(this.stack.toJSON(), null, 2)}\n`
    try {
      mkdirSync(dirname(this.config.path), { recursive: true })
      const tmp = `${this.config.path}.tmp`
      writeFileSync(tmp, body, 'utf8')
      renameSync(tmp, this.config.path)
    } catch (error) {
      // 落盘失败**不能吞** —— 指针丢了等于"忘了自己在干什么"。
      this.ctx.logger.error(
        'pointer: 落盘失败 —— 指针栈可能丢失：%o',
        error instanceof Error ? error.message : String(error),
      )
    }
  }
}

export default Pointer
