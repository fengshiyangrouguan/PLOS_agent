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
import z from '@deepseek-ai/schemastery'
import type { QqIncoming } from '../adapter/index.ts'
import { conversationOf, parseConversation } from '../adapter/buffer.ts'
// ★ 通知／申请的映射 —— **纯逻辑在 `notice.ts`** ✓（白名单、级别、两类、指纹 ✓，28 项自检 ✓）。
import { mapNotice, mapRequest, type MappedSignal } from './notice.ts'
// ★ 「描述拿不到」那个占位文本 —— **从渲染它的地方导出**，别在这里再写一遍字面量
//   （两个文件靠同一个字面量耦合是脆的：改一处忘另一处就静默失效）。
import { IMAGE_MISSING } from '../pipeline/segments.ts'
import { offer } from '../wait.ts'
import type { Signal } from '../../perception/types.ts'

/** 插件名。 */
export const name = 'qq-signals'

/** 需要的能力：QQ（取消息）、感知（注册信号源）、数据库（存档）。 */
export const inject = ['qq', 'perception', 'db']

/** 配置。 */
export interface Config {
  /**
   * 等图片描述落定的窗口（毫秒）—— **到期就是终态**。
   *
   * 唤醒**不等归档**，而 VLM 那次调用实测 **1.2~38.5 秒**、且有 10 秒超时
   * （`vlm2text.config.timeoutMs`）⇒ 第一次渲染常常带着 `(加载失败)`。
   * 超时**没有中止**那次调用（是 `Promise.race`），所以它会跑完并写缓存 ——
   * 于是等这个窗口之后用 `render(…, { fresh: true })` 重看，就能拿到真描述，
   * 并**再唤醒她一次**（模板 `imageReady`：`【图片已渲染完成】`）。
   *
   * ★ 进 `Config` 而不是常量：它是**部署可变**的，而且"多久算拿不到"
   * 直接决定她多久之后才看到图。
   */
  imageReadyWaitMs: number
}

/** 配置 schema。 */
export const Config: z<Config> = z.object({
  // 60 秒：比实测最坏那次（38.5 秒）宽，又不至于让她等太久。
  imageReadyWaitMs: z.natural().default(60_000),
})

/**
 * `@` 白羽的优先级 —— ★★ **群聊里的 @** ✗。
 *
 * ★ **15**（2026-10-16 从 20 降下来 ✓，用户定 ✓）—— ★★ 意图：★ **让群 @ 低于私聊** ✓✓。
 *
 * ## 为什么（现象与推理）
 *
 * ★ 原来群 @ 与私聊**同为 20** ✗ ⇒ ★ 在 `attention` 的仲裁里（`preempt.ts` ✓）：
 * ★★ **群 @ 与私聊有同样的力量去打断她正在做的事** ✗ ——
 * ★ 实测她**在一轮里连着处理了 8 件事** ✗（★ 群 ✓ 私聊 ✓ 回复 ✓ 建记忆文件 ✓），
 * 看起来像"**被反复插队**"✓。
 *
 * ⇒ ★ 降到 15 之后：★ **私聊（20）能打断群 @（15）带来的那一轮** ✓，
 * ★★ **反过来不能** ✓✓ —— ★ 而两者都仍高于普通群消息（0 ✓）。
 */
const PRIORITY_MENTION = 15
/** 私聊的优先级。★ **保持 20** ✓ —— 它高于群 @（15 ✓）。 */
const PRIORITY_PRIVATE = 20
/** 普通群消息 —— **0 就是不产生自己的唤醒**，只搭下一次唤醒的便车。 */
const PRIORITY_GROUP = 0

/**
 * ★★ **"立刻催一次拉取"的那条线** ✗ —— ★ **独立于 `PRIORITY_MENTION`** ✓。
 *
 * ⚠️ 为什么要独立：★ 这个判据原先写成 `mapped.priority >= PRIORITY_MENTION` ✗ ——
 * ★★ 那是**借来的常量** ✓：它想说"20 级那么要紧 ⇒ 别等闲时定时器"✓，
 * ★ 却把群 @ 的级别**当成了标准** ✗。
 * ⇒ ★★ 群 @ 一降到 15，这条线会**悄悄跟着降** ✗✓（★ 而它的语义没变 ✓）。
 * ★ 所以现在写死 **20** ✓ —— ★ 与 `notice.ts` 的 `PRIORITY_DIRECT` 同值 ✓✓。
 */
const PRIORITY_TICK_NOW = 20

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
 * ★★ **待消费的通知／申请**（指纹 → 信号 ✓）。
 *
 * ## 为什么在模块级
 *
 * 放模块级是为了**不动 `collect` 的签名** ✓（少一处出错的地方 ✓）。
 * 代价是插件热重载时**不清空** ✗ —— 而这里**无害** ✓：重载后 `apply` 会重新把
 * 清单读出来用 ✓（而且"通知还在"本来就是**当前状态** ✓）。
 *
 * ## 消费语义（★ 见 `PLOS/docs/qq-notifications.md` §6.2 ✓）
 *
 * `pull()` **只读不移除** ✓（照 `peek` 的语义 —— "看不等读过" ✓）。
 * 两类的消失条件**不同** ✓：
 *
 *  · **事件型**（进群／退群／撤回／戳…）—— ★ **报出去就移出** ✓
 *    （和"有人 @ 了你"一样：发生了就是发生了 ✓，报过一次就不该再提 ✓）
 *  · **待办型**（加好友／加群申请／群邀请）—— ★★ **永不由 `pull()` 移出** ✓
 *    （**没处理就一直留着** ✓ —— 宁可重复报，也**绝不能丢** ✓✓）
 *
 * ⚠️ 待办型的**精确**清空点（她真的批准／拒绝之后 ✓）是**下一件事** ✓ ——
 * 规格已经写好了（§6.2：挂 `qq_approve_*` 成功 ✓）。在那之前，
 * 待办型会**每次 tick 都重报一遍** ✗（噪音 ✓，但**不丢** ✓ —— 方向是安全的 ✓）。
 */
const pending = new Map<string, MappedSignal>()

/**
 * 拉当前状态：**每个有未读的会话一条信号** ＋ **待消费的通知／申请**。
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
function collect(ctx: Context, ready: Map<string, string>): Signal[] {
  const signals: Signal[] = []

  // ★ **通知／申请**（指纹去重过 ✓）—— ★ 事件型**取走即清** ✓；待办型**留着** ✓。
  for (const [fingerprint, mapped] of pending) {
    if (mapped.signalClass === 'event') pending.delete(fingerprint)
    signals.push({
      kind: mapped.kind,
      source: mapped.source,
      priority: mapped.priority,
      data: mapped.data,
    })
  }

  // ★ **描述补上了的那几条** —— 数据是**渲染好的那条消息**与**会话 id**。
  //
  //   一次性：**取走即清**（下一次拉取不该再提同一件事）。
  for (const [conversation, text] of ready) {
    ready.delete(conversation)
    signals.push({
      kind: 'imageReady',
      source: conversation,
      priority: PRIORITY_PRIVATE,
      data: { conversation, text },
    })
  }

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
export function apply(ctx: Context, config: Config): void {
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

  // ★ 待告知表：会话 → **渲染好的那条消息**。`collect` **取走即清**。
  const ready = new Map<string, string>()

  /**
   * 那张图**稍后**拿到描述了吗 —— 拿到就**再唤醒一次**。
   *
   * ## 为什么需要它
   *
   * 唤醒**不等归档**（`wake` 与 `archive` 并行），而 VLM 那次调用实测 **1.2 ~ 38.5 秒**、
   * 且有 **10 秒超时**（`vlm2text.config.timeoutMs`）⇒ 第一次渲染常常带着
   * `(加载失败)` 归档。
   *
   * ★ **超时那一刻并没有中止那次调用**（超时是 `Promise.race`，不是 `abort`）——
   * 所以它会**跑完并写缓存**。于是这里等一段时间后用
   * `render(incoming, { fresh: true })` 重看：缓存命中就能拿到**真描述**。
   *
   * ## 判据
   *
   * ★ **变了才唤醒。** 没变说明还是没拿到（文本已经是 `(加载失败)`，不会更差），
   * 叫醒她也是白叫。**到期就是终态**（用户定案）。
   *
   * @param incoming - 那条可能带图的入站消息。
   */
  const followUpImage = async (incoming: QqIncoming): Promise<void> => {
    // 先看**已经渲染好的**那份（缓存命中，几乎不花钱）—— 没有待补的图就不必等。
    const before = await ctx.qq.render(incoming)
    if (!before.includes(IMAGE_MISSING)) return

    await new Promise<void>((resolve) => { setTimeout(resolve, config.imageReadyWaitMs) })

    // `fresh: true` ⇒ **丢掉解析缓存重解析**（不做的话 `resolveCache` 会把
    // `(加载失败)` 那份钉住，重看永远等于 before）。
    const after = await ctx.qq.render(incoming, { fresh: true })
    if (after === before) return

    ready.set(conversationOf(incoming), after)
    wake()
  }

  // ── 存档：每条消息进库（设计 §6.5「后台每一条都进库」）────────────
  ctx.on('qq/message', (incoming) => {
    void archive(ctx, incoming).catch((error: unknown) => {
      ctx.logger.warn(
        'qq-signals: 存档失败（不影响消息流转）：%o',
        error instanceof Error ? error.message : String(error),
      )
    })
    // ★ 补看：这一条里若有**还没描述出来的图**，稍后拿到描述时**再唤醒一次**
    //   （模板 `imageReady`）。它**不影响**下面那次唤醒的时序。
    void followUpImage(incoming).catch((error: unknown) => {
      ctx.logger.warn(
        'qq-signals: 补看图片描述失败（不影响消息流转）：%o',
        error instanceof Error ? error.message : String(error),
      )
    })
    // ★ **有人在这个会话上等待 ⇒ 消息交给它，不产生唤醒**（短路）。
    //
    //   这是 Tulpa 式等待工具的机制面：她在等 A 的下一条消息时，
    //   A 的消息**不该**再去触发一次唤醒（那会把等待变成一个重复唤醒源），
    //   而是直接回传给那个工具 —— **由它负责已读**（`drain`）。见 `../wait.ts`。
    //
    //   别的会话不受影响（`isWaiting` 只看那一个会话）。
    if (offer(conversationOf(incoming))) return
    // ★ **冲她来的消息**：先问"能不能**直接补进她正在跑的那一轮**"（同源同级），
    //   补不进去才叫醒感知层去**全体拉取**。
    //
    //   为什么先问那一下（两条都是实测过的坏结果）：
    //     · **全体拉取**给她的是每个会话一段**梗概**，而"同一个人接着说的下一句"
    //       她该看到**原文**；
    //     · 而如果只是排进队列，那要等下一条通知才被取
    //       （「发了消息她半天不理，我再说一句就全收到了」）。
    //
    //   ★ 位置在 `archive` **之后**：下面 `render()` 走的是同一条解析路径
    //     （有解析缓存），所以拿到的是**已渲染**的原文 —— 图片这时候已经有描述。
    //     用户定案的边界：「**steer 必须在 archive 之后**」。
    //
    //   普通群消息（0 级）不叫，只搭便车 ⇒ 也不必补（她根本没为它开一轮）。
    if (wakes(incoming)) {
      void (async (): Promise<void> => {
        const conversation = conversationOf(incoming)
        const priority = incoming.mentionsSelf
          ? PRIORITY_MENTION
          : (parseConversation(conversation)?.kind === 'private' ? PRIORITY_PRIVATE : PRIORITY_GROUP)
        try {
          const text = await ctx.qq.render(incoming)
          const parsed = parseConversation(conversation)
          // ★★ **必须框**：同源补充进她那一轮的是**一句裸文本**，没有"谁发的、
          //    这是聊天消息"这层 ⇒ 她会把它当成**指令去执行**。
          //
          //    实测（2026-10-15）：私聊里连说三次「停」，她把「停」当指令 ⇒
          //    **不再调 `qq_send_message`** ⇒ 她写了三条"我已经停了"，
          //    而**一条都没到 QQ** ✗✗（`assistant/message` 的正文**不会**到达对方，
          //    只有工具会）。
          //
          //    框上之后，那条就该**回**（用工具 ✓），而不是**执行** ✗。
          const framed = parsed === undefined
            ? text
            : `【QQ 新增消息】${incoming.senderName ?? '有人'}(id:${parsed.id}) 刚发来：\n${text}`
          if (ctx.perception.supplement('QQ', conversation, framed, priority)) {
            // ★ **补即已读**（用户定案）：收下了就要 `drain`，否则下次 `pull()`
            //   会再带上它 ⇒ 她收到两遍。
            ctx.qq.drain(conversation)
            return
          }
          wake()
        } catch (error) {
          // 补不进去不该更坏 —— 回落成"正常唤醒"。
          ctx.logger.warn(
            'qq-signals: 同源补充失败，回落成正常唤醒：%o',
            error instanceof Error ? error.message : String(error),
          )
          wake()
        }
      })()
    }
  })

  // ── ★ 通知／申请：接事件、攒列表 ──────────────────────────────────
  //
  //   ★ 帧的字段**全部是实测的** ✓（`PLOS/docs/qq-notifications.md` §二/§三 ✓）——
  //   映射逻辑（白名单、级别、两类、指纹）在 `notice.ts` ✓（纯函数 ＋ 28 项自检 ✓）。
  //
  //   ⚠️ **`selfId` 是懒取的** —— 映射要它判"这条是不是冲我来的" ✓，
  //   而 `get_login_info` 是异步的 ✗。**没拿到之前按"不是我"处理** ✓ ——
  //   ★ 方向是安全的：宁可把"她自己进群"报成"有人进群" ✓，
  //     也不要反过来（把**所有人**进群都报成"她进群了" ✗✗）。
  let selfId = ''
  void ctx.qq.call('get_login_info', {}).then(
    (info: unknown) => {
      const record = info as Record<string, unknown> | undefined
      selfId = String(record?.['user_id'] ?? record?.['userId'] ?? '')
    },
    () => { /* 拿不到就算了 —— 见上面的安全方向 ✓ */ },
  )

  /** ★ 群名 —— **查库** ✓（通知帧里只有 `group_id`、没有群名 ✗，实测 ✓）。 */
  const nameOfGroup = (groupId: string): string =>
    ctx.db.conversations.get(`group:${groupId}`)?.name ?? `群${groupId}`
  /** ★ 私聊名 —— 同样查库 ✓；拿不到就用会话 id ✓（★ **不能是空串** ✗）。 */
  const nameOfConversation = (conversation: string): string =>
    ctx.db.conversations.get(conversation)?.name ?? conversation

  /**
   * 把一条映射好的信号记进待消费列表。
   *
   * ★ **按指纹去重** ✓ —— 同一件事**只进一次** ✓（这就是"当前状态而不是增量日志" ✓）。
   *
   * @param mapped - 映射结果；`undefined`（不在白名单 ✓）时什么都不做 ✓。
   */
  const remember = (mapped: MappedSignal | undefined): void => {
    if (mapped === undefined) return
    if (pending.has(mapped.fingerprint)) return
    pending.set(mapped.fingerprint, mapped)
    // ★ 上限（内存卫生 ✓，不是正确性 ✓）：丢了旧指纹最坏就是"极老的事重报一次" ✓。
    if (pending.size > 200) {
      const oldest = pending.keys().next().value
      if (oldest !== undefined) pending.delete(oldest)
    }
    // ★ 20 级 ⇒ **立刻催一次拉取** ✓ —— 她这一轮就该看见，不必等闲时定时器 ✓。
    //   ★★ 用 `PRIORITY_TICK_NOW` 而**不是** `PRIORITY_MENTION` ✗ ——
    //   后者是"群 @"的级别 ✓，拿它当这条线会让线随群 @ 一起漂 ✓（见常量注释 ✓）。
    if (mapped.priority >= PRIORITY_TICK_NOW) {
      void ctx.perception.tick().catch(() => { /* tick 失败不影响攒列表 ✓ */ })
    }
  }

  /** 每次映射时才取 —— 这样 `selfId` 是懒取的就自然也生效了 ✓。 */
  const mapContext = () => ({ selfId, nameOfGroup, nameOfConversation })

  ctx.on('qq/notice', (raw) => { remember(mapNotice(raw, mapContext())) })
  ctx.on('qq/request', (raw) => { remember(mapRequest(raw, mapContext())) })

  // ── 信号源：注册即 effect，随插件卸载 ────────────────────────────
  ctx.effect(() => ctx.perception.register({
    domain: 'QQ',
    priority: PRIORITY_GROUP,
    templates: {
      mention: '群「{name}（id:{id}）」里有人 @ 了你',
      private: '{sender}(id:{id}) 私聊了你',
      group: '群「{name}（id:{id}）」里有 {count} 条新消息',
      // ★★ **通知与申请**（2026-10-15 加 ✓）—— 文本见 `PLOS/docs/qq-notifications.md` §6.1 ✓。
      //   ★ `kind` 由 `notice.ts` 的 `mapNotice` / `mapRequest` 产出 ✓（拼错渲染会失败 ✓）。
      //   ★ 占位符直接写 `{user}` / `{operator}` / `{comment}` / `{duration}` ✓ ——
      //     渲染器是通用的（`applyTemplate` ✓），**不需要为它们加接口** ✓；
      //     但**取不到就会抛错** ✗ ⇒ 所以 `data` 里必须**每个键都填**（兜底在映射侧 ✓）。
      pokeGroup: '群「{name}（id:{id}）」里 {sender} 戳了戳你',
      pokePrivate: '{sender}(id:{id}) 私聊戳了戳你',
      joinedSelf: '{operator} 把你拉进了群「{name}（id:{id}）」',
      joinedSelfApprove: '你加入了群「{name}（id:{id}）」',
      memberJoined: '群「{name}（id:{id}）」里 {user} 进来了（{operator} 批准的）',
      kickedSelf: '{operator} 把你踢出了群「{name}（id:{id}）」',
      groupDisbanded: '群「{name}（id:{id}）」解散了',
      memberKicked: '群「{name}（id:{id}）」里 {user} 被 {operator} 踢了',
      memberLeft: '{user} 退出了群「{name}（id:{id}）」',
      muted: '群「{name}（id:{id}）」里 {user} 被 {operator} 禁言了 {duration}',
      unmuted: '群「{name}（id:{id}）」里 {user} 的禁言被解除了',
      adminSelf: '你在群「{name}（id:{id}）」里成了管理员',
      adminOther: '群「{name}（id:{id}）」里 {user} 成了管理员',
      groupRecall: '群「{name}（id:{id}）」里 {operator} 撤回了一条消息',
      friendRecall: '{sender}(id:{id}) 撤回了一条消息',
      // ★★ 待办型（★ 要**她**决定 ✓ —— `comment` 是验证问答／附言，必须原样给她 ✓）
      friendRequest: '{sender}(id:{id}) 申请加你为好友，附言：{comment}',
      groupRequest: '{sender}(id:{id}) 申请加入群「{name}（id:{id}）」，验证信息：{comment}',
      groupInvite: '{operator} 邀请你加入群「{name}（id:{id}）」',
      // ★ 图片**稍后**才描述出来的那一次 —— 数据是**渲染好的那条消息**与**会话 id**。
      //   自带理由，所以她看得出"为什么又被叫了一次"，而不是以为消息重复了。
      imageReady: '【图片已渲染完成】{conversation} {text}',
    },
    pull: () => collect(ctx, ready),
  }))
}
