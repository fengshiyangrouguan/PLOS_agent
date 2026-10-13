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

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
// 副作用式类型导入：把 `agentDefaultModel` 注册到 Context 上。不 import 就没有这个属性
// （DSH 的声明合并在各自的包里，得有人先把它拉进编译单元）。
import type {} from '@deepseek-ai/dsh-agent-default-model'
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
 */
export const inject = ['agents', 'agentLoop', 'agentDefaultModel', 'tcb']

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
  sessionId: z.string().default('plos-baiyu'),
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

      const created = await ctx.agents.create({
        sessionId: SessionId(config.sessionId),
        ...config.cwd === '' ? {} : { meta: { cwd: config.cwd } },
        agentOptions,
        // 把 TCB 接到**这个 agent 自己的 scope** 上：白名单过滤 + 人设段落。
        // 在 `setup` 里注册，所以不必解析 scope 反查 TCB —— 作用域本身就是答案。
        ...tcb === undefined ? {} : { setup: (agentCtx: Context) => { ctx.tcb.apply(agentCtx, tcb) } },
      })
      // 卸载可能发生在创建返回之前：这时不要留下没人管的会话。
      if (disposed) {
        await created.dispose()
        return
      }
      handle = created
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
