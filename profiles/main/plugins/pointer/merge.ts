/**
 * 结清（合并）两个会话：**平移**与**守恒校验**。
 *
 * ## 这里的规则全部是实测出来的，不是推的
 *
 * ### ① delta 从 B 推，不做任何假设
 *
 * ```ts
 * const delta = bLog.length - Number(b.inheritedEventCount)
 * ```
 *
 * 不能用"B 活动数 + 1"——那假设了"seed 里只有一条附加标记"，
 * 而 `buildForkSeed` 会 `concat(openTurnClosers(...))`：**fork 时若 A 有未结束的
 * turn，它还会补 closer**，那时 `+1` 就错。
 *
 * ### ② "断口拼接"被 DSH 否决了
 *
 * 曾经想"不平移，只按 `end-seed` 断口拼起来"。实测**不可行**：
 *
 * ```
 * ❌ seed event at index 33 has seq 31 (expected 33); seed must be contiguous from 0
 * ```
 *
 * 因为 A 的恢复块与 B 的活动**都从 `boundary+1` 开始编号** —— 撞了。
 * **所以重编号不是"复杂"，它是必需的。**
 *
 * ### ③ 只平移 `seq` 是不够的 —— 内嵌引用要跟着走
 *
 * 实测：只改 `seq` 而不管 `surfaceOp.startSeq/endSeq` 与 `sourceEventSeqs`，
 * DSH **当场拒绝**：
 *
 * ```
 * ❌ invalid seed event at index 11: surface replace: end seq 8 not found in surface
 * ```
 *
 * **好消息**：它是 fail-loud，不是静默错位 —— 这个坑埋不下去。
 *
 * ### ④ 两半规则，都实测过
 *
 * | 引用指向 | 处理 |
 * |:--|:--|
 * | **恢复块内**（`seq >= inheritedEventCount`） | **`+delta`** |
 * | **前缀内** | **不动** |
 *
 * ### ⑤ 合并产物天然包含 A 与 B
 *
 * `merged = [...bLog, ...aResume 平移]`。而 **B 的 log 开头就是 A 的前缀**
 * （fork 时 `seed` 原样保留了 A 的事件对象）—— 所以 **M 天然含 A 的全部事件**，
 * 结清后删 A 是安全的。不需要另拼一次。
 *
 * ## 纯逻辑
 *
 * 只吃普通对象数组，不碰 cordis、不碰文件系统 —— 可离线自检（`tests/merge.spec.ts`）。
 *
 * @module pointer/merge
 */

import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** 事件上可能带的内嵌 seq 引用。 */
interface SeqRefs {
  surfaceOp?: { op?: string, startSeq?: number, endSeq?: number }
  sourceEventSeqs?: readonly number[]
}

/**
 * 把一个事件从"原坐标"平移到"合并后坐标"。
 *
 * @param event - A 的恢复块里的一个事件。
 * @param inheritedEventCount - 切口（= fork 时的 `boundary + 1`）。**`>= 它` 的才算恢复块**。
 * @param delta - 平移量。
 * @returns 新的、`seq` 与内嵌引用都改过的事件。
 */
export function shiftEvent(
  event: SessionEvent,
  inheritedEventCount: number,
  delta: number,
): SessionEvent {
  /** 只动恢复块里的引用；前缀里的原封不动。 */
  const map = (seq: number): number => (seq >= inheritedEventCount ? seq + delta : seq)

  const raw = event as unknown as SeqRefs
  const out: Record<string, unknown> = {
    ...event,
    seq: SessionSeq(Number(event.seq) + delta),
  }

  const op = raw.surfaceOp
  if (op?.op === 'replace' && typeof op.startSeq === 'number' && typeof op.endSeq === 'number') {
    out['surfaceOp'] = {
      op: 'replace',
      startSeq: SessionSeq(map(op.startSeq)),
      endSeq: SessionSeq(map(op.endSeq)),
    }
  }

  if (Array.isArray(raw.sourceEventSeqs)) {
    out['sourceEventSeqs'] = raw.sourceEventSeqs.map(seq => SessionSeq(map(seq)))
  }

  return out as unknown as SessionEvent
}

/** 合并输入。 */
export interface MergeInput {
  /** **B 的完整 log** —— 它开头已经含 A 的前缀（fork 的 `seed` 保留的）。 */
  readonly bLog: readonly SessionEvent[]
  /** B 的 `inheritedEventCount` —— **切口**，也是 delta 的推导依据。 */
  readonly inheritedEventCount: number
  /** A 在 fork 之后写的那一段（要平移的）。 */
  readonly aResume: readonly SessionEvent[]
}

/** 合并结果。 */
export type MergeResult =
  | {
      readonly ok: true
      readonly events: readonly SessionEvent[]
      readonly delta: number
      /** 结清产物应当注册的 `inheritedEventCount`（沿用切口）。 */
      readonly inheritedEventCount: number
    }
  | { readonly ok: false, readonly reason: string }

/**
 * 结清两个会话，产出合并后的 seed。
 *
 * **不做守恒校验** —— 那是 `checkConservation` 的事，由调用方在**写指针之前**跑。
 * 分开是因为校验失败时的处理（留 `error_backup`、不删源、不写指针）属于调用方的策略。
 *
 * @param input - B 的 log、切口、A 的恢复块。
 * @returns 合并后的事件数组与 delta；结构不对时返回失败。
 */
export function mergeSessions(input: MergeInput): MergeResult {
  const { bLog, inheritedEventCount, aResume } = input

  if (!Number.isInteger(inheritedEventCount) || inheritedEventCount < 0) {
    return { ok: false, reason: `inheritedEventCount 不合法：${String(inheritedEventCount)}` }
  }
  if (inheritedEventCount > bLog.length) {
    return { ok: false, reason: `切口 ${String(inheritedEventCount)} 超出 B 的日志长度 ${String(bLog.length)}` }
  }

  // ★ delta 从 B 推 —— 不假设 seed 里附加事件的条数（可能要补 closer）。
  const delta = bLog.length - inheritedEventCount

  const shifted = aResume.map(event => shiftEvent(event, inheritedEventCount, delta))
  return {
    ok: true,
    events: [...bLog, ...shifted],
    delta,
    inheritedEventCount,
  }
}

/** 守恒校验的结果。 */
export interface ConservationReport {
  /** 事件数守恒：`len(M) === len(B) + len(A恢复)`。 */
  readonly countOk: boolean
  /** seq 从 0 连续递增。 */
  readonly contiguousOk: boolean
  /** 每个内嵌引用都指得到存在的事件。 */
  readonly refsOk: boolean
  /** 人类可读的问题清单（空 = 全过）。 */
  readonly problems: readonly string[]
}

/**
 * 守恒校验 —— **写指针与删源的前置条件**（docs/m5-preemption.md §15.4 / E2）。
 *
 * 三项：
 * 1. **事件数守恒**
 * 2. **seq 从 0 连续**（DSH 硬性要求 `contiguous from 0`）
 * 3. **内嵌引用可解析**（`replace` 区间与 `sourceEventSeqs` 都必须指得到已存在的事件）
 *
 * 第 3 项是实测出来的：只平移 `seq` 而漏了引用，DSH 会报
 * `surface replace: end seq 8 not found in surface`。**在本地先拦住，好过让它去炸。**
 *
 * **⚠️ 本地这一项比 DSH 弱**：DSH 查的是"在不在 **surface**（推导出来的节点表）里"，
 * 本地查的是"在不在**日志**里"。两者不同 —— 一个 seq 可以在日志里、却不是表面节点
 * （比如被别的 `replace` 遮蔽了）。所以本地校验**过了也不保证 DSH 收**；
 * 但 DSH 那关是 **fail-loud** 的（当场拒绝、不静默错位），所以漏网的会被它兜住。
 *
 * @param merged - 合并产物。
 * @param expectedLength - 期望长度（`len(B) + len(A恢复)`）。
 * @returns 报告。
 */
export function checkConservation(
  merged: readonly SessionEvent[],
  expectedLength: number,
): ConservationReport {
  const problems: string[] = []

  const countOk = merged.length === expectedLength
  if (!countOk) {
    problems.push(`事件数不守恒：合并后 ${String(merged.length)}，期望 ${String(expectedLength)}`)
  }

  let contiguousOk = true
  for (let i = 0; i < merged.length; i += 1) {
    if (Number(merged[i]!.seq) !== i) {
      contiguousOk = false
      problems.push(`seq 不连续：第 ${String(i)} 个事件的 seq 是 ${String(Number(merged[i]!.seq))}`)
      break
    }
  }

  const present = new Set(merged.map(event => Number(event.seq)))
  let refsOk = true
  for (const event of merged) {
    const raw = event as unknown as SeqRefs
    const cited = [
      ...(raw.surfaceOp?.op === 'replace'
        ? [raw.surfaceOp.startSeq, raw.surfaceOp.endSeq]
        : []),
      ...(raw.sourceEventSeqs ?? []),
    ]
    for (const seq of cited) {
      if (typeof seq !== 'number') continue
      if (!present.has(seq)) {
        refsOk = false
        problems.push(`seq ${String(Number(event.seq))} 的引用指向不存在的事件 ${String(seq)}`)
        break
      }
    }
    if (!refsOk) break
  }

  return { countOk, contiguousOk, refsOk, problems }
}
