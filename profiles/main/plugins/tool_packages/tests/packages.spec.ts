/**
 * `packages.ts` 的自检 —— 工具包的清单与"该藏哪些"。
 *
 * 跑法（和其它 spec 一样，从 `deepseek-harness` 跑）：
 * ```powershell
 * cd E:\project\PLOS\deepseek-harness
 * node --import tsx/esm E:\project\PLOS\PLOS_agent\profiles\main\plugins\tool_packages\tests\packages.spec.ts
 * ```
 *
 * ## 这里重点验什么
 *
 * 1. ★★★ **每个包里的工具名都真实存在** —— 拼错一个就等于**静默少一个工具** ✗，
 *    而那种 bug 不报错、只是"她少了个能力" ✓。★ 基准是**探针抓到的真实工具表** ✓
 *    （2026-10-16 10:24，49 个 ✓，见 `PLOS/docs/todo-2026-10-15.md` §五 ✓）。
 * 2. ★★ **49 个工具一个不落** —— 包里 ✓ ＋ 卸载 ✓ ＋ 留日常 ✓ ＋ 查找工具 ✓
 * 3. ★★ **卸载的 4 个不在任何包里** ✓（否则"卸载"就名不副实 ✗）
 * 4. ★ `hiddenTools` 的四种情形 ✓（卸载／未取用／已取用／日常 ✓）
 * 5. ★★ **说明文本稳定** ✓（★ 缓存靠前缀稳定 ✓ —— 两次调用必须逐字相同 ✓）
 *
 * @module tool_packages/spec
 */

import assert from 'node:assert/strict'
import {
  FIND_TOOLS_NAME,
  TOOL_PACKAGES,
  UNINSTALLED_TOOLS,
  hiddenTools,
  packageOf,
  packagesSectionText,
} from '../packages.ts'

let passed = 0
let failed = 0

/**
 * 跑一个断言。
 *
 * @param label - 说明。
 * @param fn - 断言体。
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

/**
 * ★★ **真实工具表的基准** —— 探针 2026-10-16 10:24 抓到的 49 个 ✓（逐字照抄 ✓）。
 *
 * ★ 它是"她当时真实有的工具" ✓ —— 不是我想象的 ✗。
 */
const REAL_TOOL_TABLE: readonly string[] = [
  'create_goal', 'edit', 'exit_plan_mode', 'get_goal', 'glob', 'grep', 'interrupt_agent',
  'job_kill', 'job_list', 'job_output', 'list_agents', 'pwsh',
  'qq_approve_friend', 'qq_approve_group', 'qq_chats', 'qq_group_muted', 'qq_group_requests',
  'qq_list_group_members', 'qq_qzone_comment', 'qq_qzone_feeds', 'qq_qzone_like', 'qq_qzone_list',
  'qq_qzone_post', 'qq_read', 'qq_read_message', 'qq_recall_message', 'qq_search', 'qq_send_image',
  'qq_send_message', 'qq_set_group_ban', 'qq_wait_message',
  'read', 'read_image', 'send_message',
  'session_event_read', 'session_event_search', 'session_event_trace', 'session_search', 'session_trace',
  'set_idle_wake_interval', 'skill', 'subagent', 'subagent_fork', 'todo_write', 'update_goal',
  'web_fetch', 'web_search', 'workflow', 'write',
]

/** ★ 留日常的 17 个（用户定案 ✓）。 */
const DAILY: readonly string[] = [
  'qq_send_message', 'qq_send_image', 'qq_recall_message', 'qq_read', 'qq_chats',
  'qq_search', 'qq_wait_message', 'read', 'write', 'edit', 'glob', 'grep',
  'web_search', 'web_fetch', 'pwsh', 'skill', 'set_idle_wake_interval',
]

const packaged = TOOL_PACKAGES.flatMap(item => item.tools)

// ── ★★★ 名字核对（最重要的一条 ✓）────────────────────────────────
check('★★★ 每个包里的工具名**都真实存在**（拼错＝静默少一个 ✗）', () => {
  const missing = packaged.filter(name => !REAL_TOOL_TABLE.includes(name))
  assert.deepEqual(missing, [], `不存在的工具名：${missing.join(', ')}`)
})

check('★★ 卸载的 4 个**也真实存在**（否则说明抄错了 ✓）', () => {
  const missing = UNINSTALLED_TOOLS.filter(name => !REAL_TOOL_TABLE.includes(name))
  assert.deepEqual(missing, [], `不存在：${missing.join(', ')}`)
})

check('★★ 留日常的 17 个**也真实存在**', () => {
  const missing = DAILY.filter(name => !REAL_TOOL_TABLE.includes(name))
  assert.deepEqual(missing, [], `不存在：${missing.join(', ')}`)
})

// ── ★★ 覆盖（49 个一个不落 ✓）──────────────────────────────────
check('★★ 49 个工具**一个不落**（包里 ＋ 卸载 ＋ 日常 ＋ 查找工具）', () => {
  const covered = new Set([...packaged, ...UNINSTALLED_TOOLS, ...DAILY, FIND_TOOLS_NAME])
  const uncovered = REAL_TOOL_TABLE.filter(name => !covered.has(name))
  assert.deepEqual(uncovered, [], `没被归类的：${uncovered.join(', ')}`)
})

check('★★ 没有重复归类（一个工具只属于一类）', () => {
  const all = [...packaged, ...UNINSTALLED_TOOLS, ...DAILY]
  const duplicated = all.filter((name, index) => all.indexOf(name) !== index)
  assert.deepEqual([...new Set(duplicated)], [], `重复：${duplicated.join(', ')}`)
})

check('★★ 卸载的 4 个**不在任何包里**（否则"卸载"名不副实 ✗）', () => {
  const leaked = UNINSTALLED_TOOLS.filter(name => packaged.includes(name))
  assert.deepEqual(leaked, [])
})

check('★ 账目对上：28 进包 ＋ 4 卸载 ＋ 17 日常 ＋ 1 查找 = 50', () => {
  assert.equal(packaged.length, 28)
  assert.equal(UNINSTALLED_TOOLS.length, 4)
  assert.equal(DAILY.length, 17)
  assert.equal(REAL_TOOL_TABLE.length + 1, 50)
})

// ── 包本身 ───────────────────────────────────────────────────────
check('七个包：qzone / group-admin / requests / agents / jobs / memory / misc', () => {
  assert.deepEqual(
    TOOL_PACKAGES.map(item => item.name).sort(),
    ['agents', 'group-admin', 'jobs', 'memory', 'misc', 'qzone', 'requests'],
  )
})

check('★ 包名唯一', () => {
  const names = TOOL_PACKAGES.map(item => item.name)
  assert.equal(new Set(names).size, names.length)
})

check('★ 每个包都有说明与适用范围（否则那段 section 会有空行 ✗）', () => {
  for (const item of TOOL_PACKAGES) {
    assert.ok(item.summary.length > 0, `${item.name} 缺 summary`)
    assert.ok(item.when.length > 0, `${item.name} 缺 when`)
    assert.ok(item.tools.length > 0, `${item.name} 是空包`)
  }
})

check('★ `packageOf` 认名字、也老实说不认识', () => {
  assert.equal(packageOf('qzone')?.tools.length, 5)
  assert.equal(packageOf('nope'), undefined)
})

// ── hiddenTools 的四种情形 ───────────────────────────────────────
check('★ 一个包都没取 ⇒ 包里的全藏 ＋ 卸载的全藏', () => {
  const hidden = hiddenTools(new Set())
  assert.ok(hidden.has('qq_qzone_post'), '包里的该藏')
  assert.ok(hidden.has('create_goal'), '卸载的该藏')
  assert.ok(!hidden.has('qq_send_message'), '日常的不该藏 ✓')
  assert.ok(!hidden.has(FIND_TOOLS_NAME), '★ 查找工具自己**永远可见** ✓')
  assert.equal(hidden.size, 32, '28 包内 ＋ 4 卸载 = 32 ✓')
})

check('★ 取了 qzone ⇒ 那 5 个**不藏**（加回来了 ✓），别的包照样藏', () => {
  const hidden = hiddenTools(new Set(['qzone']))
  assert.ok(!hidden.has('qq_qzone_post'), '取过的该可见 ✓')
  assert.ok(hidden.has('qq_approve_friend'), '没取的照样藏 ✓')
  assert.equal(hidden.size, 27, '32 − 5 = 27 ✓')
})

check('★ 取多个包 ⇒ 各自的 5＋3 都放出来', () => {
  const hidden = hiddenTools(new Set(['qzone', 'requests']))
  assert.ok(!hidden.has('qq_qzone_post'))
  assert.ok(!hidden.has('qq_approve_friend'))
  assert.equal(hidden.size, 24, '32 − 8 = 24 ✓')
})

check('★★ 卸载的**任何情况都不放出来**（取包也不行 ✓）', () => {
  const scenarios: readonly ReadonlySet<string>[] = [
    new Set<string>(),
    new Set(['qzone']),
    new Set(TOOL_PACKAGES.map(item => item.name)),
  ]
  for (const active of scenarios) {
    const hidden = hiddenTools(active)
    for (const name of UNINSTALLED_TOOLS) {
      assert.ok(hidden.has(name), `${name} 在 active=${[...active].join(',')} 时被放出来了 ✗`)
    }
  }
})

check('★★ 取**全部**包 ⇒ 只剩卸载的 4 个被藏', () => {
  const hidden = hiddenTools(new Set(TOOL_PACKAGES.map(item => item.name)))
  assert.equal(hidden.size, 4)
  assert.deepEqual([...hidden].sort(), [...UNINSTALLED_TOOLS].sort())
})

// ── 说明文本 ─────────────────────────────────────────────────────
check('★★ 说明文本**稳定**（两次调用逐字相同 —— 缓存靠这个 ✓）', () => {
  assert.equal(packagesSectionText(), packagesSectionText())
})

check('★ 说明里列出**每个**包名（漏一个她就不知道有那个包 ✗）', () => {
  const text = packagesSectionText()
  for (const item of TOOL_PACKAGES) {
    assert.ok(text.includes(item.name), `说明里没有包名 ${item.name}`)
  }
})

check('★ 说明里写了**每个包的工具名**（她要看出里面有什么 ✓）', () => {
  const text = packagesSectionText()
  for (const name of packaged) {
    assert.ok(text.includes(name), `说明里没有工具名 ${name}`)
  }
})

check('★★ 措辞是"按需取用"而不是"我有"（★ 因为平时不在工具表里 ✗）', () => {
  const text = packagesSectionText()
  assert.ok(text.includes(FIND_TOOLS_NAME), '要告诉她用哪个工具取 ✓')
  assert.ok(text.includes('取用'), '要有"取用"这个说法 ✓')
})

check('★ 说明里**不含**动态内容（"取过哪些包"由查找工具的返回值表达 ✓）', () => {
  const text = packagesSectionText()
  assert.ok(!text.includes('已取'), '不该写"已取用"之类的动态状态 ✓')
  assert.ok(!text.includes('当前'), '不该写"当前" ✓')
})

console.log(`\n通过 ${passed}，失败 ${failed}`)
if (failed > 0) process.exitCode = 1
