/**
 * `queue.ts` 的自检脚本。
 *
 * 跑法：
 * ```powershell
 * cd E:\project\PLOS\deepseek-harness
 * node --import tsx/esm E:\project\PLOS\PLOS_agent\profiles\main\plugins\attention\tests\queue.spec.ts
 * ```
 *
 * 能这么跑是因为 `queue.ts` 只 import 类型，运行时零依赖。
 *
 * ## 这里重点验什么
 *
 * **0 级最多一条（保留最新）** —— 这是用户定案的不变量：
 * 0 级是"不太有用的信息"，定时器不重置、她忙时照常走，这类条目会反复产生；
 * 攒一队没有意义，第二条起都是同一件事的过时快照。
 *
 * 以及 **严格优先级 + 同级 FIFO** 的排序（设计 §4.3）：
 * 任意优先级差不排队，同优先级按到达顺序。
 *
 * @module attention/queue.spec
 */

import assert from 'node:assert/strict'
import { PendingQueue } from '../queue.ts'
import type { PerceptionNotice } from '../../perception/types.ts'

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
 * 造一个带标记的感知条目。
 *
 * **来源按 `tag` 派生**（不是按信号序号）—— 这样"不同 tag"就等于"不同会话"，
 * 不会因为都叫 `s0` 而被**同来源合并**规则吃掉。要测合并就显式传同一个 `source`。
 *
 * @param tag - 放进正文里用于辨认，同时是默认来源。
 * @param highest - 最高优先级。
 * @param signals - 信号条数（默认 1，让 `quiet` 与 `highest` 自洽）。
 * @param source - 显式指定来源；默认用 `tag`。
 */
function notice(tag: string, highest: number, signals = 1, source = tag): PerceptionNotice {
  return {
    at: 0,
    text: tag,
    signals: Array.from({ length: signals }, (_unused, i) => ({
      kind: 'k',
      data: {},
      source: signals > 1 ? `${source}#${String(i)}` : source,
      domain: 'D',
      priority: highest,
      line: tag,
    })),
    highest,
    quiet: highest === 0,
  }
}

/** 取队首的正文标记。 */
function tagOf(item: { notice: PerceptionNotice } | undefined): string | undefined {
  return item?.notice.text
}

// ── ★ 0 级最多一条，保留最新 ────────────────────────────────────────
{
  const queue = new PendingQueue()
  queue.push(notice('q1', 0), 100)
  check('0 级入队', queue.size, 1)

  queue.push(notice('q2', 0), 200)
  check('第二个 0 级不增长队列', queue.size, 1)
  check('★ 保留的是最新那条', tagOf(queue.peek()), 'q2')

  queue.push(notice('q3', 0), 300)
  check('★ 继续顶掉，始终只有一条', queue.size, 1)
  check('★ 仍是最新', tagOf(queue.peek()), 'q3')

  // 非 0 级不受影响
  queue.push(notice('hot', 20), 400)
  check('非 0 级正常入队', queue.size, 2)
  check('有非 0 级时它排前面', tagOf(queue.peek()), 'hot')

  queue.drain()
  check('取走非 0 级后 0 级还在', tagOf(queue.peek()), 'q3')
}

// ── 排序：优先级降序 ────────────────────────────────────────────────
{
  const queue = new PendingQueue()
  queue.push(notice('p20', 20), 1)
  queue.push(notice('p5', 5), 2)
  queue.push(notice('p80', 80), 3)
  queue.push(notice('p1', 1), 4)

  check('最高优先级先出', tagOf(queue.drain()), 'p80')
  check('其次 20', tagOf(queue.drain()), 'p20')
  check('再次 5', tagOf(queue.drain()), 'p5')
  check('最后 1', tagOf(queue.drain()), 'p1')
  check('取空后为空', queue.drain(), undefined)
}

// ── 排序：同级 FIFO ─────────────────────────────────────────────────
{
  const queue = new PendingQueue()
  queue.push(notice('先到', 30), 100)
  queue.push(notice('后到', 30), 200)
  check('同级按到达顺序', tagOf(queue.drain()), '先到')
  check('然后才是后到的', tagOf(queue.drain()), '后到')

  // 入队时间倒过来也必须按时间排（不是按插入顺序）
  const q2 = new PendingQueue()
  q2.push(notice('晚', 30), 500)
  q2.push(notice('早', 30), 100)
  check('同级按 queuedAt 而不是插入顺序', tagOf(q2.drain()), '早')
}

// ── 任意优先级差都插队（不需要到 80）────────────────────────────────
{
  const queue = new PendingQueue()
  queue.push(notice('p30', 30), 1)
  queue.push(notice('p31', 31), 999)   // 晚到，但优先级高一级
  check('★ 高一级就插队，不必到 80', tagOf(queue.drain()), 'p31')
  check('被插队的还在', tagOf(queue.drain()), 'p30')
}

// ── peek 不取走 ─────────────────────────────────────────────────────
{
  const queue = new PendingQueue()
  queue.push(notice('a', 10), 1)
  check('peek 拿到队首', tagOf(queue.peek()), 'a')
  check('peek 不减少数量', queue.size, 1)
  check('peek 两次结果一致', tagOf(queue.peek()), tagOf(queue.peek()))
}

// ── 容量上限：丢最旧的非 0 级 ───────────────────────────────────────
{
  const queue = new PendingQueue(3)
  queue.push(notice('a', 10), 1)
  queue.push(notice('b', 10), 2)
  queue.push(notice('c', 10), 3)
  check('到达上限', queue.size, 3)

  queue.push(notice('d', 10), 4)
  check('超限后仍是 3', queue.size, 3)
  check('丢的是最旧的非 0 级', tagOf(queue.drain()), 'b')
}

// ── 容量上限不吃掉 0 级 ─────────────────────────────────────────────
{
  const queue = new PendingQueue(2)
  queue.push(notice('quiet', 0), 1)
  queue.push(notice('a', 10), 2)
  queue.push(notice('b', 10), 3)   // 超限：该丢非 0 级
  check('0 级不被容量淘汰', queue.size, 2)
  const tags = [tagOf(queue.drain()), tagOf(queue.drain())]
  check('0 级仍在（且非 0 级被丢了一个）', tags.includes('quiet'), true)
}

// ── allQuiet / clear ────────────────────────────────────────────────
{
  const queue = new PendingQueue()
  check('空队列 allQuiet 为真（vacuous）', queue.allQuiet, true)
  queue.push(notice('q', 0), 1)
  check('只有 0 级时 allQuiet', queue.allQuiet, true)
  queue.push(notice('h', 20), 2)
  check('有非 0 级时不是 allQuiet', queue.allQuiet, false)

  queue.clear()
  check('clear 清空', queue.size, 0)
}

// ── ★ 同来源合并（用户定案）：整条换新，位置留旧的 ──────────────────
{
  const queue = new PendingQueue()
  queue.push(notice('先来的', 20, 1, 'group:1'), 100)
  queue.push(notice('别人', 20, 1, 'group:2'), 200)

  // 同来源（group:1）再来一条：不新开，并进已有那条。
  queue.push(notice('后补的', 20, 1, 'group:1'), 300)
  check('★ 同来源不新开一条', queue.size, 2)

  const tags = [tagOf(queue.drain()), tagOf(queue.drain())]
  check('★ 同来源的内容取最新', tags.includes('后补的'), true)
  check('★ 老内容被换掉（不是并排两条）', tags.includes('先来的'), false)
}

// ── ★ 位置留旧的：同优先级下，先来的仍在前面 ────────────────────────
{
  const queue = new PendingQueue()
  queue.push(notice('甲', 20, 1, 'group:1'), 100)   // 队位最前
  queue.push(notice('乙', 20, 1, 'group:2'), 200)

  // 甲又来一条（更晚的时间戳）。若"位置被刷新"，乙就会排到前面去。
  queue.push(notice('甲新', 20, 1, 'group:1'), 300)
  check('★ 合并后位置留在旧的（先来的仍先走）', tagOf(queue.peek()), '甲新')
}

// ── 不同来源不合并 ──────────────────────────────────────────────────
{
  const queue = new PendingQueue()
  queue.push(notice('甲', 20, 1, 'group:1'), 100)
  queue.push(notice('乙', 20, 1, 'group:2'), 200)
  check('不同来源各占一格', queue.size, 2)
}

// ── 同来源跨等级也合并（0 级升到 20 级）─────────────────────────────
{
  const queue = new PendingQueue()
  queue.push(notice('群里有人说', 0, 1, 'group:1'), 100)
  queue.push(notice('@我了', 20, 1, 'group:1'), 200)
  check('★ 同来源跨等级合并成一条', queue.size, 1)
  check('★ 合并后优先级取新的', queue.peek()?.notice.highest, 20)
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
if (failed > 0) process.exitCode = 1
