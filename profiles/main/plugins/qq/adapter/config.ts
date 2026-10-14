/**
 * `qq` 能力 seam 的配置面。
 *
 * 迁移自实验期的 `platform/sources/qq_napcat/config_schema.py`，但有两处**刻意的差异**：
 *
 * 1. 旧版适配器是 **WebSocket 服务端**（NapCat 反向连入，默认 :8080）。SnowLuma 是标准的
 *    OneBot v11 协议端，默认由我们**主动连入**它的 WS 服务端（默认 :3001）。所以这里配的是
 *    `wsUrl`（要连的地址）而不是 `host`/`port`（要监听的地址）。
 * 2. 过滤名单沿用旧版的语义：默认 **blacklist + 空表 = 放行一切**。这是刻意的——自动生成的
 *    配置不应该默认拒绝所有消息（旧版注释里明确记过这条）。
 */

import z from '@deepseek-ai/schemastery'

/** 名单模式。`blacklist` + 空表 = 放行一切。 */
export type ListMode = 'whitelist' | 'blacklist'

/** 转发（合并转发 / 聊天记录）内图片的处理方式。 */
export type ForwardImageMode = 'skip' | 'first' | 'all'

/** `ctx.qq` 的配置。 */
export interface Config {
  /** OneBot v11 WebSocket 服务端地址（SnowLuma 暴露的那个）。 */
  wsUrl: string
  /** `access_token`；空串表示不启用鉴权。 */
  accessToken: string
  /**
   * 本机器人自身的 QQ 号 —— **兜底值，通常留空**。
   *
   * 适配器连上后会自己调 `get_login_info` 拿到真实 QQ 并用它做 `AT_ME` 判定；
   * 这个字段只在"还没连上就收到消息"这种边缘情况下兜底。
   *
   * 旧版踩过坑——一边是 int 一边是 str 会比不中，所以这里统一用 string，不提供数字形态。
   */
  selfId: string
  /** 群消息过滤。 */
  groups: {
    mode: ListMode
    /** 群号列表（字符串，与 OneBot 的 `group_id` 直接比较）。 */
    list: string[]
  }
  /** 私聊消息过滤。 */
  private: {
    mode: ListMode
    list: string[]
  }
  /** 合并转发的展开参数。 */
  forward: {
    /** 转发内图片：`skip` 不下载 / `first` 只下整棵树的第一张 / `all` 全下。 */
    imageMode: ForwardImageMode
    /** 嵌套转发最大深度。 */
    maxDepth: number
    /** 展开总条数上限（跨嵌套共享一个计数器）。 */
    maxTotal: number
    /** 单次 `get_msg` 展开的超时（毫秒）。旧版是 5 秒。 */
    expandTimeoutMs: number
  }
  /** WebSocket 重连参数。 */
  reconnect: {
    /** 首次重连延迟（毫秒）。 */
    initialDelayMs: number
    /** 延迟上限（毫秒）。 */
    maxDelayMs: number
  }
  /** 单次 action 调用的响应超时（毫秒）。旧版是 30 秒。 */
  actionTimeoutMs: number
  /** 图片下载超时（毫秒）。旧版 30 秒——注释实测「CDN 波动大，慢图可达 10s+」。 */
  imageTimeoutMs: number
  /**
   * 单张图片字节上限；超过就放弃。
   *
   * 旧版留了个 TODO：「应在获取消息前加一个判断是否尺寸过大」。这里补上——
   * 不设限的话一张原图能把内存和上下文一起撑爆。
   */
  imageMaxBytes: number
  /** 已解析消息的缓存条数。防同一条消息被反复解析（每次都会重新下图片）。 */
  resolveCacheSize: number
  /** 消息缓冲：推/拉两条路的共同地基。见 `buffer.ts`。 */
  buffer: {
    /** 每个会话保留的条数上限。 */
    perConversation: number
    /** 保留的会话数上限；超出按最久未活动淘汰。 */
    conversations: number
  }
  /**
   * 原始帧采集 —— **实验素材**，默认关。见 `capture.ts`。
   *
   * 它按"每类计数 + 每类 N 条完整样本"存，所以文件大小有硬上限、与流量无关。
   * 想让素材攒着以备将来动别的 `post_type`（notice / request / 回执……），才开它。
   */
  capture: {
    /** 是否采集。 */
    enabled: boolean
    /**
     * 落盘路径。**启用时必填** —— 空串不采集并记 warn（宁可响，不要静默不生效）。
     * 注意里面是**原样**的群聊与私聊内容，所以路径必须落在不进版本库的地方。
     */
    path: string
    /** 每类保留多少条完整样本。 */
    samplesPerKind: number
  }
}

/** 配置校验。DSH 约定：插件内不放硬编码可调项，随部署变化的都从这里进。 */
export const Config: z<Config> = z.object({
  wsUrl: z.string().default('ws://127.0.0.1:3001'),
  accessToken: z.string().default(''),
  selfId: z.string().default(''),
  groups: z.object({
    mode: z.union(['whitelist', 'blacklist'] as const).default('blacklist'),
    list: z.array(z.string()).default([]),
  }).default({ mode: 'blacklist', list: [] }),
  private: z.object({
    mode: z.union(['whitelist', 'blacklist'] as const).default('blacklist'),
    list: z.array(z.string()).default([]),
  }).default({ mode: 'blacklist', list: [] }),
  forward: z.object({
    imageMode: z.union(['skip', 'first', 'all'] as const).default('skip'),
    maxDepth: z.natural().min(1).default(3),
    maxTotal: z.natural().min(1).default(50),
    expandTimeoutMs: z.natural().default(5000),
  }).default({ imageMode: 'skip', maxDepth: 3, maxTotal: 50, expandTimeoutMs: 5000 }),
  reconnect: z.object({
    initialDelayMs: z.natural().default(1000),
    maxDelayMs: z.natural().default(30000),
  }).default({ initialDelayMs: 1000, maxDelayMs: 30000 }),
  actionTimeoutMs: z.natural().default(30000),
  imageTimeoutMs: z.natural().default(30000),
  imageMaxBytes: z.natural().default(8 * 1024 * 1024),
  resolveCacheSize: z.natural().default(64),
  buffer: z.object({
    perConversation: z.natural().min(1).default(50),
    conversations: z.natural().min(1).default(32),
  }).default({ perConversation: 50, conversations: 32 }),
  // 默认关：它是"要素材时才开"的东西，不是常开日志。
  capture: z.object({
    enabled: z.boolean().default(false),
    path: z.string().default(''),
    samplesPerKind: z.natural().min(1).default(20),
  }).default({ enabled: false, path: '', samplesPerKind: 20 }),
})
