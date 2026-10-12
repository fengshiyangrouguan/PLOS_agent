/**
 * 模型链路自检 —— **默认关闭**（`QQ_LLM_PROBE=1` 才跑）。
 *
 * ## 为什么要有它
 *
 * 观测到的事实：常驻会话的 turn 正常跑完（`status=running` → `idle`），上下文也装配好了
 * （投影缓存里 `toolsTokens: 5872`、`surfaceTokens: 6215`），但
 * **`tokenUsage.totals` 全是 0** —— 说明模型调用没有拿到响应。
 *
 * agent-loop 不记录模型调用，所以从上面这条路径看不到失败原因。这里绕过整个 agent，
 * 直接调一次 `ctx.llm.stream()`，把异常原样打出来。
 *
 * 它检验的是**能力层**（provider + 凭证 + 网络），不掺会话、提示词、工具的任何因素。
 *
 * @module qq/probe-llm
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-default-model'

/** 插件名。 */
export const name = 'qq-probe-llm'

/** 需要模型服务，以及默认模型选择（不重复配置 provider/model）。 */
export const inject = ['llm', 'agentDefaultModel']

/**
 * 跑一次直连模型调用。
 * @param ctx - 本插件的上下文。
 */
async function run(ctx: Context): Promise<void> {
  const selection = ctx.agentDefaultModel.currentSelection()
  console.log(`[qq-probe-llm] 用 ${selection.provider} / ${selection.model} 直连一次`)

  const chunks: string[] = []
  try {
    const stream = ctx.llm.stream({
      provider: selection.provider,
      model: selection.model,
      messages: [{ role: 'user', content: [{ type: 'text', text: '只回复两个字：收到' }] }],
    })
    for await (const chunk of stream) {
      chunks.push(chunk.type)
      if (chunk.type === 'text-delta') process.stdout.write(chunk.text)
      if (chunk.type === 'finish') console.log(`[qq-probe-llm] finish=${JSON.stringify(chunk)}`)
    }
    console.log(`[qq-probe-llm] 成功：收到 ${String(chunks.length)} 个 chunk（${chunks.join(',')}）`)
  } catch (error) {
    console.log(`[qq-probe-llm] 失败：${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`)
  }
}

/**
 * 环境变量开启时跑一次。
 * @param ctx - 本插件的上下文。
 */
export function apply(ctx: Context): void {
  if (process.env['QQ_LLM_PROBE'] !== '1') return
  // 必须延迟：provider 是**别的插件**（llm-deepseek / llm-deepseek-account）在它自己的
  // apply 里注册的，而 inject 'llm' 只保证 llm 服务在，不保证那些 provider 已注册。
  // 不延迟会拿到 NO_ADAPTER 的假象——实测踩过。
  const delayMs = Number(process.env['QQ_LLM_PROBE_DELAY_MS'] ?? '15000')
  void (async () => {
    await new Promise(resolve => setTimeout(resolve, Number.isFinite(delayMs) ? delayMs : 15000))
    await run(ctx)
  })().catch((error: unknown) => {
    console.log(`[qq-probe-llm] 未捕获：${error instanceof Error ? error.message : String(error)}`)
  })
}
