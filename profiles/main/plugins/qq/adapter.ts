/**
 * `qq` 能力 seam：一个 OneBot v11 WebSocket **客户端**。
 *
 * ## 它是什么 / 不是什么
 *
 * **是**：一条通往 QQ 的连接，以及"发消息 / 查消息"的能力。它 `provide('qq')`，
 * 对上层暴露 `this.ctx.qq`。
 *
 * **不是**：它**不渲染 LLM 文本**（那是 `render.ts` 的事），**不碰会话日志**，
 * **不知道 agent 的存在**。这条边界是从实验期继承下来的——
 * `segments` 是唯一真相，渲染是可替换的一步，谁需要谁调。
 *
 * ## 与实验期的差异
 *
 * 旧版适配器是 WebSocket **服务端**（NapCat 反向连入 :8080）。SnowLuma 是标准 OneBot v11
 * 协议端，默认由客户端连入它的 :3001。所以这里方向相反：我们主动连、我们负责重连。
 *
 * ## 生命周期
 *
 * 连接是资源，用 `ctx.effect` 表达：创建处返回清理，插件卸载时自动断开并把
 * 所有在途调用失败掉（不能让 Promise 悬着）。
 *
 * @module qq/adapter
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Config as ConfigSchema, type Config } from './config.ts'
import {
  asSegments,
  echoId,
  type ActionMap,
  type ActionName,
  type ActionResponse,
  type GroupMember,
  type LoginInfo,
  type MessageEvent,
  type MetaEvent,
  type RawEvent,
  type Segment,
  type StrangerInfo,
} from './protocol.ts'

// ────────────────────────────── 对外类型 ──────────────────────────────

/** 消息目标。 */
export type QqTarget =
  | { readonly kind: 'group', readonly id: string }
  | { readonly kind: 'private', readonly id: string }

/** 连接状态变化。 */
export type QqConnectionState = 'connecting' | 'open' | 'closed'

/** 一条通过过滤、已做基础规范化的入站消息。 */
export interface QqIncoming {
  /** 消息 id（字符串，与 OneBot 的原值逐字一致）。 */
  readonly messageId: string
  /** 群号；私聊时为 undefined。 */
  readonly groupId: string | undefined
  /** 发送者 QQ。 */
  readonly userId: string
  /** 发送者显示名：群聊优先群名片，回落昵称，再回落 QQ 号。 */
  readonly senderName: string
  /** 发言时间（Unix 秒）。 */
  readonly time: number
  /**
   * 消息段 —— **唯一真相**。
   *
   * 这里刻意不提供渲染好的文本字段：渲染是可替换的一步（见 `render.ts`），
   * 把结果缓存进事件会让 VLM 描述与渲染策略耦死在适配器里。要文本就调
   * `renderMessage()`。
   */
  readonly segments: Segment[]
  /** 是否 @ 了机器人（`@全体成员` 与 `@自己` 同等对待，沿用实验期语义）。 */
  readonly mentionsSelf: boolean
  /**
   * 本条消息里被 @ 的 QQ 号（去重，可能含 `'all'`）。
   *
   * 旧版踩过坑：必须先入列表再查昵称——昵称查询失败不能让 `AT_ME` 判定失效。
   * 所以这里在解析阶段就落定，渲染阶段才去补昵称。
   */
  readonly atUserIds: string[]
  /** 群名（若协议端在事件里带了 `peerName`）。 */
  readonly groupName: string | undefined
  /** 原始事件，仅供排障。**不要喂给模型**——它可能很大且含冗余字段。 */
  readonly raw: RawEvent
}

/** action 调用失败。 */
export class QqActionError extends Error {
  /** OneBot 的 `retcode`；本地超时/无连接时为负数（沿用实验期约定）。 */
  readonly retcode: number
  /**
   * @param message - 可读原因。
   * @param retcode - 协议端 retcode，或本地负数（-1 无连接 / -2 超时 / -3 传输异常）。
   */
  constructor(message: string, retcode: number) {
    super(message)
    this.name = 'QqActionError'
    this.retcode = retcode
  }
}

// ─────────────────────────── 声明合并：服务与事件 ───────────────────────────

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 通往 QQ 的能力 seam。 */
    qq: QqAdapter
  }

  interface Events {
    /**
     * 收到一条通过过滤的入站消息。观察类事件，监听器返回值被丢弃。
     * @param event - 已规范化的入站消息。
     */
    'qq/message'(event: QqIncoming): void
    /**
     * 连接状态变化。观察类事件。
     * @param state - 新状态。
     * @param detail - 可读补充（关闭码、错误信息等）。
     */
    'qq/connection'(state: QqConnectionState, detail?: string): void
  }
}

// ────────────────────────────── WebSocket 最小面 ──────────────────────────────

/** 我们用到的那一小块 WebSocket 接口。 */
interface WsLike {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: string, listener: (event: WsEvent) => void): void
}

interface WsEvent {
  data?: unknown
  code?: number
  reason?: string
  message?: string
}

interface WsCtor {
  new (url: string): WsLike
}

/** Node 22+ 提供全局 WebSocket；取不到就在这里显式炸，而不是留一个静默的坏连接。 */
function resolveWebSocket(): WsCtor {
  const ctor = (globalThis as { WebSocket?: unknown }).WebSocket
  if (typeof ctor !== 'function') {
    throw new Error('qq-adapter: 运行时不提供全局 WebSocket（需要 Node 22+）')
  }
  return ctor as WsCtor
}

/** 在途 action 调用。 */
interface PendingCall {
  resolve: (response: ActionResponse) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

// ─────────────────────────────── 适配器 ───────────────────────────────

/**
 * OneBot v11 WebSocket 客户端，注册为 `ctx.qq`。
 *
 * 遵守 DSH 的 service 包约定：`export class ... extends Service` + `static Config`
 * + `export default`（不具名导出，服务包与函数插件的导出形态不同，混用会让 Loader
 * 丢掉插件的命名空间）。
 */
export class QqAdapter extends Service {
  static Config: z<Config> = ConfigSchema

  private readonly config: Config
  private readonly wsFactory: WsCtor

  private socket: WsLike | undefined
  private closed = true
  private reconnectDelay: number
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined

  /** 在途调用，键是 `echo`。 */
  private readonly pending = new Map<string, PendingCall>()

  /** 协议端报告的登录信息；未登录时为 undefined。 */
  private login: LoginInfo | undefined

  /** 心跳存活：最近一次有效心跳时间（毫秒）。 */
  private lastBeat = 0
  /** 协议端报告的心跳间隔（毫秒）。 */
  private beatInterval = 30000
  private beatTimer: ReturnType<typeof setInterval> | undefined

  /**
   * @param ctx - 本插件的上下文。
   * @param config - 已校验的配置。
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'qq')
    this.config = config
    this.wsFactory = resolveWebSocket()
    this.reconnectDelay = config.reconnect.initialDelayMs

    // 连接是资源：创建处返回清理，插件卸载（或依赖变化）时自动断开。
    ctx.effect(() => {
      this.closed = false
      void this.connectLoop()
      return () => this.teardown()
    })
  }

  /** 是否已连接且握手完成。 */
  get connected(): boolean {
    return this.socket !== undefined && this.socket.readyState === 1
  }

  /** 机器人自身 QQ；未登录时回落到配置里的 `selfId`。 */
  get selfId(): string {
    return this.login === undefined ? this.config.selfId : String(this.login.user_id)
  }

  // ────────────────────────── 连接与重连 ──────────────────────────

  /** 目标 URL；有 token 时按 OneBot 惯例挂 `access_token` 查询参数。 */
  private targetUrl(): string {
    const token = this.config.accessToken
    if (token === '') return this.config.wsUrl
    const separator = this.config.wsUrl.includes('?') ? '&' : '?'
    return `${this.config.wsUrl}${separator}access_token=${encodeURIComponent(token)}`
  }

  /** 连接 → 断开 → 退避重连，直到被卸载。 */
  private async connectLoop(): Promise<void> {
    while (!this.closed) {
      try {
        await this.openOnce()
      } catch (error) {
        this.log('warn', `连接失败：${describe(error)}`)
      }
      if (this.closed) break
      this.ctx.emit('qq/connection', 'closed')
      await this.sleep(this.reconnectDelay)
      // 退避翻倍，但不超过上限。
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.config.reconnect.maxDelayMs)
    }
  }

  /** 建一次连接并等着它关闭；正常关闭也算这一轮结束。 */
  private openOnce(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.ctx.emit('qq/connection', 'connecting')
      this.log('info', `连接 ${this.config.wsUrl}`)
      const socket = new this.wsFactory(this.targetUrl())
      this.socket = socket

      socket.addEventListener('open', () => {
        this.reconnectDelay = this.config.reconnect.initialDelayMs
        this.lastBeat = Date.now()
        this.ctx.emit('qq/connection', 'open')
        this.log('info', '已连接')
        void this.refreshLogin()
      })

      socket.addEventListener('message', (event) => {
        this.onFrame(event.data)
      })

      socket.addEventListener('close', (event) => {
        this.stopBeat()
        if (this.socket === socket) this.socket = undefined
        this.login = undefined
        this.log('info', `连接关闭（code=${String(event.code ?? '?')}）`)
        resolve()
      })

      socket.addEventListener('error', (event) => {
        this.log('warn', `连接错误：${event.message ?? '未知'}`)
      })
    })
  }

  /** 卸载：断开、停心跳、把在途调用全部失败掉。 */
  private teardown(): void {
    this.closed = true
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer)
    this.stopBeat()
    try {
      this.socket?.close(4000, 'adapter disposed')
    } catch {
      // 关闭一个已死的 socket 不值得让卸载失败。
    }
    this.socket = undefined
    this.failAllPending('适配器已卸载')
  }

  /** 处理一帧文本。 */
  private onFrame(data: unknown): void {
    if (typeof data !== 'string') return
    let raw: RawEvent
    try {
      raw = JSON.parse(data) as RawEvent
    } catch {
      this.log('warn', '收到非法 JSON 帧，已丢弃')
      return
    }

    // 回执优先：带 echo 的帧是调用响应，不是事件。
    const id = echoId(raw.echo)
    if (id !== undefined) {
      this.settle(id, raw as ActionResponse)
      return
    }

    if (raw.post_type === 'meta_event') {
      this.onMeta(raw as MetaEvent)
      return
    }
    if (raw.post_type === 'message') {
      this.onMessage(raw as MessageEvent)
      return
    }
    // notice / request / message_sent 暂不处理——但**不静默**，留一行日志便于后续补。
    this.log('debug', `忽略未处理的 post_type=${String(raw.post_type)}`)
  }

  /** 处理元事件：只用于判活。 */
  private onMeta(meta: MetaEvent): void {
    if (meta.meta_event_type === 'lifecycle' && meta.sub_type === 'connect') {
      this.lastBeat = Date.now()
      this.startBeat()
      return
    }
    if (meta.meta_event_type !== 'heartbeat') return
    // 旧版教训：只有 online && good 才算活着，否则主动断开触发重连。
    const healthy = meta.status?.online === true && meta.status?.good === true
    if (!healthy) {
      this.log('warn', '心跳报告状态不健康，主动断开以触发重连')
      try {
        this.socket?.close(4001, 'unhealthy heartbeat')
      } catch { /* 已经断了就算了 */ }
      return
    }
    this.lastBeat = Date.now()
    if (typeof meta.interval === 'number' && meta.interval > 0) this.beatInterval = meta.interval
  }

  /** 心跳看门狗：超过两个周期没动静就断开重连。 */
  private startBeat(): void {
    this.stopBeat()
    this.beatTimer = setInterval(() => {
      if (Date.now() - this.lastBeat > this.beatInterval * 2) {
        this.log('warn', '心跳超时，主动断开以触发重连')
        try {
          this.socket?.close(4002, 'heartbeat timeout')
        } catch { /* 已经断了就算了 */ }
      }
    }, Math.max(1000, Math.floor(this.beatInterval / 2)))
  }

  private stopBeat(): void {
    if (this.beatTimer !== undefined) clearInterval(this.beatTimer)
    this.beatTimer = undefined
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.reconnectTimer = setTimeout(resolve, ms)
    })
  }

  // ────────────────────────── 消息解析与过滤 ──────────────────────────

  /**
   * 名单过滤。沿用实验期语义：**blacklist + 空表 = 放行一切**。
   * @param mode - 名单模式。
   * @param list - 名单内容。
   * @param id - 待判定的群号或 QQ 号。
   * @returns 是否放行。
   */
  private allowed(mode: 'whitelist' | 'blacklist', list: readonly string[], id: string): boolean {
    const hit = list.includes(id)
    return mode === 'whitelist' ? hit : !hit
  }

  /** 解析一条消息事件；不合规或不放行的直接丢。 */
  private onMessage(event: MessageEvent): void {
    const isGroup = event.message_type === 'group'
    const groupId = event.group_id === undefined ? undefined : String(event.group_id)
    const userId = String(event.user_id)

    if (isGroup) {
      if (groupId === undefined) return
      if (!this.allowed(this.config.groups.mode, this.config.groups.list, groupId)) {
        this.log('debug', `群 ${groupId} 不在名单内，丢弃`)
        return
      }
    } else if (!this.allowed(this.config.private.mode, this.config.private.list, userId)) {
      this.log('debug', `私聊 ${userId} 不在名单内，丢弃`)
      return
    }

    const segments = asSegments(event.message)
    const atUserIds: string[] = []
    for (const segment of segments) {
      if (segment.type !== 'at') continue
      const qq = segment.data['qq']
      if (typeof qq !== 'string' && typeof qq !== 'number') continue
      const value = String(qq)
      if (!atUserIds.includes(value)) atUserIds.push(value)
    }
    // @全体与@自己同等对待（实验期语义，`_handle_message_event` 里明确写过）。
    const mentionsSelf = atUserIds.includes('all') || atUserIds.includes(this.selfId)

    const sender = event.sender
    const card = typeof sender?.card === 'string' && sender.card !== '' ? sender.card : undefined
    const nickname = typeof sender?.nickname === 'string' && sender.nickname !== '' ? sender.nickname : undefined

    const incoming: QqIncoming = {
      messageId: String(event.message_id),
      groupId,
      userId,
      senderName: card ?? nickname ?? userId,
      time: typeof event.time === 'number' ? event.time : Math.floor(Date.now() / 1000),
      segments,
      mentionsSelf,
      atUserIds,
      groupName: typeof event.peerName === 'string' && event.peerName !== '' ? event.peerName : undefined,
      raw: event,
    }
    this.ctx.emit('qq/message', incoming)
  }

  // ────────────────────────── action 调用 ──────────────────────────

  /**
   * 调一个 OneBot action 并等它的响应。
   *
   * 回执用 `echo` 关联；超时按本地约定返回 `-2`，无连接返回 `-1`，传输异常 `-3`
   * （沿用实验期 `_send_websocket` 的语义）。
   * @param action - action 名。
   * @param params - action 参数。
   * @returns 协议端响应。
   * @throws {QqActionError} 未连接、超时、发送失败，或 `retcode` 非 0。
   */
  async call<A extends ActionName>(action: A, params: ActionMap[A]['params']): Promise<ActionMap[A]['result']> {
    const socket = this.socket
    if (socket === undefined || socket.readyState !== 1) {
      throw new QqActionError('未连接到协议端', -1)
    }
    const echo = `${action}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const response = await new Promise<ActionResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo)
        reject(new QqActionError(`${action} 超时（${this.config.actionTimeoutMs}ms）`, -2))
      }, this.config.actionTimeoutMs)
      this.pending.set(echo, { resolve, reject, timer })
      try {
        socket.send(JSON.stringify({ action, params, echo }))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(echo)
        reject(new QqActionError(`${action} 发送失败：${describe(error)}`, -3))
      }
    })
    if (response.retcode !== undefined && response.retcode !== 0) {
      throw new QqActionError(response.message ?? response.wording ?? `${action} 失败`, response.retcode)
    }
    return response.data as ActionMap[A]['result']
  }

  /** 兑现一个在途调用。 */
  private settle(echo: string, response: ActionResponse): void {
    const call = this.pending.get(echo)
    if (call === undefined) return
    clearTimeout(call.timer)
    this.pending.delete(echo)
    call.resolve(response)
  }

  /** 把所有在途调用失败掉——不能让 Promise 悬着。 */
  private failAllPending(reason: string): void {
    for (const [echo, call] of this.pending) {
      clearTimeout(call.timer)
      call.reject(new QqActionError(reason, -1))
      this.pending.delete(echo)
    }
  }

  private async refreshLogin(): Promise<void> {
    try {
      this.login = await this.call('get_login_info', {})
      this.log('info', `已登录：${String(this.login.user_id)}（${this.login.nickname ?? '?'}）`)
    } catch (error) {
      this.log('warn', `get_login_info 失败：${describe(error)}`)
    }
  }

  // ────────────────────────── 对外能力（qq-tools 用） ──────────────────────────

  /**
   * 发一段消息。
   * @param target - 群或私聊。
   * @param segments - 要发送的消息段。
   * @returns 协议端返回的消息 id。
   */
  async sendSegments(target: QqTarget, segments: Segment[]): Promise<string> {
    if (target.kind === 'group') {
      const result = await this.call('send_group_msg', { group_id: Number(target.id), message: segments })
      return String(result.message_id)
    }
    const result = await this.call('send_private_msg', { user_id: Number(target.id), message: segments })
    return String(result.message_id)
  }

  /**
   * 发纯文本（含可选 @ 与引用）。
   *
   * 段序沿用实验期 `send_text` 的约定，但**去掉了"引用即点名"那条隐式行为**——
   * 它会在群聊里凭空多出一个 `at` 段，调用方无从预期。要 @ 就显式传 `at`。
   * @param target - 群或私聊。
   * @param text - 正文。
   * @param options - 可选的 @ 列表与引用消息 id。
   * @returns 协议端返回的消息 id。
   */
  async sendText(
    target: QqTarget,
    text: string,
    options: { at?: readonly string[], replyTo?: string } = {},
  ): Promise<string> {
    const segments: Segment[] = []
    if (options.replyTo !== undefined) {
      segments.push({ type: 'reply', data: { id: options.replyTo } })
    }
    // 私聊没有 @ 语义，静默跳过（沿用实验期行为）。
    if (target.kind === 'group') {
      for (const userId of options.at ?? []) {
        segments.push({ type: 'at', data: { qq: userId } })
        segments.push({ type: 'text', data: { text: ' ' } })
      }
    }
    if (text !== '') segments.push({ type: 'text', data: { text } })
    return await this.sendSegments(target, segments)
  }

  /**
   * 发一张图。`file` 可以是 URL、本地路径或 `base64://` 形式，由协议端解释。
   * @param target - 群或私聊。
   * @param file - 图片引用。
   * @returns 协议端返回的消息 id。
   */
  async sendImage(target: QqTarget, file: string): Promise<string> {
    return await this.sendSegments(target, [{ type: 'image', data: { file } }])
  }

  /**
   * 撤回一条消息。
   * @param messageId - 消息 id。
   */
  async deleteMessage(messageId: string): Promise<void> {
    await this.call('delete_msg', { message_id: Number(messageId) })
  }

  /**
   * 查一条消息的原文（引用与转发展开都靠它）。
   * @param messageId - 消息 id。
   * @returns 消息详情。
   */
  async getMessage(messageId: string): Promise<ActionMap['get_msg']['result']> {
    return await this.call('get_msg', { message_id: Number(messageId) })
  }

  /**
   * 查群成员列表。
   * @param groupId - 群号。
   * @returns 成员列表。
   */
  async getGroupMemberList(groupId: string): Promise<GroupMember[]> {
    return await this.call('get_group_member_list', { group_id: Number(groupId) })
  }

  /**
   * 查陌生人（非好友）信息。@ 段补昵称靠它。
   * @param userId - QQ 号。
   * @returns 该用户信息。
   */
  async getStrangerInfo(userId: string): Promise<StrangerInfo> {
    return await this.call('get_stranger_info', { user_id: Number(userId) })
  }

  /**
   * 禁言。
   * @param groupId - 群号。
   * @param userId - 被禁言者。
   * @param durationSeconds - 时长（秒）；0 表示解禁。
   */
  async setGroupBan(groupId: string, userId: string, durationSeconds: number): Promise<void> {
    await this.call('set_group_ban', {
      group_id: Number(groupId),
      user_id: Number(userId),
      duration: durationSeconds,
    })
  }

  // ────────────────────────── 日志 ──────────────────────────

  private log(level: 'info' | 'warn' | 'debug', message: string): void {
    if (level === 'debug') this.ctx.logger.debug(message)
    else if (level === 'warn') this.ctx.logger.warn(message)
    else this.ctx.logger.info(message)
  }
}

/** 把未知异常变成一句可读文本。 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default QqAdapter
