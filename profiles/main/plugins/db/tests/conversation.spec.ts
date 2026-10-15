/**
 * `ConversationStore` 的自检 —— 会话元信息（**通用**：群／私聊一视同仁 ✓）。
 *
 * 跑法（和其它 spec 一样，从 `deepseek-harness` 跑 —— tsx 装在那里）：
 * ```powershell
 * cd E:\project\PLOS\deepseek-harness
 * node --import tsx/esm E:\project\PLOS\PLOS_agent\profiles\main\plugins\db\tests\conversation.spec.ts
 * ```
 *
 * ## 为什么要有它
 *
 * ★★ 通知帧里**只有 `group_id`、没有群名** ✗（实测 ✓），而感知层的模板到处用 `{name}` ✓，
 * 且**渲染器取不到字段会抛错**（`perception/render.ts:74` ✓）⇒
 * ★ 所以"能不能问出名字"是信号层能不能成立的前提 ✓。
 *
 * ## 这里重点验什么
 *
 * 1. ★★ **没有名字时 `name` 是 `undefined`，不是空串、不是编造的兜底** ✓ ——
 *    兜底是**用的人**的事（感知层填 `群<id>` ✓）；store 编造了，别人就分不出真假 ✗
 * 2. ★ **群名改过 ⇒ 取最近一条非空的名字** ✓（老消息里的旧名字不该赢 ✗）
 * 3. ★ **中间有 `NULL` 名字的消息不该把已有的名字顶掉** ✓（`conversation_name` 是 nullable ✓）
 * 4. 未知会话给 `undefined`（不是空对象 ✗）
 * 5. `recent()` 按最后一条消息的时间倒序 ✓
 *
 * ★ 纯 SQL 逻辑 ⇒ 用**内存库**离线验 ✓（`schema.ts` / `stores.ts` 都不认识 cordis ✓）。
 *
 * @module db/conversation-spec
 */

import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { migrate } from '../schema.ts'
import { ConversationStore } from '../stores.ts'

let passed = 0
let failed = 0

/**
 * 跑一个断言。
 *
 * @param label - 说明。
 * @param fn - 断言体（用 `assert` ✓，抛错即失败 ✓）。
 */
function check(label: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`  ok   ${label}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${label}`)
    console.log(`       ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 一条要写进库的消息。 */
interface Row {
  readonly id: string
  readonly type: string
  /** ★ `null` = 这一条没有名字（nullable 列 ✓）。 */
  readonly name: string | null
  readonly time: number
  readonly messageId: string
}

/**
 * 建一个装了这些消息的内存库。
 *
 * @param rows - 消息。
 * @returns 可查询的 store。
 */
function makeStore(rows: readonly Row[]): ConversationStore {
  const handle = new DatabaseSync(':memory:')
  migrate(handle)
  const insert = handle.prepare(
    `INSERT INTO messages
       (platform, message_id, conversation_id, conversation_type, conversation_name,
        sender_id, sender_name, time, content)
     VALUES ('qq', ?, ?, ?, ?, '1', 'somebody', ?, 'hello')`,
  )
  for (const row of rows) {
    insert.run(row.messageId, row.id, row.type, row.name, row.time)
  }
  return new ConversationStore(handle)
}

// ── 1. 有名字 / 没名字 ────────────────────────────────────────────────
check('有名字的会话能查出来（id / type / name / lastTime 都对）', () => {
  const store = makeStore([
    { id: 'group:100', type: 'group', name: '测试群', time: 1000, messageId: 'm1' },
  ])
  assert.deepEqual(store.get('group:100'), {
    id: 'group:100', type: 'group', name: '测试群', lastTime: 1000,
  })
})

check('★★ 没有名字时 `name` 是 **undefined**（不编造兜底 ✗、不是空串 ✗）', () => {
  const store = makeStore([
    { id: 'private:9', type: 'private', name: null, time: 500, messageId: 'm1' },
  ])
  const info = store.get('private:9')
  assert.ok(info !== undefined)
  assert.equal('name' in info, false)
  assert.equal(info.name, undefined)
})

check('未知会话 ⇒ **undefined**（不是空对象 ✗）', () => {
  const store = makeStore([
    { id: 'group:100', type: 'group', name: '测试群', time: 1000, messageId: 'm1' },
  ])
  assert.equal(store.get('group:999'), undefined)
})

check('空库 ⇒ 未知会话也是 undefined', () => {
  assert.equal(makeStore([]).get('group:1'), undefined)
})

// ── 2. 名字的取法 ────────────────────────────────────────────────────
check('★ 群名改过 ⇒ 取**最近**一条非空的名字（老的旧名字不该赢 ✗）', () => {
  const store = makeStore([
    { id: 'group:100', type: 'group', name: '老名字', time: 1000, messageId: 'm1' },
    { id: 'group:100', type: 'group', name: '新名字', time: 2000, messageId: 'm2' },
  ])
  assert.equal(store.get('group:100')?.name, '新名字')
})

check('★ 中间夹着 NULL 名字的消息，**不该把已有的名字顶掉** ✓', () => {
  const store = makeStore([
    { id: 'group:100', type: 'group', name: '真名字', time: 1000, messageId: 'm1' },
    { id: 'group:100', type: 'group', name: null, time: 2000, messageId: 'm2' },
    { id: 'group:100', type: 'group', name: null, time: 3000, messageId: 'm3' },
  ])
  assert.equal(store.get('group:100')?.name, '真名字')
  assert.equal(store.get('group:100')?.lastTime, 3000)
})

check('★ 空串名字等同于"没有名字"（`<> \'\'` ✓）', () => {
  const store = makeStore([
    { id: 'group:100', type: 'group', name: '', time: 1000, messageId: 'm1' },
  ])
  assert.equal(store.get('group:100')?.name, undefined)
})

check('lastTime 取**最大**的时间（消息不一定按序插入 ✓）', () => {
  const store = makeStore([
    { id: 'group:100', type: 'group', name: 'x', time: 3000, messageId: 'm1' },
    { id: 'group:100', type: 'group', name: 'x', time: 1000, messageId: 'm2' },
  ])
  assert.equal(store.get('group:100')?.lastTime, 3000)
})

// ── 3. recent() ─────────────────────────────────────────────────────
check('recent() 按最后一条消息的时间**倒序** ✓', () => {
  const store = makeStore([
    { id: 'group:1', type: 'group', name: '最早', time: 100, messageId: 'a1' },
    { id: 'group:2', type: 'private', name: null, time: 300, messageId: 'b1' },
    { id: 'group:3', type: 'group', name: '中间', time: 200, messageId: 'c1' },
  ])
  assert.deepEqual(store.recent().map(item => item.id), ['group:2', 'group:3', 'group:1'])
})

check('recent() 里**没名字的那些也不编造** ✓', () => {
  const store = makeStore([
    { id: 'group:1', type: 'group', name: null, time: 100, messageId: 'a1' },
  ])
  const [first] = store.recent()
  assert.ok(first !== undefined)
  assert.equal(first.name, undefined)
})

check('recent(limit) 会截断 ✓', () => {
  const store = makeStore([
    { id: 'group:1', type: 'group', name: 'a', time: 100, messageId: 'a1' },
    { id: 'group:2', type: 'group', name: 'b', time: 200, messageId: 'b1' },
    { id: 'group:3', type: 'group', name: 'c', time: 300, messageId: 'c1' },
  ])
  assert.equal(store.recent(2).length, 2)
  assert.deepEqual(store.recent(2).map(item => item.id), ['group:3', 'group:2'])
})

console.log(`\n通过 ${passed}，失败 ${failed}`)
if (failed > 0) process.exitCode = 1
