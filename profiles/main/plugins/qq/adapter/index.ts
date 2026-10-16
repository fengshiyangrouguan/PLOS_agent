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
import { MessageBuffer } from './buffer.ts'
import { renderSegments } from '../pipeline/render.ts'
import { resolveMessage } from '../pipeline/segments.ts'
// ★ **出站反解析**：正文里的 `[表情：X]` / `[未知表情:ID]` 要还原成 `face` 段 ✓
//   （表与反查都在 `pipeline/face.ts` ✓ —— 那是"表情映射"的唯一落点 ✓）。
import { parseOutgoingFaces } from '../pipeline/face.ts'
import { FrameCapture } from './capture.ts'
import type { ImageDescriber, ResolveContext, ResolvedSegment } from '../pipeline/segment.ts'
import {
  asSegments,
  displayNameOf,
  echoId,
  type ActionMap,
  type ActionName,
  type ActionResponse,
  type ForwardNode,
  type GroupMember,
  type LoginInfo,
  type MessageEvent,
  type MetaEvent,
  type RawEvent,
  type Segment,
  type StrangerInfo,
} from '../protocol/index.ts'

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
  /**
   * 群名。
   *
   * 优先取 group_name —— 实测 SnowLuma（Lagrange 内核）发的是这个字段。
   * peerName 留作兼容回落（别的协议端可能有）。都取不到就是 undefined，
   * 调用方自己回落。
   */
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
    /**
     * ★★ **收到一条通知**（`post_type=notice`）—— 加好友、退群/进群、禁言、
     * 撤回、点赞评论… 观察类事件，监听器返回值被丢弃。
     *
     * ★ 载荷是**原始帧**（`Record<string, unknown>`），**刻意不收紧类型** ✗ ——
     * 各 OneBot 实现的字段差异很大，而**下一步是抓帧**（用户定的顺序 ✓）
     * ⇒ 拿到真实帧之后再按它写类型 ✓。
     *
     * 已知的 `notice_type` 取值（来自 SnowLuma 的 schema ✓）：
     * `friend_add` / `friend_recall` / `group_recall` / `group_admin` /
     * `group_increase` / `group_decrease` / `group_ban` ✓
     *
     * @param raw - 原始通知帧。
     */
    'qq/notice'(raw: Record<string, unknown>): void
    /**
     * ★★ **收到一条请求**（`post_type=request`）—— **加好友**／**加群申请** ✓。
     *
     * ★ 同样带**原始帧**（见上）；已知有 `request_type: friend | group` ✓。
     *
     * @param raw - 原始请求帧。
     */
    'qq/request'(raw: Record<string, unknown>): void
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
  /**
   * 我们**发出去**的 action 与 params。
   *
   * 留着只为采集：回执帧单独看是残缺的 —— 一个 `{status:'failed'}` 不告诉你
   * 它对应哪个请求。`capture.ts` 把两者成对记下来。
   */
  request: { action: string, params: unknown }
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

  /** 已解析消息的缓存，键是 `messageId`。见 `resolve()` 的惰性说明。 */
  private readonly resolveCache = new Map<string, ResolvedSegment[]>()

  /**
   * 消息缓冲：推/拉两条路的共同地基。
   *
   * 适配器是**唯一写入方**（消息到达时 push），读取由上层决定（`drain` 推进游标，
   * `peek` 不推进）。适配器自己**不消费**这个缓冲——"要不要看、看了算不算读过"
   * 是策略，属于推/拉那一层。
   */
  private readonly buffer: MessageBuffer

  /**
   * 原始帧采集 —— **实验素材**，`config.capture.enabled` 为真时才存在。
   *
   * 挂在帧处理函数的**最前面**（白名单过滤之前），所以"我们丢掉了什么"也留得下。
   * 见 `capture.ts`。
   */
  private readonly capture: FrameCapture | undefined

  /**
   * 可选的图片描述器（VLM）。
   *
   * **适配器自己不实现它**，只提供注入点（`setImageDescriber`）。理由：实现它需要
   * `ctx.llm`，而"适配器依赖模型"会让 `qq` 这条 seam 变成一个环。由消费方
   * （persona / 记忆层）实现并注入。
   */
  private describe: ImageDescriber | undefined

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
    this.buffer = new MessageBuffer(config.buffer)

    // 采集是"要素材时才开"的东西。**启用却没给路径**要响，不能静默不生效。
    if (config.capture.enabled && config.capture.path === '') {
      ctx.logger.warn('qq-adapter: capture.enabled 为真但 capture.path 是空的 —— 不采集')
      this.capture = undefined
    } else if (config.capture.enabled) {
      this.capture = new FrameCapture({
        path: config.capture.path,
        samplesPerKind: config.capture.samplesPerKind,
      })
      this.capture.start()
    } else {
      this.capture = undefined
    }

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
    // 采集器落最后一次盘并停表 —— 卸载/重连都会走到这里。
    this.capture?.stop()
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

    // ★ 采集点：所有帧的**唯一咽喉**，而且在白名单过滤与任何解析**之前** ——
    //   所以"我们丢掉了什么"（非白名单群、未处理的 post_type）也留得下。
    const id = echoId(raw.echo)
    this.capture?.note(
      id !== undefined ? 'echo' : String(raw.post_type ?? '(无 post_type)'),
      raw,
      id === undefined ? undefined : this.pending.get(id)?.request,
    )

    // 回执优先：带 echo 的帧是调用响应，不是事件。
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
    // ★★ **通知与请求**（加好友／加群申请、退群、禁言、点赞评论…）——
    //   从"忽略"改成**发出去** ✓。
    //
    //   ★ 这里**刻意只带原始帧**（`raw`），**不去猜字段名** ✗ ——
    //   OneBot 各实现的通知字段差异很大（SnowLuma 自己的 schema 在
    //   `config-ClrCrmAk.js` 里，值是 `friend_add` / `group_recall` / `group_admin` /
    //   `group_increase` / `group_decrease` / `group_ban` ✓，而"申请"走 `post_type=request`
    //   的 `request_type: friend|group` ✓）。
    //
    //   ★ **下一步是抓帧**（用户定的顺序 ✓）⇒ 拿到真实帧之后再收紧这里的类型 ✓，
    //   而不是现在按印象写一套 ✗（这条在 `AGENTS.md` §一 里已经付过几次代价 ✓）。
    if (raw.post_type === 'notice') {
      this.ctx.emit('qq/notice', raw)
      this.log('debug', `通知 notice_type=${String(raw['notice_type'])}`)
      return
    }
    if (raw.post_type === 'request') {
      this.ctx.emit('qq/request', raw)
      this.log('debug', `申请 request_type=${String(raw['request_type'])}`)
      return
    }
    // 其余的（`message_sent` 等）暂不处理——但**不静默**，留一行日志便于后续补。
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
    // 心跳每 ~30s 一次：既是判活依据，也是 stdout 的定期 flush 点
    // （node 的 stdout 接管道时会缓冲，长时间无输出就看把日志停在半路）。
    this.log('debug', `心跳（interval=${String(meta.interval ?? '?')}ms）`)
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

    const incoming: QqIncoming = {
      messageId: String(event.message_id),
      groupId,
      userId,
      // 显示名收在 `protocol.displayNameOf()` 一处 —— 三处共用同一套规则。
      senderName: displayNameOf(event.sender, userId),
      time: typeof event.time === 'number' ? event.time : Math.floor(Date.now() / 1000),
      segments,
      mentionsSelf,
      atUserIds,
      groupName: typeof event.group_name === 'string' && event.group_name !== ''
      ? event.group_name
      : (typeof event.peerName === 'string' && event.peerName !== '' ? event.peerName : undefined),
      raw: event,
    }
    // 入缓冲，再广播。顺序要紧：监听器里读缓冲时必须已经能看到这一条。
    this.buffer.push(incoming)
    // debug 级：开发时用来看"消息到底进没进来"。级别在补丁层的 `- id: logs`
    // （dsh-logbook）的 `stderr.types` 里调，不是 cordis 自带的 logger-console。
    this.log('debug', `收到${isGroup ? `群 ${groupId ?? '?'}` : `私聊 ${userId}`}消息`
      + `（${segments.length} 段，msg_id=${incoming.messageId}`
      + `${mentionsSelf ? '，@了我' : ''}）`)
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
      this.pending.set(echo, { resolve, reject, timer, request: { action, params } })
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
   * ★ **只压 `reply` 段** ✗ —— ★★ **不自动补 `at`** ✓✓（2026-10-16 实测 ✓）。
   *
   * 为什么：★ 曾按"复刻 QQ 的引用即点名"补过一个 `at` ✓ ——
   * ★★ 而实测**群里显示两个 `@`** ✗✗（★ 引用块自己就带一个 ✓ ——
   * ★ 她的 `text` 里并没有 `@`，所以那两个都来自段 ✓✓）。
   * ⇒ ★ **协议端显示引用时本来就会 @ 被回复者** ✗ ⇒ ★ **再补就是重复** ✓✓。
   * ★ 所以回到最简：★ **要 @ 谁就显式传 `at`** ✓，引用只管引用 ✓。
   *
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
    // ★ 只压 `reply` 段 ✗ —— ★★ **不自动补 `at`** ✓（★ 实测那样会显示两个 `@` ✓，见方法注释 ✓）。
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
    // ★★ **出站反解析**：把正文里的 `[表情：X]` 还原成 `face` 段 ✓。
    //
    //   为什么必须做：她看到的入站形态是 `[表情：笑哭]` ✓（`faceToText` 渲染的 ✓），
    //   所以她写回来时也是这个形态 ✓ ⇒ 不还原的话，**对方收到的是一串方括号** ✗。
    //
    //   ★ 表里查不到的表情**整段丢掉**（用户定案）—— 发一个不存在的表情名没有意义 ✓，
    //     而当普通文本发出去更糟 ✗。判据与切分规则都在 `parseOutgoingFaces` 里 ✓。
    // ★★ **出站一律不发表情段**（用户定案，2026-10-15）。
    //
    //   为什么：QQ 的新表情（sysemojis，**id 199 以上**）**只能收不能发** ✗ ——
    //   发了被服务器拒（`OIDB error 11000 on 0x9155_1: get emoji … id 237
    //   sysemojis cfg not found` ✗），而且★ **会招 QQ 风控** ✓
    //   ⇒ 代价远大于"少一个表情" ✓ ⇒ **统一不发**最省事、也不会卡住别的功能 ✓。
    //
    //   ★ 实现：仍然用 `parseOutgoingFaces` 切分（它认得全角/半角/兜底各写法 ✓），
    //     但**只取其中的文本段** —— 表情段直接丢掉 ✓（相邻文本已被它合并 ✓，不产出碎片 ✓）。
    //   ⚠️ 于是 `[表情：X]` 从她的消息里**消失**（不是发成别的 ✓）—— 这是有意的 ✓。
    for (const part of parseOutgoingFaces(text)) {
      if (part.kind === 'text') segments.push({ type: 'text', data: { text: part.text } })
    }
    // ★★ **一段都不剩 ⇒ 必须报错**（实测踩过，2026-10-15）。
    //
    //   她发的东西可能**只有**一个表里没有的表情 ⇒ 按"认不出就丢掉"的规则
    //   什么都剩不下 ⇒ 协议端直接拒：
    //       `message segment array must not be empty` ✗
    //
    //   ★ 而**静默地发出去更糟** —— 她会以为发出去了 ✓ ⇒ 这里抛错，
    //     `qq_send_message` 会把 `Send failed: …` 回给她 ✓（她那就能自己改 ✓）。
    if (segments.length === 0) {
      // ★★ **回传要给她看**（model-facing ✓）—— 不写文件名、不写内部概念 ✗。
      //
      //   现在"一段都不剩"只可能是**她只发了表情**（表情一律不发 ✓）⇒ 直接说清约束 ✓。
      throw new Error(
        '这条消息里只有表情，没有可发送的文字。'
        + '**QQ 的新表情暂时不支持协议**（只能收、不能发），所以表情会被去掉 —— 请改用文字表达。',
      )
    }
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
   * 取合并转发的内容。
   *
   * ★ **参数是 `forward` 段 `data.id` 那坨不透明 token，原样传，绝不 `Number()`。**
   * 与 `getMessage` 是两条不同的路：把 token 丢给 `get_msg` 实测会被回
   * `retcode 1400 · "message_id: expected a message id"`。
   *
   * @param token - `forward` 段的 `id`。
   * @returns 扁平的子消息数组（见 `ForwardNode`）。
   */
  async getForwardMsg(token: string): Promise<ForwardNode[]> {
    const result = await this.call('get_forward_msg', { message_id: token })
    return result.messages ?? []
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

  // ────────────────────────── 消息流水线 ──────────────────────────

  /**
   * 解析一条消息 → 结构化表示。
   *
   * **惰性**：不在收到消息时自动跑。原因是配置默认放行所有群消息，而解析会真的去下载
   * 图片、查引用、展开转发——对没人要看的历史消息做这些是纯浪费。
   * 需要文本的消费方（`qq-tools`、未来的会话桥）主动调 `render()`。
   *
   * 结果按 `messageId` 缓存，同一条消息重复调用不会重复下载。
   * @param incoming - 入站消息。
   * @returns 已解析的段。
   */
  async resolve(incoming: QqIncoming): Promise<ResolvedSegment[]> {
    const cached = this.resolveCache.get(incoming.messageId)
    if (cached !== undefined) return cached
    const resolved = await resolveMessage(
      { segments: incoming.segments, raw: incoming.raw },
      this.resolveContext(),
    )
    this.rememberResolved(incoming.messageId, resolved)
    return resolved
  }

  /**
   * 解析并渲染成 LLM 友好文本。
   *
   * @param incoming - 入站消息。
   * @param options - `fresh: true` ⇒ **先丢掉这条消息的解析缓存再重解析**。
   *
   *   ★ **为什么需要这个口子**：图片描述有**超时**（`vlm2text.config.timeoutMs`），
   *   超时那次渲染出来的是占位；而**占位会被 `resolveCache` 缓存住** ⇒
   *   描述稍后落定时再渲染，**拿到的还是占位** ⇒
   *   「【图片已渲染完成】」那条第二次唤醒就完全失去意义。
   *   所以那一头必须能**明确地要一份新的**，而不是靠"缓存刚好过期"。
   *
   * @returns 可直接放进上下文窗口的文本。
   */
  async render(incoming: QqIncoming, options?: { readonly fresh?: boolean }): Promise<string> {
    if (options?.fresh === true) this.resolveCache.delete(incoming.messageId)
    return renderSegments(await this.resolve(incoming))
  }

  // ────────────────────────── 消息缓冲的读取面 ──────────────────────────
  //
  // 适配器只写缓冲，**不决定谁读、读了算不算数**——那是推/拉那一层的策略。
  // 这四个方法就是那一层需要的全部。

  /**
   * 已知会话键（`group:<id>` / `private:<id>`），最久未活动的在前。
   * @returns 会话键列表。
   */
  conversations(): string[] {
    return this.buffer.known()
  }

  /**
   * 某会话的未读条数。
   * @param conversation - 会话键。
   * @returns 游标之后的消息数。
   */
  unread(conversation: string): number {
    return this.buffer.unread(conversation)
  }

  /**
   * 只看不推进游标 —— 用于"偷看一眼"而不算已读。
   * @param conversation - 会话键。
   * @param limit - 最多几条（取最近的）。
   * @returns 未读消息，按时间升序。
   */
  peek(conversation: string, limit?: number): QqIncoming[] {
    return this.buffer.peek(conversation, limit)
  }

  /**
   * 取增量并**推进游标** —— "拉"的语义：读过就算看过了。
   * @param conversation - 会话键。
   * @returns 未读消息，按时间升序。
   */
  drain(conversation: string): QqIncoming[] {
    return this.buffer.drain(conversation)
  }

  /**
   * 把所有保留的消息重新算未读。
   * @param conversation - 会话键。
   */
  rewind(conversation: string): void {
    this.buffer.rewind(conversation)
  }

  /** 装解析结果，超出上限就丢最旧的。 */
  private rememberResolved(messageId: string, resolved: ResolvedSegment[]): void {
    this.resolveCache.set(messageId, resolved)
    while (this.resolveCache.size > this.config.resolveCacheSize) {
      const oldest = this.resolveCache.keys().next()
      if (oldest.done === true) break
      this.resolveCache.delete(oldest.value)
    }
  }

  /**
   * 构造解析上下文。
   *
   * VLM 描述器由**外部注入**（{@link setImageDescriber}），**适配器自己不实现它**：
   * 实现它需要模型调用，而把"适配器"和"模型"绑在一起会让这条 seam 变成环。
   *
   * 现在的注入方是 `qq/vlm` —— 它把**领域无关**的 `ctx.vlm2text` 接上来。
   * 没挂那个插件时 `describe` 留空，图片段仍会被解析，只是 `description` 为空
   * （渲染成 `[图片]`）。
   */
  private resolveContext(): ResolveContext {
    return {
      getMessage: async (messageId) => {
        const detail = await this.getMessage(messageId)
        return {
          segments: asSegments(detail.message),
          // ★ 这里以前**只读 nickname、没看 card** —— 于是同一个群成员
          //   在引用/转发里和在实时消息里会显示成两个不同的名字。现在共用同一个函数。
          senderName: detail.sender === undefined
            ? undefined
            : displayNameOf(detail.sender, String(detail.sender.user_id ?? '')),
          // ★★ 渲染 `(qq:…)` 要用它 ✗ —— ★ 让她能直接抄去 `at` ✓（2026-10-16 加 ✓）。
          senderId: detail.sender?.user_id === undefined ? undefined : String(detail.sender.user_id),
        }
      },
      getForward: (token) => this.getForwardMsg(token),
      fetchImage: (url) => this.downloadImage(url),
      lookupNickname: (userId) => this.lookupNickname(userId),
      ...this.describe === undefined ? {} : { describe: this.describe },
      options: {
        imageMode: this.config.forward.imageMode,
        maxDepth: this.config.forward.maxDepth,
        maxTotal: this.config.forward.maxTotal,
        expandTimeoutMs: this.config.forward.expandTimeoutMs,
      },
    }
  }

  /**
   * 下载图片并转 base64。
   *
   * 两道防线（都是旧版踩出来的）：
   * 1. **校验 `Content-Type` 前缀是 `image/`** —— 图片 CDN 的 rkey 过期时返回的是
   *    一个错误页而不是图片，不校验就会把 HTML 当图片喂给模型。
   * 2. **校验大小** —— 超限直接放弃，不让一张原图撑爆内存。
   * @param url - 图片地址。
   * @returns base64 数据与 MIME 类型；任何一步失败都返回 undefined。
   */
  private async downloadImage(url: string): Promise<{ base64: string, mimeType: string } | undefined> {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(this.config.imageTimeoutMs) })
      if (!response.ok) {
        this.log('debug', `图片下载失败：HTTP ${response.status}`)
        return undefined
      }
      const mimeType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? ''
      if (!mimeType.startsWith('image/')) {
        this.log('debug', `图片 Content-Type 不是 image/*（${mimeType}），按失败处理`)
        return undefined
      }
      const declared = Number(response.headers.get('content-length') ?? '0')
      if (declared > this.config.imageMaxBytes) {
        this.log('debug', `图片声明大小 ${declared} 超限，放弃`)
        return undefined
      }
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (bytes.byteLength > this.config.imageMaxBytes) {
        this.log('debug', `图片实际大小 ${bytes.byteLength} 超限，放弃`)
        return undefined
      }
      return { base64: Buffer.from(bytes).toString('base64'), mimeType }
    } catch (error) {
      this.log('debug', `图片下载异常：${describe(error)}`)
      return undefined
    }
  }

  /** 查昵称；查不到返回 undefined（调用方降级成 `user_id=xx`）。 */
  private async lookupNickname(userId: string): Promise<string | undefined> {
    if (userId === '' || userId === 'all') return undefined
    const info = await this.getStrangerInfo(userId)
    return typeof info.nickname === 'string' && info.nickname !== '' ? info.nickname : undefined
  }

  /**
   * 注入图片描述器。
   *
   * 传 `undefined` 可以撤销。撤销后图片段仍会被解析，只是 `description` 为空。
   * @param describer - 描述器；`undefined` 表示不描述。
   */
  setImageDescriber(describer: ImageDescriber | undefined): void {
    this.describe = describer
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
