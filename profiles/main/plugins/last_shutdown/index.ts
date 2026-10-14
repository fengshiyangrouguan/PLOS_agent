/**
 * `last_shutdown` 能力 seam：**上次进程停止时，她停在哪里**（优雅关闭原理）。
 *
 * ## ★ 为什么它独立于 `interrupt_plan`
 *
 * **语义对不上。** `interrupt_plan` 管的是「被一条**信号**打断」——
 * 有中断正文、有优先级、有快照 subagent、有"她望不望回来"的判断判据。
 * 这里管的是「**进程被关掉了**」—— 没有正文、没有优先级、也没人可问。
 *
 * 两者只在"她被打断过"这个很远的层面上相似。**共用一份代码会让两边都变模糊**：
 * 读 `interrupt_plan` 的人会问"进程关闭跟抢占有什么关系"，
 * 而改 `interrupt_plan` 的人会为一个不属于它的场景动它的判据。
 *
 * ## ★ 它怎么被用（这就是"注入某个接口"）
 *
 * 只有一处消费者：`qq/resident` 在建完常驻会话之后叫一声。
 * 而那一处**用 `ctx.get('lastShutdown')` 拿**（DSH：**可选服务**用 `ctx.get`，
 * `ctx.<name>` 留给已声明的注入）—— 于是：
 *
 * ```
 * 不挂这个插件  → ctx.get 返回 undefined → 那一行短路 → 【影响为零】
 * 挂上它        → 补丁加一行，读 / 写 / 注入全活
 * ```
 *
 * **这就是它作为"非必要插件"的正确形态**：默认不挂，而不是"挂着再关掉"。
 *
 * ## 坐标从哪来
 *
 * 共享模块 `_session-mark.ts` —— 跟 `interrupt_plan` **同一份实现**，不各写一遍。
 * 它一口气把坐标和 fork seed 一起取定，因为那个"同一份 log"的保证不能拆
 * （见那个模块的说明）。
 *
 * ## 生命周期
 *
 * | 时刻 | 做什么 |
 * |:--|:--|
 * | 激活 | 读上次的记录（**这一刻还没有 agent**，所以只读、不注入） |
 * | `announce(agent)` | 由 `qq/resident` 调 —— 注入一次，然后删档 |
 * | 卸载 | **同步**写下这一轮的坐标（关闭路径上不能等异步） |
 *
 * ## ⚠️ 已知的粗糙：分不出"进程真的停了"和"HMR 重载了本插件"
 *
 * 见 {@link recordShutdown}。**这是它默认不挂的主要原因** —— 不是功能不对，
 * 是**触发判据在开发期不可靠**（而我们开发期一直开着 HMR）。
 *
 * ## 导出形态
 *
 * 遵守 DSH 的 service 包约定。**不具名导出**。
 *
 * @module last_shutdown
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { recordStartupLine } from '../_startup-log.ts'
import { markOf } from '../_session-mark.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Config as ConfigSchema, type Config } from './config.ts'
import { renderShutdown, type ShutdownRecord } from './render.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** 由本插件浮进上下文的一条"上次是停下来的"。 */
    'last-shutdown': { kind: 'last-shutdown' }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 上次进程停止时的坐标（优雅关闭原理）。**可选挂载。** */
    lastShutdown: LastShutdown
  }
}

/**
 * 优雅关闭记账，注册为 `ctx.lastShutdown`。
 */
export class LastShutdown extends Service {
  static Config: z<Config> = ConfigSchema

  /** 要 agent 注册表（临死前得知道"哪个才是白羽"才能记坐标）与注意力焦点。 */
  static inject = ['agents', 'pointer']

  private readonly config: Config

  /**
   * 上次进程停止留下的记录。
   *
   * 启动时从 `config.statePath` 读进来，由 {@link announce} 注入一次后清掉。
   */
  private record: ShutdownRecord | undefined

  /**
   * @param ctx - 本插件的上下文。
   * @param config - 配置。
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'lastShutdown')
    this.config = config
  }

  /** 有没有读到上次的记录（诊断用）。 */
  get pending(): boolean {
    return this.record !== undefined
  }

  /**
   * 构造完成之后运行：读上次的记录，并交出卸载时的写盘。
   *
   * 顺序是"**先读、再 yield**" —— `yield` 出来的 disposer 才是临死前那一下。
   */
  async *[Service.init](): AsyncGenerator<() => void, void, void> {
    this.load()

    yield () => {
      // **同步写** —— 关闭路径上不能等异步。
      this.recordShutdown()
    }
  }

  /**
   * 启动时把"上次是停下来的"注入她的上下文，**只做一次**。
   *
   * 由 `qq/resident` 在建完常驻会话之后调用 —— **那一刻才有 agent 可以注入**
   * （本插件激活时 `ctx.agents` 还是空的）。注入后把存档删掉：这条信息只对
   * **紧接的那一次启动**有意义，留着只会在下次启动时重复一遍。
   *
   * @param agent - 刚建好的常驻 agent。
   */
  announce(agent: Agent): void {
    const record = this.record
    this.record = undefined
    if (record === undefined) return
    try {
      agent.inject(createUserMessage({
        content: [{ type: 'text', text: renderShutdown(record) }],
        source: { kind: 'last-shutdown' },
      }))
      this.ctx.logger.info(
        `last-shutdown: 已注入上次的关闭记录（停在 ${record.sessionId} 第 ${String(record.turn)} 轮）`,
      )
    } catch (error) {
      this.ctx.logger.warn(
        'last-shutdown: 注入关闭记录失败：%o',
        error instanceof Error ? error.message : String(error),
      )
    }
    this.dropFile()
  }

  /** 读上次的记录；文件不存在是**正常**的（第一次跑，或上次是被杀的）。 */
  private load(): void {
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(this.config.statePath, 'utf8')) as unknown
    } catch (error) {
      const code = (error as { code?: string }).code
      if (code !== 'ENOENT') {
        this.ctx.logger.warn(
          'last-shutdown: 关闭记录读失败，按"没有"继续：%o',
          error instanceof Error ? error.message : String(error),
        )
      }
      return
    }
    if (typeof raw !== 'object' || raw === null) return
    const candidate = raw as Record<string, unknown>
    if (typeof candidate['sessionId'] !== 'string'
      || typeof candidate['turn'] !== 'number'
      || typeof candidate['seq'] !== 'number') {
      this.ctx.logger.warn(`last-shutdown: 关闭记录形状不对（${this.config.statePath}），忽略`)
      return
    }
    this.record = {
      sessionId: candidate['sessionId'],
      turn: candidate['turn'],
      seq: candidate['seq'],
      at: typeof candidate['at'] === 'number' ? candidate['at'] : 0,
      reason: typeof candidate['reason'] === 'string' ? candidate['reason'] : '原因未记录',
    }
    // 启动自述：那一刻还没有终端出口，所以先登记、由补丁层最后一行补打。
    recordStartupLine(
      `last-shutdown: 上次停在 ${this.record.sessionId} 第 ${String(this.record.turn)} 轮（启动时注入）`,
    )
  }

  /**
   * 临死前记一笔。
   *
   * ## ★ 只在"确实有事在飞"时写
   *
   * 判据是**她正在跑**。这一个判据同时干掉两件事：
   *
   * 1. **空转时的无意义记录** —— 她闲着被停掉，本来就没有"没做完的事"要提醒。
   * 2. ★ **HMR 重载造成的假记录** —— 我们的补丁层开着 HMR，改一次插件文件就会
   *    卸载重装（disposer 会跑），而那时她通常是闲的。
   *
   * ## ⚠️ 剩下的那部分它解决不了（TODO，上游面）
   *
   * 她**恰好**在跑的时候被 HMR 重载，还是会误记一条。要根治得有一个真正的
   * "应用正在关闭"信号，而 DSH 把 SIGINT / SIGTERM / 正常退出**收敛成同一个
   * `interrupt(code)`**（`apps/cli/src/profile-boot.ts:280-281`）——
   * **插件侧看不出是哪种，也看不出"这是关闭还是重载"**。
   *
   * 顺带：**它记不到真正原因**，所以 `reason` 只描述"当时她正在跑"。
   */
  private recordShutdown(): void {
    try {
      const sessionId = this.ctx.pointer.current?.sessionId
      if (sessionId === undefined) return
      const agent = this.ctx.agents.list().find(item => item.id === sessionId)
      if (agent === undefined) return
      if (agent.status !== 'running') return

      // ★ 同步取坐标。`markOf` 只被调这一次 —— 它把坐标和 seed 一起取定，
      //   这里只用坐标（seed 是 `interrupt_plan` 要的）。
      const mark = markOf(agent)
      const record: ShutdownRecord = {
        sessionId: mark.sessionId,
        turn: mark.turn,
        seq: mark.seq,
        at: Date.now(),
        reason: '你当时正在做事',
      }
      mkdirSync(dirname(this.config.statePath), { recursive: true })
      const tmp = `${this.config.statePath}.tmp`
      writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
      renameSync(tmp, this.config.statePath)
    } catch (error) {
      // 记不下来只是少一条提醒，**不该让关闭流程炸**。
      this.ctx.logger.warn(
        'last-shutdown: 关闭记录写失败：%o',
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  /** 删掉存档（注入之后）。删不掉只是下次会重复一遍，不致命。 */
  private dropFile(): void {
    try {
      unlinkSync(this.config.statePath)
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') {
        this.ctx.logger.warn(
          'last-shutdown: 关闭记录删不掉，下次启动会再注入一遍：%o',
          error instanceof Error ? error.message : String(error),
        )
      }
    }
  }
}

export default LastShutdown
