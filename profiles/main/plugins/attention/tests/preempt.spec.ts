/**
 * `preempt.ts` 的自检脚本。
 *
 * 跑法：
 * ```powershell
 * cd E:\project\PLOS\deepseek-harness
 * node --import tsx/esm E:\project\PLOS\PLOS_agent\profiles\main\plugins\attention\tests\preempt.spec.ts
 * ```
 *
 * 能这么跑是因为 `preempt.ts` 只 import 两个常量，运行时零依赖。
 *
 * ## 这里重点验什么
 *
 * 模型已从"RTOS 抢占"换成"**注意力转移**"（docs/m5-preemption.md §20），
 * 所以这份自检盯的是新模型的三件事：
 *
 * 1. **`m` 那条线管的是"要不要立刻放下手上的事"**，不是"能不能被牵走"
 *    —— 任意优先级差都会牵走注意力，`m` 只决定用软的还是硬的。
 * 2. **`n` 那条线管的是"要不要记待办"**，判据是**原任务的优先级**
 *    （不是中断的优先级）。0 级原任务不记 —— 那是用户的原型情形①。
 * 3. **`WRAPUP_HINT` 里不许再出现"结束该 turn"** —— 那句是 fork 模型的遗留，
 *    在无 fork 的新模型里会教她停下来。这是防回归。
 *
 * @module attention/preempt.spec
 */

import assert from 'node:assert/strict'
import { WRAPUP_HINT, planTransfer, withHint } from '../preempt.ts'

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

// ── 她闲着：直接交付，没有"转移"可言 ────────────────────────────────
{
  check('空闲 + 0 级 → 交付', planTransfer('idle', 0, 0), { kind: 'deliver' })
  check('空闲 + 20 → 交付', planTransfer('idle', 0, 20), { kind: 'deliver' })
  check('空闲 + 100 → 交付', planTransfer('idle', 0, 100), { kind: 'deliver' })
  check('空闲时原任务优先级无关', planTransfer('idle', 99, 100), { kind: 'deliver' })
}

// ── ★ 她忙 + 0 级：不牵走注意力，排队 ──────────────────────────────
{
  check('★ 忙碌 + 0 级 → 排队（0 级不产生自己的唤醒）', planTransfer('running', 0, 0), { kind: 'queue' })
  check('★ 忙碌 + 0 级，原任务再高也不记待办', planTransfer('running', 80, 0), { kind: 'queue' })
}

// ── 她忙 + 1..79：软转移（steer），要不要记待办看原任务 ──────────────
{
  check(
    '忙碌 + 20，原任务是 0 级 → steer，★不记待办（情形①：群聊被打断）',
    planTransfer('running', 0, 20),
    { kind: 'steer', record: false },
  )
  check(
    '忙碌 + 20，原任务是 20 级 → steer，★记待办（情形②：私聊被终端打断）',
    planTransfer('running', 20, 20),
    { kind: 'steer', record: true },
  )
  check(
    '忙碌 + 79 → 还是软转移（79 < 80）',
    planTransfer('running', 20, 79),
    { kind: 'steer', record: true },
  )
}

// ── ★ 她忙 + ≥80：硬切（cancel），不给收尾机会 ──────────────────────
{
  check(
    '★ 忙碌 + 80 → 硬 cancel',
    planTransfer('running', 20, 80),
    { kind: 'cancel', record: true },
  )
  check(
    '★ 忙碌 + 100 → 硬 cancel',
    planTransfer('running', 20, 100),
    { kind: 'cancel', record: true },
  )
  check(
    '★ 硬 cancel 也会记待办（原任务 > n）',
    planTransfer('running', 20, 80),
    { kind: 'cancel', record: true },
  )
  check(
    '★ 原任务 0 级时硬 cancel 仍不记待办',
    planTransfer('running', 0, 80),
    { kind: 'cancel', record: false },
  )
}

// ── 两个阈值都是可配置的 ────────────────────────────────────────────
{
  check(
    'n 可配：n=10、原任务 5 → 不记',
    planTransfer('running', 5, 20, { pendingThreshold: 10, urgentThreshold: 80 }),
    { kind: 'steer', record: false },
  )
  check(
    'n 可配：n=10、原任务 10 → 不记（判据是 > n，不是 >= n）',
    planTransfer('running', 10, 20, { pendingThreshold: 10, urgentThreshold: 80 }),
    { kind: 'steer', record: false },
  )
  check(
    'n 可配：n=10、原任务 11 → 记',
    planTransfer('running', 11, 20, { pendingThreshold: 10, urgentThreshold: 80 }),
    { kind: 'steer', record: true },
  )
  check(
    'm 可配：m=50 时 60 就硬切',
    planTransfer('running', 20, 60, { pendingThreshold: 0, urgentThreshold: 50 }),
    { kind: 'cancel', record: true },
  )
  check(
    'm 可配：m=200 时 100 只是软转移',
    planTransfer('running', 20, 100, { pendingThreshold: 0, urgentThreshold: 200 }),
    { kind: 'steer', record: true },
  )
}

// ── ★ 防回归：提示里不许再有 fork 模型的残留 ────────────────────────
{
  checkTrue('★ WRAPUP_HINT 不再要求她"结束该 turn"', !WRAPUP_HINT.includes('结束该 turn'))
  checkTrue('★ WRAPUP_HINT 要求她处理完接着做原来的事', WRAPUP_HINT.includes('接着做原来的事'))
  checkTrue('WRAPUP_HINT 保留"判断是否有必要打断你"', WRAPUP_HINT.includes('打断你'))
}

// ── withHint 把提示放末尾 ───────────────────────────────────────────
{
  check(
    'withHint 拼在末尾（前面只有一条换行）',
    withHint('正文\n\n', '提示'),
    '正文\n\n提示',
  )
  check(
    'withHint 不破坏正文中间的空行',
    withHint('第一段\n\n第二段', '提示'),
    '第一段\n\n第二段\n\n提示',
  )
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
if (failed > 0) process.exitCode = 1
