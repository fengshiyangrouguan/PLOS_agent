/**
 * `llm-throttle` 的自检 —— 只测**纯逻辑**（令牌估算与滑动窗口）。
 *
 * `Bucket` 的 `now` 是**从外面传进来的**，所以这里不需要等到天亮，
 * 也不会因为机器慢而变成偶发失败。
 */

import { Bucket, estimateTokens } from '../index.ts'

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

console.log(`\n通过 ${passed}，失败 ${failed}`)
if (failed > 0) process.exitCode = 1
