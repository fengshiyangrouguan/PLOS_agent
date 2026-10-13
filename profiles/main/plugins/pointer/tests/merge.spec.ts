/**
 * `merge.ts` 的自检脚本。
 *
 * 跑法：
 * ```powershell
 * cd E:\project\PLOS\deepseek-harness
 * node --import tsx/esm E:\project\PLOS\PLOS_agent\profiles\main\plugins\pointer\tests\merge.spec.ts
 * ```
 *
 * ## 这里重点验什么
 *
 * 两条都是**实测出来的坑**，不是推的：
 *
 * 1. **delta 从 B 推** —— "B 活动数 + 1"在 seed 补了 closer 时会错
 * 2. **内嵌引用要跟着平移，但只动恢复块里的** —— 只改 `seq` 会被 DSH 当场拒绝
 *    （`surface replace: end seq 8 not found in surface`）
 *
 * @module pointer/merge.spec
 */

import assert from 'node:assert/strict'
import { checkConservation, mergeSessions, shiftEvent } from '../merge.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

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

/**
 * 造一个带 seq 的消息事件。
 * @param seq - 序号。
 * @param extra - 附加字段（`surfaceOp` / `sourceEventSeqs`）。
 */
function ev(seq: number, extra: Record<string, unknown> = {}): SessionEvent {
  return { type: 'user/message', seq, time: 0, data: {}, ...extra } as unknown as SessionEvent
}

/**
 * 造一个 `replace` 事件。
 * @param seq - 序号。
 * @param start - 遮蔽区间起点。
 * @param end - 遮蔽区间终点。
 */
function replace(seq: number, start: number, end: number): SessionEvent {
  return ev(seq, {
    surfaceOp: { op: 'replace', startSeq: start, endSeq: end },
    sourceEventSeqs: [start, end],
  })
}

/** 取一个事件的内嵌引用（拍平）。 */
function refs(event: SessionEvent): number[] {
  const raw = event as unknown as {
    surfaceOp?: { op?: string, startSeq?: number, endSeq?: number }
    sourceEventSeqs?: number[]
  }
  return [
    ...(raw.surfaceOp?.op === 'replace' ? [raw.surfaceOp.startSeq, raw.surfaceOp.endSeq] : []),
    ...(raw.sourceEventSeqs ?? []),
  ].filter((n): n is number => typeof n === 'number')
}

// ── shiftEvent：seq 一律平移 ────────────────────────────────────────
{
  const seqOnly = (n: number): number => Number(shiftEvent(ev(n), 5, 3).seq)
  check('seq 平移 +delta', [seqOnly(5), seqOnly(6), seqOnly(10)], [8, 9, 13])
}

// ── ★ 内嵌引用：恢复块里的跟着走，前缀里的不动 ──────────────────────
{
  // inheritedEventCount = 5 → 5 及之后是恢复块
  const inBlock = replace(7, 6, 7)
  const shifted = shiftEvent(inBlock, 5, 3)
  // refs() 把 replace 区间【和】 sourceEventSeqs 都拍平 → 4 项
  check('★ 恢复块内的 replace 区间跟着平移', refs(shifted), [9, 10, 9, 10])
  check('★ 恢复块内的 sourceEventSeqs 也平移',
    (shifted as unknown as { sourceEventSeqs: number[] }).sourceEventSeqs, [9, 10])

  const touchesPrefix = replace(7, 2, 6)
  const mixed = shiftEvent(touchesPrefix, 5, 3)
  check('★ 指向前缀的引用不动（2 不动，6 跟着走）', refs(mixed), [2, 9, 2, 9])

  const plain = ev(7)
  check('没有引用的普通事件只改 seq', refs(shiftEvent(plain, 5, 3)), [])
}

// ── mergeSessions：delta 从 B 推 ────────────────────────────────────
{
  const bLog = [ev(0), ev(1), ev(2), ev(3)]
  const result = mergeSessions({ bLog, inheritedEventCount: 2, aResume: [ev(2), ev(3)] })
  check('合并成功', result.ok, true)
  if (result.ok) {
    // delta = 4 - 2 = 2
    check('★ delta = len(B) - 切口', result.delta, 2)
    check('产物 = B ++ A恢复平移', result.events.map(e => Number(e.seq)), [0, 1, 2, 3, 4, 5])
    check('产物的切口沿用', result.inheritedEventCount, 2)
  }
}

// ── ★ seed 补了 closer 时：旧公式会错，新公式不会 ───────────────────
{
  // 切口 2，但 B 的 log 有 7 个（前缀 2 + 标记 1 + **closer 2** + 活动 2）
  const bLog = [ev(0), ev(1), ev(2), ev(3), ev(4), ev(5), ev(6)]
  const activityCount = 2
  const oldDelta = activityCount + 1          // 旧公式：活动数 + 1 = 3
  const result = mergeSessions({ bLog, inheritedEventCount: 2, aResume: [ev(2)] })
  check('合并成功（有 closer 的情况）', result.ok, true)
  if (result.ok) {
    check('★ 新公式 delta = 7 - 2 = 5', result.delta, 5)
    check('★ 旧公式（活动数+1=3）确实会算错', result.delta !== oldDelta, true)
    check('平移后 A 恢复接在 B 之后', result.events.map(e => Number(e.seq)), [0, 1, 2, 3, 4, 5, 6, 7])
  }
}

// ── 边界：切口不合法 ────────────────────────────────────────────────
{
  const bad = mergeSessions({ bLog: [ev(0)], inheritedEventCount: 5, aResume: [] })
  check('切口超出 B 长度 → 失败', bad.ok, false)
  const neg = mergeSessions({ bLog: [ev(0)], inheritedEventCount: -1, aResume: [] })
  check('切口为负 → 失败', neg.ok, false)
  const empty = mergeSessions({ bLog: [], inheritedEventCount: 0, aResume: [ev(0)] })
  check('B 为空时也合法（delta=0）', empty.ok, true)
}

// ── ★ 守恒校验 ──────────────────────────────────────────────────────
{
  const good = [ev(0), ev(1), ev(2), replace(3, 0, 1)]
  const r1 = checkConservation(good, 4)
  check('全过：事件数', r1.countOk, true)
  check('全过：连续', r1.contiguousOk, true)
  check('全过：引用可解析', r1.refsOk, true)
  check('全过：没有 problem', r1.problems, [])

  const r2 = checkConservation(good, 5)
  check('事件数不守恒能被抓到', r2.countOk, false)

  const gapped = [ev(0), ev(1), ev(5)]
  const r3 = checkConservation(gapped, 3)
  check('★ seq 断档能被抓到', r3.contiguousOk, false)
  check('断档给一句可读的话', r3.problems[0]?.includes('seq 不连续'), true)

  // ★ 这正是实测里 DSH 报的那个错：replace 指向不存在的事件
  const dangling = [ev(0), ev(1), replace(2, 0, 99)]
  const r4 = checkConservation(dangling, 3)
  check('★ 悬空引用能被抓到', r4.refsOk, false)
  check('悬空引用给一句可读的话', r4.problems[0]?.includes('指向不存在的事件'), true)

  check('空数组 + 期望 0 → 全过', checkConservation([], 0).problems, [])
}

// ── ★ 端到端：合并 → 校验 ───────────────────────────────────────────
{
  // A：切口 3 → 前缀 0..2，恢复块从 3 起。
  // 恢复块里的 replace 指向【前缀】的 1 —— 平移后应当**不动**。
  const bLog = [ev(0), ev(1), ev(2), ev(3)]           // 前缀 0..2 + 标记(3)
  const aResume = [ev(3), replace(4, 1, 1)]

  const merged = mergeSessions({ bLog, inheritedEventCount: 3, aResume })
  check('端到端：合并成功', merged.ok, true)
  if (merged.ok) {
    // delta = 4 - 3 = 1 → aResume 变成 seq 4、5
    check('端到端：delta', merged.delta, 1)
    check('端到端：产物 seq', merged.events.map(e => Number(e.seq)), [0, 1, 2, 3, 4, 5])
    // ★ 关键：那个 replace 原来指向 3（前缀里），平移后**不该动**
    check('端到端：指向前缀的引用没动（1 不动）', refs(merged.events[5]!), [1, 1, 1, 1])

    const report = checkConservation(merged.events, bLog.length + aResume.length)
    check('★ 端到端：守恒全过（可以写指针了）', report.problems, [])
  }

  // 反例：引用指向【日志之外】的 seq → 本地校验必须拦住
  const outOfLog = [ev(0), replace(1, 0, 99)]
  const badReport = checkConservation(outOfLog, 2)
  check('★ 引用指向日志外 → 本地校验拦住', badReport.refsOk, false)
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
if (failed > 0) process.exitCode = 1
