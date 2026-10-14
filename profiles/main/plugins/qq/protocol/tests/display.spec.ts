/**
 * `displayNameOf()` 的自检脚本。
 *
 * 跑法（和其它 spec 一样，从 deepseek-harness 跑）：
 * ```powershell
 * cd E:\project\PLOS\deepseek-harness
 * node --import tsx/esm E:\project\PLOS\PLOS_agent\profiles\main\plugins\qq\protocol\tests\display.spec.ts
 * ```
 *
 * ## 为什么值得单独钉死
 *
 * 这个字符串是**模型可见的**（每条消息、每条转发、群成员列表都带它），
 * 而它靠真实流量盯不住 —— 模型不会告诉你"你把谁的名字搞混了"。
 * 出错的形态又特别隐蔽：**同一个群成员在实时消息里叫 A、在转发里叫 B**，
 * 而两边都不报错。所以规则必须靠这份自检写死。
 *
 * @module qq/protocol/display.spec
 */

import assert from 'node:assert/strict'
import { displayNameOf } from '../index.ts'

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

// ── 主规则：昵称 + 不同的群名片 ──────────────────────────────────────
check(
  '★ 有不同群名片 → 昵称(群昵称:名片)',
  displayNameOf({ nickname: '张三', card: '李四' }, '10001'),
  '张三(群昵称:李四)',
)

// ── 折叠：名片与昵称相同 ─────────────────────────────────────────────
check(
  '★ 群名片 === 昵称 → 折叠成一次（括号不携带信息）',
  displayNameOf({ nickname: '张三', card: '张三' }, '10001'),
  '张三',
)

// ── 没有名片（私聊 / 没设群名片）─────────────────────────────────────
check('没有 card → 只有昵称', displayNameOf({ nickname: '张三' }, '10001'), '张三')
check(
  '★ 空串 card 视同没有（协议端给空串是常态）',
  displayNameOf({ nickname: '张三', card: '' }, '10001'),
  '张三',
)

// ── 只有名片 ────────────────────────────────────────────────────────
check('只有 card → 用名片', displayNameOf({ card: '李四' }, '10001'), '李四')
check('空串 nickname 视同没有', displayNameOf({ nickname: '', card: '李四' }, '10001'), '李四')

// ── 都没有 → 回落 ───────────────────────────────────────────────────
check('两个都空 → 回落 id', displayNameOf({}, '10001'), '10001')
check('sender 整个缺失 → 回落 id', displayNameOf(undefined, '10001'), '10001')
check(
  '两个都是空串 → 回落 id',
  displayNameOf({ nickname: '', card: '' }, '10001'),
  '10001',
)

// ── 形状容错：转发那种松对象 ────────────────────────────────────────
check(
  '多余字段不影响（转发记录里还有一堆别的键）',
  displayNameOf({ user_id: 10001, nickname: '张三', card: '李四', role: 'admin' } as never, 'x'),
  '张三(群昵称:李四)',
)

console.log(`\n通过 ${passed}，失败 ${failed}`)
if (failed > 0) process.exitCode = 1
