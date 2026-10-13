/**
 * `schema.ts` + `stores.ts` 的自检脚本。
 *
 * 跑法（和其它 spec 一样，从 deepseek-harness 跑——tsx 装在那里）：
 * ```powershell
 * cd E:\project\PLOS\deepseek-harness
 * node --import tsx/esm E:\project\PLOS\PLOS_agent\profiles\main\plugins\db\tests\db.spec.ts
 * ```
 *
 * 能这么跑是因为 `schema.ts` / `stores.ts` **不认识 cordis** ——
 * 只吃一个 `DatabaseSync`，所以能用内存库离线验证。
 *
 * ## 这里重点验什么
 *
 * 1. **迁移**：幂等、版本推进、**库比代码新时要报错而不是降级**
 *    （Shiraha_OS 的教训：没有迁移，字段演进静默丢数据）
 * 2. **搜索的区间合并**：这是设计 §7.3 最细的一条 ——
 *    命中靠得近时区间重合，**必须合并**，否则同一段消息返回两遍
 * 3. **单行约束**：会话指针表出现两行就是 bug，`CHECK (id = 1)` 要挡住
 *
 * @module db/spec
 */

import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { LATEST_VERSION, currentVersion, migrate } from '../schema.ts'
import { DEFAULT_CONTEXT, MessageStore, PerceptionStore } from '../stores.ts'

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

/** 断言抛错。
 * @param label - 用例名。
 * @param fn - 应当抛错的函数。
 * @param pattern - 错误信息需匹配的正则。
 */
function checkThrows(label: string, fn: () => void, pattern: RegExp): void {
  try {
    fn()
    failed += 1
    console.log(`  FAIL ${label}（没有抛错）`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (pattern.test(message)) {
      passed += 1
      console.log(`  ok   ${label}`)
    } else {
      failed += 1
      console.log(`  FAIL ${label}`)
      console.log(`       期望匹配: ${String(pattern)}`)
      console.log(`       实际错误: ${message}`)
    }
  }
}

/** 开一个已迁移的内存库。 */
function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  migrate(db)
  return db
}

/** 造一条消息。
 * @param id - 消息 id。
 * @param time - 时间戳。
 * @param content - 文本。
 * @param conversationId - 会话 id。
 */
function msg(id: string, time: number, content: string, conversationId = 'group:a') {
  return {
    platform: 'qq',
    messageId: id,
    conversationId,
    conversationType: 'group',
    conversationName: '测试群',
    senderId: 'u1',
    senderName: '张三',
    time,
    content,
  }
}

// ── 迁移 ────────────────────────────────────────────────────────────
{
  const db = new DatabaseSync(':memory:')
  check('新库版本为 0', currentVersion(db), 0)

  const first = migrate(db)
  check('首次迁移从 0 开始', first.from, 0)
  check('首次迁移到最新版', first.to, LATEST_VERSION)
  check('首次迁移应用了 1 条', first.applied.length, 1)
  check('版本号已写入', currentVersion(db), LATEST_VERSION)

  const second = migrate(db)
  check('重复迁移不做事', second.applied.length, 0)
  check('重复迁移版本不变', second.to, LATEST_VERSION)

  db.exec(`PRAGMA user_version = ${String(LATEST_VERSION + 5)}`)
  checkThrows('库比代码新时报错（不降级）', () => { migrate(db) }, /高于本构建已知的/)

  db.close()
}

// ── 表真的建出来了 ──────────────────────────────────────────────────
{
  const db = freshDb()
  const names = (db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all() as { name: string }[]).map(row => row.name)
  check('三张表都在', names, ['events', 'messages', 'perception_history'])

  // events 照搬 Shiraha：两条外键降级为普通列（不能有 FOREIGN KEY 约束）。
  const ddl = (db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'events'",
  ).get() as { sql: string }).sql
  check('events 没有外键约束', /FOREIGN KEY/i.test(ddl), false)
  check('events 保留了 conversation_id 列', /conversation_id/.test(ddl), true)
  check('events 保留了 user_id 列', /user_id/.test(ddl), true)
  db.close()
}

// ── 消息存档 ────────────────────────────────────────────────────────
{
  const db = freshDb()
  const store = new MessageStore(db)
  store.insert(msg('m1', 1000, '早安'))
  store.insert(msg('m2', 1001, '今天天气不错'))
  check('插入两条', store.count(), 2)

  store.insert(msg('m2', 1001, '今天天气不错（改）'))
  check('同 id 覆盖而非新增', store.count(), 2)

  store.insert({ ...msg('m3', 1002, '在别的群'), conversationId: 'group:b' })
  check('跨会话不冲突', store.count(), 3)
  db.close()
}

// ── 搜索：区间与合并（设计 §7.3 的核心） ────────────────────────────
{
  const db = freshDb()
  const store = new MessageStore(db)
  // 造 50 条，time 1000..1049，每 10 条里有一条带关键词
  for (let i = 0; i < 50; i += 1) {
    const mark = i === 25 ? ' 关键词' : ''
    store.insert(msg(`m${String(i)}`, 1000 + i, `第${String(i)}条${mark}`))
  }

  const one = store.search({ query: '关键词' })
  check('命中 1 条', one.hits, 1)
  check('合并后 1 个区间', one.ranges.length, 1)
  // 命中在 i=25；上下各 10 条 → i=15..35，共 21 条
  check('区间长度 = 上下各 10 + 命中自身', one.ranges[0]?.messages.length, 2 * DEFAULT_CONTEXT + 1)
  check('区间起点', one.ranges[0]?.messages[0]?.time, 1015)
  check('区间终点', one.ranges[0]?.messages.at(-1)?.time, 1035)
  check('命中 id 被标出', one.ranges[0]?.hitIds, ['m25'])
  check('未截断', one.truncated, false)

  // 两条命中靠得近 → 区间重合，必须合并成一段
  store.insert(msg('m28', 1028, '又一个 关键词'))
  const two = store.search({ query: '关键词' })
  check('命中 2 条', two.hits, 2)
  check('重合区间合并成 1 段', two.ranges.length, 1)
  // [1015,1035] ∪ [1018,1038] = [1015,1038] → 24 条
  check('合并后区间 = 并集', two.ranges[0]?.messages.length, 24)
  check('合并后起点取较早', two.ranges[0]?.messages[0]?.time, 1015)
  check('合并后终点取较晚', two.ranges[0]?.messages.at(-1)?.time, 1038)
  check('两个命中 id 都在', [...(two.ranges[0]?.hitIds ?? [])].sort(), ['m25', 'm28'])

  // 命中条数上限
  const limited = store.search({ query: '关键词', hitLimit: 1 })
  check('hitLimit 生效', limited.hits, 1)

  // 时间范围（"最近多久"的可选项）。命中在 1025 和 1028，从 1026 起只剩后者。
  const recent = store.search({ query: '关键词', since: 1026 })
  check('since 过滤掉了较早的命中', recent.hits, 1)
  check('剩下的是较晚那条', recent.ranges[0]?.hitIds, ['m28'])

  // 总量上限 → 截断并注明
  const capped = store.search({ query: '关键词', maxMessages: 5 })
  check('超上限被截断', capped.truncated, true)
  check('截断后不超过上限', capped.ranges[0]?.messages.length, 5)

  // 限定会话
  store.insert({ ...msg('b1', 1025, '别的群也有关键词'), conversationId: 'group:b' })
  const scoped = store.search({ query: '关键词', conversationId: 'group:b' })
  check('限定会话只拿到该会话', scoped.ranges.length, 1)
  check('限定会话内容正确', scoped.ranges[0]?.conversationId, 'group:b')

  // 无命中
  check('查不到时返回空', store.search({ query: '绝对不存在的词' }).ranges, [])
  db.close()
}

// ── 感知历史 ────────────────────────────────────────────────────────
{
  const db = freshDb()
  const store = new PerceptionStore(db)
  store.record({ time: 100, domain: 'qq', source: 'group:a', summary: '有人 @ 了你' })
  store.record({ time: 200, domain: 'news', source: 'feed', summary: '3 条新推送' })

  const recent = store.recent()
  check('最近两条，时间降序', recent.map(r => r.domain), ['news', 'qq'])
  check('默认未拉取', recent[0]?.pulled, false)

  store.markPulled([recent[0]!.id])
  check('标记后已拉取', store.recent()[0]?.pulled, true)
  check('未标记的仍是未拉取', store.recent()[1]?.pulled, false)
  db.close()
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
if (failed > 0) process.exitCode = 1
