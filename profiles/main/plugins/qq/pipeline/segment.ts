/**
 * 消息段的**结构化中间表示**。
 *
 * 这是整条流水线的中心：
 *
 * ```
 * OneBot 原始段 (adapter 收到)
 *   → resolve()   异步补数据：下图片 / get_msg 引用与转发 / 查 @ 昵称
 *   → ResolvedSegment[]   ← 就是这里。唯一真相，不含 I/O 痕迹
 *   → render()    纯函数拼 LLM 文本
 * ```
 *
 * **为什么要有这一层**：实验期的原始设计是 "segments 是唯一真相、content 由 cortex 单写入"。
 * 那次实现把"补数据"和"拼格式"揉在一个类里，导致换渲染策略要动适配器。
 * 拆开后：`resolve` 可以慢、可以有 I/O、可以降级；`render` 必须是纯的。
 * VLM 图片描述挂在 render 那一侧，不属于适配器。
 *
 * 本文件**只有类型，没有运行时代码**（DSH 的 `src/types.ts` 约定）。
 *
 * @module qq/segment
 */

/** 一条已解析的消息段。判别字段是 `kind`。 */
export type ResolvedSegment =
  | ResolvedText
  | ResolvedImage
  | ResolvedFace
  | ResolvedMention
  | ResolvedReply
  | ResolvedForward
  | ResolvedVideo
  | ResolvedCard
  | ResolvedUnknown

/** 纯文本，原样呈现。 */
export interface ResolvedText {
  kind: 'text'
  text: string
}

/**
 * 图片或动画表情（`image` 段的 `sub_type === 1` 视为动画表情）。
 *
 * 三种状态用两个字段表达，对应实验期的三种返回值：
 * - `failed: false` + `description` 非空 → `[图片:描述]`
 * - `failed: true` → `[图片:(下载失败)]`
 * - `description` 为空且未失败 → `[图片]`（已解析但没描述，例如未接 VLM）
 */
export interface ResolvedImage {
  kind: 'image'
  /** 是否为动画表情（原 `sub_type === 1`）。 */
  sticker: boolean
  /** VLM 或缓存的描述；空表示没有描述。 */
  description: string
  /** 下载/解析失败。 */
  failed: boolean
}

/** QQ 内置表情。`label` 已是中文展示串（如 `[表情：笑哭]`）。 */
export interface ResolvedFace {
  kind: 'face'
  label: string
}

/** @ 某人。`display` 已解析好（昵称 / `全体成员` / `user_id=xx`）。 */
export interface ResolvedMention {
  kind: 'mention'
  display: string
  /** 被 @ 的 QQ；`all` 表示全体成员。 */
  userId: string
}

/** 引用回复。 */
export interface ResolvedReply {
  kind: 'reply'
  /** 被引消息的 id。 */
  messageId: string
  /** 被引消息发送者昵称；查不到时为 undefined。 */
  senderName: string | undefined
  /** 被引消息发送者的 **QQ 号** ✗ —— ★ 渲染时跟在昵称后面 ✓（2026-10-16 加 ✓）。 */
  senderId: string | undefined
  /** 被引消息的正文预览（只取 text 段）；无正文或查不到时为 undefined。 */
  preview: string | undefined
}

/** 合并转发（聊天记录）。 */
export interface ResolvedForward {
  kind: 'forward'
  /** 结构化展开结果；展开失败时为 undefined。 */
  block: ForwardBlock | undefined
  /** XML 摘要兜底文本；连摘要都没有时为 undefined。 */
  xmlSummary: string | undefined
}

/** 视频消息。 */
export interface ResolvedVideo {
  kind: 'video'
  url: string | undefined
  localPath: string | undefined
}

/** JSON 卡片（分享链接、小程序等）。 */
export interface ResolvedCard {
  kind: 'card'
  /** 已解析的卡片文本；解析失败时为 undefined。 */
  text: string | undefined
}

/** 未识别的段类型。 */
export interface ResolvedUnknown {
  kind: 'unknown'
  /** 原始 OneBot 段类型名。 */
  type: string
}

/** 转发块里的一条子消息。 */
export interface ForwardSubMessage {
  /** 发送者显示名。 */
  senderName: string
  /** 发送者的 **QQ 号** ✗ —— ★ 渲染时跟在昵称后面 ✓（2026-10-16 加 ✓）。 */
  senderId: string | undefined
  /** 该子消息的段（已解析）。 */
  segments: ResolvedSegment[]
  /**
   * 嵌套转发的子块。
   *
   * 与 `segments` 分开存：渲染时嵌套块要整体后置到该行之后，
   * 混在 segments 里会打乱行内顺序。
   */
  nested: ForwardBlock | undefined
}

/** 一个完整的转发块。 */
export interface ForwardBlock {
  /** 标题（如 `群聊的聊天记录`）。 */
  title: string
  /** 该转发消息的 id。 */
  messageId: string
  /** 子消息，按原顺序。 */
  messages: ForwardSubMessage[]
  /**
   * 因超出上限而未展开的条数；为 0 表示完整展开。
   *
   * 实验期是把一条 `note` 段塞进 `messages` 末尾的——那会污染"消息"这个语义。
   * 这里改成块的属性，渲染时补一行。
   */
  truncated: number
}

/** 图片描述器：把图片字节变成一句话。由调用方注入，适配器不实现它。 */
export type ImageDescriber = (image: {
  /** base64 编码的图片数据（不含 data URI 前缀）。 */
  base64: string
  /** MIME 类型，如 `image/png`。 */
  mimeType: string
  /** 是否动画表情。 */
  sticker: boolean
}) => Promise<string>

/** 解析一条消息时的上下文——把适配器能力按需喂进来，而不是让本模块 import 适配器。 */
export interface ResolveContext {
  /**
   * 取一条消息的**原始**段与发送者名。
   *
   * 刻意返回原始段而不是 `ResolvedSegment[]`：解析是递归的，调用方（`segments.ts`）
   * 需要自己决定子消息解析到哪一层。返回 `undefined` 表示查不到（调用方降级）。
   */
  getMessage: (messageId: string) => Promise<{
    segments: import('../protocol/index.ts').Segment[],
    senderName: string | undefined,
    /** ★ 发送者 QQ 号 ✗ —— ★ 渲染 `(qq:…)` 要用 ✓（2026-10-16 加 ✓）。 */
    senderId: string | undefined,
  } | undefined>
  /**
   * 取合并转发的内容（`get_forward_msg`）。
   *
   * ★ 与 `getMessage` **是两回事**：转发段里那坨 `id` 不是消息号，
   * 拿它去 `get_msg` 会被协议端拒绝（实测 `retcode 1400`）。
   * 参数是那坨 token，原样传，**不要 `Number()`**。
   *
   * @param token - `forward` 段 `data.id`。
   * @returns 扁平的子消息数组；查不到返回 `undefined`。
   */
  getForward: (token: string) => Promise<readonly import('../protocol/index.ts').ForwardNode[] | undefined>
  /** 下载图片并转 base64；失败返回 undefined。 */
  fetchImage: (url: string) => Promise<{ base64: string, mimeType: string } | undefined>
  /** 查昵称；失败返回 undefined。 */
  lookupNickname: (userId: string) => Promise<string | undefined>
  /** VLM 描述器；不接就不产生描述。 */
  describe?: ImageDescriber
  /** 展开参数。 */
  options: {
    imageMode: 'skip' | 'first' | 'all'
    maxDepth: number
    maxTotal: number
    /** 单次 `get_msg`（引用查询 / 转发展开）的超时（毫秒）。 */
    expandTimeoutMs: number
  }
}
