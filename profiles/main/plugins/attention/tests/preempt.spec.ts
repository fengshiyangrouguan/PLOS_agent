/**
 * `preempt.ts` 的自检脚本。
 *
 * 跑法：
 * ```powershell
 * cd E:\project\PLOS\deepseek-harness
 * node --import tsx/esm E:\project\PLOS\PLOS_agent\profiles\main\plugins\attention\tests\preempt.spec.ts
 * ```
 *
 * 能这么跑是因为 `preempt.ts` 只 import 一个常量，运行时零依赖。
 *
 * ## 这里重点验什么
 *
 * **三条轴各自一个职责**（设计 §4.2/§4.3），而 80 那条线最容易被理解错 ——
 * 它不是"能不能抢占"（任意优先级差都能抢占），它是"**收不收尾**"。
 *
 * 以及一个容易漏的边界：**她忙的时候，0 级条目不该抢占**。
 *
 * @module attention/preempt.spec
 */

import assert from 'node:assert/strict'
import { WRAPUP_HINT, planPreemption, withWrapupHint } from '../preempt.ts'

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

// ── 她闲着：直接交付，没有抢占 ──────────────────────────────────────
{
  check('空闲 + 0 级 → 交付', planPreemption('idle', 0), { kind: 'deliver' })
  check('空闲 + 20 → 交付', planPreemption('idle', 20), { kind: 'deliver' })
  check('空闲 + 100 → 交付', planPreemption('idle', 100), { kind: 'deliver' })
}

// ── ★ 她忙 + 0 级：不抢占，排队 ────────────────────────────────────
{
  check('★ 忙碌 + 0 级 → 排队（0 级不产生抢占）', planPreemption('running', 0), { kind: 'queue' })
}

// ── 她忙 + 1..79：允许先收尾 ───────────────────────────────────────
{
  check('忙碌 + 1 → 先收尾', planPreemption('running', 1), { kind: 'wrapup-then-preempt' })
  check('忙碌 + 20（QQ 的 @）→ 先收尾', planPreemption('running', 20), { kind: 'wrapup-then-preempt' })
  check('忙碌 + 79 → 先收尾（79 还没到线）', planPreemption('running', 79), { kind: 'wrapup-then-preempt' })
}

// ── ★ 她忙 + ≥80：立即执行，不给收尾 ───────────────────────────────
{
  check('★ 忙碌 + 80 → 立即接管', planPreemption('running', 80), { kind: 'preempt-now' })
  check('忙碌 + 100 → 立即接管', planPreemption('running', 100), { kind: 'preempt-now' })
}

// ── ★ 80 不是"能不能抢占"那条线 ────────────────────────────────────
{
  // 79 也能抢占（plan 不是 queue/deliver），只是允许收尾。
  // 这条断言防的是"把 80 当成抢占门槛"这个最常见的误读。
  check('★ 79 也抢占，只是允许收尾',
    planPreemption('running', 79).kind === 'queue', false)
  check('★ 80 与 79 的差别只在收尾',
    [planPreemption('running', 79).kind, planPreemption('running', 80).kind],
    ['wrapup-then-preempt', 'preempt-now'])
}

// ── 收尾提示 ────────────────────────────────────────────────────────
{
  check('提示里含"你可以选择"（不是命令）', WRAPUP_HINT.includes('你可以选择'), true)
  check('提示里含"判断当前任务中断情况"', WRAPUP_HINT.includes('判断当前任务中断情况'), true)
  check('提示里给两个具体例子', WRAPUP_HINT.includes('道别') && WRAPUP_HINT.includes('保存'), true)

  const out = withWrapupHint('【QQ】\n群「X」里有人 @ 了你')
  check('提示拼在正文之后', out.startsWith('【QQ】'), true)
  check('提示在末尾', out.endsWith(WRAPUP_HINT), true)
  check('正文与提示之间空一行', out.includes('有人 @ 了你\n\n'), true)

  // 正文末尾已有换行时不该留下多余空行
  check('正文末尾多余换行被吃掉', withWrapupHint('正文\n\n'), `正文\n\n${WRAPUP_HINT}`)
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
if (failed > 0) process.exitCode = 1
