/**
 * 「推」：把 QQ 消息变成 `user` 消息推进白羽的上下文，**唤醒**她，之后她自己决定怎么办。
 *
 * ## 推 vs 拉
 *
 * | | 机制 | 类比 |
 * |:--|:--|:--|
 * | **推**（本文件） | 消息经 `followup()` 成为独立 turn 的 `user` 消息，唤醒驱动 | 手机响了 |
 * | **拉**（`qq_check_messages`） | 白羽主动调工具去看积压的消息 | 人打开手机翻消息 |
 *
 * 两条路并存，共用 `buffer.ts` 的游标。
 *
 * ## 为什么不能来一条推一条
 *
 * 群里连发十条消息会变成十个 turn——既贵又吵，而且白羽会逐条回话。
 * 所以这里做两件事：
 *
 * - **防抖**：最后一条消息之后再等 `debounceMs`，把连发合并成一次唤醒
 * - **冷却**：同一会话两次唤醒至少隔 `cooldownMs`，防止一个热闹的群把额度烧光
 *
 * 唤醒时把该会话**所有未读**（`drain`）一次性带进去，所以白羽看到的是完整的一段对话，
 * 而不是被切成十条的碎片。
 *
 * ## 落地方式
 *
 * `agent.followup(message)` —— 它排一个独立的 follow-up turn 并唤醒驱动。
 * agent-loop 在 step 入口把这次投递 append 成 `user/message` 会话事件
 * （`agent-loop/src/agent.ts:420`），所以推入的内容**持久且可回放**，
 * 满足 DSH 那条"模型可见 ⟺ 已记录"的规矩。
 *
 * @module qq/push
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { QqIncoming } from '../adapter/index.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** 推入上下文的 QQ 消息。 */
    qq: { kind: 'qq', conversation: string }
  }
}

/** 插件名。 */
export const name = 'qq-attention'

/** 依赖 `qq`（消息来源）与 `agents`（投递目标）。 */
export const inject = ['qq', 'agents']

/** 配置。 */
export interface Config {
  /**
   * 触发条件。
   *
   * - `mention` —— 只有 @ 白羽 才推。默认，也是最安全的
   * - `all` —— 任何消息都推。只建议在白名单群里用
   */
  trigger: 'mention' | 'all'
  /** 群白名单；空数组表示不限。私聊不受此限。 */
  groups: string[]
  /**
   * 目标 agent 的 session id。
   *
   * 留空时要求**恰好只有一个** agent 在册——多于一小时拒绝投递并告警，
   * 而不是随便挑一个（投错人会很难查）。
   */
  sessionId: string
  /** 防抖：最后一条消息之后等这么久再唤醒（毫秒）。 */
  debounceMs: number
  /** 冷却：同一会话两次唤醒的最小间隔（毫秒）。 */
  cooldownMs: number
  /** 一次唤醒最多带几条消息。 */
  batchLimit: number
}

/** 配置校验。 */
export const Config: z<Config> = z.object({
  trigger: z.union(['mention', 'all'] as const).default('mention'),
  groups: z.array(z.string()).default([]),
  sessionId: z.string().default(''),
  debounceMs: z.natural().default(3000),
  cooldownMs: z.natural().default(30000),
  batchLimit: z.natural().min(1).default(20),
})

/** 一个会话的待唤醒状态。 */
interface PendingWake {
  timer: ReturnType<typeof setTimeout>
  /** 上次真正唤醒的时间戳；0 表示从未。 */
  lastWokenAt: number
}

/**
 * 渲染推入上下文的正文。
 *
 * 措辞从**模型视角**写：告诉她这是哪儿、谁说了什么、用哪个工具回话。
 * @param conversation - 会话键。
 * @param groupName - 群名（有就带上，便于模型理解语境）。
 * @param messages - 本次要带进去的消息（已渲染文本）。
 * @returns 模型可见的正文。
 */
function renderPush(
  conversation: string,
  groupName: string | undefined,
  messages: readonly { senderName: string, text: string, mentionsSelf: boolean }[],
): string {
  const where = groupName === undefined ? conversation : `${conversation}（${groupName}）`
  const lines = messages.map(
    message => `${message.senderName}${message.mentionsSelf ? '（@了你）' : ''}: ${message.text}`,
  )
  return [
    `[QQ] ${where} 的新消息：`,
    '',
    ...lines,
    '',
    `回话用 qq_send_message，target 填 "${conversation}"。`,
    '不想回就不用回——这里没有必须回复的规则。',
  ].join('\n')
}

/**
 * 注册推送逻辑。
 * @param ctx - 本插件的上下文；`qq` 与 `agents` 已由 inject 声明。
 * @param config - 已校验的配置。
 */
export function apply(ctx: Context, config: Config): void {
  /** 每个会话的待唤醒状态。 */
  const pending = new Map<string, PendingWake>()

  /** 找投递目标；不确定时返回 undefined 并告警——**不猜**。 */
  const targetAgent = (): Agent | undefined => {
    if (config.sessionId !== '') {
      const agent = ctx.agents.list().find(candidate => candidate.id === config.sessionId)
      if (agent === undefined) {
        ctx.logger.warn(`qq-attention: 配置的 sessionId "${config.sessionId}" 不在册，跳过投递`)
      }
      return agent
    }
    const all = ctx.agents.list()
    if (all.length === 1) return all[0]
    ctx.logger.warn(`qq-attention: 期望恰好一个 agent，实际 ${String(all.length)} 个；请配 sessionId`)
    return undefined
  }

  /** 真正推一次：把该会话的未读一次性带进去。 */
  const wake = async (conversation: string): Promise<void> => {
    const state = pending.get(conversation)
    if (state === undefined) return
    const now = Date.now()
    const wait = state.lastWokenAt + config.cooldownMs - now
    if (wait > 0) {
      // 还在冷却：重新排一次，而不是丢弃——冷却期间的消息不能被吞掉。
      clearTimeout(state.timer)
      state.timer = setTimeout(() => { void wake(conversation) }, wait)
      return
    }

    const agent = targetAgent()
    if (agent === undefined) {
      pending.delete(conversation)
      return
    }

    // 取增量。`drain` 推进游标，所以推出去的消息不会被下一次"拉"重复读到。
    const unseen: QqIncoming[] = ctx.qq.drain(conversation)
    if (unseen.length === 0) {
      pending.delete(conversation)
      return
    }
    const batch = unseen.slice(-config.batchLimit)

    // 顺序渲染：一条消息可能触发图片下载，并发会把协议端和网络一起打满。
    const rendered = []
    for (const incoming of batch) {
      rendered.push({
        senderName: incoming.senderName,
        text: await ctx.qq.render(incoming),
        mentionsSelf: incoming.mentionsSelf,
      })
    }

    const groupName = batch[0]?.groupName
    const message = createUserMessage({
      content: [{ type: 'text', text: renderPush(conversation, groupName, rendered) }],
      source: { kind: 'qq', conversation },
    })
    agent.followup(message)

    state.lastWokenAt = Date.now()
    pending.delete(conversation)
    ctx.logger.info(`qq-attention: 已推入 ${String(rendered.length)} 条（${conversation}），唤醒 ${agent.id}`)
  }

  /** 判断一条消息该不该触发推送。 */
  const shouldTrigger = (incoming: QqIncoming): boolean => {
    // 自己的消息不该唤醒自己（协议端默认不上报自身消息，这里只是兜底）。
    if (incoming.userId === ctx.qq.selfId) return false
    if (config.trigger === 'mention' && !incoming.mentionsSelf) return false
    // 白名单只约束群；私聊一律放行（私聊本来就是对着她说的）。
    if (incoming.groupId !== undefined && config.groups.length > 0) {
      if (!config.groups.includes(incoming.groupId)) return false
    }
    return true
  }

  ctx.on('qq/message', (incoming) => {
    if (!shouldTrigger(incoming)) return
    const conversation = incoming.groupId === undefined
      ? `private:${incoming.userId}`
      : `group:${incoming.groupId}`

    const existing = pending.get(conversation)
    if (existing !== undefined) {
      // 防抖：把定时器往后推，让连发的消息并进同一次唤醒。
      clearTimeout(existing.timer)
      existing.timer = setTimeout(() => { void wake(conversation) }, config.debounceMs)
      return
    }
    pending.set(conversation, {
      timer: setTimeout(() => { void wake(conversation) }, config.debounceMs),
      lastWokenAt: 0,
    })
  })

  ctx.effect(() => () => {
    for (const state of pending.values()) clearTimeout(state.timer)
    pending.clear()
  })

  ctx.logger.info(`qq-push 已就绪：trigger=${config.trigger}`
    + `${config.groups.length === 0 ? '，群不限' : `，群白名单 ${config.groups.join(', ')}`}`
    + `，防抖 ${String(config.debounceMs)}ms，冷却 ${String(config.cooldownMs)}ms`)
  // 投递目标不在册是最容易踩的坑（headless 启动没有 agent），启动时报一次比事后猜强。
  const roster = ctx.agents.list()
  ctx.logger.info(roster.length === 0
    ? 'qq-attention: 当前没有在册 agent —— 有消息也无人可推（headless 启动不会创建 agent）'
    : `qq-attention: 当前在册 agent ${String(roster.length)} 个：${roster.map(agent => agent.id).join(', ')}`)
}
