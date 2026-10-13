/**
 * `qq` 领域的**感知接入**：把 QQ 变成感知层的一个信号源，并把消息存档。
 *
 * ## 为什么单独一个插件
 *
 * 三条边界各归各位（计划 §0.2 的分层纪律）：
 *
 * | 目录 | 层 | 职责 |
 * |:--|:--|:--|
 * | `qq/adapter` | ① 能力 seam | WS 连接、收发、消息缓冲 |
 * | `qq/tools` | ② 工具包装 | 给模型的可调用工具 |
 * | **`qq/signals`** | **领域 → 感知** | **注册信号源 + 消息存档** |
 * | `qq/prompt` | ③ 提示词 | 说明 |
 *
 * 放在 adapter 里会让能力层认识 `perception` 和 `db`；放在 tools 里会让
 * "给模型看的东西"和"给感知层看的东西"混在一起。
 *
 * ## 方向（docs/design.md §4.1）
 *
 * **领域只暴露状态，感知层统一渲染。** 这里 `pull()` 返回的是**结构化信号**，
 * 不是渲染好的文本 —— 文本由 `templates` + 感知层的渲染器拼出来。
 * 这是"不写大量提示词"能成立的前提：简报只说"有人 @ 了你"，不说"你该回话"。
 *
 * ## 已读语义（docs/design.md §4.7）
 *
 * **点进去才算已读**。所以：
 * - 这里 `pull()` 用 `peek()` / `unread()` —— **都不推进游标**
 * - 只有 `qq_read` 那个工具用 `drain()`，它才推进
 *
 * 旧的 `attention` 在这里调 `ctx.qq.drain()`（读即已读），等于"感知层替你点进去了"。
 * M3 把响应侧改成订阅感知条目之后，这条路径已经不存在了；本插件保证它不再回来。
 *
 * ## 群名：字段接通了，但 SnowLuma 实际不发
 *
 * `QqIncoming.groupName` 已存在 —— adapter 从事件的**非标准字段 `peerName`** 取
 * （adapter/index.ts:458，`protocol/index.ts:64` 有说明：标准 OneBot v11 没有群名，
 * 常规做法是调 `get_group_info`，用这个字段可以省一次往返，"取不到就不取"）。
 *
 * **实测结论：取不到。** 落库的 `conversation_name` 三个会话全是空，
 * 渲染回落成 `群「871234（id:871234）」`。所以 SnowLuma 的事件里没有 `peerName`。
 *
 * 模板仍然写成 `{name}（id:{id}）` 并在 `nameOf()` 里回落 id —— 这样：
 * - 上游哪天带了群名，不用改代码就有了
 * - 不带也不缺字段（`applyTemplate` 对缺字段是抛错的）
 *
 * 真要群名就得给 adapter 加一个带缓存的 `get_group_info` 查询（一次往返 + 缓存）。
 * **但注意 id 反而是更可靠的标识** —— 用户实测过 AI 会把「秘密の基地」打成
 * 「秘密的基地」（decisions.md 的 TODO #1），名字对模型是有损的。
 *
 * @module qq/signals
 */

import type { Context } from '@deepseek-ai/cordis'
import type { QqIncoming } from '../adapter/index.ts'
import { parseConversation } from '../adapter/buffer.ts'
import type { Signal } from '../../perception/types.ts'

/** 插件名。 */
export const name = 'qq-signals'

/** 需要的能力：QQ（取消息）、感知（注册信号源）、数据库（存档）。 */
export const inject = ['qq', 'perception', 'db']

/** `@` 白羽的优先级。 */
const PRIORITY_MENTION = 20
/** 私聊的优先级。 */
const PRIORITY_PRIVATE = 20
/** 普通群消息 —— **0 就是不产生自己的唤醒**，只搭下一次唤醒的便车。 */
const PRIORITY_GROUP = 0

/**
 * 把一条入站消息渲染成文本并存档。
 *
 * 渲染可能有 I/O（图片下载 / VLM 描述），所以是异步的；失败只记日志 ——
 * **存档失败不该影响消息的正常流转**。
 *
 * @param ctx - 插件上下文。
 * @param incoming - 入站消息。
 */
async function archive(ctx: Context, incoming: QqIncoming): Promise<void> {
  const text = await ctx.qq.render(incoming)
  ctx.db.messages.insert({
    platform: 'qq',
    messageId: incoming.messageId,
    conversationId: conversationIdOf(incoming),
    conversationType: incoming.groupId === undefined ? 'private' : 'group',
    conversationName: incoming.groupName,
    senderId: incoming.userId,
    senderName: incoming.senderName,
    time: incoming.time * 1000,
    content: text,
    segments: JSON.stringify(incoming.segments),
  })
}

/**
 * 算出一条消息所属的规范化会话 id。
 * @param incoming - 入站消息。
 * @returns `group:<群号>` 或 `private:<QQ号>`。
 */
function nameOf(last: QqIncoming | undefined, fallback: string): string {
  return last?.groupName ?? fallback
}

/**
 * 算出一条消息所属的规范化会话 id。
 * @param incoming - 入站消息。
 * @returns `group:<群号>` 或 `private:<QQ号>`。
 */
function conversationIdOf(incoming: QqIncoming): string {
  return incoming.groupId === undefined ? `private:${incoming.userId}` : `group:${incoming.groupId}`
}

/**
 * 拉当前状态：**每个有未读的会话一条信号**。
 *
 * **必须是"当前状态"而不是"增量日志"** —— 闲时定时器不重置，她在忙时照常走，
 * 所以这个函数会被反复调用；返回当前状态才能保证重复调用不会累积出错误的历史
 * （docs/design.md §4.6）。
 *
 * 用 `peek()` 而不是 `drain()` —— **看不等读过**。
 *
 * @param ctx - 插件上下文。
 * @returns 信号列表。
 */
function collect(ctx: Context): Signal[] {
  const signals: Signal[] = []
  for (const conversation of ctx.qq.conversations()) {
    const unread = ctx.qq.unread(conversation)
    if (unread === 0) continue

    const pending = ctx.qq.peek(conversation, unread)
    const parsed = parseConversation(conversation)
    if (parsed === undefined) continue
    const last = pending.at(-1)
    const mentioned = pending.some(item => item.mentionsSelf)

    if (mentioned) {
      signals.push({
        kind: 'mention',
        source: conversation,
        priority: PRIORITY_MENTION,
        data: { name: nameOf(last, parsed.id), id: parsed.id, sender: last?.senderName ?? '有人' },
      })
      continue
    }

    if (parsed.kind === 'private') {
      signals.push({
        kind: 'private',
        source: conversation,
        priority: PRIORITY_PRIVATE,
        data: { id: parsed.id, sender: last?.senderName ?? '有人' },
      })
      continue
    }

    signals.push({
      kind: 'group',
      source: conversation,
      priority: PRIORITY_GROUP,
      data: { name: nameOf(last, parsed.id), id: parsed.id, count: unread },
    })
  }
  return signals
}

/**
 * 装好存档与信号源。
 * @param ctx - 插件上下文。
 */
export function apply(ctx: Context): void {
  // ── 存档：每条消息进库（设计 §6.5「后台每一条都进库」）────────────
  ctx.on('qq/message', (incoming) => {
    void archive(ctx, incoming).catch((error: unknown) => {
      ctx.logger.warn(
        'qq-signals: 存档失败（不影响消息流转）：%o',
        error instanceof Error ? error.message : String(error),
      )
    })
  })

  // ── 信号源：注册即 effect，随插件卸载 ────────────────────────────
  ctx.effect(() => ctx.perception.register({
    domain: 'QQ',
    priority: PRIORITY_GROUP,
    templates: {
      mention: '群「{name}（id:{id}）」里有人 @ 了你',
      private: '{sender}(id:{id}) 私聊了你',
      group: '群「{name}（id:{id}）」里有 {count} 条新消息',
    },
    pull: () => collect(ctx),
  }))
}
