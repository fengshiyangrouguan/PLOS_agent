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
 * ## 群名：**能拿到**（这里曾有一段错误结论）
 *
 * ⚠️ 本节曾写"实测结论：取不到，所以 SnowLuma 的事件里没有群名"。
 * **那是错的** —— 错在**字段名**：SnowLuma 发的是**非标准的 `group_name`**，
 * 而 adapter 当时只读 `peerName`，所以永远是空。
 *
 * **抓一次原始 JSON 即可定论**（这件事本身就是教训：数据能直接看就不要反推，
 * 见 AGENTS.md 第一节）。修好之后渲染正常：
 *
 *     群「古乐の秘♂密基地（id:728636404）」里有 2 条新消息
 *
 * 现在的形状：`QqIncoming.groupName` 由 adapter 从 `group_name` 取
 * （`peerName` 留作兼容回落，别的协议端可能有），落库进 `conversation_name`。
 *
 * 模板写成 `{name}（id:{id}）` 并在 `nameOf()` 里回落 id —— 这样：
 * - 上游哪天不带群名，回落成 id，不会炸
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
import { conversationOf, parseConversation } from '../adapter/buffer.ts'
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
 * 唤醒的防抖窗口（毫秒）。
 *
 * `< 80` 的唤醒是"有人找你"，不是"出事了" —— 一批连着来的消息
 * **合并成一次拉取**就够了。这不光省事，也是 Shiraha_OS 的做法。
 *
 * ★ **合并不会漏内容**：`pull()` 返回的是**当前状态**而不是增量日志
 * （见 `collect()` 的注释），所以后一次拉取本身已包含前面的消息；
 * 而 `attention` 队列的**同来源合并**（`queue.ts`）保证它们只占一格、内容取最新。
 */
const WAKE_DEBOUNCE_MS = 300

/**
 * 一条入站消息是否"**产生自己的唤醒**"。
 *
 * 与 `collect()` 里的优先级赋值**同源**：@我 → 20、私聊 → 20、普通群消息 → 0。
 * `0` 的定义就是"不产生自己的唤醒"（`design.pre-m5.md:134`）。
 *
 * 这里只看"是不是冲她来的"，**不判优先级数值** —— 数值的归属在 `collect()` 里一处。
 *
 * @param incoming - 入站消息。
 * @returns 是否该发起一次信号拉取。
 */
function wakes(incoming: QqIncoming): boolean {
  return incoming.mentionsSelf || incoming.groupId === undefined
}

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
    conversationId: conversationOf(incoming),
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
 * 取会话名（群名），取不到时回落 id。
 *
 * **占位符必须有值** —— 感知层的 `applyTemplate` 对缺字段是抛错的，
 * 所以这里不能把 `undefined` 传给模板。
 *
 * @param last - 该会话最后一条消息。
 * @param fallback - 群名缺失时的回落值（用会话 id）。
 * @returns 会话名。
 */
function nameOf(last: QqIncoming | undefined, fallback: string): string {
  return last?.groupName ?? fallback
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
  // ── ★ ② 信号拉：`priority > 0` 的信号**产生自己的唤醒** ─────────────
  //
  //   ★ 这是感知的**两根轴**里被漏掉的那一根（另一根是闲时定时拉）：
  //
  //       `docs/design.pre-m5.md:91`
  //         │ ① 定时拉（闲时，30 分钟） │ ② **信号拉（带优先级）**
  //       `:134`
  //         | **0** | 不太有用的信息 | **不产生自己的唤醒**，只搭下一次唤醒的便车 |
  //
  //   没有它，一条私聊只能等闲时定时器（生产值 **30 分钟**）—— 等于没在听。
  //   而 `perception.tick()` 本来就是个公开方法，只是此前**唯一调用方是定时循环**。
  //
  //   注意 `attention` 的模块注释（"信号发起的拉取 ⟹ `highest > 0`"）与
  //   删掉 `trigger` 字段（提交 `2ab635d`）都**以这根轴存在为前提** ——
  //   所以接上它同时也是把那两处的依据补实。
  let wakeTimer: ReturnType<typeof setTimeout> | undefined
  const wake = (): void => {
    // 已排定 ⇒ 并进那一次（防抖）。
    if (wakeTimer !== undefined) return
    wakeTimer = setTimeout(() => {
      wakeTimer = undefined
      void ctx.perception.tick().catch((error: unknown) => {
        ctx.logger.warn(
          'qq-signals: 信号拉取失败：%o',
          error instanceof Error ? error.message : String(error),
        )
      })
    }, WAKE_DEBOUNCE_MS)
  }
  ctx.effect(() => () => {
    if (wakeTimer !== undefined) clearTimeout(wakeTimer)
  })

  // ── 存档：每条消息进库（设计 §6.5「后台每一条都进库」）────────────
  ctx.on('qq/message', (incoming) => {
    void archive(ctx, incoming).catch((error: unknown) => {
      ctx.logger.warn(
        'qq-signals: 存档失败（不影响消息流转）：%o',
        error instanceof Error ? error.message : String(error),
      )
    })
    // 冲她来的消息**当场叫醒感知层**去拉一次；普通群消息（0 级）不叫，只搭便车。
    if (wakes(incoming)) wake()
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
