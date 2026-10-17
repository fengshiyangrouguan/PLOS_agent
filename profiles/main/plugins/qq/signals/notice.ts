/**
 * 把 QQ 的**通知帧**与**申请帧**映射成感知信号 —— **纯逻辑**。
 *
 * ★ 这个模块**不认识 cordis**（不吃 `ctx` ✓）—— 与 `attention/preempt.ts` /
 * `attention/queue.ts` 同一个形状 ✓：能离线验的判定全在这儿，
 * 插件那边只负责"接事件、攒列表、供 `pull()`" ✓（好测、也好改 ✓）。
 *
 * ## 规格来源
 *
 * ★ 全部依据 **`PLOS/docs/qq-notifications.md`** ✓：
 *   · §二 / §三 —— **实测**的帧形状（11 个 notice ＋ 4 个 request ✓）
 *   · §6.1 —— 每条通知的**模板化语言**（`kind` 与 `data` 的键就照它 ✓）
 *   · §6.2 —— **白名单与消费语义** ✓
 *
 * ## 这个模块要回答的三个问题
 *
 * 1. ★★ **收不收**（白名单）—— 尤其 **`notify/input_status` 必须丢掉** ✗✗：
 *    实测 11 个 notice 里占 3 个，而且**对方每打一个字都推** ⇒
 *    收了它 = 她被无限唤醒 ✗
 * 2. ★★ **几级** —— 决定"叫不叫醒她" ✓（0 = 只搭便车 ✓）
 * 3. ★★★ **哪一类** —— `'event'`（送到就算完 ✓）还是 `'todo'`（要等她处理完 ✓）：
 *    用户 2026-10-15 的原话：「**xxx加群了、xxx退群了，本质就是跟谁 at 了一样的。
 *    那些需要处理的比如好友申请、加群申请的才是需要等待处理完才清掉的。**」✓
 *
 * @module qq/signals/notice
 */

/** 优先级：0 = **永不唤醒**（只在闲时定时拉时出现 ✓）。 */
export const PRIORITY_PASSIVE = 0
/** 优先级：需要她理的事（申请、@、私聊 ✓）。 */
export const PRIORITY_DIRECT = 20

/**
 * 信号的类别 —— ★★ 决定它**什么时候从列表里消失** ✓。
 *
 *  · `'event'`：**送到就算完** ✓（和"有人 @ 了你"一样 —— 发生了就是发生了 ✓）
 *  · `'todo'`：**要等她处理完**（批准／拒绝 ✓）才清掉 ✓ —— 没处理就一直留着 ✓
 */
export type SignalClass = 'event' | 'todo'

/** 一条映射好的信号（感知层的 `Signal` ＋ 我们跟踪用的两个字段 ✓）。 */
export interface MappedSignal {
  /** 对应 `templates` 里的键 ✓（拼错会渲染失败 ✓）。 */
  readonly kind: string
  /** 模板占位符的取值 ✓（值只能是 `string | number` ✓）。 */
  readonly data: Readonly<Record<string, string | number>>
  /** 来源标识（进感知历史用 ✓，不参与渲染 ✓）。 */
  readonly source: string
  /** 生效优先级 ✓。 */
  readonly priority: number
  /** ★★ 哪一类 ✓。 */
  readonly signalClass: SignalClass
  /**
   * ★ 指纹 —— **同一件事只进列表一次** ✓（防同一条通知在每个 tick 重报 ✓）。
   *
   *  · 待办型：用 **`flag`** ✓（它本来就是唯一的 ✓）
   *  · 事件型：用帧里的稳定字段拼（`message_id` ／ `(group,user,time)` ✓）
   */
  readonly fingerprint: string
  /**
   * ★ 待办型的身份 —— **`flag`** ✓（她处理完时用它把这条清掉 ✓）。
   *
   * 实测两种格式：好友 `u_BRFKUDGs7v8nn1DiQ0N-dw` ／ 群 `slreq:1:…:0` ✓ ——
   * ★ **都是字符串，绝不能当数字** ✓。
   */
  readonly flag?: string
}

/**
 * 映射要用到的外部信息。
 *
 * ★ 刻意做成**两个回调**（而不是把 `ctx` 塞进来 ✓）—— 这样这个模块能离线验 ✓。
 */
export interface MapContext {
  /** 机器人自己的 QQ 号 —— ★★ 用来判"这条是不是冲我来的" ✓。 */
  readonly selfId: string
  /**
   * 按**群号**取群名。
   *
   * ★ 通知帧里**只有 `group_id`、没有群名** ✗（实测 ✓）⇒ 由调用方查库 ✓
   * （`ctx.db.conversations` ✓ 见 `db/stores.ts` 的 `ConversationStore` ✓）。
   * ★★ **必须返回非空字符串** ✓ —— 拿不到时**由调用方**填兜底（如 `群<id>` ✓），
   * 因为感知层的渲染器**取不到字段会抛错** ✓（`perception/render.ts:74` ✓）。
   */
  readonly nameOfGroup: (groupId: string) => string
  /**
   * 按**会话 id** 取展示名（私聊用 ✓）。
   *
   * 拿不到时同样由调用方兜底 ✓。
   */
  readonly nameOfConversation: (conversationId: string) => string
}

/** 取出一个字符串字段（帧里的值可能是数字 ✓）。 */
function str(raw: Record<string, unknown>, key: string): string {
  const value = raw[key]
  return value === undefined || value === null ? '' : String(value)
}

/** 取出一个数字字段。 */
function num(raw: Record<string, unknown>, key: string): number {
  const value = Number(raw[key])
  return Number.isFinite(value) ? value : 0
}

/** 这条帧是不是"冲我来的" ✓（★ 判据是 `user_id === selfId` ✓）。 */
function isSelf(raw: Record<string, unknown>, ctx: MapContext): boolean {
  return str(raw, 'user_id') === ctx.selfId
}

/** 群会话 id（与 `adapter/buffer.ts` 的写法一致 ✓）。 */
function groupConversation(groupId: string): string {
  return `group:${groupId}`
}

/** 私聊会话 id ✓。 */
function privateConversation(userId: string): string {
  return `private:${userId}`
}

/** 禁言的时长，写成人话 ✓。 */
function durationText(seconds: number): string {
  if (seconds <= 0) return ''
  if (seconds % 3600 === 0) return `${String(seconds / 3600)} 小时`
  if (seconds % 60 === 0) return `${String(seconds / 60)} 分钟`
  return `${String(seconds)} 秒`
}

/**
 * 把一个 `post_type=notice` 的帧映射成信号。
 *
 * @param raw - 原始通知帧 ✓。
 * @param ctx - 外部信息（`selfId` ＋ 取名回调 ✓）。
 * @returns 信号；**不在白名单里就 `undefined`** ✓（调用方丢掉它 ✓）。
 */
export function mapNotice(
  raw: Readonly<Record<string, unknown>>,
  ctx: MapContext,
): MappedSignal | undefined {
  const noticeType = str(raw, 'notice_type')
  const subType = str(raw, 'sub_type')
  const time = num(raw, 'time')

  // ── notify：★ 只有 poke 收；★★ input_status 必须丢 ✗ ──────────────
  if (noticeType === 'notify') {
    if (subType !== 'poke') return undefined
    const sender = str(raw, 'sender_id') || str(raw, 'user_id')
    const groupId = str(raw, 'group_id')
    if (groupId === '') {
      // 私聊戳一戳 ✓
      return {
        kind: 'pokePrivate',
        data: { sender: ctx.nameOfConversation(privateConversation(sender)), id: sender },
        source: privateConversation(sender),
        priority: PRIORITY_DIRECT,
        signalClass: 'event',
        fingerprint: `poke:${sender}:${String(time)}`,
      }
    }
    return {
      kind: 'pokeGroup',
      data: { name: ctx.nameOfGroup(groupId), id: groupId, sender },
      source: groupConversation(groupId),
      priority: PRIORITY_DIRECT,
      signalClass: 'event',
      fingerprint: `poke:${groupId}:${sender}:${String(time)}`,
    }
  }

  // ── 进群 ──────────────────────────────────────────────────────────
  if (noticeType === 'group_increase') {
    const groupId = str(raw, 'group_id')
    const user = str(raw, 'user_id')
    const operator = str(raw, 'operator_id')
    // ★★ 判据：`user_id` 是不是自己 —— 不能只看 `sub_type` ✗（实测证实 ✓）
    if (isSelf(raw, ctx)) {
      const kind = subType === 'invite' ? 'joinedSelf' : 'joinedSelfApprove'
      return {
        kind,
        data: { name: ctx.nameOfGroup(groupId), id: groupId, operator },
        source: groupConversation(groupId),
        priority: PRIORITY_DIRECT,
        signalClass: 'event',
        fingerprint: `join:${groupId}:${user}:${String(time)}`,
      }
    }
    return {
      kind: 'memberJoined',
      data: { name: ctx.nameOfGroup(groupId), id: groupId, user, operator },
      source: groupConversation(groupId),
      priority: PRIORITY_DIRECT,
      signalClass: 'event',
      fingerprint: `join:${groupId}:${user}:${String(time)}`,
    }
  }

  // ── 退群（★ `sub_type` 的语义来自 SnowLuma 的转换器 ✓）───────────
  if (noticeType === 'group_decrease') {
    const groupId = str(raw, 'group_id')
    const user = str(raw, 'user_id')
    const operator = str(raw, 'operator_id')
    const source = groupConversation(groupId)
    const fingerprint = `leave:${groupId}:${user}:${String(time)}`
    if (subType === 'disband') {
      return {
        kind: 'groupDisbanded',
        data: { name: ctx.nameOfGroup(groupId), id: groupId },
        source,
        priority: PRIORITY_DIRECT,
        signalClass: 'event',
        fingerprint,
      }
    }
    if (subType === 'kick_me') {
      return {
        kind: 'kickedSelf',
        data: { name: ctx.nameOfGroup(groupId), id: groupId, operator },
        source,
        priority: PRIORITY_DIRECT,
        signalClass: 'event',
        fingerprint,
      }
    }
    if (subType === 'kick') {
      return {
        kind: 'memberKicked',
        data: { name: ctx.nameOfGroup(groupId), id: groupId, user, operator },
        source,
        priority: PRIORITY_DIRECT,
        signalClass: 'event',
        fingerprint,
      }
    }
    // `leave`（含未知 ✓ —— ★ 宁可当"有人退了"报出来，也不要静默丢 ✗）。
    return {
      kind: 'memberLeft',
      data: { name: ctx.nameOfGroup(groupId), id: groupId, user },
      source,
      priority: PRIORITY_DIRECT,
      signalClass: 'event',
      fingerprint,
    }
  }

  // ── 禁言／解除（★ 也是我们自己禁言工具的回执 ✓）──────────────────
  if (noticeType === 'group_ban') {
    const groupId = str(raw, 'group_id')
    const lift = subType === 'lift_ban'
    return {
      kind: lift ? 'unmuted' : 'muted',
      data: {
        name: ctx.nameOfGroup(groupId),
        id: groupId,
        user: str(raw, 'user_id'),
        operator: str(raw, 'operator_id'),
        duration: durationText(num(raw, 'duration')),
      },
      source: groupConversation(groupId),
      priority: PRIORITY_PASSIVE,
      signalClass: 'event',
      fingerprint: `ban:${groupId}:${str(raw, 'user_id')}:${String(time)}`,
    }
  }

  // ── 管理权限 ──────────────────────────────────────────────────────
  if (noticeType === 'group_admin') {
    const groupId = str(raw, 'group_id')
    const user = str(raw, 'user_id')
    const self = isSelf(raw, ctx)
    return {
      kind: self ? 'adminSelf' : 'adminOther',
      data: { name: ctx.nameOfGroup(groupId), id: groupId, user },
      source: groupConversation(groupId),
      priority: self ? PRIORITY_DIRECT : PRIORITY_PASSIVE,
      signalClass: 'event',
      fingerprint: `admin:${groupId}:${user}:${String(time)}`,
    }
  }

  // ── 群撤回 ────────────────────────────────────────────────────────
  if (noticeType === 'group_recall') {
    const groupId = str(raw, 'group_id')
    return {
      kind: 'groupRecall',
      data: {
        name: ctx.nameOfGroup(groupId),
        id: groupId,
        operator: str(raw, 'operator_id'),
        user: str(raw, 'user_id'),
      },
      source: groupConversation(groupId),
      priority: PRIORITY_PASSIVE,
      signalClass: 'event',
      // ★ 撤回用 `message_id` 当指纹 ✓（它天然唯一 ✓）。
      fingerprint: `grecall:${str(raw, 'message_id')}:${String(time)}`,
    }
  }

  // ── 私聊撤回（★ 20 级 —— 用户定案 ✓）─────────────────────────────
  if (noticeType === 'friend_recall') {
    const user = str(raw, 'user_id')
    return {
      kind: 'friendRecall',
      data: { sender: ctx.nameOfConversation(privateConversation(user)), id: user },
      source: privateConversation(user),
      priority: PRIORITY_DIRECT,
      signalClass: 'event',
      fingerprint: `frecall:${str(raw, 'message_id')}:${String(time)}`,
    }
  }

  // ★ 其余（含**未在名单里的新通知** ✓）一律丢掉 ✓ ——
  //   宁可先丢、需要时再加 ✓（★ 反过来的风险更大：一条高频通知会把她淹掉 ✗）。
  return undefined
}

/**
 * ★★ 一条**待办型**申请的指纹 ✗ —— ★ `pending` 里的键 ✓（2026-10-17 收成一处 ✓）。
 *
 * ## 为什么要一个函数（★ 而不是两边各拼一次 ✗）
 *
 * ★ 写它的是 {@link mapRequest} ✓（★ 产出信号时 ✓），
 * ★★ 而**删它的是 `signals/index.ts` 里的监听器** ✗ —— 收到 `qq/request-consumed` 之后 ✓。
 * ⇒ ★★★ 那意味着**同一个字符串在两个插件里各拼一遍** ✗✓ ——
 * ★ 拼歪了就是"删不掉"✓，而那个症状**正是这次的真机故障**（★ 通知反复跳、无法被消费 ✓✓）。
 * ⇒ ★★★★ 所以收成这一个函数 ✓，两边都用它 ✓
 * （★ 自检直接对比它与 `mapRequest` 的输出，歪了就红 ✓）。
 *
 * @param flag - 原始帧里的 `flag` ✓。
 * @returns 指纹，形如 `req:u_abc` ✓。
 */
export function requestPendingKey(flag: string): string {
  return `req:${flag}`
}

/**
 * 把一个 `post_type=request` 的帧映射成信号。
 *
 * ★★ 这一类**全部是待办型** ✓ —— 「**要等待处理完才清掉**」✓（用户定案 ✓）：
 * 它们**不会**因为"送进 agent"而消失 ✓，只会因为**她批准／拒绝**而消失 ✓。
 *
 * ★ 而"她批准／拒绝"这件事的接线是 **`qq/request-consumed`** ✗（2026-10-17 ✓）——
 * ★★ 见 `signals/index.ts` 里那个 `ctx.on` ✓。
 *
 * @param raw - 原始申请帧 ✓。
 * @param ctx - 外部信息。
 * @returns 信号；不在白名单里就 `undefined` ✓。
 */
export function mapRequest(
  raw: Readonly<Record<string, unknown>>,
  ctx: MapContext,
): MappedSignal | undefined {
  const requestType = str(raw, 'request_type')
  const subType = str(raw, 'sub_type')
  // ★ 原样回传用的身份 ✓ —— **必须非空** ✓，否则她没法处理 ✓。
  const flag = str(raw, 'flag')
  if (flag === '') return undefined

  if (requestType === 'friend') {
    const user = str(raw, 'user_id')
    return {
      kind: 'friendRequest',
      data: {
        sender: ctx.nameOfConversation(privateConversation(user)),
        id: user,
        // ★★ `comment` 必须给她看 ✓（她据此决定批不批 ✓）。
        comment: str(raw, 'comment'),
      },
      source: privateConversation(user),
      priority: PRIORITY_DIRECT,
      signalClass: 'todo',
      fingerprint: requestPendingKey(flag),
      flag,
    }
  }

  if (requestType === 'group') {
    const groupId = str(raw, 'group_id')
    const user = str(raw, 'user_id')
    // ★ `invite` = 有人**邀她**进群（帧里有 `invited_id` ✓）；`add` = 有人**申请进群** ✓。
    if (subType === 'invite') {
      return {
        kind: 'groupInvite',
        data: { name: ctx.nameOfGroup(groupId), id: groupId, operator: user },
        source: groupConversation(groupId),
        priority: PRIORITY_DIRECT,
        signalClass: 'todo',
        fingerprint: requestPendingKey(flag),
        flag,
      }
    }
    return {
      kind: 'groupRequest',
      data: {
        sender: ctx.nameOfConversation(privateConversation(user)),
        user,
        name: ctx.nameOfGroup(groupId),
        id: groupId,
        // ★★ 实测它就是**验证问答**（形如 `问题：你好\n答案：测试通知2` ✓）——
        //    必须原样给她 ✓，**不要我们写死批不批的规则** ✗。
        comment: str(raw, 'comment'),
      },
      source: groupConversation(groupId),
      priority: PRIORITY_DIRECT,
      signalClass: 'todo',
      fingerprint: requestPendingKey(flag),
      flag,
    }
  }

  return undefined
}
