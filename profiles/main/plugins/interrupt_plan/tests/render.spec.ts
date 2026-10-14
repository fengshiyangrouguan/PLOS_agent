/**
 * `render.ts` 的自检脚本。
 *
 * 跑法：
 * ```powershell
 * cd E:\project\PLOS\deepseek-harness
 * node --import tsx/esm E:\project\PLOS\PLOS_agent\profiles\main\plugins\interrupt_plan\tests\render.spec.ts
 * ```
 *
 * 能这么跑是因为 `render.ts` **只做字符串拼装，运行时零依赖**（连 cordis 都不 import）。
 *
 * ## 这里重点验什么
 *
 * 这两个字符串是**模型可见的**，靠真实流量盯不住（模型输出每次都不同），
 * 所以只能靠这份自检钉死。五件事：
 *
 * 1. **写待办的指令必须明说"中断内容不在你的上下文里"** —— 不说她就会去上下文里
 *    找"什么事打断了我"，找不到就编一个。这是整个机制最脆的一环（防回归）。
 * 2. **`why` 不由模型产** —— 服务端手里就有原文（那条感知条目），绕模型一圈
 *    **只能损失不能增益**。所以指令里**不许**再出现"原样抄用"那种要求。
 * 3. **解析按行首标记找**，不按行号 —— 模型多一句前言不该让整条待办变成占位说明。
 * 4. **★ 冒号两种宽度都认** —— 早先 `WHAT_LABEL` 带全角冒号并 `startsWith` 匹配，
 *    模型写成半角 `:` 就整行落空、**静默退回占位说明**。标点不是协议。
 * 5. **过期就不注入**，且**注入正文里必须三个坐标齐全**（`sessionId` / turn / seq）——
 *    §20.10 定案"只给坐标不给内容"，坐标缺一个她就找不回去。
 *
 * @module interrupt_plan/render.spec
 */

import assert from 'node:assert/strict'
import {
  WHAT_LABEL, WHAT_PLACEHOLDER, WRITER_TASK, parseWhat, renderPlan, renderPlans, writerTaskFor,
  type PlanRenderInput,
} from '../render.ts'

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

/** 断言为真。 */
function checkTrue(label: string, actual: boolean): void {
  check(label, actual, true)
}

// ── ★ 防回归：指令必须说清"你看到的不是刚刚发生的事" ──────────────────
{
  checkTrue(
    '★ 指令明说中断信号【不在】她的上下文里（不说她就会去猜、就会编）',
    WRITER_TASK.includes('中断她的那条信号【不在你的上下文里】'),
  )
  checkTrue(
    '★ 指令明说不要去猜、不要去编',
    WRITER_TASK.includes('不要猜、不要编'),
  )
  checkTrue(
    '★ 指令明说那一项不由它负责',
    WRITER_TASK.includes('不由你负责'),
  )
  checkTrue(
    '★ 指令把上下文的时间位置说清楚（"之前"的那个上下文）',
    WRITER_TASK.includes('【白羽在被打断之前】'),
  )
  checkTrue(
    '★ 指令要求恰好一行（待办要短 —— 细节靠坐标回看，不靠待办搬运）',
    WRITER_TASK.includes('输出**恰好一行**'),
  )
  checkTrue(
    '★ 指令明说它是工具不是对话者（省掉一整段寒暄）',
    WRITER_TASK.includes('你是一个记录工具，不是对话者'),
  )
  checkTrue(
    '★ 指令里出现行首标记（解析器认的就是它）',
    WRITER_TASK.includes(WHAT_LABEL),
  )
  checkTrue(
    '★ 指令里【不再】要求抄写 why —— why 由服务端直接用原文',
    !WRITER_TASK.includes('原样抄') && !WRITER_TASK.includes('为什么停下'),
  )
}

// ── writerTaskFor 把坐标接上去（**不接 why**） ──────────────────────
{
  const task = writerTaskFor({ sessionId: 'plos-baiyu', turn: 7, seq: 42 })
  checkTrue('task 保留指令原文', task.includes(WRITER_TASK))
  checkTrue('task 给出会话 id', task.includes('plos-baiyu'))
  checkTrue('task 给出轮号', task.includes('第 7 轮'))
  checkTrue('task 给出 seq（给工具的坐标）', task.includes('seq=42'))
  checkTrue('★ task 里没有 why —— 它不该绕模型一圈', !task.includes('@ 了你'))
}

// ── parseWhat：正常 ────────────────────────────────────────────────
{
  check('正常一行', parseWhat('在做什么：正在给 attention 加待办'), '正在给 attention 加待办')
  check(
    '★ 多一句前言不影响解析（按标记找，不按行号）',
    parseWhat('好的，我看看。\n\n在做什么：A\n\n希望有帮助！'),
    'A',
  )
  check('行首有缩进也认（模型爱缩进）', parseWhat('  在做什么：A'), 'A')
  check('标记行取第一次出现的那条', parseWhat('在做什么：第一次\n在做什么：第二次'), '第一次')
  check('★ 半角冒号也认（标点不是协议）', parseWhat('在做什么: A'), 'A')
  check('★ 半角冒号 + 无空格也认', parseWhat('在做什么:B'), 'B')
  check('★ 干脆不写冒号也认', parseWhat('在做什么 A'), 'A')
}

// ── parseWhat：解析不到时给【占位说明】，不是空串 ───────────────────
{
  check(
    '★ 什么都没写 → 占位说明（宁可如实说没写清楚，也不要渲染出残句）',
    parseWhat('我不知道该说什么'),
    WHAT_PLACEHOLDER,
  )
  check('★ 标记在但内容为空 → 也算没写清楚', parseWhat('在做什么：'), WHAT_PLACEHOLDER)
  check('★ 标记在但只有冒号', parseWhat('在做什么:  '), WHAT_PLACEHOLDER)
  check(
    '★ 标记出现在句子中间不算（必须行首）',
    parseWhat('我写了 在做什么：A 这句'),
    WHAT_PLACEHOLDER,
  )
  check('空输入不抛错', parseWhat(''), WHAT_PLACEHOLDER)
}

// ── renderPlan：★ 过期就不注入 ─────────────────────────────────────
{
  const coordinates = { sessionId: 'plos-baiyu', turn: 7, seq: 42 }
  const draft = { what: '正在改 attention', why: '群里有人 @ 了她' }
  const now = 1_000_000_000_000

  check(
    '★ 刚好到期的待办不注入（`<=` 而不是 `<`）',
    renderPlan({ ...coordinates, ...draft, createdAt: now, expiresAt: now }, now),
    undefined,
  )
  check(
    '★ 已过期的待办不注入',
    renderPlan({ ...coordinates, ...draft, createdAt: now - 1000, expiresAt: now - 1 }, now),
    undefined,
  )
}

// ── renderPlan：三个坐标必须齐全（§20.10「只给坐标不给内容」） ────────
{
  const now = 1_000_000_000_000
  const text = renderPlan({
    sessionId: 'plos-baiyu',
    turn: 7,
    seq: 42,
    what: '正在改 attention',
    why: '群里有人 @ 了她',
    createdAt: now,
    expiresAt: now + 2 * 3_600_000,
  }, now)

  checkTrue('没过期时一定有正文', typeof text === 'string')
  const body = text ?? ''
  checkTrue('★ 含"在做什么"', body.includes('正在改 attention'))
  checkTrue('★ 含"被打断的原因"', body.includes('群里有人 @ 了她'))
  checkTrue('★ 含 sessionId 坐标', body.includes('plos-baiyu'))
  checkTrue('★ 含 turn 坐标（人说的"轮"就是 turn）', body.includes('第 7 轮'))
  checkTrue('★ 含 seq 坐标（给 session_event_read 用的那把钥匙）', body.includes('seq=42'))
  checkTrue('★ 告诉她用哪个工具回看', body.includes('session_event_read'))
  checkTrue('★ 语气是许可式，不是命令式', body.includes('由你决定'))
  checkTrue('★ 明说可以不管它', body.includes('忽略这条就行'))
  checkTrue('★ 写明剩余寿命（2 小时）', body.includes('还能记 2 小时'))
  checkTrue('★ 带记下时刻（排障时对得上时间线）', body.includes('2001-09-09T01:46:40.000Z'))
  checkTrue(
    '★ 正文不含未替换的占位符',
    !body.includes('${') && !body.includes('undefined') && !body.includes('NaN'),
  )
}

// ── renderPlan：剩余寿命分三档 ─────────────────────────────────────
{
  const now = 1_000_000_000_000
  const at = (ms: number): string => renderPlan({
    sessionId: 's',
    turn: 1,
    seq: 1,
    what: 'w',
    why: 'y',
    createdAt: now,
    expiresAt: now + ms,
  }, now) ?? ''

  checkTrue('还差 30 分钟', at(30 * 60_000).includes('还能记 30 分钟'))
  checkTrue('不满 1 分钟也显示 1 分钟（不写 0）', at(1).includes('还能记 1 分钟'))
  checkTrue('还差 5 小时', at(5 * 3_600_000).includes('还能记 5 小时'))
  checkTrue('23 小时 59 分按小时算', at(24 * 3_600_000 - 60_000).includes('还能记 23 小时'))
}

// ── renderPlans：批量投递（投递推迟到她 idle，所以可能积下好几条）────
{
  const now = 1_000_000_000_000
  const live = now + 3_600_000
  const plan = (id: number, what: string, expiresAt: number): PlanRenderInput => ({
    sessionId: `s${String(id)}`,
    turn: id,
    seq: id * 10,
    what,
    why: `原因${String(id)}`,
    createdAt: now,
    expiresAt,
  })

  checkTrue('空数组 → undefined（不注入）', renderPlans([], now) === undefined)

  const one = renderPlans([plan(1, '写接线', live)], now) ?? ''
  checkTrue('★ 只有一条时退化成单条形态（保留原开场词）', one.includes('【一件没做完的事】'))
  checkTrue('单条形态不带编号', !one.includes('1. '))

  const two = renderPlans([plan(1, '写接线', live), plan(2, '改文档', live)], now) ?? ''
  checkTrue('★ 多条时批量开场并报条数', two.includes('【2 件没做完的事】'))
  checkTrue(
    '★ 每条编号（顺序 = 传入顺序）',
    two.includes('1. 你之前正在：写接线') && two.includes('2. 你之前正在：改文档'),
  )
  checkTrue(
    '★ 每条的坐标各自齐全，不会串',
    two.includes('会话 s1 第 1 轮') && two.includes('seq=10')
    && two.includes('会话 s2 第 2 轮') && two.includes('seq=20'),
  )
  checkTrue(
    '★ 开场与结尾**各只出现一次**（不是把几段整篇拼起来）',
    two.split('【').length === 2 && two.split('由你决定').length === 2,
  )
  checkTrue('★ 批量时结尾用"它们"（指向多条）', two.includes('不打算管它们了'))

  const expired = renderPlans([plan(1, 'a', now - 1), plan(2, 'b', now - 1)], now)
  checkTrue('★ 全都过期 → undefined', expired === undefined)

  const mixed = renderPlans([plan(1, '甲任务', now - 1), plan(2, '乙任务', live)], now) ?? ''
  checkTrue('★ 过期的被滤掉、且不占编号', !mixed.includes('甲任务') && mixed.includes('乙任务'))
  checkTrue('★ 滤完只剩一条 → 退化成单条形态', mixed.includes('【一件没做完的事】'))
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
if (failed > 0) process.exitCode = 1
