/**
 * OneBot v11 线上类型。
 *
 * 只描述我们**真正读写**的字段。这不是完整的 OneBot v11 规范实现——协议端是 SnowLuma，
 * 我们只是它的一个客户端。未在此声明的字段一律忽略，不要假装知道它们。
 *
 * 结构分四块：
 * - 信封：`RawEvent`（收到的）/ `ActionResponse`（调用 action 回来的）
 * - 事件：`MessageEvent` / `MetaEvent`（其余 post_type 暂时不处理）
 * - 消息段：`Segment`
 * - action 名与参数：`ActionMap`
 *
 * 外加**一个**纯函数 {@link displayNameOf} —— 全仓**唯一**算"这个人的显示名"的地方。
 *
 * 命名沿用 OneBot 的 snake_case，**不做驼峰转换**——转换层只会让字段对不上号，
 * 出问题时无法和协议文档逐字对照。
 *
 * @module qq/protocol
 */

/** 一个消息段。`data` 的形状由 `type` 决定，各分支在 `segments.ts` 里收窄。 */
export interface Segment {
  type: string
  data: Record<string, unknown>
}

/** 消息发送者。 */
export interface Sender {
  user_id?: number
  nickname?: string
  /** 群名片；私聊时不存在。 */
  card?: string
  /** 群角色：owner / admin / member。 */
  role?: string
}

/**
 * QQ 的**显示名** —— 全仓唯一算它的地方（用户定案）。
 *
 * ## 规则
 *
 * | 情况 | 渲染 |
 * |:--|:--|
 * | 有群名片，且**与 QQ 昵称不同** | `昵称(群昵称:名片)` |
 * | 群名片与昵称**相同** | `昵称` —— **折叠**。括号存在的意义是区分两个不同的名字，相等时它不携带信息 |
 * | 没有群名片（私聊，或没设群名片） | `昵称` |
 * | 没有昵称 | `名片` |
 * | 两个都没有 | `fallback`（调用方给 `user_id`） |
 *
 * ## 「群昵称:」是**字面**渲染的
 *
 * 群名片与 QQ 昵称是两个概念，不标出来**模型只能猜括号里的是哪个**。
 * 代价是多几个字，换"不会认错人"。
 *
 * ## 为什么住在这里
 *
 * 这是 **QQ 平台的概念**（OneBot 的 `sender.card`）。按分层纪律（`AGENTS.md` §二），
 * 平台分叉**只许出现在 `qq/adapter` 与 `qq/protocol`**；上层（pipeline / tools）
 * 只该看到一个"显示名"字符串。收成一个纯函数之后，三处共用同一套规则。
 *
 * ★ 在此之前有 **5 处各自算**，逻辑还不一样：adapter 收消息时是 `card ?? nickname`，
 * 而 `getMessage` / `qq_read_message` / 转发展开那三处**只读 nickname、完全没看 card**
 * —— 同一个群成员，在实时消息里和在转发里会显示成两个不同的名字。
 *
 * @param sender - OneBot 的 `sender`；转发那种松形状也能用（只要有 `nickname` / `card`）。
 * @param fallback - 两个名字都没有时用什么（调用方给 `user_id`）。
 * @returns 显示名。
 */
export function displayNameOf(
  sender: { nickname?: string | undefined, card?: string | undefined } | undefined,
  fallback: string,
): string {
  const nickname = sender?.nickname !== undefined && sender.nickname !== '' ? sender.nickname : undefined
  const card = sender?.card !== undefined && sender.card !== '' ? sender.card : undefined
  if (nickname === undefined) return card ?? fallback
  if (card === undefined || card === nickname) return nickname
  return `${nickname}(群昵称:${card})`
}

/** 收到的原始事件信封。`post_type` 是判别字段。 */
export interface RawEvent {
  time?: number
  self_id?: number
  post_type?: string
  /** 调用 action 时带上的回执 id；出现在这里说明这是一个响应而不是事件。 */
  echo?: unknown
  [key: string]: unknown
}

/** 消息事件（`post_type === 'message'`）。 */
export interface MessageEvent extends RawEvent {
  post_type: 'message'
  message_type: 'private' | 'group'
  sub_type?: string
  message_id: number
  user_id: number
  /** 私聊时不存在。 */
  group_id?: number
  /** 消息段数组；部分协议端可能给纯字符串。 */
  message: Segment[] | string
  raw_message?: string
  sender?: Sender
  font?: number
  /**
   * NapCat / SnowLuma 的扩展字段：群名。
   * OneBot v11 本身没有群名，标准做法是调 `get_group_info` 查——但那是一次额外往返。
   * 用这个字段，取不到就不取（旧版也是这么做的）。
   */
  group_name?: string
  peerName?: string
}

/** 元事件（`post_type === 'meta_event'`）。我们用 `lifecycle` 和 `heartbeat` 判活。 */
export interface MetaEvent extends RawEvent {
  post_type: 'meta_event'
  meta_event_type: 'lifecycle' | 'heartbeat'
  sub_type?: string
  /** 心跳里带的运行状态。 */
  status?: { online?: boolean, good?: boolean }
  /** 心跳间隔（毫秒）。 */
  interval?: number
}

/** action 调用回来的响应。`status === 'ok'` 才算成功。 */
export interface ActionResponse<T = unknown> {
  status?: string
  retcode?: number
  data?: T
  message?: string
  wording?: string
}

/** 一个群成员。 */
export interface GroupMember {
  user_id: number
  nickname?: string
  card?: string
  role?: string
}

/** 陌生人信息。 */
export interface StrangerInfo {
  user_id: number
  nickname?: string
}

/** 登录信息。 */
export interface LoginInfo {
  user_id: number
  nickname?: string
}

/** `get_msg` 回来的消息。 */
export interface MessageDetail {
  message_id?: number
  message?: Segment[] | string
  sender?: Sender
  [key: string]: unknown
}

/**
 * 我们使用的 action 及其参数/返回。
 *
 * 只登记实际会用到的。新增 action 时一并登记，这样类型检查能挡住拼错的 action 名。
 */
export interface ActionMap {
  send_group_msg: { params: { group_id: number, message: Segment[] }, result: { message_id: number } }
  send_private_msg: { params: { user_id: number, message: Segment[] }, result: { message_id: number } }
  delete_msg: { params: { message_id: number }, result: unknown }
  get_msg: { params: { message_id: number }, result: MessageDetail }
  get_login_info: { params: Record<string, never>, result: LoginInfo }
  get_stranger_info: { params: { user_id: number }, result: StrangerInfo }
  get_group_member_list: { params: { group_id: number }, result: GroupMember[] }
  /**
   * ★ **禁言／解除／全体禁言** —— 一个动作覆盖三种情形。
   *
   * `user_id` 声明成 `number | 'all'`：★ **全体禁言就是传 `'all'`** ✓。
   *
   * 依据（SnowLuma 的 API schema，`config-ClrCrmAk.js`）：
   * ```
   * :1531  function groupUserAction(def) {
   * :1534    user_id: f.**memberId()**.describe("QQ 号"),
   * ```
   * ★ 它用的是 **`memberId()`**，而 `comment_qzone` 的 `target_uin` 用的是 **`f.userId()`**
   * —— **两个类型刻意分开** ✓ ⇒ 前者允许 `'all'`、后者是纯 uint ✓（OneBot 11 的约定 ✓）。
   * 另外它**还**有一个等价的独立动作 `set_group_whole_ban`（`{enable}` → `muteAll` ✓）
   * —— **我们不用它** ✓：一条路语义统一、少一个工具 ✓。
   *
   * `duration: 0` ⇒ **解除禁言** ✓（schema 里 `f.duration().default(1800)` ✓）。
   */
  set_group_ban: { params: { group_id: number, user_id: number | 'all', duration: number }, result: unknown }
  /**
   * 处理好友添加请求（通过／拒绝）。
   *
   * schema：`params: { flag: f.string({allowEmpty:false}), approve: f.bool().default(true) }` ✓
   * `flag` 来自事件（`post_type=request` ✓），**不是** QQ 号 ✓。
   */
  set_friend_add_request: { params: { flag: string, approve: boolean }, result: unknown }
  /**
   * 处理加群请求（通过／拒绝）。
   *
   * schema：`{ flag, sub_type?, type?, approve = true, reason = "" }` ✓
   * ★ `sub_type` 与 `type` 二者取一（内部 `p.sub_type ?? p.type ?? "add"` ✓）——
   * `add` = 别人申请进群，`invite` = 有人邀我进群 ✓。
   */
  set_group_add_request: {
    params: { flag: string, sub_type?: string, type?: string, approve: boolean, reason?: string }
    result: unknown
  }

  // ── ★ QQ 空间（说说）──────────────────────────────────────────────
  // 这一组是 **SnowLuma 的扩展**（OneBot 11 没有 ✓），全部照它的 schema 抄 ✓。

  /**
   * 发表说说。
   *
   * schema：`{ content(必填), images?, ugc_right(默认 1), target_uins? }` ✓
   * ★ 约束也在 schema 里：`ugc_right ∈ {1,4,16,64,128}` ✓；
   * **`16`／`128` 时 `target_uins` 必填** ✓（分别表示可见／不可见名单 ✓）。
   */
  send_qzone_msg: {
    params: {
      content: string
      images?: readonly string[]
      ugc_right?: number
      target_uins?: readonly number[]
    }
    result: { tid?: string, [key: string]: unknown }
  }
  /** 评论说说（`tid` 来自 `get_qzone_msg_list`／`send_qzone_msg` ✓）。 */
  comment_qzone: {
    params: { tid: string, content: string, target_uin?: number, images?: readonly string[] }
    result: unknown
  }
  /** 删除说说。 */
  delete_qzone_msg: { params: { tid: string }, result: unknown }
  /**
   * 给说说点赞／取消赞。
   *
   * `abstime` 是**说说发表时间**（unix 秒 ✓）—— schema 说"传真实值更可靠" ✓。
   */
  like_qzone: { params: { tid: string, target_uin?: number, abstime?: number }, result: unknown }
  unlike_qzone: { params: { tid: string, target_uin?: number, abstime?: number }, result: unknown }
  /**
   * 说说列表（`readOnly`）。
   *
   * ★ **`tid` 就是从这里来的** ✓（`msglist[].tid` ✓）—— 点赞／评论都要它 ✓。
   */
  get_qzone_msg_list: {
    params: { target_uin?: number, pos?: number, num?: number }
    result: { total?: number, msglist?: readonly QzoneMsg[], [key: string]: unknown }
  }
  /** 好友动态（`readOnly`）。★ `page_num` **只有首页可靠**（schema 明说深翻页要时间游标，暂未实现 ✓）。 */
  get_qzone_feeds: {
    params: { page_num?: number, count?: number }
    result: { [key: string]: unknown }
  }

  // ── ★ 通知类（`readOnly`）──────────────────────────────────────────
  /**
   * ★★ **群系统消息** —— **加群申请**就从这里来 ✓。
   *
   * 返回数组，每项含 `group_id` / `group_name` / `request_id` / … ✓
   * ★ 与事件那条路（`post_type=request` ✓）是**两条路**：事件是**实时**推送 ✓，
   * 这个是**主动拉**（漏掉的能补 ✓）。
   */
  get_group_system_msg: {
    params: Record<string, never>
    result: readonly QqSystemMessage[]
  }
  /**
   * ★ **可疑好友申请**（`readOnly`）——
   * 只读、**不做处理**：配套的 `set_doubt_friends_add_request` 有风险，**不接** ✓。
   *
   * ★ `uid` 就是"回传作 `flag`"的那个 ✓（schema 原话 ✓）。
   */
  get_doubt_friends_add_request: {
    params: Record<string, never>
    result: readonly DoubtFriendRequest[]
  }
  /** 谁赞过我的资料卡。 */
  get_profile_like: { params: Record<string, never>, result: { [key: string]: unknown } }
  /** ★ 群禁言名单（还在禁言里的人 ✓）。 */
  get_group_shut_list: {
    params: { group_id: number }
    result: readonly ShutMember[]
  }

  /**
   * 取合并转发（聊天记录）的内容。
   *
   * ## ★ 这个动作是**实测**试出来的，三个坑都在这里
   *
   * 1. **`message_id` 收的是 `forward` 段 `data.id` 那坨不透明 token，不是消息号。**
   *    拿它去调 `get_msg` 会被回 `retcode 1400 · "message_id: expected a message id"`
   *    —— 而 `Number(token)` 是 `NaN`，序列化后变 `null`，所以请求从一开始就是垃圾。
   *    所以这里声明成 **`string`**，不要 `Number()`。
   * 2. **回来的不是消息树，是一个扁平的消息数组**（`data.messages`）——
   *    见 {@link ForwardNode}。`get_msg` 那条路**拿不到转发内容**：
   *    它回传的 forward 段 `data` 里只有那个 token。
   * 3. 实测 `{ id: token }` 也能用，但 `message_id` 是 OneBot 的正规拼写，取它。
   */
  get_forward_msg: { params: { message_id: string }, result: { messages: ForwardNode[] } }
}

/** `get_qzone_msg_list` 回来的一条说说。 */
export interface QzoneMsg {
  tid?: string
  content?: string
  created_time?: number
  [key: string]: unknown
}

/** `get_group_system_msg` 回来的一条群系统消息（加群申请／邀请 ✓）。 */
export interface QqSystemMessage {
  group_id?: number
  group_name?: string
  request_id?: string
  /** `invitation` / `add` … */
  sub_type?: string
  [key: string]: unknown
}

/** `get_doubt_friends_add_request` 回来的一条可疑好友申请。 */
export interface DoubtFriendRequest {
  /** ★ **回传作 `flag`** 用 ✓（schema 原话 ✓）。 */
  uid?: string
  user_id?: number
  nick?: string
  [key: string]: unknown
}

/** `get_group_shut_list` 回来的一条（还在禁言中的成员 ✓）。 */
export interface ShutMember {
  user_id?: number
  nickname?: string
  /** 禁言到期时间戳（秒 ✓）。 */
  shut_up_time?: number
  [key: string]: unknown
}

/**
 * `get_forward_msg` 回来的一条子消息。
 *
 * **扁平**：`message_type` / `sender` / `message` 直接挂在顶层，
 * **没有** `get_msg` 那种 `{data: {...}}` 包装。
 *
 * ★ 老 NapCat 是**有包装**的，而 `ForwardExpander` 一直按包装读
 * （`node.data.message_type`、`node.data.content`）—— 所以在 SnowLuma 上
 * 什么都读不到，最终渲染成 `[聊天记录(解析失败)]`。
 * 现在展开器把扁平节点包一层再交给同一套读法，两边都不用改。
 */
export interface ForwardNode {
  user_id?: number
  time?: number
  message_type?: string
  sub_type?: string
  /** 发送者。与顶层消息的 `Sender` 同构（含 `card`）。 */
  sender?: Sender
  /** 这一条的段。 */
  message?: Segment[]
  /** ★ 嵌套转发时它是 `0` —— 递归只能靠段里的 token。 */
  message_id?: number
  message_seq?: number
}

/** 所有支持的 action 名。 */
export type ActionName = keyof ActionMap

/**
 * 从三种可能的 `message` 字段形态里取出段数组。
 *
 * OneBot v11 规定 `message` 是段数组，但部分实现会退化成 CQ 码字符串。我们只接受数组，
 * 字符串或其它形态一律当空数组——**宁可少渲染，不要猜错格式**。
 * @param value - 事件或响应里的 `message` 字段。
 * @returns 消息段数组；非法形态返回空数组。
 */
export function asSegments(value: unknown): Segment[] {
  return Array.isArray(value) ? value as Segment[] : []
}

/**
 * 从 `echo` 字段里取出我们写入的调用 id。
 *
 * 我们发出去的 action 一定带 `echo`，且一定是字符串。协议端回传时可能原样回字符串，
 * 也可能被 JSON 往返成别的形态，所以这里只接受字符串。
 * @param value - 响应信封的 `echo` 字段。
 * @returns 调用 id；不是字符串则返回 undefined。
 */
export function echoId(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
