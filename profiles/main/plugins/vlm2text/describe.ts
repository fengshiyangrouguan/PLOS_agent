/**
 * `vlm2text` 的**纯逻辑**：缓存判定、类型收窄、降级。
 *
 * ## 为什么单独一层
 *
 * **不认识 cordis、不碰数据库句柄** —— 只吃一个"缓存"接口和一个"调 VLM"的函数。
 * 所以能离线自检（`tests/describe.spec.ts`），而且缓存那部分能拿**真的**
 * `ImageDescriptionStore`（内存库）来验，不是假的替身。
 *
 * ## 三条不变量（这张文件的全部内容）
 *
 * | | |
 * |:--|:--|
 * | **只缓存成功** | 失败 / 空描述 / 截断的描述都**不写行** ⇒ 下次遇到同一张图自动重试 |
 * | **失败不抛错** | 一律返回空串 —— 调用方把它渲染成 `[图片]`，**绝不阻断消息流转** |
 * | **失败要报具体内容** | 不是一句"失败了"，要带上错误类型、稳定 code 和消息（见 {@link describeError}） |
 *
 * @module vlm2text/describe
 */

import { createHash } from 'node:crypto'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'

/**
 * 附件服务收的图片类型。
 *
 * 和 `ImageMediaType`（`@deepseek-ai/dsh-attachment`）**必须一致** ——
 * 不一致的话我们会在 `saveImage` 那里才炸，而那时已经浪费了一次缓存查找。
 * 这里先收窄，失败就是一次普通的降级。
 */
export const ACCEPTED_MEDIA_TYPES: readonly ImageMediaType[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]

/** 要描述的一张图。**形状与 `qq/pipeline/segment.ts` 的 `ImageDescriber` 入参一致**。 */
export interface DescribeInput {
  /** base64 编码的图片数据（不含 data URI 前缀）。 */
  readonly base64: string
  /** MIME 类型，如 `image/png`。 */
  readonly mimeType: string
  /**
   * 是否动画表情。
   *
   * ⚠️ **目前不影响行为** —— 保留它是为了与 `qq/pipeline/segment.ts` 的
   * `ImageDescriber` 入参一致，这样 `qq` 侧那个钩子可以**直接**把参数转发进来
   * （`image => ctx.vlm2text.describe(image)`），不必在桥接处拆字段。
   * 真需要区别对待表情包时（比如换一句提示词），再从 `call` 往下传。
   */
  readonly sticker: boolean
}

/** 一次成功的 VLM 调用。 */
export interface DescribeResult {
  /** 描述文本（**未 trim**，由本模块统一 trim）。 */
  readonly text: string
  /** 写出它的 provider（记进缓存，排障用）。 */
  readonly provider: string
  /** 写出它的模型。 */
  readonly model: string
  /**
   * 这条描述**能不能进缓存**。
   *
   * `false` 用在"描述被 max-tokens 截断"这种情况：**文本仍然可用**
   * （本次她能看图），但它是残句，不该被固化下来 —— 下次再要一份完整的。
   */
  readonly cacheable: boolean
}

/**
 * 描述缓存的最小接口。
 *
 * **刻意不 import `db/stores.ts`** —— 这一层只依赖结构，`ImageDescriptionStore`
 * 天然满足它。这样纯逻辑不用把整个 db 插件拖进来，自检也能换实现。
 */
export interface DescriptionCache {
  /** 查一条描述。 */
  get: (hash: string) => { readonly text: string } | undefined
  /** 写一条描述（同 hash 覆盖）。 */
  put: (row: {
    readonly hash: string
    readonly text: string
    readonly provider: string
    readonly model: string
    readonly createdAt: number
  }) => void
}

/** 一次描述的依赖。 */
export interface DescribeDeps {
  /** 描述缓存。 */
  readonly cache: DescriptionCache
  /** 真正去调 VLM。失败请**抛错** —— 本模块负责把它变成降级。 */
  readonly call: (bytes: Uint8Array, mediaType: ImageMediaType) => Promise<DescribeResult>
  /** 现在（毫秒）。注入以便自检。 */
  readonly now: () => number
  /** 记一行日志。**具体失败内容由本模块拼好**（见 {@link describeError}）。 */
  readonly log: (level: 'warn' | 'debug', message: string) => void
}

/**
 * 算缓存键：图片**原始字节**的 sha256。
 *
 * ★ **不是** attachment 的 id：附件服务会规范化（缩放 / 重编码），它的摘要是
 * **规范化之后**的字节 —— 那回答不了"QQ 发的是不是同一张图"。
 *
 * @param bytes - 图片原始编码字节。
 * @returns 十六进制 sha256。
 */
export function cacheKeyOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * 把 MIME 类型收窄成附件服务认的那几种。
 *
 * 容忍真实世界的写法：去空白、转小写、丢掉 `;charset=…` 之类的参数。
 *
 * @param mimeType - 收到的 MIME 类型。
 * @returns 规范化后的类型；不认识时 `undefined`。
 */
export function acceptedMediaType(mimeType: string): ImageMediaType | undefined {
  const normalized = mimeType.split(';')[0]?.trim().toLowerCase() ?? ''
  return ACCEPTED_MEDIA_TYPES.find(type => type === normalized)
}

/**
 * 把任意 error 说成一句**具体**的话。
 *
 * 带上 `name` 和稳定 `code`（`LlmError` 的 `code` 是共享失败分类，如
 * `AUTH` / `RATE_LIMIT`）—— 排查"为什么这张图没描述"时，那句泛泛的
 * "失败了"没有任何用。
 *
 * @param error - 捕获到的值。
 * @returns 一句可读的失败描述。
 */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const code = (error as { code?: unknown }).code
  const suffix = typeof code === 'string' && code !== '' ? ` [${code}]` : ''
  return `${error.name}${suffix}: ${error.message}`
}

/**
 * 解 base64。
 *
 * **不在这里校验"是不是真图片"** —— 那是附件服务的职责（它解码、量尺寸、
 * 比摘要），而且它会把失败说得很清楚。这里只挡"压根没有字节"。
 *
 * @param base64 - base64 文本。
 * @returns 字节；解不出东西时 `undefined`。
 */
export function decodeBase64(base64: string): Uint8Array | undefined {
  if (base64 === '') return undefined
  const bytes = Buffer.from(base64, 'base64')
  return bytes.byteLength === 0 ? undefined : bytes
}

/**
 * 拿一句话描述一张图，**带缓存**。
 *
 * **任何失败都返回空串，绝不抛错。** 具体分四种降级：
 *
 * | 情况 | 结果 |
 * |:--|:--|
 * | MIME 类型不收 | 空串，**不调 VLM** |
 * | base64 解不出字节 | 空串，**不调 VLM** |
 * | 缓存命中 | 缓存里的描述，**不调 VLM** |
 * | VLM 失败 / 返回空 / 截断 | 空串（截断返回文本），**不写缓存** |
 *
 * @param deps - 缓存、VLM 调用、时钟、日志。
 * @param input - 要描述的图。
 * @returns 描述；失败时为空串。
 */
export async function describeWithCache(deps: DescribeDeps, input: DescribeInput): Promise<string> {
  const mediaType = acceptedMediaType(input.mimeType)
  if (mediaType === undefined) {
    deps.log(
      'warn',
      `vlm2text: 不支持的图片类型 "${input.mimeType}"（只收 ${ACCEPTED_MEDIA_TYPES.join(' / ')}），`
      + '该图降级为 [图片]',
    )
    return ''
  }

  const bytes = decodeBase64(input.base64)
  if (bytes === undefined) {
    deps.log('warn', 'vlm2text: 图片 base64 解不出字节，该图降级为 [图片]')
    return ''
  }

  const hash = cacheKeyOf(bytes)
  const short = hash.slice(0, 8)
  const cached = deps.cache.get(hash)
  if (cached !== undefined) {
    deps.log('debug', `vlm2text: 缓存命中 ${short}（${String(cached.text.length)} 字）`)
    return cached.text
  }

  let result: DescribeResult
  try {
    result = await deps.call(bytes, mediaType)
  } catch (error) {
    // ★ **不写缓存** ⇒ 这张图下次会自动重试，而不是被一次瞬时故障永久按成 [图片]。
    deps.log(
      'warn',
      `vlm2text: 描述失败 ${short}（${String(bytes.byteLength)} 字节，${mediaType}）—— `
      + `该图本次降级为 [图片]，下次遇到会重试：${describeError(error)}`,
    )
    return ''
  }

  const text = result.text.trim()
  if (text === '') {
    deps.log(
      'warn',
      `vlm2text: VLM（${result.provider}/${result.model}）返回空描述 ${short}，`
      + '该图本次降级为 [图片]，不写缓存',
    )
    return ''
  }

  if (!result.cacheable) {
    deps.log(
      'warn',
      `vlm2text: 描述被截断 ${short}（${result.provider}/${result.model}）—— `
      + '本次用它，但**不写缓存**，下次再要一份完整的',
    )
    return text
  }

  try {
    deps.cache.put({
      hash,
      text,
      provider: result.provider,
      model: result.model,
      createdAt: deps.now(),
    })
  } catch (error) {
    // 缓存写不进去**不该丢掉刚拿到的描述** —— 这张图这次确实是有描述的。
    deps.log('warn', `vlm2text: 描述缓存写失败（不影响本次结果）：${describeError(error)}`)
  }
  return text
}
