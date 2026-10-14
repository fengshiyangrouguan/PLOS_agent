/**
 * `vlm2text/describe.ts` 的自检脚本。
 *
 * 跑法（和其它 spec 一样，从 deepseek-harness 跑 —— tsx 装在那里）：
 * ```powershell
 * cd E:\project\PLOS\deepseek-harness
 * node --import tsx/esm E:\project\PLOS\PLOS_agent\profiles\main\plugins\vlm2text\tests\describe.spec.ts
 * ```
 *
 * 能这么跑是因为 `describe.ts` **不认识 cordis** —— 它只吃一个缓存接口和一个
 * "调 VLM"的函数。缓存用的是**真的** `ImageDescriptionStore`（内存库 + 真迁移），
 * 不是替身；只有 VLM 那一步是替身（那本来就要花钱）。
 *
 * ## 这里重点验什么
 *
 * `m6.md` 定的三条不变量，每一条都有对应用例：
 *
 * 1. **只缓存成功** —— 失败 / 空描述 / 截断的描述都**不写行**
 * 2. **★ 失败之后同一张图会自动重试**（这是"不写行"的目的，不是副作用）
 * 3. **失败要报具体内容** —— 不是一句"失败了"
 *
 * @module vlm2text/spec
 */

import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { migrate } from '../../db/schema.ts'
import { ImageDescriptionStore } from '../../db/stores.ts'
import {
  acceptedMediaType,
  cacheKeyOf,
  decodeBase64,
  describeError,
  describeWithCache,
  type DescribeDeps,
  type DescriptionCache,
  type DescribeResult,
} from '../describe.ts'

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

/** 一张假图的 base64（内容任意 —— 只有替身 VLM 会"看"它）。 */
const B64 = Buffer.from('not-really-a-png').toString('base64')
/** 另一张假图。 */
const OTHER_B64 = Buffer.from('a-different-image').toString('base64')

/**
 * 某张图的缓存键（解不出字节时退化成空字节的哈希，用来把失败说清楚）。
 * @param base64 - base64 文本。
 * @returns 十六进制 sha256。
 */
function keyOf(base64: string): string {
  return cacheKeyOf(decodeBase64(base64) ?? new Uint8Array())
}

/** 一次成功描述。 */
const OK: DescribeResult = { text: '一只橘猫趴在键盘上', provider: 'siliconflow', model: 'qwen3-vl', cacheable: true }

/** 测试环境。 */
interface Harness {
  readonly deps: DescribeDeps
  readonly store: ImageDescriptionStore
  /** 调了几次 VLM。 */
  calls: () => number
  /** 换掉下一次 VLM 的行为。 */
  setNext: (next: () => Promise<DescribeResult>) => void
  /** 收到的日志。 */
  logs: () => string[]
  /** 关掉底层库。 */
  close: () => void
}

/**
 * 造一个测试环境：**真缓存**（内存库）+ 可控的 VLM 替身。
 * @param cache - 换掉缓存实现（默认用真的 `ImageDescriptionStore`）。
 * @returns 环境。
 */
function makeHarness(cache?: DescriptionCache): Harness {
  const db = new DatabaseSync(':memory:')
  migrate(db)
  const store = new ImageDescriptionStore(db)

  let calls = 0
  let next: () => Promise<DescribeResult> = async () => OK
  const logs: string[] = []

  return {
    deps: {
      cache: cache ?? store,
      call: async () => {
        calls += 1
        return await next()
      },
      now: () => 1_700_000_000_000,
      log: (_level, message) => { logs.push(message) },
    },
    store,
    calls: () => calls,
    setNext: (fn) => { next = fn },
    logs: () => logs,
    close: () => { db.close() },
  }
}

/**
 * 跑全部用例。
 */
async function main(): Promise<void> {
  // ── 纯辅助函数 ────────────────────────────────────────────────────
  check('MIME 去空白、转小写', acceptedMediaType(' Image/JPEG '), 'image/jpeg')
  check('MIME 丢掉 charset 参数', acceptedMediaType('image/png;charset=utf-8'), 'image/png')
  check('★ 不认识的类型返回 undefined（先收窄，别等附件服务才炸）', acceptedMediaType('image/bmp'), undefined)
  check('空 MIME 也返回 undefined', acceptedMediaType(''), undefined)

  {
    const a = new Uint8Array([1, 2, 3])
    const b = new Uint8Array([1, 2, 4])
    check('同一个内容哈希一致', cacheKeyOf(a), cacheKeyOf(new Uint8Array([1, 2, 3])))
    check('★ 内容变一位哈希就变', cacheKeyOf(a) === cacheKeyOf(b), false)
    check('哈希是 64 位十六进制', /^[0-9a-f]{64}$/.test(cacheKeyOf(a)), true)
  }

  check('空 base64 解不出字节', decodeBase64(''), undefined)
  check('正常 base64 解得出来', decodeBase64(B64)?.byteLength, Buffer.from('not-really-a-png').byteLength)

  check('普通错误只有 name 和消息', describeError(new TypeError('boom')), 'TypeError: boom')
  check(
    '★ 有稳定 code 的要带上（LlmError 的 code 是共享分类，排障全靠它）',
    describeError(Object.assign(new Error('限流了'), { name: 'LlmError', code: 'RATE_LIMIT' })),
    'LlmError [RATE_LIMIT]: 限流了',
  )
  check('非 Error 也能说清楚', describeError('就是失败了'), '就是失败了')

  // ── 未命中 → 调 VLM 并写缓存 ──────────────────────────────────────
  {
    const h = makeHarness()
    const text = await describeWithCache(h.deps, { base64: B64, mimeType: 'image/jpeg', sticker: false })
    check('未命中时拿到描述', text, OK.text)
    check('调了一次 VLM', h.calls(), 1)
    check('写进缓存了', h.store.count(), 1)
    check(
      '缓存里记下了是谁写的',
      [h.store.get(keyOf(B64))?.provider, h.store.get(keyOf(B64))?.model],
      ['siliconflow', 'qwen3-vl'],
    )
    h.close()
  }

  // ── 命中 → 不再调 VLM ─────────────────────────────────────────────
  {
    const h = makeHarness()
    await describeWithCache(h.deps, { base64: B64, mimeType: 'image/jpeg', sticker: false })
    const second = await describeWithCache(h.deps, { base64: B64, mimeType: 'image/jpeg', sticker: false })
    check('第二次拿到同样的描述', second, OK.text)
    check('★ 第二次没有再调 VLM（同一张图只描述一次）', h.calls(), 1)
    check('缓存里还是一条', h.store.count(), 1)
    check('命中有日志', h.logs().some(line => line.includes('缓存命中')), true)
    h.close()
  }

  // ── MIME 变了但字节相同 → 仍然命中（键是内容） ────────────────────
  {
    const h = makeHarness()
    await describeWithCache(h.deps, { base64: B64, mimeType: 'image/png', sticker: false })
    await describeWithCache(h.deps, { base64: B64, mimeType: 'image/jpeg', sticker: false })
    check('★ 键是图片内容，不是 MIME 也不是附件 id', h.calls(), 1)
    h.close()
  }

  // ── 另一张图是另一次调用 ──────────────────────────────────────────
  {
    const h = makeHarness()
    await describeWithCache(h.deps, { base64: B64, mimeType: 'image/jpeg', sticker: false })
    await describeWithCache(h.deps, { base64: OTHER_B64, mimeType: 'image/jpeg', sticker: false })
    check('不同内容各调一次', h.calls(), 2)
    check('缓存里两条', h.store.count(), 2)
    h.close()
  }

  // ── ★ 失败：降级 + 不写缓存 + 报具体内容 + 下次重试 ───────────────
  {
    const h = makeHarness()
    h.setNext(async () => {
      throw Object.assign(new Error('429 Too Many Requests'), { name: 'LlmError', code: 'RATE_LIMIT' })
    })
    const text = await describeWithCache(h.deps, { base64: B64, mimeType: 'image/jpeg', sticker: false })
    check('失败返回空串（渲染成 [图片]）', text, '')
    check('★ 失败不写缓存', h.store.count(), 0)
    check(
      '★ 报的是具体失败内容（含 code 与原始消息）',
      h.logs().some(line => line.includes('RATE_LIMIT') && line.includes('429 Too Many Requests')),
      true,
    )

    h.setNext(async () => OK)
    const retry = await describeWithCache(h.deps, { base64: B64, mimeType: 'image/jpeg', sticker: false })
    check('★ 同一张图会重试并成功（没被一次瞬时故障永久按成 [图片]）', retry, OK.text)
    check('重试确实又调了一次', h.calls(), 2)
    check('这次写进缓存了', h.store.count(), 1)
    h.close()
  }

  // ── 空描述：不写缓存 ─────────────────────────────────────────────
  {
    const h = makeHarness()
    h.setNext(async () => ({ text: '   ', provider: 'p', model: 'm', cacheable: true }))
    check('空描述降级为空串', await describeWithCache(h.deps, { base64: B64, mimeType: 'image/jpeg', sticker: false }), '')
    check('★ 空描述不写缓存', h.store.count(), 0)
    check('空描述有日志', h.logs().some(line => line.includes('返回空描述')), true)
    h.close()
  }

  // ── 截断：本次照用，但不写缓存 ────────────────────────────────────
  {
    const h = makeHarness()
    h.setNext(async () => ({ text: '  一只橘色的  ', provider: 'p', model: 'm', cacheable: false }))
    const text = await describeWithCache(h.deps, { base64: B64, mimeType: 'image/jpeg', sticker: false })
    check('截断的描述本次照用（并且已 trim）', text, '一只橘色的')
    check('★ 截断不写缓存（下次再要一份完整的）', h.store.count(), 0)
    check('截断有日志', h.logs().some(line => line.includes('被截断')), true)
    h.close()
  }

  // ── 压根不调 VLM 的两种情况 ───────────────────────────────────────
  {
    const h = makeHarness()
    check(
      '不支持的图片类型 → 空串',
      await describeWithCache(h.deps, { base64: B64, mimeType: 'image/bmp', sticker: false }),
      '',
    )
    check(
      '空 base64 → 空串',
      await describeWithCache(h.deps, { base64: '', mimeType: 'image/jpeg', sticker: false }),
      '',
    )
    check('★ 这两种都不该浪费一次 VLM 调用', h.calls(), 0)
    check('也不该写缓存', h.store.count(), 0)
    h.close()
  }

  // ── 缓存写失败不该丢掉刚拿到的描述 ───────────────────────────────
  {
    const h = makeHarness({
      get: () => undefined,
      put: () => { throw new Error('disk full') },
    })
    const text = await describeWithCache(h.deps, { base64: B64, mimeType: 'image/jpeg', sticker: false })
    check('★ 缓存写失败，本次描述仍然返回', text, OK.text)
    check('写失败有日志', h.logs().some(line => line.includes('disk full')), true)
    h.close()
  }

  console.log(`\n通过 ${passed}，失败 ${failed}`)
  if (failed > 0) process.exitCode = 1
}

await main()
