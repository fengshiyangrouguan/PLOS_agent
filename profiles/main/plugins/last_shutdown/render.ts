/**
 * 关闭记录的**文本面**：那份记录的形状，和浮进上下文的那段渲染。
 *
 * 跟 `perception/render.ts`、`attention/preempt.ts`、`interrupt_plan/render.ts`
 * 同一个理由：**纯函数，运行时零依赖** —— 措辞能离网钉死
 * （`tests/render.spec.ts`）。这段字符串是**模型可见的**，真实流量盯不住。
 *
 * @module last_shutdown/render
 */

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
 * 重启之后 turn 断了 —— **她不知道上一轮是被停掉的**，看起来就像"什么都没发生过"。
 * 而 **DSH 在 SIGINT/SIGTERM 上会优雅关闭**
 * （`apps/cli/src/profile-boot.ts:280-281` 装了处理器 → `interrupt(code)`），
 * 插件的 disposer 会跑，所以"**临死前记一笔、启动时注入**"是可行的。
 *
 * ⚠️ **它只记坐标，不记内容** —— 临死前叫不动模型。要细节她自己用
 * `session_event_read` 回看，跟待办同一条纪律（§20.10 只给坐标不给内容）。
 *
 * ## 语气：**许可式**
 *
 * 同 `interrupt_plan` 的 `renderPlan`：机制上没有任何东西强制她回来，
 * 所以这里是邀请不是命令。
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
