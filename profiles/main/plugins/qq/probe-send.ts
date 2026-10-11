/**
 * 发送链路的一次性验证插件 —— **默认关闭**。
 *
 * ## 它验证什么
 *
 * 其他验证都到不了这一段：工具注册是静态的，只读 API 不碰发送。真正要确认的是
 * **完整工具管道**能发出一条消息，即：
 *
 * ```
 * ctx.tools.execute(...)
 *   → schema 校验入参
 *   → qq_send_message 的 execute
 *   → ctx.qq.sendText → OneBot action → SnowLuma → QQ
 *   → output.render 投影成模型看到的内容
 * ```
 *
 * 所以它走 `ctx.tools.execute` 而不是直接调 `ctx.qq.sendText` —— 后者只证明服务能用，
 * 证明不了工具的定义是对的（参数名写错、schema 不匹配、render 崩了都测不出来）。
 *
 * ## 为什么默认关闭
 *
 * 它会**真的在群里发消息**。这种副作用绝不能靠"记得别开"来防，所以要有两道闩：
 * `QQ_SEND_TEST=1` 才启用，且必须在 `QQ_SEND_TEST_TARGET` 里给出目标。
 * 发完立刻撤回，尽量不留痕迹——但撤回本身也可能失败，所以目标群必须是"发错了也没关系"的。
 *
 * @module qq/probe-send
 */

import type { Context } from '@deepseek-ai/cordis'

/** 插件名。 */
export const name = 'probe-send'

/** 需要工具注册表与 `qq`（前者用来走完整管道，后者用来判断连接状态）。 */
export const inject = ['tools', 'qq']

/** 轮询连接状态的上限。 */
const CONNECT_TIMEOUT_MS = 30_000
/** 轮询间隔。 */
const POLL_MS = 500

/** 等连接就绪；超时返回 false。 */
async function waitConnected(ctx: Context): Promise<boolean> {
  const deadline = Date.now() + CONNECT_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (ctx.qq.connected) return true
    await new Promise(resolve => setTimeout(resolve, POLL_MS))
  }
  return false
}

/**
 * 跑一次发送测试。
 * @param ctx - 本插件的上下文。
 * @param target - `group:<id>` 或 `private:<id>`。
 */
async function runSendTest(ctx: Context, target: string): Promise<void> {
  const ready = await waitConnected(ctx)
  if (!ready) {
    ctx.logger.warn('[probe-send] 超时：qq 一直没连上，跳过')
    return
  }

  const text = `[probe-send] qq_send_message 链路自检 ${new Date().toISOString()}`
  ctx.logger.info(`[probe-send] 经工具管道发送到 ${target}：${text}`)

  // `callId` 是品牌类型，运行时不校验内容——进程内自检用一个可辨认的字面量即可。
  const send = await ctx.tools.execute({
    callId: 'probe-send-1' as never,
    name: 'qq_send_message',
    arguments: { target, text },
    signal: new AbortController().signal,
  })

  ctx.logger.info(`[probe-send] 工具返回（模型看到的内容）：${describeResult(send)}`)

  // 从返回内容里抠出消息 id，好撤回。抠不到就明说，不要假装撤回了。
  const messageId = extractMessageId(send)
  if (messageId === undefined) {
    ctx.logger.warn('[probe-send] 没能从返回值里解析出 message id，跳过撤回')
    return
  }

  const recall = await ctx.tools.execute({
    callId: 'probe-send-2' as never,
    name: 'qq_recall_message',
    arguments: { message_id: messageId },
    signal: new AbortController().signal,
  })
  ctx.logger.info(`[probe-send] 撤回 ${messageId}：${describeResult(recall)}`)
}

/** 把工具执行结果压成一行可读文本。 */
function describeResult(result: unknown): string {
  if (result === null || typeof result !== 'object') return String(result)
  const content = (result as { content?: unknown }).content
  if (!Array.isArray(content)) return JSON.stringify(result)
  return content
    .map((block) => {
      if (block !== null && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
        return String((block as { text?: unknown }).text ?? '')
      }
      return JSON.stringify(block)
    })
    .join(' ')
}

/** 从工具返回内容里解析 `message id: <id>`。 */
function extractMessageId(result: unknown): string | undefined {
  const match = /message id:\s*(\S+)/.exec(describeResult(result))
  return match?.[1]
}

/**
 * 环境变量开启时跑一次。
 * @param ctx - 本插件的上下文。
 */
export function apply(ctx: Context): void {
  if (process.env['QQ_SEND_TEST'] !== '1') {
    ctx.logger.debug('[probe-send] 未启用（设置 QQ_SEND_TEST=1 才会真的发消息）')
    return
  }
  const target = process.env['QQ_SEND_TEST_TARGET']
  if (target === undefined || target === '') {
    ctx.logger.warn('[probe-send] 启用了 QQ_SEND_TEST 但没给 QQ_SEND_TEST_TARGET，跳过')
    return
  }
  void runSendTest(ctx, target).catch((error: unknown) => {
    ctx.logger.warn(`[probe-send] 失败：${error instanceof Error ? error.message : String(error)}`)
  })
}
