/**
 * `render.ts` 的自检脚本。
 *
 * 跑法：
 * ```powershell
 * cd E:\project\PLOS\deepseek-harness
 * node --import tsx/esm E:\project\PLOS\PLOS_agent\profiles\main\plugins\perception\tests\render.spec.ts
 * ```
 *
 * 能这么跑是因为 `render.ts` **只认识 types**，运行时零依赖。
 *
 * ## 这里重点验什么
 *
 * 1. **缺字段必须抛错，不能静默留空** —— 渲染出 `{senderName}` 的简报
 *    会让她以为那就是人名，宁可失败
 * 2. **优先级的三条轴**（设计 §4.2/§4.3）：0 = 被动 / <80 = 可收尾 / ≥80 = 紧急
 * 3. **渲染格式**：时间戳 + `【域名】` 分节 + 空行分段（用户给的样例格式）
 * 4. **`quiet` 与 `highest`** —— 响应侧（`attention`）靠它们仲裁，感知层不做决定
 *
 * @module perception/spec
 */

import assert from 'node:assert/strict'
import { applyTemplate, effectivePriority, formatTimestamp, renderNotice } from '../render.ts'
import { PRIORITY_PASSIVE, PRIORITY_URGENT, type Signal, type SignalSource } from '../types.ts'

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
 * 断言抛错。
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

/** 造一个 QQ 风格的领域源。 */
function qqSource(priority = 20): SignalSource {
  return {
    domain: 'QQ',
    priority,
    templates: {
      mention: '群「{groupName}（id:{groupId}）」里有人 @ 了你',
      private: '{senderName}(id:{userId}) 私聊了你',
    },
    pull: () => [],
  }
}

/** 造一条信号。 */
function signal(kind: string, data: Record<string, string | number>, extra: Partial<Signal> = {}): Signal {
  return { kind, data, source: 'group:1', ...extra }
}

// ── 模板代入 ────────────────────────────────────────────────────────
{
  check('单个占位符',
    applyTemplate('群「{name}」', { name: '古乐の秘♂密基地' }), '群「古乐の秘♂密基地」')
  check('多个占位符',
    applyTemplate('{a} 和 {b}', { a: '甲', b: '乙' }), '甲 和 乙')
  check('同一占位符出现两次',
    applyTemplate('{x}-{x}', { x: 'p' }), 'p-p')
  check('数字转字符串',
    applyTemplate('心率：{bpm}', { bpm: 70 }), '心率：70')
  check('没有占位符时原样返回',
    applyTemplate('无占位符', {}), '无占位符')

  // ★ 缺字段必须抛错，不能静默留空
  checkThrows('缺字段抛错', () => { applyTemplate('你好 {name}', {}) }, /不存在的字段/)
  checkThrows('部分缺字段也抛错',
    () => { applyTemplate('{a}{b}', { a: '1' }) }, /"\{b\}"/)
}

// ── 优先级的三条轴 ──────────────────────────────────────────────────
{
  check('省略时用领域基准', effectivePriority(signal('mention', {}), 20), 20)
  check('信号覆盖领域基准', effectivePriority(signal('mention', {}, { priority: 5 }), 20), 5)
  check('都没有时按被动 0', effectivePriority(signal('mention', {}), undefined), PRIORITY_PASSIVE)
  check('0 就是 0（永不唤醒）', effectivePriority(signal('x', {}, { priority: 0 }), 50), 0)
  check('负数夹到 0', effectivePriority(signal('x', {}, { priority: -5 }), undefined), 0)
  check('超过 100 夹到 100', effectivePriority(signal('x', {}, { priority: 999 }), undefined), 100)
  check('非有限值按被动', effectivePriority(signal('x', {}, { priority: Number.NaN }), 30), PRIORITY_PASSIVE)
  check('紧急线是 80', PRIORITY_URGENT, 80)
}

// ── 渲染格式 ────────────────────────────────────────────────────────
{
  // 用固定时间戳，只验格式不依赖时区（时区会改变具体数字）
  check('时间戳格式', formatTimestamp(0).replace(/\d/g, 'N'), 'NNNN-NN-NN NN:NN')

  const at = Date.now()
  const notice = renderNotice(at, [
    {
      source: qqSource(),
      signals: [
        signal('mention', { groupName: '古乐の秘♂密基地', groupId: '728636404' }, { source: 'group:728636404' }),
        signal('private', { senderName: '李四', userId: '1234567' }, { source: 'private:1234567' }),
      ],
    },
  ])

  const lines = notice.text.split('\n')
  check('第 1 行是时间戳', lines[0], formatTimestamp(at))
  check('第 2 行是空行', lines[1], '')
  check('第 3 行是领域分节', lines[2], '【QQ】')
  check('第 4 行是第一条信号', lines[3], '群「古乐の秘♂密基地（id:728636404）」里有人 @ 了你')
  check('第 5 行是第二条信号', lines[4], '李四(id:1234567) 私聊了你')
  check('组内保持 pull 顺序', notice.signals.map(s => s.kind), ['mention', 'private'])
  check('信号带上领域名', notice.signals[0]?.domain, 'QQ')
  check('渲染出行文本', notice.signals[1]?.line, '李四(id:1234567) 私聊了你')
}

// ── 多领域：分节与顺序 ──────────────────────────────────────────────
{
  const watch: SignalSource = {
    domain: '手表',
    priority: 90,
    templates: { sleep: '状态感知：{state}', bpm: '心率：{value}' },
    pull: () => [],
  }
  const notice = renderNotice(1000, [
    { source: qqSource(), signals: [signal('mention', { groupName: 'G', groupId: '1' })] },
    { source: watch, signals: [signal('sleep', { state: '进入睡眠2h，浅睡眠阶段' }), signal('bpm', { value: 70 })] },
  ])

  check('按注册顺序分节', notice.text.split('【').slice(1).map(s => s.split('】')[0]), ['QQ', '手表'])
  check('领域之间空行分段', notice.text.includes('有人 @ 了你\n\n【手表】'), true)
  check('多领域取最高优先级', notice.highest, 90)
  check('有非 0 级就不是 quiet', notice.quiet, false)
}

// ── quiet / highest：感知层不做决定，只报事实 ───────────────────────
{
  const news: SignalSource = {
    domain: '新闻',
    priority: 0,
    templates: { digest: '有 {n} 条新推送' },
    pull: () => [],
  }
  const quiet = renderNotice(1000, [{ source: news, signals: [signal('digest', { n: 3 })] }])
  check('全 0 级 → quiet', quiet.quiet, true)
  check('全 0 级 → highest=0', quiet.highest, 0)
  check('只有 0 级时不是空简报', quiet.text.includes('有 3 条新推送'), true)

  const mixed = renderNotice(1000, [
    { source: news, signals: [signal('digest', { n: 3 })] },
    { source: qqSource(), signals: [signal('mention', { groupName: 'G', groupId: '1' })] },
  ])
  check('混有非 0 级 → 不 quiet', mixed.quiet, false)
  check('混有时取非 0 的最高', mixed.highest, 20)
}

// ── 边界：没有信号 / 空领域被跳过 ───────────────────────────────────
{
  const empty = renderNotice(1000, [])
  check('无信号时正文为空', empty.text, '')
  check('无信号时 signals 为空', empty.signals, [])
  check('无信号时 quiet（highest=0）', empty.quiet, true)

  const skipped = renderNotice(1000, [
    { source: qqSource(), signals: [] },
    { source: qqSource(), signals: [signal('mention', { groupName: 'G', groupId: '1' })] },
  ])
  check('空领域不产出分节',
    skipped.text.split('【').slice(1).length, 1)
}

// ── 缺模板必须抛错（配置错误要 fail loud） ──────────────────────────
{
  checkThrows('kind 没有对应模板时抛错', () => {
    renderNotice(1000, [{ source: qqSource(), signals: [signal('不存在的种类', {})] }])
  }, /没有为信号种类/)
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
if (failed > 0) process.exitCode = 1
