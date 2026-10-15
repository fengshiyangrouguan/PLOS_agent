/**
 * `vlm2text` 的配置面。
 *
 * 只有两项，都是**部署可变**的（DSH 的规矩：可调项进 `Config`，不留硬编码）：
 * 用哪个 TCB 调 VLM，以及提示词长什么样。
 *
 * @module vlm2text/config
 */

import z from '@deepseek-ai/schemastery'

/** `ctx.vlm2text` 的配置。 */
export interface Config {
  /**
   * 用哪个 TCB 调 VLM。
   *
   * 形状照 `interrupt_plan.plannerTcb`：**一个可切换的名字** ——
   * 换 VLM 只改 `data/tcb.json` 里的那一个 TCB，不动代码。
   *
   * ⚠️ 这个 TCB 的模型必须**收图**（`input` 里要有 `'image'`，写在
   * `llm-pi-ai` 的 provider 配置里）。`vlm2text` **不自己判断模态** ——
   * 那是 llm 侧 provider catalog 的唯一真相，抄一份到配置里就是两处会分叉。
   */
  vlmTcb: string
  /**
   * 描述提示词。
   *
   * ★ **要求"只输出描述本身"**：返回值会被直接拼进消息正文
   * （`[图片:描述]`），所以前缀寒暄（"好的，这张图是……"）会污染存档和搜索。
   *
   * 表情包也走这一条 —— 提示词里已经交代了"如果是表情包，说明它表达了什么"，
   * 所以**不另开一个 stickerPrompt**：`ImageDescriber` 收 `sticker`，但这一版
   * **没有让它影响行为**（见 `describe.ts` 的 `DescribeInput.sticker`）。
   */
  prompt: string
  /**
   * 一次 VLM 调用的**超时**（毫秒）。
   *
   * ★ **为什么必须有它**（实测，2026-10-15）：同一份请求连续三次重放，
   * 耗时是 **1.2 秒 / 6.3 秒 / 38.5 秒** —— **方差极大**。而唤醒**不等归档**，
   * 所以她第 1 轮读会话时常常拿不到描述 ⇒ 表现为「**那张图第二轮才看到**」。
   *
   * 10 秒之后按**失败**处理（`describe.ts` 的不变量：失败不写缓存、不抛错、
   * 渲染成 `[图片]`）—— 于是她**立刻**被唤醒、知道有人发了图，只是还没看清；
   * 后台那次继续跑，好了再唤醒一次（【图片已渲染完成】）。
   */
  timeoutMs: number
}

/** 配置 schema。 */
export const Config: z<Config> = z.object({
  vlmTcb: z.string().min(1).default('vlm'),
  prompt: z.string().min(1).default(
    '用一句话描述这张图片的内容。'
    + '如果它是聊天表情包，说明它表达了什么情绪或意思。'
    + '只输出描述本身，不要任何前缀、解释或额外说明。',
  ),
  // 10 秒：比常见成功耗时（1~6 秒）宽，又远小于最坏那次（38 秒）。
  timeoutMs: z.natural().min(1_000).default(10_000),
})
