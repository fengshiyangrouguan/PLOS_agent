/**
 * 开发探针：把 `qq/message` 事件渲染成 LLM 文本并打日志。
 *
 * ## 它为什么存在
 *
 * `qq` 服务提供的是**能力**，不是策略——它不决定"哪些消息值得渲染"。这个探针就是
 * 一个最朴素的消费者，用来：
 *
 * 1. 验证 `resolve → render` 这条流水线在**真实消息**上的输出
 * 2. 给 `qq-tools` / 未来的会话桥当调用范例
 *
 * ## 为什么要有选择地渲染
 *
 * 解析是惰性的（见 `QqAdapter.resolve`），因为下载图片、查引用、展开转发都是真开销。
 * 配置默认放行所有群消息，无差别渲染等于把每个群的每张图都下下来。
 * 所以这里的规则是：**@ 我的消息一律渲染；其余只渲染"轻"消息**（没有图片/转发/引用的，
 * 解析不需要任何 I/O）。
 *
 * ## 形态
 *
 * 函数插件：具名导出 `name` / `inject` / `apply`，**没有 default export**。
 * 这与 `qq/adapter.ts` 相反——那个提供 service，所以 default export 服务类。
 * 两种形态不能混用，混了 Loader 会丢掉插件的命名空间。
 *
 * @module qq/probe
 */

import type { Context } from '@deepseek-ai/cordis'

/** 插件名——日志里显示为 `probe-qq`。 */
export const name = 'probe-qq'

/** 依赖 `qq` 服务；它激活后本插件才会激活。 */
export const inject = ['qq']

/**
 * 订阅消息事件并渲染。
 * @param ctx - 本插件的上下文（已注入 `qq`）。
 */
export function apply(ctx: Context): void {
  ctx.on('qq/message', (event) => {
    // 图片和转发的解析开销最大（真的下字节、真的展开整棵树），没被 @ 就不碰。
    // 引用（reply）只花一次 get_msg，放行——它的渲染结果需要真实数据才能验证。
    const expensive = event.segments.some(
      segment => segment.type === 'image' || segment.type === 'forward',
    )
    if (expensive && !event.mentionsSelf) return

    // 事件分发是同步的，不能 await；用 void 起一个任务并把异常收干净，
    // 否则渲染失败会变成一条无人处理的 unhandled rejection。
    void (async () => {
      try {
        const text = await ctx.qq.render(event)
        const where = event.groupId === undefined ? '私聊' : `群 ${event.groupId}`
        ctx.logger.info(`[probe-qq] ${where} | ${event.senderName}: ${text}`)
      } catch (error) {
        ctx.logger.warn(`[probe-qq] 渲染失败：${error instanceof Error ? error.message : String(error)}`)
      }
    })()
  })
}
