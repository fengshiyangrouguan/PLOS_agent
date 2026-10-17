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
import z from '@deepseek-ai/schemastery'
import { displayNameOf } from '../protocol/index.ts'
import { beginWait } from '../wait.ts'
import { QqActionError, type QqTarget } from '../adapter/index.ts'

/** 插件名。 */
export const name = 'qq-tools'

/** 依赖工具注册表与 `qq` 服务。 */
export const inject = ['tools', 'qq', 'db']

/**
 * 本插件的配置。
 *
 * 只有等待工具的时长 —— 它是**部署可变**的（"她能等多久"是策略，不是常量），
 * 所以按仓库规矩进 `Config`，不写成常量（`AGENTS.md` §一 记过"把间隔上下限写成常量"那次）。
 */
export interface Config {
  /** 等待工具的**上限**（秒）。用户定案：10 分钟。 */
  waitMaxSeconds: number
  /** 不传 `seconds` 时的默认等待（秒）。 */
  waitDefaultSeconds: number
}

/** 配置校验。 */
export const Config: z<Config> = z.object({
  waitMaxSeconds: z.natural().min(1).default(600),
  waitDefaultSeconds: z.natural().min(1).default(30),
})

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

/** `target` 参数的公共定义——所有"群或私聊都可能"的工具共用，措辞保持一致。 */
const TARGET_PARAM = {
  type: 'string',
  required: true,
  // ★ 描述**自解释**：两个分支都点明 ✓ —— ★ **不给例子** ✗
  //   （例子是拐杖 ✗：它出现往往说明描述没写清 ✓；而"一眼看明白"才是目标 ✓）。
  description: 'Which conversation to act on: "group:<group id>" for a group, '
    + '"private:<user id>" for a private chat.',
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
  'qq_chats',
  'qq_read',
  'qq_search',
  'qq_wait_message',
  // ★ 第 1 批（2026-10-15）：群管理 ＋ 申请处理
  'qq_set_group_ban',
  'qq_approve_friend',
  'qq_approve_group',
  // ★ 第 2 批（2026-10-15）：QQ 空间
  'qq_qzone_list',
  'qq_qzone_post',
  'qq_qzone_comment',
  'qq_qzone_like',
  // ★ 第 3 批（2026-10-15）：好友动态 ＋ 群系统消息 ＋ 禁言名单
  'qq_qzone_feeds',
  'qq_group_requests',
  'qq_group_muted',
] as const

/**
 * 注册所有工具。
 * @param ctx - 本插件的上下文；`tools` 与 `qq` 已由 inject 声明，故此处必已就绪。
 */
export function apply(ctx: Context, config: Config): void {
  // ── 发文本 ────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'qq_send_message',
    description: [
      'Send a text message to a QQ group or private chat.',
      // ★★ 这条务必放在**工具描述**里 ✗ —— ★ 2026-10-16 实测：★ 它原来只在 `at` 的参数描述里 ✗，
      //   ★★ 而她**填 `text` 时想的是"@ 要写出来"** ✗ ⇒ 于是每次都手写一遍 ⇒ 群里两个 @ ✓。
      //   ★ 见 `PLOS/docs/` 与提交记录 ✓（★ 六次带 `at` 的调用里后三次仍然手写 ✓）。
      'When you mention someone with `at`, do **not** also type their "@name" into the message —',
      'the mention appears on its own, so typing it too shows up twice.',
      // ★ 长度控制（用户定案）—— 放在**工具描述**而不是 `text` 参数描述里：
      //   它是"怎么说话"的行为准则，不是字段格式。
      'In shallow, casual chat prefer short replies — usually 15–30 Chinese characters — sent as',
      'several short messages rather than one long block.',
      'That does not apply when you are expressing complex feelings, holding a deeper discussion,',
      'or when something simply needs to be said in full.',
    ].join(' '),
    parameters: {
      target: TARGET_PARAM,
      text: {
        type: 'string',
        required: true,
        description: 'Message body. Plain text; emoji markers like [表情：笑哭] are converted back to QQ faces. '
          + 'Do **not** type "@name" here when you are also passing `at` — the mention appears by itself.',
      },
      at: {
        type: 'array',
        description: 'QQ numbers to mention, e.g. ["352699068"]. Leave the @name out of `text` — '
          + 'the mention appears on its own. Use "all" for everyone. Ignored in private chats.',
        items: { type: 'string' },
      },
      reply_to: {
        type: 'string',
        description: 'Message id to quote, from a rendered message such as "(msg_id=123)". '
          + 'Leave the @name out of `text` — quoting already shows who you are replying to. '
          + 'Only recent messages you actually received can be quoted.',
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

  // ── 等某个会话的下一条消息（Tulpa 式"把话头留着"）─────────────────
  //
  // 用途：**对方可能还有话要说，所以先不结束**／**对方还没说完，所以先不接话**。
  //
  // ★ 与 Tulpa 那套"固定尾部静默"的区别在**谁决定等多久** —— 那边是服务端拍 N 秒，
  //   这里是**她自己按情境拍的**。所以它不是"又多了一层时间轴"，而是一个新能力。
  //   `PLOS/docs/decisions.md` 的「T7 改判」那一段是这条设计的依据。
  //
  // 等待期间该会话的**唤醒被短路**（`../wait.ts` ＋ `../signals/index.ts` 里那一段）：
  // 消息直接回到这里、**不算唤醒信号**，而且**算已读**。别的会话照常唤醒她。
  ctx.tools.register(defineTool({
    name: 'qq_wait_message',
    description: [
      'Wait for the next message in one conversation, then return it.',
      'Use it when the other side may still be typing: instead of answering half a thought or',
      'ending your turn, hold the floor and wait a little.',
      'While you wait, that conversation\'s messages come straight back here, count as read, and do',
      'NOT wake you separately. Other conversations are unaffected.',
      `Wait at most ${String(config.waitMaxSeconds)} seconds; on timeout it reports that nobody`
      + ' spoke, which is not an error.',
    ].join(' '),
    parameters: {
      target: TARGET_PARAM,
      seconds: {
        type: 'integer',
        description: `How long to wait, in seconds. Defaults to ${String(config.waitDefaultSeconds)},`
          + ` capped at ${String(config.waitMaxSeconds)}.`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          spoke: { type: 'boolean' },
          messages: { type: 'array', items: { type: 'string' } },
          reason: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok !== true
          ? `Wait failed: ${value.reason ?? 'unknown reason'}`
          : value.spoke === true
            ? `They spoke:\n${(value.messages ?? []).join('\n')}`
            : 'Waited, but nobody spoke.',
      }],
    },
    async execute(args, exec) {
      const target = parseTarget(args.target)
      if (target === undefined) {
        return { ok: false, reason: `invalid target "${args.target}", expected "group:<id>" or "private:<id>"` }
      }
      // 夹到 `[1, 上限]` —— 夹取而不是拒绝（与其它时长参数一致）。
      const seconds = Math.min(
        config.waitMaxSeconds,
        Math.max(1, Math.trunc(args.seconds ?? config.waitDefaultSeconds)),
      )
      // ★ **把取消信号传下去。** 她那一轮被取消时，等待者必须从表里消失 ——
      //   否则下一条消息会被短路**吃掉**（既不唤醒、也不回传）。见 `../wait.ts`。
      const spoke = await beginWait(args.target, seconds * 1000, exec.signal)
      if (!spoke) return { ok: true, spoke: false }
      // ★ **回传即已读** —— `drain` 而不是 `peek`；这一步就是"她把这段读掉了"。
      //   唤醒已被短路（那条消息没产生信号），所以**只有这里会消费它** —— 不会重复交付。
      const messages: string[] = []
      for (const item of ctx.qq.drain(args.target)) messages.push(await ctx.qq.render(item))
      return { ok: true, spoke: true, messages }
    },
  }))

  // ── 发图片 ────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'qq_send_image',
    description: [
      'Send an image to a QQ group or private chat.',
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
      'Use it to expand a quoted preview, or to look up a message you only have the id of.',
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
          // ★★ 发送者 QQ 号 ✗ —— ★ 渲染里带上，她就能**直接抄去 `at`** ✓（2026-10-16 ✓）。
          senderId: { type: 'string' },
          text: { type: 'string' },
          reason: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? `${value.senderName ?? 'unknown'}(qq:${value.senderId ?? ''}): ${value.text ?? ''}`
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
          senderName: displayNameOf(detail.sender, 'unknown'),
          time: Math.floor(Date.now() / 1000),
          segments: Array.isArray(detail.message) ? detail.message : [],
          mentionsSelf: false,
          atUserIds: [],
          groupName: undefined,
          raw: detail as Record<string, unknown>,
        })
        return {
          ok: true,
          senderName: displayNameOf(detail.sender, 'unknown'),
          senderId: String(detail.sender?.user_id ?? ''),
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
            return {
              userId: String(member.user_id),
              // 与实时消息、引用、转发共用同一套显示名规则。
              name: displayNameOf(member, String(member.user_id)),
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

  // ── 手机模型：「打开手机看消息」的三个动作 ─────────────────────────
  //
  // 旧版是一个 qq_check_messages 两模式（不传参看概览、传参读正文）。
  // 按 docs/design.md §8.1 拆成三步 —— **因为"看列表"和"点进去看"是两件事**，
  // 而它们的差别正是已读语义（§4.7）：
  //
  //   qq_chats    打开 QQ 看会话列表 + 红点   →  **不推进游标**
  //   qq_read     点进某个会话看消息          →  **推进游标**
  //   qq_search   想不起来聊过什么就去搜      →  不涉及游标
  //
  // 这条区分的下层支撑在 adapter：`peek`/`unread` 不推进，只有 `drain` 推进。

  ctx.tools.register(defineTool({
    name: 'qq_chats',
    description: [
      'Look at the QQ chat list: which conversations have something new, and how many.',
      'Glancing at the list shows no message text and marks nothing as read — use qq_read for that.',
    ].join(' '),
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          chats: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                conversation: { type: 'string', required: true },
                unread: { type: 'integer', required: true },
              },
            },
          },
          reason: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (!value.ok) return [{ type: 'text', text: `Could not open the chat list: ${value.reason ?? 'unknown reason'}` }]
        const chats = value.chats ?? []
        if (chats.length === 0) return [{ type: 'text', text: 'No unread conversations.' }]
        return [{
          type: 'text',
          text: chats.map(item => `${item.conversation}: ${String(item.unread)} new`).join('\n'),
        }]
      },
    },
    async execute() {
      // `unread()` 不推进游标 —— 看列表不等于读过。
      const chats = ctx.qq.conversations()
        .map(conversation => ({ conversation, unread: ctx.qq.unread(conversation) }))
        .filter(item => item.unread > 0)
      return { ok: true, chats }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'qq_read',
    description: [
      'Open one QQ conversation and read its messages. This is the step that marks it as read.',
      'Rendering images and forwards costs work, so raise limit deliberately.',
    ].join(' '),
    parameters: {
      conversation: {
        type: 'string',
        description: 'Conversation to open, as "group:<group id>" or "private:<user id>".',
        required: true,
      },
      limit: {
        type: 'integer',
        description: 'Maximum messages to return. Defaults to 20.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          messages: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                messageId: { type: 'string', required: true },
                senderName: { type: 'string', required: true },
                // ★★ 发送者的 **QQ 号** ✗ —— 2026-10-16 加上 ✓：
                //   `qq_send_message` 的 `at` 要的是 QQ 号（不是昵称 ✗），
                //   ★ 而她手上只有昵称 ⇒ 每次都得先去 `qq_list_group_members` 查一轮 ✓。
                //   ★ 渲染里带上之后，她**直接抄**就能 @ ✓✓。
                senderId: { type: 'string', required: true },
                text: { type: 'string', required: true },
                mentionsSelf: { type: 'boolean', required: true },
              },
            },
          },
          reason: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (!value.ok) return [{ type: 'text', text: `Could not read it: ${value.reason ?? 'unknown reason'}` }]
        const messages = value.messages ?? []
        if (messages.length === 0) return [{ type: 'text', text: 'Nothing new there.' }]
        return [{
          type: 'text',
          text: messages
            // ★★ 带上 `(qq:…)` ✗ —— ★ 与 `(msg_id=…)` 明确不同 ✓：
            //   `qq:` 是"这个人的 QQ 号"（★ 给 `at` 用 ✓），
            //   `msg_id=` 是"这条消息的 id"（★ 给 `reply_to` 用 ✓✓）。
            .map(item => `${item.senderName}(qq:${item.senderId})${item.mentionsSelf ? ' (mentioned you)' : ''}: ${item.text}`)
            .join('\n'),
        }]
      },
    },
    async execute(args) {
      try {
        // `drain` —— **这一步才推进游标**。
        const unseen = ctx.qq.drain(args.conversation).slice(-(args.limit ?? 20))
        // 顺序渲染而不是并行：一条消息可能触发图片下载，并发起来会把协议端和网络一起打满。
        const messages = []
        for (const incoming of unseen) {
          messages.push({
            messageId: incoming.messageId,
            senderName: incoming.senderName,
            senderId: incoming.userId,
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

  ctx.tools.register(defineTool({
    name: 'qq_search',
    description: [
      'Search the full QQ message archive by text — everything ever received, not just what you were shown.',
      'Use it when you do not remember where something was said; hits come with their surrounding messages.',
    ].join(' '),
    parameters: {
      query: {
        type: 'string',
        description: 'Text to look for.',
        required: true,
      },
      conversation: {
        type: 'string',
        description: 'Limit the search to one conversation, as "group:<group id>" or "private:<user id>".',
      },
      since_hours: {
        type: 'integer',
        description: 'Only look back this many hours. Omit to search the whole archive.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          ranges: {
            type: 'array',
            description: 'Each element is one continuous stretch of a conversation containing at least one hit.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                conversation: { type: 'string', required: true },
                messages: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      senderName: { type: 'string', required: true },
                      // ★★ 发送者 QQ 号 ✗ —— ★ 搜索结果也带上 ✓：
                      //   ★ 她**正是用这个工具找人的** ✓（2026-10-16 实测她在这一步卡住 ✓）。
                      senderId: { type: 'string', required: true },
                      text: { type: 'string', required: true },
                      hit: { type: 'boolean', required: true },
                    },
                  },
                },
              },
            },
          },
          truncated: { type: 'boolean' },
          reason: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (!value.ok) return [{ type: 'text', text: `Search failed: ${value.reason ?? 'unknown reason'}` }]
        const ranges = value.ranges ?? []
        if (ranges.length === 0) return [{ type: 'text', text: 'Nothing matched.' }]
        const blocks = ranges.map(range => [
          `[${range.conversation}]`,
          ...(range.messages ?? []).map(item => `${item.hit ? '>> ' : '   '}${item.senderName}(qq:${item.senderId}): ${item.text}`),
        ].join('\n'))
        if (value.truncated === true) blocks.push('(more matches than fit — narrow the search)')
        return [{ type: 'text', text: blocks.join('\n\n') }]
      },
    },
    async execute(args) {
      try {
        const since = args.since_hours === undefined
          ? undefined
          : Date.now() - args.since_hours * 60 * 60 * 1000
        const result = ctx.db.messages.search({
          query: args.query,
          conversationId: args.conversation,
          since,
        })
        return {
          ok: true,
          truncated: result.truncated,
          ranges: result.ranges.map(range => ({
            conversation: range.conversationId,
            messages: range.messages.map(row => ({
              senderName: row.senderName ?? row.senderId ?? 'unknown',
              senderId: row.senderId ?? '',
              text: row.content,
              hit: range.hitIds.includes(row.messageId),
            })),
          })),
        }
      } catch (error) {
        return { ok: false, reason: reasonOf(error) }
      }
    },
  }))

  // ══════════════════════════════════════════════════════════════════════
  // ★ 第 1 批（2026-10-15）：群管理 ＋ 申请处理
  //
  // ★ 全部经 `ctx.qq.call(action, params)` —— 类型由 `ActionMap` 约束 ✓
  //   （动作名拼错会被类型挡住 ✓，见 `qq/protocol/index.ts` ✓）。
  //
  // ★★ **必须写 `output.schema`** ✓ —— 它是**结果类型的来源**：
  //   不写的话 `defineTool` 把结果推成 **`never`** ✗ ⇒ 报
  //   `Type '…' is not assignable to '… => Promise<never>'`（实测踩过**两次** ✗）。
  //   ★ 而 `required` 是**逐字段**写的（`{ type: 'boolean', required: true }` ✓），
  //   **不是** JSON-Schema 那个 `required: [...]` 数组 ✗ —— 照 `qq_chats` 抄的 ✓。
  //
  // ⚠️ **上下文成本**：每多一个工具，**每个请求**都要多带一份 schema ✗ ——
  //   而瓶颈是 **TPM**（硅基 L0：100,000，一条请求约 40,000 令牌 ✓）
  //   ⇒ 工具**分批上、能合就合** ✓
  // ══════════════════════════════════════════════════════════════════════

  ctx.tools.register(defineTool({
    name: 'qq_set_group_ban',
    description:
      'Mute someone in a QQ group, or lift a mute. duration is in seconds; '
      + 'pass 0 to lift a mute. Pass user_id "all" to mute the whole group.',
    parameters: {
      // ★★★ **直接照协议端的形状写** ✓ —— `set_group_ban` 本来就是
      //     `{group_id, user_id, duration}` ✓，**不需要**把它包成 `target:"group:<id>"` ✗。
      //
      //    为什么之前写错了：★ 我把 `AGENTS.md` §二 读过头了 ✗ ——
      //    那条的规矩是「**group:/private: 这类分叉只许出现在 adapter**」✓，
      //    ★★ 而**不是**「上层必须用一个编码字符串」✗。
      //    上层**不该做**的是 `if (kind === 'group') …` 这种**逻辑分叉** ✗；
      //    把 `group_id` 直接交给工具、让 adapter 去拼，**完全合规** ✓✓。
      //
      //    ★ 实测（2026-10-16）：她自然地填了 `{"group_id":"728636404", …}` ✓ ——
      //    ★ 而工具要的是 `target` ✗ ⇒ DSH 报 `missing required property "target"` ✓。
      //    **她的直觉是对的，我的形状是错的** ✓。
      //
      //    ★ `target` 只该用在"**真的可能群、也可能私聊**"的地方 ✓
      //    （`qq_send_message` / `qq_read` / `qq_send_image` / `qq_recall_message` ✓），
      //    ★ 而 `qq_list_group_members` 一直用的是 `group_id` ✓ —— **仓库里本就有正确先例** ✓。
      group_id: {
        type: 'string',
        required: true,
        description: 'The group id, digits only.',
      },
      user_id: {
        type: 'string',
        description: 'QQ number of the member to mute, or "all" for the whole group.',
      },
      duration: { type: 'number', description: 'Seconds. 0 lifts the mute.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          reason: { type: 'string' },
          muted: { type: 'string' },
          duration: { type: 'number' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? (value.duration === 0 ? `Lifted the mute on ${value.muted}.` : `Muted ${value.muted} for ${value.duration}s.`)
          : `Mute failed: ${value.reason ?? 'unknown reason'}`,
      }],
    },
    async execute(args) {
      const groupId = String(args.group_id ?? '').trim()
      if (!/^\d+$/.test(groupId)) {
        return { ok: false, reason: `group_id must be digits only, got "${groupId}"` }
      }
      const raw = String(args.user_id ?? '').trim()
      const user: number | 'all' = raw === 'all' ? 'all' : Number(raw)
      if (user !== 'all' && !Number.isFinite(user)) {
        return { ok: false, reason: `user_id must be a QQ number or "all", got "${raw}"` }
      }
      const duration = Math.max(0, Math.trunc(args.duration ?? 0))
      try {
        await ctx.qq.call('set_group_ban', { group_id: Number(groupId), user_id: user, duration })
        return { ok: true, muted: user === 'all' ? 'all' : String(user), duration }
      } catch (error) {
        return { ok: false, reason: reasonOf(error) }
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'qq_approve_friend',
    description:
      'Approve or reject a QQ friend request.',
    parameters: {
      flag: {
        type: 'string',
        required: true,
        description: 'The request flag, from the friend request you received.',
      },
      approve: { type: 'boolean', description: 'true to accept, false to reject.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          reason: { type: 'string' },
          approved: { type: 'boolean' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? (value.approved === false ? 'Friend request rejected.' : 'Friend request approved.')
          : `Friend request failed: ${value.reason ?? 'unknown reason'}`,
      }],
    },
    async execute(args) {
      try {
        await ctx.qq.call('set_friend_add_request', {
          flag: String(args.flag),
          approve: args.approve !== false,
        })
        // ★★ 告诉 `signals`：这一条处理完了 ✗ —— ★ 否则它会**每次 tick 都重报** ✓
        //   （★ 用户实测"好友通知反复跳、无法被消费"✓ ／ 见 `qq/request-consumed` 的注释 ✓）。
        ctx.emit('qq/request-consumed', String(args.flag))
        return { ok: true, approved: args.approve !== false }
      } catch (error) {
        return { ok: false, reason: reasonOf(error) }
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'qq_approve_group',
    description:
      'Approve or reject a QQ group join request, or accept a group invitation.',
    parameters: {
      flag: {
        type: 'string',
        required: true,
        description: 'The request flag, from the request you received.',
      },
      approve: { type: 'boolean', description: 'true to accept, false to reject.' },
      sub_type: {
        type: 'string',
        description: '"add" when someone asks to join, "invite" when you were invited. Optional.',
      },
      reason: { type: 'string', description: 'Reason shown on rejection. Optional.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          reason: { type: 'string' },
          approved: { type: 'boolean' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? (value.approved === false ? 'Group request rejected.' : 'Group request approved.')
          : `Group request failed: ${value.reason ?? 'unknown reason'}`,
      }],
    },
    async execute(args) {
      try {
        await ctx.qq.call('set_group_add_request', {
          flag: String(args.flag),
          approve: args.approve !== false,
          ...args.sub_type === undefined ? {} : { sub_type: String(args.sub_type) },
          ...args.reason === undefined ? {} : { reason: String(args.reason) },
        })
        // ★★ 同 `qq_approve_friend`：★ 处理完就告诉 `signals` 删掉待办 ✓。
        ctx.emit('qq/request-consumed', String(args.flag))
        return { ok: true, approved: args.approve !== false }
      } catch (error) {
        return { ok: false, reason: reasonOf(error) }
      }
    },
  }))

  // ══════════════════════════════════════════════════════════════════════
  // ★ 第 2 批（2026-10-15）：QQ 空间（说说）
  //
  // ★ 照第 1 批拿到的那两条约定写 ✓：
  //   ① `parameters` 必填字段**逐字段** `required: true` ✓
  //   ② `output` **同时**要有 `schema` 和 `render` ✓；数组要 `items` ✓
  //
  // ★ **输出一律映射成干净形状** ✓ —— 协议端的原始对象有几十个字段 ✗，
  //   直接回给模型既费令牌又没意义 ✓（而我们的瓶颈正是 TPM ✓）。
  // ══════════════════════════════════════════════════════════════════════

  ctx.tools.register(defineTool({
    name: 'qq_qzone_list',
    description:
      'List the posts on a Qzone (说说), with each post\'s tid, comment count and visibility.',
    parameters: {
      target_uin: { type: 'number', description: 'Whose Qzone. Optional (defaults to yours).' },
      pos: { type: 'number', description: 'Offset. Default 0.' },
      num: { type: 'number', description: 'How many. Default 20.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          total: { type: 'number' },
          posts: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                tid: { type: 'string', required: true },
                content: { type: 'string', required: true },
                createdAt: { type: 'number', required: true },
                commentCount: { type: 'number', required: true },
                private: { type: 'boolean', required: true },
              },
            },
          },
          reason: { type: 'string' },
        },
      },
      // ★★ **必须把 `tid` 一条条列出来** ✗ —— 只报"多少条"等于**一个都用不了** ✓✓
      //    实测（2026-10-16）：她为了回复评论**只能自己编 tid** ✗（编了 `"2"` ⇒ 协议端
      //    `-10004 参数错误` ✓）。★ 而 `tid` 是**唯一的操作句柄** ✓。
      render: (_args, value) => {
        if (value.ok !== true) return [{ type: 'text', text: `Qzone list failed: ${value.reason ?? 'unknown reason'}` }]
        const posts = value.posts ?? []
        if (posts.length === 0) return [{ type: 'text', text: `No posts (${String(value.total ?? 0)} total).` }]
        const lines = posts.map((post, index) => {
          const text = post.content.replace(/\s+/g, ' ').slice(0, 60)
          const comments = post.commentCount > 0 ? `评论 ${String(post.commentCount)}` : '无评论'
          const visibility = post.private === true ? '仅自己' : '公开'
          return `${String(index + 1)}. tid=${post.tid}  ${comments}  ${visibility}  ${text}`
        })
        return [{
          type: 'text',
          text: `共 ${String(value.total ?? posts.length)} 条，本页 ${String(posts.length)} 条：\n${lines.join('\n')}`,
        }]
      },
    },
    async execute(args) {
      try {
        const result = await ctx.qq.call('get_qzone_msg_list', {
          ...args.target_uin === undefined ? {} : { target_uin: Number(args.target_uin) },
          ...args.pos === undefined ? {} : { pos: Number(args.pos) },
          ...args.num === undefined ? {} : { num: Number(args.num) },
        })
        // ★★ 字段名照协议端的 schema 写 ✓（`time` ✓ / `comment_num` ✓ / `is_private` ✓）——
        //    ⚠️ 这里曾经写成 `created_time` ✗ ⇒ `createdAt` **恒为 0** ✓（而它还要当
        //    `qq_qzone_like` 的 `abstime` 用 ✗ ⇒ 那条链一起断 ✓）。
        const posts = (result.msglist ?? []).map(item => ({
          tid: String(item.tid ?? ''),
          content: String(item.content ?? ''),
          createdAt: Number(item.time ?? 0),
          commentCount: Number(item.comment_num ?? 0),
          private: item.is_private === true,
        }))
        return { ok: true, total: Number(result.total ?? posts.length), posts }
      } catch (error) {
        return { ok: false, reason: reasonOf(error) }
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'qq_qzone_post',
    description:
      'Post to your Qzone (说说). ugc_right: 1 = everyone, 4 = friends, '
      + '16 = only listed friends, 64 = only me, 128 = all but listed friends. Default 1.',
    parameters: {
      content: { type: 'string', required: true, description: 'The text of the post.' },
      ugc_right: { type: 'number', description: 'Visibility. Default 1 (everyone).' },
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
        text: value.ok ? 'Posted.' : `Post failed: ${value.reason ?? 'unknown reason'}`,
      }],
    },
    async execute(args) {
      try {
        await ctx.qq.call('send_qzone_msg', {
          content: String(args.content),
          ...args.ugc_right === undefined ? {} : { ugc_right: Number(args.ugc_right) },
        })
        return { ok: true }
      } catch (error) {
        return { ok: false, reason: reasonOf(error) }
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'qq_qzone_comment',
    description:
      'Comment on a Qzone post (说说). To reply to someone\'s comment on it, say so in the text '
      + '(there is no separate reply target).',
    parameters: {
      tid: {
        type: 'string',
        required: true,
        description: 'The post\'s tid, copied from qq_qzone_list.',
      },
      content: { type: 'string', required: true, description: 'The comment text.' },
      target_uin: { type: 'number', description: 'Owner of the post. Optional (defaults to yours).' },
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
        text: value.ok ? 'Commented.' : `Comment failed: ${value.reason ?? 'unknown reason'}`,
      }],
    },
    async execute(args) {
      try {
        await ctx.qq.call('comment_qzone', {
          tid: String(args.tid),
          content: String(args.content),
          ...args.target_uin === undefined ? {} : { target_uin: Number(args.target_uin) },
        })
        return { ok: true }
      } catch (error) {
        return { ok: false, reason: reasonOf(error) }
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'qq_qzone_like',
    description:
      'Like a Qzone post (说说), or pass unlike=true to remove your like.',
    parameters: {
      tid: {
        type: 'string',
        required: true,
        description: 'The post\'s tid, copied from qq_qzone_list.',
      },
      target_uin: { type: 'number', description: 'Owner of the post. Optional.' },
      abstime: {
        type: 'number',
        description: 'The post\'s createdAt, copied from qq_qzone_list. Optional.',
      },
      unlike: { type: 'boolean', description: 'true removes your like. Default false.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          reason: { type: 'string' },
          liked: { type: 'boolean' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? (value.liked === false ? 'Like removed.' : 'Liked.')
          : `Like failed: ${value.reason ?? 'unknown reason'}`,
      }],
    },
    async execute(args) {
      try {
        const action = args.unlike === true ? 'unlike_qzone' : 'like_qzone'
        await ctx.qq.call(action, {
          tid: String(args.tid),
          ...args.target_uin === undefined ? {} : { target_uin: Number(args.target_uin) },
          // ★★ `abstime` 是**说说发表时间** ✓ —— schema 自己写着「传真实值更可靠」✓。
          //    值来自 `qq_qzone_list` 的 `createdAt` ✓（★ 那条曾经断着 ✗ ——
          //    因为 list 里字段名读错成了 `created_time` ⇒ 恒为 0 ✓）。
          ...args.abstime === undefined ? {} : { abstime: Number(args.abstime) },
        })
        return { ok: true, liked: args.unlike !== true }
      } catch (error) {
        return { ok: false, reason: reasonOf(error) }
      }
    },
  }))

  // ══════════════════════════════════════════════════════════════════════
  // ★ 第 3 批（2026-10-15）：好友动态 ＋ 群系统消息 ＋ 禁言名单
  //
  // ★ 照配方写 ✓：必填参数逐字段 `required: true` ✓；`output` 同时有
  //   `schema` 和 `render` ✓；数组用 `items` ＋ 对象 schema ✓。
  // ══════════════════════════════════════════════════════════════════════

  ctx.tools.register(defineTool({
    name: 'qq_qzone_feeds',
    description:
      'Read your QQ friends\' Qzone timeline (好友动态). '
      + 'Only the first page is reliable; deeper pages are not supported yet.',
    parameters: {
      page_num: { type: 'number', description: 'Page number, starting at 1. Default 1.' },
      count: { type: 'number', description: 'Items per page. Default 10.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          reason: { type: 'string' },
          // ⚠️ 协议端这个返回体是**不透明对象**（字段没实测过 ✗）——
          //    所以先原样给 JSON ✓，**等抓一次真实返回再收紧** ✓
          //    （照 Todo 6 那条教训：不猜字段名 ✗）。
          feedsJson: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? (value.feedsJson ?? '(empty)')
          : `Qzone feeds failed: ${value.reason ?? 'unknown reason'}`,
      }],
    },
    async execute(args) {
      try {
        const result = await ctx.qq.call('get_qzone_feeds', {
          ...args.page_num === undefined ? {} : { page_num: Number(args.page_num) },
          ...args.count === undefined ? {} : { count: Number(args.count) },
        })
        return { ok: true, feedsJson: JSON.stringify(result) }
      } catch (error) {
        return { ok: false, reason: reasonOf(error) }
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'qq_group_requests',
    description:
      'Read pending QQ group system messages (加群申请 / 群邀请). '
      + 'Use this to catch requests that arrived earlier; live ones also arrive as notifications.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          reason: { type: 'string' },
          requests: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                groupId: { type: 'string', required: true },
                groupName: { type: 'string', required: true },
                subType: { type: 'string', required: true },
                requestId: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? `${String(value.requests?.length ?? 0)} pending group requests.`
          : `Group requests failed: ${value.reason ?? 'unknown reason'}`,
      }],
    },
    async execute() {
      try {
        const result = await ctx.qq.call('get_group_system_msg', {})
        const requests = (result ?? []).map(item => ({
          groupId: String(item.group_id ?? ''),
          groupName: String(item.group_name ?? ''),
          subType: String(item.sub_type ?? ''),
          requestId: String(item.request_id ?? ''),
        }))
        return { ok: true, requests }
      } catch (error) {
        return { ok: false, reason: reasonOf(error) }
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'qq_group_muted',
    description: 'List the members of a QQ group who are still muted.',
    parameters: {
      // ★ 同 `qq_set_group_ban`：★ **直接照协议端形状** `{group_id}` ✓ ——
      //   这里**只能是群** ✗，套 `target:"group:<id>"` 只会逼调用方记一个编码 ✗。
      group_id: {
        type: 'string',
        required: true,
        description: 'The group id, digits only.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          reason: { type: 'string' },
          muted: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                userId: { type: 'string', required: true },
                nickname: { type: 'string', required: true },
                until: { type: 'number', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? `${String(value.muted?.length ?? 0)} members are muted.`
          : `Muted list failed: ${value.reason ?? 'unknown reason'}`,
      }],
    },
    async execute(args) {
      // ★ 同 `qq_set_group_ban`：★ 直接照协议端形状 `{group_id}` ✓ —— 这里**只能是群** ✗，
      //   所以不该套 `target:"group:<id>"` ✗（★ 那会逼调用方记一个编码 ✓）。
      const groupId = String(args.group_id ?? '').trim()
      if (!/^\d+$/.test(groupId)) {
        return { ok: false, reason: `group_id must be digits only, got "${groupId}"` }
      }
      try {
        const result = await ctx.qq.call('get_group_shut_list', { group_id: Number(groupId) })
        const muted = (result ?? []).map(item => ({
          userId: String(item.user_id ?? ''),
          nickname: String(item.nickname ?? ''),
          until: Number(item.shut_up_time ?? 0),
        }))
        return { ok: true, muted }
      } catch (error) {
        return { ok: false, reason: reasonOf(error) }
      }
    },
  }))

  ctx.logger.info(`qq-tools 已注册 ${String(REGISTERED_TOOLS.length)} 个工具：${REGISTERED_TOOLS.join(', ')}`)
}
