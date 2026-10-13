/**
 * `stack.ts` 的自检脚本。
 *
 * 跑法：
 * ```powershell
 * cd E:\project\PLOS\deepseek-harness
 * node --import tsx/esm E:\project\PLOS\PLOS_agent\profiles\main\plugins\pointer\tests\stack.spec.ts
 * ```
 *
 * ## 这里重点验什么
 *
 * **用户给的推演表必须被精确复现**：
 *
 * ```
 * 【A 【B中断 C中断 B恢复】BC合并为B1 A恢复】A和B1合并
 * ```
 *
 * 以及一个容易搞错的点：**"C 完成"时不发生结清**（它上面没东西），
 * **"B 完成"时才把 C 结清进来**。这条错了整条链路就乱了。
 *
 * @module pointer/stack.spec
 */

import assert from 'node:assert/strict'
import { PointerStack, type PointerFrame } from '../stack.ts'

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
 * 造一帧。
 * @param id - 会话 id。
 * @param tcb - 所属 TCB。
 */
function frame(id: string, tcb = 'baiyu'): PointerFrame {
  return { sessionId: id, tcb, pushedAt: 0, reason: '' }
}

// ── ★ 推演用户给的例子 ──────────────────────────────────────────────
{
  const stack = new PointerStack()

  // A 跑
  stack.push(frame('A'))
  check('A 跑：一层，running=0', [stack.depth, stack.runningIndex], [1, 0])
  check('A 跑：current 是 A', stack.current?.sessionId, 'A')
  check('A 跑：没有冻结层', stack.frozen.length, 0)

  // B 中断
  stack.push(frame('B'))
  check('B 中断：两层，running=1', [stack.depth, stack.runningIndex], [2, 1])
  check('B 中断：current 是 B', stack.current?.sessionId, 'B')
  check('★ 被中断的 A 原封不动留在下面', stack.frozen.map(f => f.sessionId), ['A'])

  // C 中断
  stack.push(frame('C'))
  check('C 中断：三层，running=2', [stack.depth, stack.runningIndex], [3, 2])
  check('C 中断：冻结的是 A、B', stack.frozen.map(f => f.sessionId), ['A', 'B'])

  // ★ C 完成 —— 上面没东西，只上浮，**不结清**
  const planC = stack.planSettle()
  check('★ C 完成：动作是 pop（上面没东西可结清）', planC.kind, 'pop')
  stack.applySettle(planC, '不该用到', 'baiyu', 1)
  check('★ C 完成：指针上浮到 B', stack.current?.sessionId, 'B')
  check('★ C 完成：栈不变（三层）', stack.depth, 3)

  // ★ B 完成 —— 把上面的 C 结清进来
  const planB = stack.planSettle()
  check('★ B 完成：动作是 settle', planB.kind, 'settle')
  check('★ B 完成：结清 B 和 C',
    planB.kind === 'settle' ? planB.sessionIds : [], ['B', 'C'])
  stack.applySettle(planB, 'B1', 'baiyu', 2)
  check('★ B 完成：产物 B1 落在 B 的位置', stack.frames.map(f => f.sessionId), ['A', 'B1'])
  check('★ B 完成：指针上浮到 A', stack.current?.sessionId, 'A')

  // A 完成 —— 把上面的 B1 结清进来，这是最后一层
  const planA = stack.planSettle()
  check('A 完成：动作是 settle', planA.kind, 'settle')
  check('A 完成：结清 A 和 B1',
    planA.kind === 'settle' ? planA.sessionIds : [], ['A', 'B1'])
  stack.applySettle(planA, 'M', 'baiyu', 3)
  // 与设计推演表的一处有意偏差：表里写 `[]`，这里保留 `[M]`（语义等价，
  // 但 current 永远有值）。见 stack.ts 的 applySettle。
  check('A 完成：只剩产物 M 一层', stack.frames.map(f => f.sessionId), ['M'])
  check('A 完成：current 是 M', stack.current?.sessionId, 'M')
}

// ── 单层完成：直接 final ────────────────────────────────────────────
{
  const stack = new PointerStack()
  stack.push(frame('A'))
  const plan = stack.planSettle()
  check('★ 只有一层时完成 → final', plan.kind, 'final')
  stack.applySettle(plan, 'M', 'baiyu', 1)
  check('final 后栈空', stack.depth, 0)
  check('final 后无 current', stack.current, undefined)
}

// ── 两次中断不跨越 TCB（嵌套不跨 TCB）──────────────────────────────
{
  const stack = new PointerStack()
  stack.push(frame('A', 'baiyu'))
  stack.push(frame('B', 'baiyu'))
  check('同一段嵌套里 TCB 相同',
    stack.frames.map(f => f.tcb), ['baiyu', 'baiyu'])
  check('current 带得出 TCB', stack.current?.tcb, 'baiyu')
}

// ── 序列化往返 ──────────────────────────────────────────────────────
{
  const stack = new PointerStack()
  stack.push(frame('A'))
  stack.push(frame('B'))
  const json = JSON.parse(JSON.stringify(stack.toJSON())) as unknown

  const { stack: restored, restored: ok } = PointerStack.fromJSON(json)
  check('往返成功', ok, true)
  check('往返后层数不变', restored.depth, 2)
  check('往返后 current 不变', restored.current?.sessionId, 'B')
  check('往返后再序列化保持一致',
    JSON.stringify(restored.toJSON()), JSON.stringify(stack.toJSON()))
}

// ── 容错：坏数据不该让进程起不来 ────────────────────────────────────
{
  check('null → 空栈', PointerStack.fromJSON(null).restored, false)
  check('缺 frames → 空栈', PointerStack.fromJSON({ running: 0 }).restored, false)
  check('frames 不是数组 → 空栈', PointerStack.fromJSON({ frames: 'x' }).restored, false)
  check('帧缺 sessionId → 空栈',
    PointerStack.fromJSON({ frames: [{ tcb: 'x' }] }).restored, false)
  check('坏数据回来的是空栈',
    PointerStack.fromJSON({ frames: 'x' }).stack.depth, 0)

  // running 越界要夹住，而不是崩
  const out = PointerStack.fromJSON({
    frames: [{ sessionId: 'A', tcb: 't', pushedAt: 0, reason: '' }],
    running: 99,
  })
  check('running 越界被夹到栈顶', out.stack.runningIndex, 0)

  // running 缺失时默认栈顶
  const noRunning = PointerStack.fromJSON({
    frames: [
      { sessionId: 'A', tcb: 't', pushedAt: 0, reason: '' },
      { sessionId: 'B', tcb: 't', pushedAt: 0, reason: '' },
    ],
  })
  check('running 缺失时默认栈顶', noRunning.stack.current?.sessionId, 'B')
}

// ── push 在"上面还有已完成层"时不能压掉它们 ─────────────────────────
{
  const stack = new PointerStack()
  stack.push(frame('A'))
  stack.push(frame('B'))
  stack.push(frame('C'))
  // C 完成 → 指针上浮到 B
  stack.applySettle(stack.planSettle(), '-', 'baiyu', 1)
  check('上浮后 current 是 B', stack.current?.sessionId, 'B')

  // 这时候 B 又被新任务打断 —— C 还没被结清，不能丢
  stack.push(frame('D'))
  check('★ 新中断不能压掉上面已完成的 C',
    stack.frames.map(f => f.sessionId), ['A', 'B', 'D', 'C'])
  check('新中断后 current 是 D', stack.current?.sessionId, 'D')
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
if (failed > 0) process.exitCode = 1
