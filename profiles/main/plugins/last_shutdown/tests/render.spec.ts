/**
 * `last_shutdown/render.ts` 的自检脚本。
 *
 * 跑法：
 * ```powershell
 * cd E:\project\PLOS\deepseek-harness
 * node --import tsx/esm E:\project\PLOS\PLOS_agent\profiles\main\plugins\last_shutdown\tests\render.spec.ts
 * ```
 *
 * ## 这里重点验什么
 *
 * 这段文本是**模型可见的**，真实流量盯不住（每次会话内容都不同），只能靠自检钉死。
 * 四件事：
 *
 * 1. **三个坐标必须齐全**（`sessionId` / turn / seq）—— §20.10 定案
 *    "只给坐标不给内容"，坐标缺一个她就找不回去。
 * 2. **必须有"上次是停下来的"这个抬头** —— 不然它读起来像一条普通的旧消息，
 *    她不会意识到"上一轮是被停掉的"。
 * 3. **必须告诉她用哪个工具回看** —— 连 §20.10 那条纪律一起搬。
 * 4. **语气是许可式** —— 机制上没有任何东西强制她回来。
 *
 * @module last_shutdown/render.spec
 */

import assert from 'node:assert/strict'
import { renderShutdown } from '../render.ts'

let passed = 0
let failed = 0

/**
 * 断言相等。
 * @param label - 用例名。
 * @param actual - 实际值。
 * @param expected - 期望值。
 */
function check(label: string, actual: unknown, expected: unknown): void {
  try {
    assert.deepEqual(actual, expected)
    passed += 1
    console.log(`  ok   ${label}`)
  } catch {
    failed += 1
    console.log(`  FAIL ${label}`)
    console.log(`       期望: ${JSON.stringify(expected)}`)
    console.log(`       实际: ${JSON.stringify(actual)}`)
  }
}

/** 断言为真。 */
function checkTrue(label: string, actual: boolean): void {
  check(label, actual, true)
}

// ── renderShutdown：重启后她得知道上一轮是【被停掉】的 ──────────────
{
  const text = renderShutdown({
    sessionId: 'plos-baiyu',
    turn: 7,
    seq: 42,
    at: 1_000_000_000_000,
    reason: '你当时正在做事',
  })
  checkTrue('★ 抬头明说"上次是停下来的"', text.includes('【上次是停下来的】'))
  checkTrue('含停止的原因', text.includes('你当时正在做事'))
  checkTrue('★ 含 sessionId 坐标', text.includes('plos-baiyu'))
  checkTrue('★ 含 turn 坐标（人说的"轮"就是 turn）', text.includes('第 7 轮'))
  checkTrue('★ 含 seq 坐标（给 session_event_read 的钥匙）', text.includes('seq=42'))
  checkTrue('★ 告诉她用哪个工具回看', text.includes('session_event_read'))
  checkTrue('★ 语气是许可式，不是命令式', text.includes('由你决定'))
  checkTrue('★ 明说可以不管它', text.includes('忽略这条就行'))
  checkTrue(
    '★ 不含未替换的占位符',
    !text.includes('${') && !text.includes('undefined') && !text.includes('NaN'),
  )
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
if (failed > 0) process.exitCode = 1
