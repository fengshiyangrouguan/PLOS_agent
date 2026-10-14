/**
 * `qq/wait.ts` 的自检。
 *
 * 跑法（和其它 spec 一样）：
 * ```powershell
 * cd E:\project\PLOS\deepseek-harness
 * node --import tsx/esm E:\project\PLOS\PLOS_agent\profiles\main\plugins\qq\tests\wait.spec.ts
 * ```
 *
 * ## 为什么这份非写不可
 *
 * 它两条路都牵着一个 **turn 的死活**：
 *
 * - 若"同会话只允许一个"写错，**先来的那个会永远挂着** —— 她的一轮就卡在那儿不结束
 * - 若短路判据写错（比如把别的会话也短路了），消息会**悄无声息地消失**（不唤醒、也不回传）
 *
 * @module qq/tests/wait.spec
 */

import assert from 'node:assert/strict'
import { beginWait, isWaiting, offer, waitingCount } from '../wait.ts'

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
    assert.equal(actual, expected)
    passed += 1
    console.log(`  ok   ${label}`)
  } catch {
    failed += 1
    console.log(`  FAIL ${label}`)
    console.log(`       期望: ${JSON.stringify(expected)}`)
    console.log(`       实际: ${JSON.stringify(actual)}`)
  }
}

/**
 * 等 `ms` 毫秒。
 * @param ms - 毫秒。
 * @returns 到点后 resolve。
 */
async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

// ── 没人说话 → 超时返回 false（不是挂住）────────────────────────────
{
  const started = Date.now()
  const result = await beginWait('private:1', 40)
  check('★ 超时返回 false（不是永远挂着）', result, false)
  check('超时确实等满了', Date.now() - started >= 35, true)
  check('超时后不再占着这个会话', isWaiting('private:1'), false)
}

// ── 有人说话 → true ─────────────────────────────────────────────────
{
  const waiting = beginWait('private:2', 500)
  check('开始等之后 isWaiting 为真', isWaiting('private:2'), true)
  check('★ offer 命中了等待者', offer('private:2'), true)
  check('★ 唤醒返回 true', await waiting, true)
  check('醒来后不再占着这个会话', isWaiting('private:2'), false)
}

// ── 别的会话不受影响 ────────────────────────────────────────────────
{
  const waiting = beginWait('private:3', 500)
  check('★ offer 别的会话不会命中它', offer('group:9'), false)
  check('★ 它还在等（别的会话的消息没被吃掉）', isWaiting('private:3'), true)
  // 收尾：让它自然超时，别留悬挂的定时器。
  offer('private:3')
  await waiting
}

// ── ★★ 同会话只允许一个：先来的必须收到 false，不能挂死 ──────────────
{
  const first = beginWait('private:4', 120)
  const second = beginWait('private:4', 500)
  check('同会话只留一个等待者', waitingCount(), 1)

  check('offer 命中（命中的是**新的**那个）', offer('private:4'), true)
  check('★ 新的那个拿到 true', await second, true)
  // ★ 这一条是重点：旧的那个**没有被 offer 唤醒**，而它必须在**自己的超时**上
  //   以 `false` 收场 —— 若它永远挂着，她那一轮就卡死了。
  check('★★ 旧的那个以 false 收场（不是永远挂着）', await first, false)
}

// ── 没有等待者时 offer 不认领 ───────────────────────────────────────
{
  check('没人等时 offer 返回 false', offer('private:5'), false)
  check('队列是空的', waitingCount(), 0)
}

await sleep(1)

console.log(`\n通过 ${passed}，失败 ${failed}`)
if (failed > 0) process.exitCode = 1
