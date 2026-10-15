/**
 * 常驻 agent：进程一起来就建一个白羽的会话，让 QQ 那边随时有人可推。
 *
 * ## 为什么需要它
 *
 * DSH 的 agent 是**会话驱动**的：`dsh --profile main` 这种 headless 启动不创建 agent，
 * agent 由 agent-loop 在会话启动时建立。于是出现一个尴尬的空档——
 * `qq-adapter` 收得到消息、`qq-push` 也准备好了，但 `ctx.agents.list()` 是空的，
 * **没有人可以推**。实测日志就是这个结论：
 *
 * > qq-push: 当前没有在册 agent —— 有消息也无人可推（headless 启动不会创建 agent）
 *
 * 这个插件补上那一环：启动即建会话，进程在，白羽就在。
 *
 * ## 为什么不用 agent preset
 *
 * DSH 里 webhook 那条路建会话时会 `ctx.agentPresets.mount()` 组合行为、还会
 * `ctx.workspaceRegistry.create()` 挂工作区。**我们这棵树里这两个服务都不存在**
 * （`agent-preset` / `workspace` 都不在 dsh-base 的装配里），所以走朴素路径：
 * 只给 `sessionId`，模型走 `agent-default-model` 的配置。
 *
 * ## 生命周期
 *
 * 会话是资源，用 `ctx.effect` 表达。创建是异步的，而卸载可能发生在创建完成之前，
 * 所以两边都要照看到：卸载时先等创建落定，若已落定就 dispose；若创建还没回来，
 * 等它回来立刻 dispose 掉，不留孤儿。
 *
 * @module qq/resident
 */

import { flushStartupLines } from '../../_startup-log.ts'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
// 副作用式类型导入：把 `agentDefaultModel` 注册到 Context 上。不 import 就没有这个属性
// （DSH 的声明合并在各自的包里，得有人先把它拉进编译单元）。
import type {} from '@deepseek-ai/dsh-agent-default-model'
// `resume` / `SessionPersistence.stat` 的类型来自这个包 —— **得有人把它拉进编译单元**，
// 否则 `ctx.sessionPersistence` 不存在（和上面那行同一个理由）。
import type {} from '@deepseek-ai/dsh-session-persistence'
import { ReasoningEffortId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'

/** 插件名。 */
export const name = 'qq-resident'

/**
 * 需要 agent 注册表，**以及 agentLoop 服务本身**。
 *
 * `agentLoop` 不是可有可无的：它才是 `ctx.agents.setFactory()` 的调用方
 * （`agent-loop/src/index.ts:369`，在服务构造里以 effect 注册）。只 inject 'agents'
 * 会让本插件在树装配完成前就激活，撞上 `no agent factory registered` 直接失败。
 *
 * 这是实测踩出来的：日志时间线显示 apply 跑在 `hmr watching` 之前。
 * 靠依赖声明约束顺序，比轮询等工厂出现可靠。
 *
 * `pointer` 也在依赖里：白羽一上线就要把注意力焦点钉在她身上
 * （见 `apply` 里那段注释 —— 那是 `interrupt_plan` 的前置条件）。
 *
 * ⚠️ **`lastShutdown` 不在这张表里** —— 它是个**非必要插件**，所以那一处
 * 走 `ctx.get('lastShutdown')`（可选服务）。不挂它拿到 `undefined`，
 * 那行短路，**影响为零**。
 */
// `sessionPersistence`：判"这个会话盘上有没有" —— 有就 `resume`（**只有它会打开写句柄**），
// 没有才 `create`。缺了它就只能 create，会话永远是纯内存的（见下面那段注释）。
export const inject = ['agents', 'agentLoop', 'agentDefaultModel', 'tcb', 'pointer', 'sessionPersistence']

/** 配置。 */
export interface Config {
  /** 常驻会话的 id。稳定即可——同一个 id 重启后是同一个会话。 */
  sessionId: string
  /**
   * 会话的工作目录（绝对路径）。
   *
   * 留空则不传 `meta`，由 DSH 自己决定。填了就要是绝对路径，否则创建会失败。
   */
  cwd: string
  /**
   * 启动时推给白羽的一句话。
   *
   * 留空则什么都不推（默认）。填上可以当冒烟测试用：进程一起来她就会自己说一句，
   * 说明模型这条路是通的。
   */
  greeting: string
}

/** 配置校验。 */
export const Config: z<Config> = z.object({
  sessionId: z.string().default('plos'),
  cwd: z.string().default(''),
  greeting: z.string().default(''),
})

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** 常驻插件自己在启动时推入的内容。 */
    'qq-resident': { kind: 'qq-resident', sessionId: string }
  }
}

/**
 * 注册常驻会话。
 * @param ctx - 本插件的上下文；`agents` 已由 inject 声明。
 * @param config - 已校验的配置。
 */
export function apply(ctx: Context, config: Config): void {
  ctx.effect(() => {
    let handle: AgentHandle | undefined
    let disposed = false

    const creating = (async (): Promise<void> => {
      // 模型：**优先从 TCB 读**（一个 TCB 一套配置，docs/m5-preemption.md §12.2）。
      // 没有 TCB 时回落到 `agent-default-model` —— 单一真相源从那一行**转移**到 TCB，
      // 但没配 TCB 时仍要好用。
      //
      // 不给 agentOptions 的话这个会话**没有模型**，那一轮根本构造不出请求：
      // 表面看是"收到消息没反应"，实际是压根没发出去过。
      const tcb = ctx.tcb.get()
      const selection = ctx.agentDefaultModel.currentSelection()
      if (tcb === undefined) {
        ctx.logger.warn('qq-resident: 没有可用的 TCB，模型回落到 agent-default-model')
      }
      const agentOptions = tcb === undefined
        ? {
            provider: selection.provider,
            model: selection.model,
            ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
          }
        : {
            provider: tcb.model.provider,
            model: tcb.model.model,
            ...tcb.model.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(tcb.model.reasoningEffort) },
          }

      // ★★ **有持久化就 resume，没有才 create。**
      //
      //   只有 `resume` 会「**打开持久化会话以便写入**」（`core/agent/src/index.ts:192-193`）。
      //   用 `create` 建出来的会话是**纯内存**的：事件进得去、`flush()` 也不报错
      //   （没有写句柄，故无事可做 ⇒ 静默），于是**盘上永远只有头帧＋首批帧**。
      //
      //   后果不是"少个备份"：`interrupt_plan` 的待办**只存 `sessionId + seq`**，
      //   指望着靠 `session_event_read` 回去看原文 —— **盘上没有 ⇒ 那条恢复路径是断的**。
      //
      //   实测（2026-10-15）：换一个全新 id 启动，`create` **连文件都不建**；
      //   而两个子会话（走的是带 parent/seed 的另一条路）写了 25 KB / 51 KB。
      const sessionId = SessionId(config.sessionId)
      // ★★ `stat()` 会**校验**存储里的头 —— 一份**写坏了的**日志会让它**抛错**。
      //
      //   那含义是"这个会话读不了"，**不是**"没有这个会话"：绝不能让它把整个启动带下去。
      //   实测踩过：一个被打断写坏的 259 字节残帧让 `dsh` 直接
      //   `fatal load failure: corrupt session log` —— **整台机器起不来**。
      //
      //   读不了就当作"没有"，退回 `create`（纯内存，不会再碰那个坏文件）；
      //   ★ 但**这意味着此后仍然不落盘** —— 坏文件要由运维处置（改名挪走，
      //   下一次 `create` 才会写出一份好的）。
      let persisted: Awaited<ReturnType<typeof ctx.sessionPersistence.stat>> | undefined
      try {
        persisted = await ctx.sessionPersistence.stat(sessionId)
      } catch (error) {
        ctx.logger.error(
          `qq-resident: 会话 "${config.sessionId}" 的日志读不了 —— 这次按空会话起。`
          + `原文：${error instanceof Error ? error.message : String(error)}`,
        )
        persisted = undefined
      }
      const created = persisted === undefined
        ? await ctx.agents.create({
            sessionId,
            ...config.cwd === '' ? {} : { meta: { cwd: config.cwd } },
            agentOptions,
            ...tcb === undefined ? {} : { setup: (agentCtx: Context) => { ctx.tcb.apply(agentCtx, tcb) } },
          })
        : await ctx.agents.resume({
            resumeSessionId: sessionId,
            agentOptions,
            ...tcb === undefined ? {} : { setup: (agentCtx: Context) => { ctx.tcb.apply(agentCtx, tcb) } },
          })
      // ★ **`create` 之后显式落一次盘。**
      //
      //   实测：`create` 出来的会话**连文件都不建**（换全新 id 启动，`sessions/` 下
      //   什么都没多）—— 于是**下一次开机 `stat` 找不到它、又走 `create`**，
      //   永远进不了 `resume` ⇒ **永远不落盘**。
      //   所以首次建出来就必须把它materialize 下来，`resume` 才有东西可接。
      //
      //   `resume` 那条**不需要**（它本来就是"打开持久化会话"）。
      //   失败只记日志：落不了盘不该让她起不来。
      if (persisted === undefined) {
        try {
          await ctx.sessions.flush(created.agent.session)
        } catch (error) {
          ctx.logger.warn(
            'qq-resident: 新会话首次落盘失败（下次开机仍会是空会话）：%o',
            error instanceof Error ? error.message : String(error),
          )
        }
      }

      // 卸载可能发生在创建返回之前：这时不要留下没人管的会话。
      if (disposed) {
        await created.dispose()
        return
      }
      handle = created

      // ★ 写下注意力焦点 —— **这一步是 `interrupt_plan` 的前置条件**。
      //
      // `attention.targetAgent()` 的顺序是「配置的 sessionId → 焦点 → 恰好一个在册 agent」。
      // 而**待办的快照 subagent 一建出来，`agents.list()` 就不止一个了** ——
      // 焦点还空着的话，`attention` 会掉进那个"恰好一个"的兜底分支打警告，
      // 然后**什么都不投**。所以白羽一上线就把焦点钉在她身上。
      //
      // 每次启动都写（即使存档里已经指着她）：一次多余的 IO 换"崩了也认得自己是谁"，
      // 而且 `set` 是原子落盘（临时文件 + 改名）。
      ctx.pointer.set({ sessionId: created.agent.id })

      // ★ 注入"上次是停下来的"（优雅关闭原理）。
      //
      // 为什么由**这里**调、而不是那个插件自己激活时注：插件激活时
      // **还没有 agent 可以注入**（`ctx.agents` 是空的）。这里是"白羽刚上线"
      // 那个唯一时刻。那个插件已经读过存档了，这里只是把提醒交出去。
      //
      // ★ **用 `ctx.get()` 而不是声明式注入** —— `last_shutdown` 是个
      //   **非必要插件**（默认不挂：它的触发判据在开发期不可靠，见那个插件的说明）。
      //   可选服务走 `ctx.get`，于是：
      //     不挂它 → 这里拿到 undefined → 短路 → **影响为零**
      //     挂上它 → 补丁加一行，读 / 写 / 注入全活
      ctx.get('lastShutdown')?.announce(created.agent)

      // 补投"上次没来得及投"的待办（`interrupt_plan` 的跨重启那一支）。
      //
      // 走 `ctx.get` 的理由与上面那行**一样也是"可选"**，但性质不同：
      // `interrupt_plan` 在我们装配里是**常挂的**，用 `ctx.get` 只是**不让它变成
      // resident 的硬依赖** —— 那样把恢复路径摘掉时，常驻会话仍然起得来。
      // 投递本身是幂等的（只投 `state = 'pending'` 的），所以多叫一次无害。
      ctx.get('interruptPlan')?.announce(created.agent)

      // 补打各设施的启动自述（db / tcb / pointer）。
      // 它们跑在挂载早期，那一刻还没有终端出口；本行是补丁层的【最后一行】，
      // 到这里出口才就绪。**换掉最后一行时要跟着改这里。**
      flushStartupLines(ctx.logger)
      ctx.logger.info(`qq-resident: 常驻会话已就绪，agent=${created.agent.id}`)

      if (config.greeting !== '') {
        created.agent.followup(createUserMessage({
          content: [{ type: 'text', text: config.greeting }],
          source: { kind: 'qq-resident', sessionId: config.sessionId },
        }))
        // 诊断：`followup` 之后那一轮到底有没有跑起来。表面症状是"推了但没反应"，
        // 分不清是没唤醒、唤醒后卡住、还是模型调用静默失败——status 能把这三种分开。
        const agent = created.agent
        ctx.logger.info(`qq-resident: 已推入 greeting，status=${String(agent.status)}`)
        setTimeout(() => {
          ctx.logger.info(`qq-resident: 6s 后 status=${String(agent.status)}`)
        }, 6000)
      }
    })().catch((error: unknown) => {
      // 创建失败要吼出来：这等于白羽根本不在，而 QQ 侧一切看起来都正常。
      ctx.logger.warn(`qq-resident: 常驻会话创建失败 —— 白羽不在线：${error instanceof Error ? error.message : String(error)}`)
    })

    return async () => {
      disposed = true
      await creating
      await handle?.dispose()
    }
  })
}
