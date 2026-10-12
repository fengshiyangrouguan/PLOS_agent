/**
 * 把 `qq` 能力包成模型可调用的工具。
 *
 * ## 它在三层里的位置
 *
 * ```
 * ① 能力 seam   qq/adapter.ts      provide('qq')      —— 一条通往 QQ 的连接
 * ② 工具包装    qq-tools.ts        inject ['tools','qq'] —— 本文件
 * ③ 提示词                                      systemPrompt 段落
 * ```
 *
 * 本文件**只做包装**：把 `ctx.qq` 的方法翻译成模型看得懂的入参出参。它不实现协议、
 * 不解析消息段、不做策略判断——那些都在 ① 里。
 *
 * ## 为什么错误不抛出
 *
 * 发送失败（未连接、超时、被风控）是**模型应该知道并能应对**的事实，不是插件崩溃。
 * 所以每个 execute 都把失败收成 `{ ok: false, reason }` 交给 `render` 说清楚，
 * 而不是抛异常——抛出去模型只看到一句"工具执行失败"，学不到任何东西。
 *
 * ## 形态
 *
 * 函数插件：具名导出 `name` / `inject` / `apply`，**没有 default export**。
 * 与 `qq/adapter.ts` 相反（那个提供 service 所以 default export 服务类）。
 *
 * @module qq/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { QqActionError, type QqTarget } from '../adapter/index.ts'

/** 插件名。 */
export const name = 'qq-tools'

/** 依赖工具注册表与 `qq` 服务。 */
export const inject = ['tools', 'qq']

/**
 * 解析 `target` 参数。
 *
 * 形如 `group:<群号>` 或 `private:<QQ号>`。用单字符串而不是两个可选参数，
 * 是因为 JSON Schema 表达"两者恰有其一"很别扭，而模型也更容易记住一种写法。
 * @param target - 模型给的原始值。
 * @returns 解析后的目标；格式不合法返回 undefined。
 */
function parseTarget(target: string): QqTarget | undefined {
  const separator = target.indexOf(':')
  if (separator <= 0) return undefined
  const kind = target.slice(0, separator)
  const id = target.slice(separator + 1).trim()
  if (id === '') return undefined
  if (kind === 'group') return { kind: 'group', id }
  if (kind === 'private') return { kind: 'private', id }
  return undefined
}

/** 把异常变成一句可读的原因。 */
function reasonOf(error: unknown): string {
  if (error instanceof QqActionError) return `${error.message}（retcode=${error.retcode}）`
  return error instanceof Error ? error.message : String(error)
}

/** `target` 参数的公共定义——三个工具共用，措辞保持一致。 */
const TARGET_PARAM = {
  type: 'string',
  required: true,
  description: 'Conversation to act on, as "group:<group id>" or "private:<user id>". Example: "group:871074118".',
} as const

/**
 * 本插件注册的工具名。
 *
 * 单独列出来只为了在激活日志里报清楚"到底注册了什么"——工具注册是静默的，
 * 出问题时（名字冲突、inject 没就绪）没有这行就只能靠猜。
 */
const REGISTERED_TOOLS = [
  'qq_send_message',
  'qq_send_image',
  'qq_read_message',
  'qq_list_group_members',
  'qq_recall_message',
  'qq_check_messages',
] as const

/**
 * 注册所有工具。
 * @param ctx - 本插件的上下文；`tools` 与 `qq` 已由 inject 声明，故此处必已就绪。
 */
export function apply(ctx: Context): void {
  // ── 发文本 ────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'qq_send_message',
    description: [
      'Send a text message to a QQ group or private chat.',
      'Use "group:<id>" or "private:<id>" as the target.',
      'In groups you may mention people with `at` and quote a message with `reply_to`.',
    ].join(' '),
    parameters: {
      target: TARGET_PARAM,
      text: {
        type: 'string',
        required: true,
        description: 'Message body. Plain text; emoji markers like [表情：笑哭] are converted back to QQ faces.',
      },
      at: {
        type: 'array',
        description: 'QQ ids to mention. Ignored in private chats. Use "all" to mention everyone.',
        items: { type: 'string' },
      },
      reply_to: {
        type: 'string',
        description: 'Message id to quote. Use the id from a rendered message such as "(msg_id=123)".',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          messageId: { type: 'string' },
          reason: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? `Sent. message id: ${value.messageId ?? 'unknown'}`
          : `Send failed: ${value.reason ?? 'unknown reason'}`,
      }],
    },
    async execute(args) {
      const target = parseTarget(args.target)
      if (target === undefined) {
        return { ok: false, reason: `invalid target "${args.target}", expected "group:<id>" or "private:<id>"` }
      }
      try {
        const messageId = await ctx.qq.sendText(target, args.text, {
          ...args.at === undefined ? {} : { at: args.at },
          ...args.reply_to === undefined ? {} : { replyTo: args.reply_to },
        })
        return { ok: true, messageId }
      } catch (error) {
        return { ok: false, reason: reasonOf(error) }
      }
    },
  }))

  // ── 发图片 ────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'qq_send_image',
    description: [
      'Send an image to a QQ group or private chat.',
      '`file` may be an http(s) URL, an absolute local path, or a "base64://..." payload —',
      'the protocol side decides how to fetch it.',
    ].join(' '),
    parameters: {
      target: TARGET_PARAM,
      file: {
        type: 'string',
        required: true,
        description: 'Image reference: an http(s) URL, a local file path, or "base64://<data>".',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          messageId: { type: 'string' },
          reason: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? `Image sent. message id: ${value.messageId ?? 'unknown'}`
          : `Image send failed: ${value.reason ?? 'unknown reason'}`,
      }],
    },
    async execute(args) {
      const target = parseTarget(args.target)
      if (target === undefined) {
        return { ok: false, reason: `invalid target "${args.target}", expected "group:<id>" or "private:<id>"` }
      }
      try {
        return { ok: true, messageId: await ctx.qq.sendImage(target, args.file) }
      } catch (error) {
        return { ok: false, reason: reasonOf(error) }
      }
    },
  }))

  // ── 读一条消息的原文 ──────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'qq_read_message',
    description: [
      'Read one stored QQ message by id and render it as text.',
      'Use this to look at a quoted message whose preview looked truncated, or to pull a',
      'message you only have the id of.',
    ].join(' '),
    parameters: {
      message_id: {
        type: 'string',
        required: true,
        description: 'Message id, as shown by rendered messages in "(msg_id=...)".',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          senderName: { type: 'string' },
          text: { type: 'string' },
          reason: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? `${value.senderName ?? 'unknown'}: ${value.text ?? ''}`
          : `Read failed: ${value.reason ?? 'unknown reason'}`,
      }],
    },
    async execute(args) {
      try {
        const detail = await ctx.qq.getMessage(args.message_id)
        // 复用流水线：把取回的消息**当作一条入站消息**解析，这样引用、图片、转发
        // 的渲染规则与实时消息完全一致——不另写一套。
        const text = await ctx.qq.render({
          messageId: args.message_id,
          groupId: undefined,
          userId: String(detail.sender?.user_id ?? ''),
          senderName: detail.sender?.nickname ?? 'unknown',
          time: Math.floor(Date.now() / 1000),
          segments: Array.isArray(detail.message) ? detail.message : [],
          mentionsSelf: false,
          atUserIds: [],
          groupName: undefined,
          raw: detail as Record<string, unknown>,
        })
        return {
          ok: true,
          ...detail.sender?.nickname === undefined ? {} : { senderName: detail.sender.nickname },
          text,
        }
      } catch (error) {
        return { ok: false, reason: reasonOf(error) }
      }
    },
  }))

  // ── 群成员列表 ────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'qq_list_group_members',
    description: [
      'List members of a QQ group with their display names and QQ ids.',
      'Use this to find the QQ id behind a name before mentioning someone with qq_send_message.',
    ].join(' '),
    parameters: {
      group_id: { type: 'string', required: true, description: 'Group id, digits only.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          members: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                userId: { type: 'string', required: true },
                name: { type: 'string', required: true },
                role: { type: 'string' },
              },
            },
          },
          reason: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? (value.members ?? []).map(member => `${member.name} (${member.userId}${member.role === undefined ? '' : `, ${member.role}`})`).join('\n')
          : `List failed: ${value.reason ?? 'unknown reason'}`,
      }],
    },
    async execute(args) {
      try {
        const members = await ctx.qq.getGroupMemberList(args.group_id)
        return {
          ok: true,
          members: members.map((member) => {
            const card = typeof member.card === 'string' && member.card !== '' ? member.card : undefined
            const nickname = typeof member.nickname === 'string' && member.nickname !== '' ? member.nickname : undefined
            return {
              userId: String(member.user_id),
              name: card ?? nickname ?? String(member.user_id),
              ...typeof member.role === 'string' && member.role !== '' ? { role: member.role } : {},
            }
          }),
        }
      } catch (error) {
        return { ok: false, reason: reasonOf(error) }
      }
    },
  }))

  // ── 撤回 ──────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'qq_recall_message',
    description: [
      'Recall (delete) a message the bot sent, by message id.',
      'Only works within the protocol side\'s recall window and on messages the bot may recall.',
    ].join(' '),
    parameters: {
      message_id: { type: 'string', required: true, description: 'Message id to recall.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          reason: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok ? 'Recalled.' : `Recall failed: ${value.reason ?? 'unknown reason'}`,
      }],
    },
    async execute(args) {
      try {
        await ctx.qq.deleteMessage(args.message_id)
        return { ok: true }
      } catch (error) {
        return { ok: false, reason: reasonOf(error) }
      }
    },
  }))

  // ── 主动查看消息（"拉"）─────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'qq_check_messages',
    description: [
      'Look at QQ messages that arrived and have not been seen yet.',
      'Call it with no arguments to see which conversations have unread messages and how many.',
      'Call it with a "conversation" to read that conversation\'s unread messages and mark them read.',
      'Reading marks messages as seen unless mark_read is false, so the next call returns only what is new.',
    ].join(' '),
    parameters: {
      conversation: {
        type: 'string',
        description: 'Conversation to read, as "group:<group id>" or "private:<user id>". Omit to list unread counts instead.',
      },
      limit: {
        type: 'integer',
        description: 'Maximum messages to return per conversation. Defaults to 20. Rendering images and forwards costs work, so raise it deliberately.',
      },
      mark_read: {
        type: 'boolean',
        description: 'Whether reading advances the seen cursor. Defaults to true. Set false to look without marking as read.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          conversations: {
            type: 'array',
            description: 'Unread overview, present when no conversation was named.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                conversation: { type: 'string', required: true },
                unread: { type: 'integer', required: true },
              },
            },
          },
          messages: {
            type: 'array',
            description: 'Read messages, present when a conversation was named.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                conversation: { type: 'string', required: true },
                messageId: { type: 'string', required: true },
                senderName: { type: 'string', required: true },
                text: { type: 'string', required: true },
                mentionsSelf: { type: 'boolean', required: true },
              },
            },
          },
          reason: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (!value.ok) return [{ type: 'text', text: `Check failed: ${value.reason ?? 'unknown reason'}` }]
        const conversations = value.conversations ?? []
        if (conversations.length > 0) {
          return [{
            type: 'text',
            text: conversations.map(item => `${item.conversation}: ${String(item.unread)} unread`).join('\n'),
          }]
        }
        const messages = value.messages ?? []
        if (messages.length === 0) return [{ type: 'text', text: 'No unseen messages.' }]
        return [{
          type: 'text',
          text: messages
            .map(item => `[${item.conversation}] ${item.senderName}${item.mentionsSelf ? ' (mentioned you)' : ''}: ${item.text}`)
            .join('\n'),
        }]
      },
    },
    async execute(args) {
      const limit = args.limit ?? 20

      // 概览模式：没给会话就只报未读数，不拉正文——那才是"打开手机看一眼"。
      if (args.conversation === undefined || args.conversation === '') {
        const conversations = ctx.qq.conversations()
          .map(conversation => ({ conversation, unread: ctx.qq.unread(conversation) }))
          .filter(item => item.unread > 0)
        return { ok: true, conversations }
      }

      try {
        // `peek` 不推进游标，`drain` 推进——这就是"看"与"读过"的区别。
        const unseen = args.mark_read === false
          ? ctx.qq.peek(args.conversation, limit)
          : ctx.qq.drain(args.conversation).slice(-limit)
        // 顺序渲染而不是并行：一条消息可能触发图片下载，并发起来会把协议端和网络一起打满。
        const messages = []
        for (const incoming of unseen) {
          messages.push({
            conversation: args.conversation,
            messageId: incoming.messageId,
            senderName: incoming.senderName,
            text: await ctx.qq.render(incoming),
            mentionsSelf: incoming.mentionsSelf,
          })
        }
        return { ok: true, messages }
      } catch (error) {
        return { ok: false, reason: reasonOf(error) }
      }
    },
  }))

  ctx.logger.info(`qq-tools 已注册 ${String(REGISTERED_TOOLS.length)} 个工具：${REGISTERED_TOOLS.join(', ')}`)
}
