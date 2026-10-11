/**
 * 冒烟插件 B：验证树外 bare import 经 DSH 的运行时解析拦截，
 * 落到安装的 DSH 那份模块上；并验证 `inject` 的依赖驱动激活与 `ctx.tools.register`。
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'probe-tools'
export const inject = ['tools']

/** 无副作用回显工具，用于确认工具注册表收到了我们的注册。 */
const plosPing = defineTool({
  name: 'plos_ping',
  description: 'Return a fixed acknowledgement. Used to verify the PLOS_agent plugin layer is mounted.',
  parameters: {},
  output: {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: value }],
  },
  async execute() {
    return 'pong from PLOS_agent'
  },
})

/**
 * 注册冒烟工具并报告激活。
 * @param ctx - 本插件的上下文；`tools` 已由 inject 声明，故此处必已就绪。
 */
export function apply(ctx: Context) {
  ctx.tools.register(plosPing)
  ctx.logger.info('PLOS_agent[B]: probe-tools activated — 树外 bare import + inject + register 均 OK')
}
