/**
 * `attention` 的**同源补充**判断 —— 只测抽出来的那个纯函数。
 *
 * 为什么单独测它：`supplement()` 是类上的方法（要 ctx、要 agent），
 * 而**判断错的两个方向都会静默出错**：
 *
 *   · 该补没补 ⇒ 退回"全体拉取" ⇒ 她只看到梗概、看不到原文
 *   · 不该补却补了 ⇒ 拿**梗概**去回答一个**更高级的打断** ✗
 *
 * 所以判据本身必须钉住。
 */

import { shouldSupplement } from '../index.ts'

let passed = 0
let failed = 0

/**
 * 断言相等。
 *
 * @param label - 说明。
 * @param actual - 实际值。
 * @param expected - 期望值。
 */
function check(label: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed += 1
    console.log(`  ✓ ${label}`)
  } else {
    failed += 1
    console.log(`  ✗ ${label}\n      实际 ${JSON.stringify(actual)}\n      期望 ${JSON.stringify(expected)}`)
  }
}

const running = { source: 'private:2673439877', priority: 20 }

// ── 该补的 ──────────────────────────────────────────────────────────
{
  check('★ 同源 ＋ 同级 ⇒ 补', shouldSupplement(running, 'private:2673439877', 20), true)
  check('★ 同源 ＋ 更低 ⇒ 也补（她接着说，级别更低没关系）',
    shouldSupplement(running, 'private:2673439877', 0), true)
  check('同源 ＋ 同级 0（普通群消息）⇒ 补',
    shouldSupplement({ source: 'group:728636404', priority: 0 }, 'group:728636404', 0), true)
}

// ── 不该补的 ────────────────────────────────────────────────────────
{
  check('★ 不同源 ＋ 同级 ⇒ **不补**（★ 这一条就是 `currentSource` 必须存在的原因：'
    + '优先级说不出是哪个会话）',
  shouldSupplement(running, 'group:728636404', 20), false)
  check('★ 同源 ＋ **更高** ⇒ 不补（它可能要**中断**她，那是 planTransfer 那条路）',
    shouldSupplement(running, 'private:2673439877', 80), false)
  check('★ 会话 id 只差一位 ⇒ 不补（纯字符串比较，别写成前缀匹配）',
    shouldSupplement(running, 'private:267343987', 20), false)
  check('没有正在跑的一轮（source 未知）⇒ 不补',
    shouldSupplement({ source: undefined, priority: 20 }, 'private:2673439877', 20), false)
  check('current 整个是 undefined ⇒ 不补',
    shouldSupplement(undefined, 'private:2673439877', 20), false)
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
if (failed > 0) process.exitCode = 1
