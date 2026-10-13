/**
 * `pointer` 能力 seam：**当前注意力焦点** —— 白羽现在在哪个会话上。
 *
 * ## 它不再是栈
 *
 * 它**曾经**是一个栈：每层中断 fork 一个新会话、压一帧、逐层结清。
 * 那个模型（docs/m5-preemption.md §6–§19）**已被"注意力转移"模型取代**（§20）——
 * 根因是它把 RTOS 的性质当成了人的性质：RTOS 的中断处理程序**必须短**，
 * 而人的高优先级事务（写代码、急症）**恰恰是长的，且几乎不会被打断**。
 *
 * 现在**只有一个主 agent、一个会话**，所以"当前焦点"就是一个值。
 *
 * ## ★ 为什么还留着（而不是删掉）
 *
 * `ctx.agents.list()` **不再是单义的**：写待办的快照 subagent 也是一个在册 agent。
 * 所以"**哪个才是白羽**"必须有一个明确的答案，这就是本 seam 的唯一职责。
 *
 * （旧模型里 `pointer` 还负责"会话 id 一直在变"这件事 —— 结清会产出新会话。
 * 注意力模型没有结清，**会话 id 变成稳定的**，那条职责随之消失。）
 *
 * ## 为什么是 `data/` 里的文件，不进数据库
 *
 * 判据是"**要不要给人改**"（docs/m5-preemption.md §13.1）：数据库存会话记录、
 * 图片、表情包这类大批量内容；焦点是小的、显式的、排障时要直接看的。
 *
 * ## 崩溃安全
 *
 * 每次改动**立即**落盘（写临时文件再改名，避免半截文件）。
 * 焦点丢了等于"忘了自己是谁"，比一次多余的 IO 贵得多。
 *
 * ## 导出形态
 *
 * 遵守 DSH 的 service 包约定。**不具名导出**。
 *
 * @module pointer
 */

import { recordStartupLine } from '../_startup-log.ts'
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { Config as ConfigSchema, type Config } from './config.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 当前注意力焦点。 */
    pointer: Pointer
  }
}

/** 当前焦点。 */
export interface FocusFrame {
  /** 焦点所在的会话 id —— 也就是那个主 agent 的 id（两者被注册表强制相等）。 */
  readonly sessionId: string
  /**
   * 这一层属于哪个 TCB（稳定身份）。
   *
   * 身份在 TCB 上、不在会话 id 上（docs/m5-preemption.md §12.2）：
   * 会话 id 是"注意力在哪"，TCB 是"是谁"。
   */
  readonly tcb: string
  /** 最后更新时间（毫秒）。 */
  readonly updatedAt: number
}

/**
 * 注意力焦点设施，注册为 `ctx.pointer`。
 */
export class Pointer extends Service {
  static Config: z<Config> = ConfigSchema

  private readonly config: Config
  private frame: FocusFrame | undefined

  /**
   * @param ctx - 本插件的上下文。
   * @param config - 配置。
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'pointer')
    this.config = config
    // 先空；`load()` 在 Service.init 里跑（那时 logger 才可用）。
    this.frame = undefined
  }

  /**
   * 构造完成之后运行：载入存档。
   *
   * `yield` 出的函数无事可做 —— **每次改动即时落盘**，没有待清理的资源。
   */
  async *[Service.init](): AsyncGenerator<() => void, void, void> {
    yield () => { /* 每次改动已即时落盘 */ }
    this.load()
  }

  /** 当前焦点；还没设过时为 `undefined`。 */
  get current(): FocusFrame | undefined {
    return this.frame
  }

  /**
   * 设置焦点并立即落盘。
   *
   * @param frame - 新焦点。
   */
  set(frame: FocusFrame): void {
    this.frame = frame
    this.persist()
  }

  /** 清空（测试 / 重置用）。 */
  clear(): void {
    this.frame = undefined
    this.persist()
  }

  /** 从存档载入；文件不存在是正常的，形状不对记警告并留空。 */
  private load(): void {
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(this.config.path, 'utf8')) as unknown
    } catch (error) {
      // 文件不存在是**正常**的（首次运行）；其它错误说明存档坏了。
      const code = (error as { code?: string }).code
      if (code !== 'ENOENT') {
        this.ctx.logger.warn(
          'pointer: 存档读取失败，按"无焦点"继续：%o',
          error instanceof Error ? error.message : String(error),
        )
      }
      return
    }

    if (typeof raw !== 'object' || raw === null) {
      this.ctx.logger.warn(`pointer: 存档形状不对（${this.config.path}），按"无焦点"继续`)
      return
    }
    const candidate = raw as Record<string, unknown>
    if (typeof candidate['sessionId'] !== 'string' || typeof candidate['tcb'] !== 'string') {
      this.ctx.logger.warn(`pointer: 存档形状不对（${this.config.path}），按"无焦点"继续`)
      return
    }

    this.frame = {
      sessionId: candidate['sessionId'],
      tcb: candidate['tcb'],
      updatedAt: typeof candidate['updatedAt'] === 'number' ? candidate['updatedAt'] : 0,
    }
    recordStartupLine(`pointer: 已恢复焦点 = ${this.frame.sessionId}（tcb ${this.frame.tcb}）`)
  }

  /** 落盘（临时文件 + 改名，避免半截文件）。 */
  private persist(): void {
    const body = `${JSON.stringify(this.frame ?? null, null, 2)}\n`
    try {
      mkdirSync(dirname(this.config.path), { recursive: true })
      const tmp = `${this.config.path}.tmp`
      writeFileSync(tmp, body, 'utf8')
      renameSync(tmp, this.config.path)
    } catch (error) {
      // 落盘失败**不能吞** —— 焦点丢了等于"忘了自己是谁"。
      this.ctx.logger.error(
        'pointer: 落盘失败 —— 焦点可能丢失：%o',
        error instanceof Error ? error.message : String(error),
      )
    }
  }
}

export default Pointer
