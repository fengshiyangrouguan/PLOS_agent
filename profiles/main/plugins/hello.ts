/**
 * 冒烟插件 A：验证「补丁层 → 装配树 → 模块加载 → 激活」这条链。
 *
 * 它是全树**最早**激活的一类插件（无 inject，装载即激活），所以不能用 `ctx.logger`：
 * logger 是 cordis 核心服务，但它的 exporter（logger-console 那行）可能尚未挂上，
 * 此时发出的日志会被丢弃——本插件第一次跑就踩到了这个。
 * 用 `console.log` 直接写 stdout，保证任何时候都可见。
 *
 * 需要走 logger 管线的示例见同目录的 probe-tools.ts。
 */

import type { Context } from '@deepseek-ai/cordis'

export const name = 'hello'

/**
 * 激活时直接写 stdout 报告。
 * @param ctx - 本插件的上下文（此处未使用，保留插件签名）。
 */
export function apply(ctx: Context) {
  void ctx
  console.log('[PLOS_agent][A] hello activated — 补丁层 / 模块加载 / 激活 均 OK')
}
