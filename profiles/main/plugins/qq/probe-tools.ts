/**
 * 工具调用自检 —— **默认关闭**，靠环境变量指定要调哪个工具。
 *
 * ## 为什么必须走 `ctx.tools.execute`
 *
 * 直接调 `ctx.qq.sendText` 只证明服务能用，**证明不了工具定义是对的**——
 * 参数名写错、schema 不匹配、`render` 崩了，全都测不出来。只有经过完整管道
 * （schema 校验 → execute → output.render）才算验证了工具。
 *
 * ## 怎么用
 *
 * ```powershell
 * $env:QQ_TOOL_TEST='qq_check_messages'
 * $env:QQ_TOOL_TEST_ARGS='{"conversation":"group:871074118"}'
 * ```
 *
 * 没设 `QQ_TOOL_TEST` 就什么都不做。发消息类工具会**自动撤回**，尽量不留痕迹——
 * 但撤回本身也可能失败，所以目标群必须是"发错了也没关系"的。
 *
 * @module qq/probe-tools
 */

import type { Context } from '@deepseek-ai/cordis'

/** 插件名。刻意带 `qq-` 前缀——`plugins/probe-tools.ts` 那个冒烟探针已占用 `probe-tools`。 */
export const name = 'qq-probe-tools'

/** 需要工具注册表与 `qq`（后者用来等连接就绪）。 */
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
 * 调一个工具。
 * @param ctx - 本插件的上下文。
 * @param tool - 工具名。
 * @param args - 参数。
 * @returns 执行结果。
 */
async function invoke(ctx: Context, tool: string, args: unknown): Promise<unknown> {
  return await ctx.tools.execute({
    // `callId` 是品牌类型，运行时不校验内容——进程内自检用一个可辨认的字面量即可。
    callId: `probe-tools:${tool}` as never,
    name: tool,
    arguments: args,
    signal: new AbortController().signal,
  })
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

/**
 * 跑一次工具自检。
 * @param ctx - 本插件的上下文。
 * @param tool - 工具名。
 * @param args - 参数。
 */
async function run(ctx: Context, tool: string, args: unknown): Promise<void> {
  if (!await waitConnected(ctx)) {
    ctx.logger.warn('[qq-probe-tools] 超时：qq 一直没连上，跳过')
    return
  }

  ctx.logger.info(`[qq-probe-tools] 调用 ${tool}，参数 ${JSON.stringify(args)}`)
  const result = await invoke(ctx, tool, args)
  const text = describeResult(result)
  ctx.logger.info(`[qq-probe-tools] 模型看到的内容：${text}`)

  // 发消息类工具自动撤回：自检不该在群里留下痕迹。
  if (tool !== 'qq_send_message') return
  const messageId = /message id:\s*(\S+)/.exec(text)?.[1]
  if (messageId === undefined) {
    ctx.logger.warn('[qq-probe-tools] 没能从返回值里解析出 message id，跳过撤回')
    return
  }
  ctx.logger.info(`[qq-probe-tools] 撤回 ${messageId}：${describeResult(await invoke(ctx, 'qq_recall_message', { message_id: messageId }))}`)
}

/**
 * 环境变量指定了工具就跑一次。
 * @param ctx - 本插件的上下文。
 */
export function apply(ctx: Context): void {
  const tool = process.env['QQ_TOOL_TEST']
  if (tool === undefined || tool === '') {
    ctx.logger.debug('[qq-probe-tools] 未启用（设置 QQ_TOOL_TEST=<工具名> 才会真的调用）')
    return
  }

  let args: unknown = {}
  const rawArgs = process.env['QQ_TOOL_TEST_ARGS']
  if (rawArgs !== undefined && rawArgs !== '') {
    try {
      args = JSON.parse(rawArgs) as unknown
    } catch (error) {
      ctx.logger.warn(`[qq-probe-tools] QQ_TOOL_TEST_ARGS 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
      return
    }
  }

  void (async () => {
    // 预热：`qq_check_messages` 这类工具要有消息积攒才看得出效果。
    const warmup = Number(process.env['QQ_TOOL_TEST_DELAY_MS'] ?? '0')
    if (Number.isFinite(warmup) && warmup > 0) {
      ctx.logger.info(`[qq-probe-tools] 预热 ${String(warmup)}ms 等消息进来`)
      await new Promise(resolve => setTimeout(resolve, warmup))
    }
    await run(ctx, tool, args)
  })().catch((error: unknown) => {
    ctx.logger.warn(`[qq-probe-tools] 失败：${error instanceof Error ? error.message : String(error)}`)
  })
}