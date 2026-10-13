/**
 * 待办的**文本面**：写待办的指令、待办的解析、以及浮进上下文的那段渲染。
 *
 * ## 为什么单独一层
 *
 * 和 `perception/render.ts`、`attention/preempt.ts` 同一个理由：**纯函数，运行时零依赖** ——
 * 于是措辞和格式能离网钉死（`tests/render.spec.ts`）。这两个字符串是**模型可见的**，
 * 靠真实流量盯不住（模型输出每次都不同），只能靠自检守。
 *
 * ## 写待办的是**快照 subagent**，拿到的正是"中断前"的上下文
 *
 * §20.4：**"写待办的 subagent 在【中断那一刻】启动 —— subagent 的上下文在启动时取定，
 * 所以它拿到的正是'中断前'的状态。"**
 *
 * 这一条是 §7.2 那条洞见的搬运：**必须在上下文还完整时生成**。
 * 等 T 到了再让她自己回忆，中断自己的过程已经把上下文搅了。
 *
 * 所以待办**分两次生成**（这是 §20.4 的全部内容）：
 *
 * ```
 * 中断那一刻   同步取边界 + 起快照 subagent      ← 上下文最完整，此时取定
 * 中断 > T     subagent 被叫起来写待办 → 浮进上下文
 * 中断 < T     丢弃，一次模型调用都不花
 * ```
 *
 * ## 三个"必须"（照 §7.2，换了个便宜得多的位置）
 *
 * | | 为什么 |
 * |:--|:--|
 * | **必须由 subagent 看**，不是服务端写 | 服务端只知道"有个信号来了"，不知道她刚刚在干什么 |
 * | **必须在中断那一刻取上下文** | 晚一秒上下文就被中断自己搅了 |
 * | **必须只给坐标**，不搬上下文回来 | §20.10 定案：待办里记 `sessionId` + turn/seq，细节由她自己调工具取 |
 *
 * @module interrupt_plan/render
 */

/**
 * 写待办那一行的行首标记。
 *
 * ⚠️ **它只是行首前缀，不含冒号** —— 冒号是**标点**，不是协议。
 * 早先写成 `'在做什么：'`（全角冒号）并 `startsWith` 匹配，模型把全角写成半角
 * `:` 就整行落空、静默退回占位说明。**别把标点当协议。**
 */
export const WHAT_LABEL = '在做什么'

/** 解析不到时的占位说明。**宁可如实说"没写清楚"，也不给一条残句。** */
export const WHAT_PLACEHOLDER = '（没有写清楚。她的上下文里可以看那段会话。）'

/**
 * 写待办的指令。
 *
 * ## ★ 只要一行 —— `why` 不由它产
 *
 * 待办要两样东西：**她刚在干什么**（`what`）与**被什么打断的**（`why`）。
 * 后者**服务端本来就知道**（就是那条感知条目的正文），所以**不绕模型一圈**。
 *
 * 早先的版本让模型「原样抄用」`why` 再解析回来 —— 那一圈**只能损失不能增益**
 * （抄错一个字、或把冒号换成半角，就静默降级），而它抄的正是我们手里那份原文。
 * 现在 `why` 由 `index.ts` 直接用中断那一刻的原话。
 *
 * ## 措辞的三件事
 *
 * 1. 「你已经看到…**之前**的那个上下文」—— 把她手上这份历史的**位置**说清楚。
 *    不说，她可能以为自己看到的是"刚刚发生的事"，那就会去读下面没有的东西。
 * 2. **明说看不到中断内容** —— 否则她会去上下文里找"到底什么事打断了"，找不到就编。
 * 3. **明说"不用道歉/不用回应"** —— 它是工具调用，不是一次对话。
 */
export const WRITER_TASK = [
  '你是一个记录工具，不是对话者。不要道歉、不要提问、不要输出这一行以外的任何内容。',
  '',
  '你看到的是【白羽在被打断之前】的那个上下文。从现在起它不再增长：',
  '上面最后发生的事，就是她被打断时正在做的事。',
  '中断她的那条信号【不在你的上下文里】，所以你也无从知道那是什么事',
  '—— 那一项不由你负责，不要猜、不要编、不要写。',
  '',
  '请只在上下文中找证据（最后几条消息、最后一次工具调用、最后一句她的话），',
  '然后输出**恰好一行**：',
  '',
  '在做什么：<一句话。她正进行到哪一步。用她自己的动作描述，不要复述原文>',
].join('\n')

/**
 * 一次中断的**坐标**。
 *
 * `sessionId` / `turn` / `seq` **全部来自中断那一刻**的内容，不是事后算的 ——
 * 否则 T 期间她又跑了几轮，坐标就漂了。
 */
export interface PlanCoordinates {
  /** 从哪个会话继续。 */
  readonly sessionId: string
  /** **中断发生前最后完成的那一轮** —— 即"没写成的那一轮"的编号。 */
  readonly turn: number
  /** 那一轮里最后一个事件的 seq。**给工具用**（`session_event_read` 收 seq）。 */
  readonly seq: number
}

/**
 * 拼写待办指令，把中断那一刻的坐标接上去。
 *
 * **只给坐标，不给 `why`** —— `why` 由服务端直接用原话（见 {@link WRITER_TASK}）。
 *
 * @param coordinates - 中断那一刻的坐标。
 * @returns 给快照 subagent 的完整指令。
 */
export function writerTaskFor(coordinates: PlanCoordinates): string {
  return [
    WRITER_TASK,
    '',
    '── 参考：她停在这里 ──',
    `会话 ${coordinates.sessionId} 的第 ${String(coordinates.turn)} 轮`
    + `（最后一个事件 seq=${String(coordinates.seq)}）`,
  ].join('\n')
}

/**
 * 解析 subagent 的输出，取出"在做什么"。
 *
 * **按行首标记找，不按行号找** —— 模型可能加一句前言或多一个空行。
 * 标记行之外的**全部忽略**：这条路径上"多出来的内容"没有价值，
 * 而把它塞进待办等于把上下文又搬一遍。
 *
 * ⚠️ **冒号两种宽度都接受**（见 {@link WHAT_LABEL}）：全角、半角、或者干脆没写
 * 冒号，都算命中。标点不是协议。
 *
 * 标记在但内容空，或整行没出现时，返回 {@link WHAT_PLACEHOLDER} 而不是空串 ——
 * 空串会渲染出一条「你之前正在：」的残句，看起来像渲染 bug。
 *
 * @param text - subagent 最后一条 assistant 消息的纯文本。
 * @returns 一句话；解析不到时是占位说明。
 */
export function parseWhat(text: string): string {
  for (const raw of text.split(/\r?\n/)) {
    const trimmed = raw.trim()
    if (!trimmed.startsWith(WHAT_LABEL)) continue
    const body = trimmed.slice(WHAT_LABEL.length).replace(/^[：:]\s*/, '').trim()
    if (body !== '') return body
  }
  return WHAT_PLACEHOLDER
}

/**
 * 渲染待办要的全部输入。坐标单独给，渲染本身不认识数据库。
 *
 * `what` 来自快照 subagent，`why` 来自**中断那一刻的原话**（服务端手里那份，
 * 不绕模型 —— 见 {@link WRITER_TASK}）。
 */
export interface PlanRenderInput extends PlanCoordinates {
  /** 被打断时正在做什么（来自快照 subagent）。 */
  readonly what: string
  /** 因为什么被打断（**服务端原话**，就是那条感知条目的正文）。 */
  readonly why: string
  /** 中断发生时刻（毫秒）。 */
  readonly createdAt: number
  /** 落定时刻（毫秒）。 */
  readonly expiresAt: number
}

/** 把毫秒渲染成"还能记多久"。最长的是 1 天，所以只分三档就够。 */
function remaining(expiresAt: number, now: number): string {
  const left = expiresAt - now
  if (left <= 0) return '即将过期'
  const hours = Math.floor(left / 3_600_000)
  if (hours >= 1) return `还能记 ${String(hours)} 小时`
  return `还能记 ${String(Math.max(1, Math.floor(left / 60_000)))} 分钟`
}

/**
 * 把一条待办渲染成注入她上下文的那段文本。
 *
 * ## 为什么要有这一段（§20.7）
 *
 * 旧模型**必须**保证"一定能回来"，因为它没有恢复路径，只好用 fork 把状态冻起来。
 * 新模型承认"可能回不来"，但留了这一条路：
 *
 * ```
 * 待办躺在表里 → perception 的闲时定时器把她唤醒 → 这段文本进入上下文
 *              → 她想起来还有件事没做完
 * ```
 *
 * **所以这段文本是整套"用恢复路径换掉上下文冻结"里唯一的落脚点**，
 * 它要说清三件事：**本来在干什么**（`what`）、**被什么打断了**（`why`）、
 * **去哪看细节**（坐标）。
 *
 * ## 为什么只给坐标不给内容（§20.10）
 *
 * 待办里记的是 `sessionId` + turn/seq，细节由她自己调 `session_event_read` 取。
 * 这是"**忘了细节但没丢事**"（§8.6 E3）的落地方式 —— 也是待办能只活一天的原因：
 * 它不承担"把上下文搬回来"的职责。
 *
 * ## 语气：**许可式**
 *
 * 同样的理由和 `WRAPUP_HINT` 一致：机制上没有任何东西强制她回来做这件事
 * （§20.7「**不保证**」），所以这里也是邀请不是命令。
 * **过期就不提** —— 端上来只会让她对着一条死事发呆。
 *
 * @param plan - 待办内容与坐标。
 * @param now - 现在（毫秒）。注入以便自检。
 * @returns 注入正文；**已经过期时返回 `undefined`**（调用方据此不注入）。
 */
export function renderPlan(plan: PlanRenderInput, now: number): string | undefined {
  if (plan.expiresAt <= now) return undefined

  return [
    '【一件没做完的事】',
    `你之前正在：${plan.what}`,
    `被打断的原因：${plan.why}`,
    `想接着做的话，从会话 ${plan.sessionId} 第 ${String(plan.turn)} 轮那里看起`
    + `（seq=${String(plan.seq)}，可以用 session_event_read 取回那一轮的上下文）。`,
    `（这条记于 ${new Date(plan.createdAt).toISOString()}，${remaining(plan.expiresAt, now)}。）`,
    '',
    '要不要接着做由你决定；如果你已经不打算管它了，忽略这条就行。',
  ].join('\n')
}

/**
 * 优雅关闭记录：**上次进程停止时，她正停在哪里**。
 *
 * 它跟待办是同一件事的两个来源（都算"被打断了"），但**不是同一批数据**：
 * 待办由快照 subagent 写、有 `what`；**关闭记录来不及叫模型**（关不干净），
 * 所以只有坐标。
 */
export interface ShutdownRecord {
  /** 进程停止时注意力焦点所在的会话。 */
  readonly sessionId: string
  /** 停在哪一轮。 */
  readonly turn: number
  /** 停在哪条事件。 */
  readonly seq: number
  /** 停止时刻（毫秒）。 */
  readonly at: number
  /** **为什么停止** —— 进程能观测到的那一部分。 */
  readonly reason: string
}

/**
 * 渲染"上次是停下来的"。
 *
 * ## 为什么要有它（优雅关闭原理）
 *
 * 重启之后 `currentPriority` 回落到 `0`、turn 也断了 —— **她不知道上一轮是被停掉的**，
 * 看起来就像"什么都没发生过"。而 **DSH 在 SIGINT/SIGTERM 上会优雅关闭**
 * （`apps/cli/src/profile-boot.ts:280` 装了处理器 → `interrupt(code)`），
 * 插件的 disposer 会跑，所以"**临死前记一笔、启动时注入**"是可行的。
 *
 * ⚠️ **它只记坐标，不记内容** —— 临死前叫不动模型。要细节她自己用
 * `session_event_read` 回看，跟待办同一条纪律（§20.10）。
 *
 * ## 语气同 `renderPlan`：许可式
 *
 * 机制上没有任何东西强制她回来，所以这里是邀请不是命令。
 *
 * @param record - 关闭记录。
 * @returns 注入正文。
 */
export function renderShutdown(record: ShutdownRecord): string {
  return [
    '【上次是停下来的】',
    `上一次运行时进程停止了（${record.reason}）。`,
    `你当时停在会话 ${record.sessionId} 第 ${String(record.turn)} 轮`
    + `（seq=${String(record.seq)}，可以用 session_event_read 取回那一段）。`,
    '',
    '要不要接着做由你决定；如果你已经不打算管它了，忽略这条就行。',
  ].join('\n')
}
