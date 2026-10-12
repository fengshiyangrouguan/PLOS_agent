/**
 * 可行性验证探针：**fork 快照 + 三阶段合并**（`QQ_FORK_PROBE=1` 才跑）。
 *
 * ## 要验证什么
 *
 * 用户设计的抢占式上下文，三阶段：
 * ```
 * ① B 运行中，B 看得到 A 的历史   →  fork A@N（seed = A 的 0..N 前缀）
 * ② 回 A，A 看不到 B              →  resume 原会话 A（它停在 N，从未写过 B）
 * ③ 最终合并                      →  新会话 seed = [A前缀][B的活动][A的恢复(平移)]
 * ```
 *
 * 本探针只验证**机制能不能用**，不写产品代码。三件事：
 *
 * 1. **能不能用合成 seed 建会话**，以及 `inheritedEventCount` 的语义
 * 2. **fork 出来的会话是否真的继承前缀**（surface 里有没有 A 的节点）
 * 3. **能不能手工做合并**——把两个分支的事件按 [前缀][B][A恢复] 拼成一个新 seed，
 *    验证序列号平移算法
 *
 * ## 已知的类型层结论（探针不需要验）
 *
 * `Agent.session` 是 `readonly`（`agent/src/runtime-types.ts:168`）——
 * **一个 Agent 不能切会话**。所以 A 和 B 必然是**两个 Agent**，
 * 这正好落在 DSH 的 subagent 形状上（fork 父会话 + 独立上下文）。
 *
 * ## 序列号平移的算法（本探针要证的）
 *
 * ```
 * 合并后布局：
 *   0..N        A 的前缀        不动
 *   N+1         end-seed 标记   buildForkSeed 产物
 *   N+2..N+1+k  B 的活动        【不用平移】—— B 的 log 里它们本来就在这个位置
 *   ...         A 的恢复        整体 +delta
 *
 * delta = k + 1     （k = B 的活动事件数；+1 是那条 end-seed 标记）
 * ```
 *
 * @module qq/probe-fork
 */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import { buildForkSeed } from '@deepseek-ai/dsh-session/fork'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-default-model'

/** 插件名。 */
export const name = 'qq-probe-fork'

/** 需要建 agent 的能力 + 默认模型。 */
export const inject = ['agents', 'agentLoop', 'agentDefaultModel']

/** 造一条最简单的 user/message。 */
function userMessage(text: string): ReturnType<typeof createUserMessage> {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/** 把日志压成一行可读摘要。 */
function summarize(events: readonly SessionEvent[]): string {
  return events
    .map((event) => {
      const text = (event.data as { message?: { content?: { text?: string }[] } }).message
        ?.content?.[0]?.text
      return `${String(event.seq)}:${event.type}${text === undefined ? '' : `(${text})`}`
    })
    .join(' ')
}

/**
 * 跑一次验证。
 * @param ctx - 本插件的上下文。
 */
async function run(ctx: Context): Promise<void> {
  const { provider, model } = ctx.agentDefaultModel.currentSelection()
  const agentOptions = { provider, model }
  const log = (line: string): void => { console.log(`[probe-fork] ${line}`) }

  // ── 1. 造会话 A，塞几条消息 ──────────────────────────────────────
  const stamp = String(Date.now())
  const idA = SessionId(`probe-fork-a-${stamp}`)
  const a = await ctx.agents.create({ sessionId: idA, agentOptions })
  for (let i = 1; i <= 3; i += 1) {
    a.agent.session.append('user/message', userMessage(`A-${String(i)}`), { surfaceOp: 'append' })
  }
  const aLog = a.agent.session.snapshotEvents()
  const boundary = aLog.length - 1
  log(`A：${String(aLog.length)} 个事件 | ${summarize(aLog)}`)

  // ── 2. fork A@boundary ──────────────────────────────────────────
  const seed = buildForkSeed(aLog, SessionSeq(boundary))
  log(`seed 长度 ${String(seed.length)}（前缀 ${String(boundary + 1)} + end-seed + closers）`
    + ` | ${summarize(seed)}`)

  const idB = SessionId(`probe-fork-b-${stamp}`)
  const b = await ctx.agents.create({
    sessionId: idB,
    seed,
    inheritedEventCount: SessionLogOffset(boundary + 1),
    meta: { isSeeded: true },
    agentOptions,
  })
  const bLog0 = b.agent.session.snapshotEvents()
  log(`B：inheritedEventCount=${String(b.agent.session.inheritedEventCount)}`
    + `（期望 ${String(boundary + 1)}）`)
  log(`B 初始 log：${String(bLog0.length)} 个事件 | ${summarize(bLog0)}`)
  log(`B 初始 surface nodes=${String(b.agent.session.surface.nodes.length)}`
    + `（期望 ≥ ${String(boundary + 1)}，说明继承了前缀）`)

  // ── 3. B 继续活动（模拟"任务 B"）────────────────────────────────
  const bActivityStart = bLog0.length
  for (let i = 1; i <= 2; i += 1) {
    b.agent.session.append('user/message', userMessage(`B-${String(i)}`), { surfaceOp: 'append' })
  }
  const bLog = b.agent.session.snapshotEvents()
  const bActivity = bLog.slice(bActivityStart)
  log(`B 活动：${String(bActivity.length)} 个事件 | ${summarize(bActivity)}`)

  // ── 4. A 恢复（模拟"回到任务 A"）────────────────────────────────
  a.agent.session.append('user/message', userMessage('A-resume-1'), { surfaceOp: 'append' })
  a.agent.session.append('user/message', userMessage('A-resume-2'), { surfaceOp: 'append' })
  const aResume = a.agent.session.snapshotEvents().slice(boundary + 1)
  log(`A 恢复：${String(aResume.length)} 个事件，原 seq ${String(aResume[0]?.seq ?? -1)} 起`
    + ` | ${summarize(aResume)}`)

  // ── 5. 手工合并：前缀 + end-seed + B 活动 + A 恢复(平移) ────────
  const delta = bActivity.length + 1
  const shifted = aResume.map(event => ({
    ...event,
    seq: SessionSeq(Number(event.seq) + delta),
  })) as SessionEvent[]
  const merged = [...seed.slice(0, boundary + 2), ...bActivity, ...shifted]
  log(`合并 delta=${String(delta)}，合并后 ${String(merged.length)} 个事件 | ${summarize(merged)}`)

  const idM = SessionId(`probe-fork-merged-${stamp}`)
  try {
    const m = await ctx.agents.create({
      sessionId: idM,
      seed: merged,
      inheritedEventCount: SessionLogOffset(boundary + 1),
      meta: { isSeeded: true },
      agentOptions,
    })
    const mLog = m.agent.session.snapshotEvents()
    log(`✅ 合并会话建成：${String(mLog.length)} 个事件 | ${summarize(mLog)}`)
    log(`✅ 合并后 surface nodes=${String(m.agent.session.surface.nodes.length)}`)

    // ── 6. 最后一关：seeded 会话能不能 resume ────────────────────────
    // 合并产物是 isSeeded=true 的会话。进程重启后要把它接回来，就得 resume 一个
    // seeded session。这一条不通，整套抢占式设计在重启后就断了。
    log('— 测 resume seeded 会话 —')
    await m.dispose()
    log('已 dispose 合并 agent')
    // 等持久化落盘
    await new Promise(resolve => setTimeout(resolve, 3000))
    try {
      const resumed = await ctx.agents.resume({ resumeSessionId: idM, agentOptions })
      const rLog = resumed.agent.session.snapshotEvents()
      log(`✅ resume 成功：${String(rLog.length)} 个事件 | surface nodes=${String(resumed.agent.session.surface.nodes.length)}`)
      log(`   inheritedEventCount=${String(resumed.agent.session.inheritedEventCount)}`)
      log(`   log 摘要：${summarize(rLog)}`)
    } catch (error) {
      log(`❌ resume 失败：${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`)
    }
  } catch (error) {
    log(`❌ 合并失败：${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`)
  }
}

/**
 * 环境变量开启时跑一次。
 * @param ctx - 本插件的上下文。
 */
export function apply(ctx: Context): void {
  if (process.env['QQ_FORK_PROBE'] !== '1') return
  // 延迟：provider 由别的插件在自己的 apply 里注册，agentLoop 的工厂也是。
  const delayMs = Number(process.env['QQ_FORK_PROBE_DELAY_MS'] ?? '20000')
  void (async () => {
    await new Promise(resolve => setTimeout(resolve, Number.isFinite(delayMs) ? delayMs : 20000))
    await run(ctx)
  })().catch((error: unknown) => {
    console.log(`[probe-fork] 未捕获：${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`)
  })
}
