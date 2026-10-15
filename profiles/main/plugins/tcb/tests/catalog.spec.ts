/**
 * `catalog.ts` 的自检脚本。
 *
 * 跑法：
 * ```powershell
 * cd E:\project\PLOS\deepseek-harness
 * node --import tsx/esm E:\project\PLOS\PLOS_agent\profiles\main\plugins\tcb\tests\catalog.spec.ts
 * ```
 *
 * ## 这里重点验什么
 *
 * **坏配置必须响。** DSH 的规矩是 `Misconfiguration fails loud`——
 * 一个名字拼错的 TCB 如果静默退回默认，人就会以为"改了配置但没生效"，
 * 然后去查一个不存在的问题。
 *
 * 以及**照 `LlmCallConfig` 取模型参数**：可选字段缺失时留 `undefined`，
 * 不要编造默认值（默认值归 LLM 层管，两边各有一套默认必然漂）。
 *
 * @module tcb/catalog.spec
 */

import assert from 'node:assert/strict'
import { parseCatalog, resolveTcb } from '../catalog.ts'

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
 * 断言解析失败，且错误信息含某关键词。
 * @param label - 用例名。
 * @param raw - 输入。
 * @param pattern - 错误信息需匹配的正则。
 */
function checkBad(label: string, raw: unknown, pattern: RegExp): void {
  const result = parseCatalog(raw)
  if (result.ok) {
    failed += 1
    console.log(`  FAIL ${label}（本该失败却成功了）`)
    return
  }
  if (pattern.test(result.error)) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL ${label}`)
    console.log(`       期望匹配: ${String(pattern)}`)
    console.log(`       实际错误: ${result.error}`)
  }
}

/** 一份最小的合法目录。 */
function sample(): unknown {
  return {
    default: 'plos',
    tcbs: {
      plos: {
        model: { provider: 'deepseek-official', model: 'deepseek-flash', temperature: 0.9 },
        identity: 'data/identity/plos.md',
        sections: ['deployment:persona-prefix', 'tool:pwsh'],
      },
      reasoner: {
        model: { provider: 'deepseek-official', model: 'deepseek-reasoner', reasoningEffort: 'high' },
        sections: [],
      },
    },
  }
}

// ── 正常解析 ────────────────────────────────────────────────────────
{
  const result = parseCatalog(sample())
  check('合法目录解析成功', result.ok, true)
  if (result.ok) {
    check('默认 id', result.catalog.defaultId, 'plos')
    check('两个 TCB', [...result.catalog.tcbs.keys()], ['plos', 'reasoner'])
    check('模型字段照 LlmCallConfig',
      result.catalog.tcbs.get('plos')?.model,
      { provider: 'deepseek-official', model: 'deepseek-flash', temperature: 0.9,
        reasoningEffort: undefined, maxTokens: undefined, stop: undefined })
    check('人设路径', result.catalog.tcbs.get('plos')?.identity, 'data/identity/plos.md')
    check('白名单原样', result.catalog.tcbs.get('plos')?.sections,
      ['deployment:persona-prefix', 'tool:pwsh'])
    check('空白名单合法（一个段落都不给）', result.catalog.tcbs.get('reasoner')?.sections, [])
    check('没有 identity 也是合法的', result.catalog.tcbs.get('reasoner')?.identity, undefined)
  }
}

// ── resolveTcb ──────────────────────────────────────────────────────
{
  const result = parseCatalog(sample())
  if (result.ok) {
    check('省略 id 用默认', resolveTcb(result.catalog)?.id, 'plos')
    check('指定 id', resolveTcb(result.catalog, 'reasoner')?.id, 'reasoner')
    check('不存在的 id → undefined（不静默退回默认）',
      resolveTcb(result.catalog, '不存在'), undefined)
  }
}

// ── ★ 坏配置必须响 ─────────────────────────────────────────────────
{
  checkBad('顶层不是对象', null, /不是对象/)
  checkBad('缺 default', { tcbs: {} }, /default/)
  checkBad('default 是空串', { default: '', tcbs: {} }, /default/)
  checkBad('缺 tcbs', { default: 'a' }, /tcbs/)

  const noModel = { default: 'a', tcbs: { a: { sections: [] } } }
  checkBad('缺 model', noModel, /缺少 "model"/)

  const noProvider = { default: 'a', tcbs: { a: { model: { model: 'x' }, sections: [] } } }
  checkBad('model.provider 缺失', noProvider, /provider/)

  const noName = { default: 'a', tcbs: { a: { model: { provider: 'p' }, sections: [] } } }
  checkBad('model.model 缺失', noName, /model\.model/)

  const noSections = { default: 'a', tcbs: { a: { model: { provider: 'p', model: 'm' } } } }
  checkBad('缺 sections', noSections, /sections/)

  const badSections = { default: 'a', tcbs: { a: { model: { provider: 'p', model: 'm' }, sections: [1] } } }
  checkBad('sections 里不是字符串', badSections, /字符串数组/)

  const badIdentity = { default: 'a', tcbs: { a: { model: { provider: 'p', model: 'm' }, sections: [], identity: 7 } } }
  checkBad('identity 不是字符串', badIdentity, /identity/)

  // ★ 最容易犯的错：default 指向一个不存在的 TCB
  const danglingDefault = {
    default: 'typo',
    tcbs: { plos: { model: { provider: 'p', model: 'm' }, sections: [] } },
  }
  checkBad('★ default 指向不存在的 TCB', danglingDefault, /默认 TCB "typo" 不在/)
}

// ── 边界：空目录 ────────────────────────────────────────────────────
{
  checkBad('tcbs 为空对象但 default 不在 → 报错',
    { default: 'x', tcbs: {} }, /默认 TCB "x" 不在/)
  const ok = parseCatalog({ default: 'x', tcbs: { x: { model: { provider: 'p', model: 'm' }, sections: [] } } })
  check('只有一个 TCB 是合法的', ok.ok, true)
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
if (failed > 0) process.exitCode = 1
