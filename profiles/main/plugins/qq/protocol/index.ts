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
  set_group_ban: { params: { group_id: number, user_id: number, duration: number }, result: unknown }
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
