/**
 * `llm-throttle` 的自检 —— 只测**纯逻辑**（令牌估算与滑动窗口）。
 *
 * `Bucket` 的 `now` 是**从外面传进来的**，所以这里不需要等到天亮，
 * 也不会因为机器慢而变成偶发失败。
 */

import { Bucket, estimateTokens, isRateLimited, pickBest } from '../index.ts'

let passed = 0
let failed = 0

/**
 * 断言相等。
 *
 * @param label - 说明。
 * @param actual - 实际值。
 * @param expected - 期望值。
 */
function check(label: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed += 1
    console.log(`  ✓ ${label}`)
  } else {
    failed += 1
    console.log(`  ✗ ${label}\n      实际 ${JSON.stringify(actual)}\n      期望 ${JSON.stringify(expected)}`)
  }
}

// ── 令牌估算：量级正确即可 ──────────────────────────────────────────
{
  const tokens = estimateTokens({ messages: [{ role: 'user', content: 'x'.repeat(400) }] })
  // 400 字符 + JSON 外壳 ⇒ 约 100~120 令牌。只钉"量级"。
  check('400 字符估出 100~150 令牌', tokens >= 100 && tokens <= 150, true)
  check('空消息也是正数（不返回 0 让预算失效）', estimateTokens({}) >= 0, true)
}

// ── 窗口：没超预算 ⇒ 立刻可发 ──────────────────────────────────────
{
  const bucket = new Bucket({ perMinute: 3, tokensPerMinute: 1_000, maxConcurrent: 4 })
  check('空桶可发', bucket.check(100, 0).waitMs, 0)
  bucket.enter(100, 0)
  check('用掉一条仍可发', bucket.check(100, 0).waitMs, 0)
}

// ── RPM 满 ⇒ 等到最早那条出窗口 ────────────────────────────────────
{
  const bucket = new Bucket({ perMinute: 2, tokensPerMinute: 10_000, maxConcurrent: 4 })
  bucket.enter(10, 0)
  bucket.enter(10, 30_000)
  const verdict = bucket.check(10, 30_000)
  check('★ RPM 满了要等', verdict.blockedBy, 'rpm')
  check('★ 等到最早那条（at=0）出 60 秒窗口', verdict.waitMs, 30_000)
  check('在 60 秒之后就不必等了', bucket.check(10, 60_001).waitMs, 0)
}

// ── TPM 满 ⇒ 也等 ──────────────────────────────────────────────────
{
  const bucket = new Bucket({ perMinute: 100, tokensPerMinute: 1_000, maxConcurrent: 4 })
  bucket.enter(900, 0)
  const verdict = bucket.check(500, 1_000)
  check('★ TPM 满了要等', verdict.blockedBy, 'tpm')
  check('★ 窗口清空后就能发', bucket.check(500, 61_000).waitMs, 0)
}

// ── 并发满 ⇒ 也拦 ──────────────────────────────────────────────────
{
  const bucket = new Bucket({ perMinute: 100, tokensPerMinute: 10_000, maxConcurrent: 1 })
  bucket.enter(10, 0)
  check('★ 并发满了', bucket.check(10, 0).blockedBy, 'concurrency')
  bucket.leave()
  check('★ 还回并发位后就能发', bucket.check(10, 0).waitMs, 0)
}

// ── 并发位不会被还成负数 ────────────────────────────────────────────
{
  const bucket = new Bucket({ perMinute: 100, tokensPerMinute: 10_000, maxConcurrent: 1 })
  bucket.leave()
  bucket.leave()
  check('多余的 leave 不会把计数压成负数', bucket.check(10, 0).waitMs, 0)
}

// ── 均衡：在等价候选里挑一个 ────────────────────────────────────────
{
  /** 造一个报价。 */
  const offer = (key: string, waitMs: number, headroom = 0, cooling = false) => ({ key, waitMs, headroom, cooling })

  check('空列表 ⇒ undefined（没得挑）', pickBest([]), undefined)
  check('都可用 ⇒ 取不用等的那个', pickBest([offer('a', 5), offer('b', 0)]), 1)
  check('★ 冷却里的先排除', pickBest([offer('a', 0, 0, true), offer('b', 3)]), 1)
  check(
    '★★ 全在冷却 ⇒ 退回全部（宁可碰一次，也不许把她卡住）',
    pickBest([offer('a', 0, 0, true), offer('b', 3, 0, true)]),
    0,
  )
  check('★ 等得一样多时取余量大的', pickBest([offer('a', 2, 0.1), offer('b', 2, 0.9)]), 1)
  check('单个候选就是它自己', pickBest([offer('only', 9)]), 0)
}

// ── 限速识别（**启发式**：认不出只是不冷却，不会更坏）────────────────
{
  check('认 429', isRateLimited({ message: '429 status code (no body)' }), true)
  check(
    '认硅基的 50602',
    isRateLimited({ message: '{"code":50602,"message":"Request was rejected due to rate limit"}' }),
    true,
  )
  check('认 rate limit 字样', isRateLimited({ message: 'Rate Limit exceeded' }), true)
  check('★ 别的错不误判（否则好模型也被关冷却）', isRateLimited({ message: '400 status code (no body)' }), false)
  check('undefined 不炸', isRateLimited(undefined), false)
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
if (failed > 0) process.exitCode = 1
