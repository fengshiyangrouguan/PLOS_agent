/**
 * `stripLeadingMention()` 的自检脚本。
 *
 * 跑法：
 * ```powershell
 * cd E:\project\PLOS\deepseek-harness
 * node --import tsx/esm E:\project\PLOS\PLOS_agent\profiles\main\plugins\qq\tests\strip-mention.spec.ts
 * ```
 *
 * ## 为什么需要它（2026-10-16 实测 ✓）
 *
 * ★ 她**倾向于**在传 `at` 的同时，**又在正文开头手写一个 `@名字`** ✗ ——
 * ★★ 于是群里显示两个 `@` ✗（★ 六次带 `at` 的调用里，后三次知道了要 QQ 号仍然每次都手写 ✓）。
 * ★ 描述里写了「Do not also write the @name in `text`」✗ —— **拦不住** ✓，
 * ⇒ ★ 所以在工具里兜底 ✓，而这条规则**必须有自检钉住** ✓✓。
 *
 * @module qq/strip-mention.spec
 */

import assert from 'node:assert/strict'
import { stripLeadingMention } from '../tools/index.ts'

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

// ── ★★ 剥掉开头那个（★ 实测的三次原文 ✓）─────────────────────────
check('★★ 实测⑥ `@NAVI 测试@功能~`', stripLeadingMention('@NAVI 测试@功能~'), '测试@功能~')
check('★★ 实测⑤ `@冯氏羊肉馆 测试@功能`', stripLeadingMention('@冯氏羊肉馆 测试@功能'), '测试@功能')
check('★★ 实测④ `测试@功能~ @NAVI`（★ @ 不在开头 ⇒ **不动** ✓）',
  stripLeadingMention('测试@功能~ @NAVI'), '测试@功能~ @NAVI')
check('实测① `@贺富内的裤睿 拉什么拉，我可是版本升级了`',
  stripLeadingMention('@贺富内的裤睿 拉什么拉，我可是版本升级了'), '拉什么拉，我可是版本升级了')

// ── ★ 边界 ────────────────────────────────────────────────────────
check('★ 没有 @ ⇒ 原样', stripLeadingMention('你好呀'), '你好呀')
check('★ @ 在句中 ⇒ 不动', stripLeadingMention('你好 @NAVI 在吗'), '你好 @NAVI 在吗')
check('★★ 只有 `@某人`（★ 剥完为空）⇒ **保留原文** ✗', stripLeadingMention('@NAVI'), '@NAVI')
check('★★ 只有 `@某人` ＋ 空格 ⇒ 也保留原文 ✗', stripLeadingMention('@NAVI '), '@NAVI ')
check('★ 多个前导 @ ⇒ 只剥**第一个** ✓', stripLeadingMention('@甲 @乙 你好'), '@乙 你好')
check('★ 名字里有连字符／下划线 ⇒ 照样剥 ✓', stripLeadingMention('@a-b_c 你好'), '你好')
check('★ 剥完保留后面的空白与换行 ✓', stripLeadingMention('@甲 第一行\n第二行'), '第一行\n第二行')

console.log(`\n通过 ${passed}，失败 ${failed}`)
if (failed > 0) process.exitCode = 1
