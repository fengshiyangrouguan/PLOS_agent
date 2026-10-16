/**
 * `tcb.example.json`（**进版本库的骨架** ✓）与真实 `data/tcb.json` 的一致性。
 *
 * ## 为什么需要它
 *
 * ★★ `data/` 整个目录**被 gitignore** ✗ ⇒ ★ 换机器／重装时，仓库里**没有** `data/tcb.json` ✓。
 * ★ 而 `tcb` 的 `sections` 是**白名单** ✗ —— 名单里没有的段**一律被滤掉** ✓✓。
 *
 * ⇒ ★★★ 后果很隐蔽 ✓：★ 我们的**工具包说明**是一个 section（名字 `tool-packages` ✓）
 *   ⇒ ★ 名单里漏了它 ⇒ ★ **那段说明进不了提示词** ✗
 *   ⇒ ★★ 而包里的工具**又不在 `tools` 里** ✗（★ 那正是工具包的设计 ✓）
 *   ⇒ ★★★ **那些能力对她等于不存在** ✗✗
 *   ★ 而**全程不报错** ✗ —— 只表现为"她不知道有这些能力" ✓。
 *
 * ## 这条自检做什么
 *
 * ★ 把**模板的段名列表**与**真实配置的段名列表**逐字比对 ✓ ——
 * ★ 谁加了段而忘了更新模板，这里就红 ✓。
 *
 * ⚠️ `data/tcb.json` **可能不存在**（★ 新 clone 的机器 ✓）⇒ ★ **跳过**，**不算失败** ✓
 *   （★ 那正是模板存在的意义 ✓ —— 自检不该在"还没铺配置"的机器上失败 ✓）。
 */

import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

/**
 * ★★ **用 `import.meta.url` 定位，不用相对 cwd** ✗ ——
 * spec 是**从 `deepseek-harness` 目录**跑的（`scripts/check.ps1:85` ✓），
 * ★ 相对路径会指到那边去 ✓。
 *
 * ⚠️ 而且**必须过 `fileURLToPath`** ✗ —— ★ 直接读 `url.pathname` 在 Windows 上给出
 * `/E:/…` ✓，再拼一次就成了 `E:\E:\…` ✗（实测踩过 ✓）。
 *
 * 本文件在 `profiles/main/plugins/tcb/tests/` ⇒ ★ 往上三级是 `profiles/main/` ✓。
 */
const PROFILE_DIR = fileURLToPath(new URL('../../../', import.meta.url))

/** 仓库内的模板（★ 进版本库 ✓）。 */
const TEMPLATE = path.join(PROFILE_DIR, 'tcb.example.json')

/** 真实配置（★ gitignored ✓ —— 可能不存在 ✓）。`profiles/main/` 再上两级是 `$DSH_HOME` ✓。 */
const ACTUAL = path.resolve(PROFILE_DIR, '..', '..', 'data', 'tcb.json')

let passed = 0
let failed = 0

/**
 * 跑一条断言。
 * @param label - 说明。
 * @param fn - 断言体；抛错即失败。
 */
function check(label: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`  ✓ ${label}`)
  } catch (error) {
    failed += 1
    console.log(`  ✗ ${label}\n      ${error instanceof Error ? error.message : String(error)}`)
  }
}

interface TcbFile {
  readonly default?: string
  readonly tcbs?: Record<string, { readonly sections?: readonly string[] }>
}

const template = JSON.parse(readFileSync(TEMPLATE, 'utf8')) as TcbFile

// ── ★ 模板自身的性质（不需要真实配置 ✓）───────────────────────────
check('★ 模板存在且是合法 JSON ✓', () => {
  assert.equal(typeof template.default, 'string')
  assert.ok(template.tcbs !== undefined)
})

check('★★ 模板里 `main.sections` **含 `tool-packages`** ✓（★ 漏了那段包说明就进不去 ✗）', () => {
  const sections = template.tcbs?.main?.sections ?? []
  assert.ok(sections.includes('tool-packages'), `实际：${sections.join(', ')}`)
})

check('★ 模板里三个 TCB 都在（main / vlm / planner ✓）', () => {
  const names = Object.keys(template.tcbs ?? {}).sort()
  assert.deepEqual(names, ['main', 'planner', 'vlm'])
})

check('★★ 模板的 `identity` 是**占位符** ✓（★ 真实人设路径是私密的，不该进版本库 ✗）', () => {
  const text = JSON.stringify(template)
  assert.ok(text.includes('YOUR-PERSONA.md'), '该用占位符 ✓')
  assert.ok(!text.includes('shiraha'), '★ 不许出现那个代号 ✗（仓库硬规矩 ✓）')
})

// ── ★★ 与真实配置的一致性（文件在才比 ✓）─────────────────────────
if (!existsSync(ACTUAL)) {
  console.log(`\n  ⚠ ${ACTUAL} 不存在 ⇒ ★ **跳过一致性比对** ✓`)
  console.log('    （★ 新机器正是这种状态：★ 把模板拷成它、改好 identity 即可 ✓）')
} else {
  const actual = JSON.parse(readFileSync(ACTUAL, 'utf8')) as TcbFile

  check('★★ `main.sections` 逐字一致 ✓（★ 这就是这次要防的那个静默滤掉 ✗）', () => {
    const want = actual.tcbs?.main?.sections ?? []
    const have = template.tcbs?.main?.sections ?? []
    // ★ 用排序后的集合比 —— 顺序不影响白名单语义 ✓，但**缺一个就是缺一个** ✗。
    assert.deepEqual(
      [...have].sort(),
      [...want].sort(),
      `模板缺：${want.filter(name => !have.includes(name)).join(', ') || '（无）'}；`
      + `模板多：${have.filter(name => !want.includes(name)).join(', ') || '（无）'}`,
    )
  })

  check('★ `default` 一致 ✓', () => {
    assert.equal(template.default, actual.default)
  })

  check('★ 模板给了 `vlm` 一把模型 ✓（★ 图转文要用 ✓）', () => {
    const models = (template.tcbs?.vlm as { models?: unknown[] } | undefined)?.models ?? []
    assert.ok(models.length > 0)
  })

  check('★ 真实 `main.sections` 里没有**模板不知道**的段 ✓（★ 反向也要防 ✓）', () => {
    const want = actual.tcbs?.main?.sections ?? []
    const have = template.tcbs?.main?.sections ?? []
    const unknown = want.filter(name => !have.includes(name))
    assert.deepEqual(unknown, [], `真实配置里有而模板没有：${unknown.join(', ')}`)
  })
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
