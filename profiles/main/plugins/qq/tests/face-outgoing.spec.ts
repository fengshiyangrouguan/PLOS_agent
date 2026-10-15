/**
 * `parseOutgoingFaces` 的自检 —— **出站反解析**。
 *
 * 它是 `faceToText` 的逆：那条路让模型看到 `[表情：笑哭]`，这条把她写的还原成 `face` 段。
 *
 * ★ 判据错的两个方向都会静默出错：
 *   · 该还原没还原 ⇒ **对方收到一串方括号** ✗
 *   · 认不出来的没丢掉 ⇒ 同上 ✗（用户定案：**整段丢掉**）
 */

import { FACE_TEXT_TO_ID, parseOutgoingFaces } from '../pipeline/face.ts'

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

// ── 反查表本身 ────────────────────────────────────────────────────────
{
  check('★ 表能反查出「笑哭」', FACE_TEXT_TO_ID['[表情：笑哭]'] !== undefined, true)
  check('★ 重复值取**最先出现**的数字键（保证稳定）', FACE_TEXT_TO_ID['[表情：笑哭]'], '237')
  check('表里没有的名字查不到', FACE_TEXT_TO_ID['[表情：不存在]'], undefined)
}

// ── 只有表情 ──────────────────────────────────────────────────────────
{
  check('单个表情', parseOutgoingFaces('[表情：笑哭]'),
    [{ kind: 'face', id: '237' }])
  check('★ 查不到的表情 ⇒ **整段丢掉**（不产出任何段）',
    parseOutgoingFaces('[表情：不存在]'), [])
  check('★ 丢掉之后**前后文本仍在**（且会合成一段 —— 不产出碎片）',
    parseOutgoingFaces('甲[表情：不存在]乙'),
    [{ kind: 'text', text: '甲乙' }])
}

// ── ★ 兜底形态自带 id ⇒ 直接认 ────────────────────────────────────────
{
  check('★ `[未知表情:999]` 直接用它的 id（比丢掉好得多）',
    parseOutgoingFaces('[未知表情:999]'),
    [{ kind: 'face', id: '999' }])
  check('兜底形态里不是数字 ⇒ 丢掉',
    parseOutgoingFaces('[未知表情:abc]'), [])
}

// ── 切分与合并 ────────────────────────────────────────────────────────
{
  check('文本夹表情 ⇒ 三段', parseOutgoingFaces('笑死[表情：笑哭]了'),
    [{ kind: 'text', text: '笑死' }, { kind: 'face', id: '237' }, { kind: 'text', text: '了' }])
  check('两个表情挨着', parseOutgoingFaces('[表情：笑哭][表情：赞]'),
    [{ kind: 'face', id: '237' }, { kind: 'face', id: FACE_TEXT_TO_ID['[表情：赞]'] }])
  check('★ 相邻纯文本会合并（不产出碎片）', parseOutgoingFaces('甲[表情：不存在]乙'),
    [{ kind: 'text', text: '甲乙' }])
  check('没有表情 ⇒ 一整段文本', parseOutgoingFaces('普通一句话'),
    [{ kind: 'text', text: '普通一句话' }])
  check('空串 ⇒ 空数组（不产出空段）', parseOutgoingFaces(''), [])
}

// ── 容错：多余空格 / 全角冒号 ─────────────────────────────────────────
{
  check('★ 名字前有空格也认（老表里有那种瑕疵）', parseOutgoingFaces('[表情： 笑哭]'),
    [{ kind: 'face', id: '237' }])
  check('方括号里的名字带尾空格也认', parseOutgoingFaces('[表情：笑哭 ]'),
    [{ kind: 'face', id: '237' }])
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
if (failed > 0) process.exitCode = 1
