/**
 * 临时探针：**只盯 planner 那一路**的出网请求与结局。
 *
 * ## 它要回答什么
 *
 * `interrupt_plan` 的 planner 有时候以
 * `{"kind":"error","failure":{"message":"400 status code (no body)","code":"INVALID_REQUEST"}}`
 * 结束，而**复现不出来**（我手写请求四个组合全 200）。剩下的嫌疑是
 * **planner 自己的 `messages`** —— 上次查到这里却**没把那条请求留全** ✗，
 * 等于把最有嫌疑的东西放走了。
 *
 * ⇒ 这个探针把**请求全量**（`messages` ＋ `tools` ＋ model/采样）与**结局**一起落盘。
 *
 * ## 为什么挂 `llm/stream` 而不是包 `fetch`
 *
 *   · 失败以 **`finish` 块的 `reason.kind === 'error'`** 出现 ⇒ 在这里看得见 ✓
 *   · 请求体就在 **`options.messages`** 里 ✓
 *   · ★ 而包 `fetch` 要处理 body 克隆、还要防 HMR 叠层（上次就栽在叠层上 ✗）
 *
 * ## 只记 planner
 *
 * 判据是 **`sessionId` 以 `interrupt-plan-` 开头**（快照 subagent 的会话 id 前缀）。
 * ⇒ ★ 不会再像上次那个全量探针一样涨到 65 MB（那个记所有请求）。
 *
 * ## 纪律
 *
 *   · **只读不写**：不改 `options`、不改块（上一课的教训：在 `llm/stream` 里
 *     **改写** `options` 会让请求构造不出来 ✗）—— 这里只旁听 ✓
 *   · `appendFileSync`（§四：`ctx.logger` 打 JSON 会被格式化吃掉）
 *   · **用完即删**（连同补丁行）
 *
 * @module _probe-planner
 */

import { appendFileSync, rmSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'

/** 插件名。 */
export const name = 'probe-planner'

/** 只要 `llm` 这个 seam。 */
export const inject = ['llm']

/** 快照 subagent 的会话 id 前缀 —— 全仓写它的地方是 `interrupt_plan`。 */
const SESSION_PREFIX = 'interrupt-plan-'

/** 落盘位置（明文 JSONL，好直接读）。 */
const OUT = `${process.env['TEMP'] ?? '.'}\\plos-planner.jsonl`

/**
 * 装好探针。
 *
 * @param ctx - 插件上下文。
 */
export function apply(ctx: Context): void {
  // 每次开机清空 —— 上一轮的记录没有诊断价值，而且会让"这次的失败"淹没在里面。
  try {
    rmSync(OUT, { force: true })
  } catch {
    // 删不掉就用追加（不影响出网）。
  }

  /**
   * 落一行。**采集失败绝不能影响出网。**
   *
   * @param row - 要记的东西。
   */
  const dump = (row: unknown): void => {
    try {
      appendFileSync(OUT, `${JSON.stringify(row)}\n`, 'utf8')
    } catch {
      // 同上。
    }
  }

  ctx.on('llm/stream', (options, next): AsyncIterable<StreamChunk> => {
    // ★ 不是 planner 那一路 ⇒ **原样放行**，一个字节都不碰。
    if (!String(options.sessionId ?? '').startsWith(SESSION_PREFIX)) return next()

    return (async function* (): AsyncIterable<StreamChunk> {
      dump({
        at: new Date().toISOString(),
        event: 'request',
        sessionId: options.sessionId,
        provider: options.provider,
        model: options.model,
        // ★ **全量**：上次就是没留这个才查不下去。
        tools: options.tools,
        messages: options.messages,
      })
      let chunks = 0
      let failure: unknown
      for await (const chunk of next()) {
        chunks += 1
        if (chunk.type === 'finish' && chunk.reason !== undefined && chunk.reason.kind === 'error') {
          failure = chunk.reason.failure
        }
        // ★ **原样往下传** —— 探针只旁听。
        yield chunk
      }
      dump({
        at: new Date().toISOString(),
        event: 'done',
        sessionId: options.sessionId,
        model: options.model,
        chunks,
        ...failure === undefined ? {} : { failure },
      })
    })()
  })
}
