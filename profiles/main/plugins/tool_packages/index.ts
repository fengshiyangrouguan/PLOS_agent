/**
 * 工具包（渐进式披露）—— 把不常用的工具**收进包**，按需取用。
 *
 * ## 它做四件事
 *
 * 1. ★★ **过滤工具表** —— 挂在 `system-prompt/assemble` 瀑布上，把「包里的（未取用的）」
 *    与「卸载名单里的」从 `result.tools` 里筛掉 ✓
 *    （★ 与 `tcb.apply` 的 `sections` 过滤**同一个形状** ✓，只是多筛一个字段 ✓）。
 * 2. ★ **一段说明进系统提示词** —— 每个包**有什么、什么时候用、可以按需取用** ✓
 *    （★ 文本固定 ⇒ 命中提示词缓存 ✓ 实测命中率 **95.1%** ✓）。
 * 3. ★ **一个查找工具** `find_tools` —— 她按需把某一包取进**本 turn** ✓。
 * 4. ★ **turn 边界回落** —— 新 turn 一开始就清空 ⇒ 回到基线 ✓（★ 缓存重新命中 ✓）。
 *
 * ## ★★ 为什么不能用 DSH 内置的 `deferLoading`
 *
 * DSH 的 `ToolSchema.deferLoading` 正是为这件事设计的 ✓（`llm/llm/src/types.ts:473` ✓），
 * 但 **pi-ai 那条路显式抛错** ✗：
 *
 * ```
 * llm-pi-ai/src/context.ts:131
 *   if (options.tools?.some(tool => tool.deferLoading === true)) {
 *     throw new LlmError('Deferred tool loading is not supported yet', 'UNSUPPORTED_CONTENT')
 *   }
 * ```
 *
 * ★ 而且它的**激活**一半（`tool-addition` / `tool-removal` 消息）在 pi-ai 上**同样抛错** ✓
 * （`llm-pi-ai/tests/context.spec.ts:88-97` ✓）。★ 所以我们**自己筛装配结果** ✓ ——
 * 那条路**与 provider 无关** ✓（纯客户端 ✓）。
 *
 * ★★ **将来若切到 `llm-deepseek`（官方路 ✓），它的 `serialize.ts:164` 认 `defer_loading`** ✓ ⇒
 * 那时可以改用内置机制、把这份自制过滤退掉 ✓。
 *
 * ## ⚠️ 两条硬约束
 *
 * · ★★ **能不能调用只取决于 `tools`** ✗ —— 光在 tool result 里写 schema **调不了** ✓。
 * · ★★ **取包会改变工具表前缀 ⇒ 那一次请求断缓存** ✗ ⇒ 所以**turn 结束必须回落** ✓。
 *
 * @module tool-packages
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  FIND_TOOLS_NAME,
  TOOL_PACKAGES,
  hiddenTools,
  packageOf,
  packagesSectionText,
} from './packages.ts'

/** 插件名。 */
export const name = 'tool-packages'

/** ★ 只依赖工具表与系统提示词两件事 ✓。 */
export const inject = ['tools', 'systemPrompt'] as const

/** 那段说明的段名 —— ★ **必须同时列进 `data/tcb.json` 的 `sections`** ✗，否则被 `tcb` 滤掉 ✓。 */
export const SECTION_NAME = 'tool-packages'

/**
 * 那段说明的位置 —— ★ 紧跟在人设之后 ✓（她该早早知道"有哪些能力可以取" ✓）。
 *
 * 参照 `system-prompt` 现成的取值：`HARNESS_IDENTITY: -1000` ✓／
 * `DEPLOYMENT_PERSONA_PREFIX: 0` ✓／`PLAN_POLICY: 500` ✓ ⇒ 取 **100** ✓。
 */
const SECTION_ORDER = 100

/**
 * 注册工具包：过滤工具表 ＋ 写说明 ＋ 提供查找工具。
 *
 * @param ctx - 插件上下文。
 */
export function apply(ctx: Context): void {
  /**
   * ★★ **本 turn 已取用的包名** —— 空集 ⇒ 回到基线（包里的全藏 ✓）。
   *
   * ⚠️ **作用域说明**：它是**插件级**的一个集合 ✓（不是 per-agent ✗）。
   * 现在只有她一个 agent 会取包 ✓（planner 不取 ✓）⇒ 这是可接受的 ✓。
   * ★ 将来若多个 agent 都要取包，就得按 agent 分开记 ✗（那时 `agent/request` 的载荷
   * 也不够 —— 它只有 `{turn, step, signal}` ✓，得靠注册作用域区分 ✓）。
   */
  const active = new Set<string>()

  // ── ① ★ turn 边界：新 turn 一开始就回落 ─────────────────────────────
  //
  // `agent/request` 的载荷是 `{ turn, step, signal }`（`core/agent-loop/src/agent.ts:577` ✓）
  // ⇒ ★★ **`step === 1` 就是"新的一轮开始了"** ✓ —— 那时清空 ⇒ 回到基线 ✓。
  //
  // ★ 这是个**瀑布**（返回 `LlmCallConfig` ✓）⇒ **必须 `next()`** 并把它返回 ✓
  //   （照 `tcb/index.ts:196` 的写法 ✓）。
  ctx.on('agent/request', (payload, next) => {
    if ((payload as { step?: unknown } | undefined)?.step === 1) active.clear()
    return next()
  })

  // ── ② ★★ 过滤工具表：包里的（未取用的）＋ 卸载的 ⇒ 不进 `tools` ──────
  //
  // ★ 返回值是 `PromptAssembly`（`sections` / `contexts` / **`tools`** / `variables` ✓）
  //   ⇒ 和 `sections` 一样筛 ✓。
  // ★★ **包里的工具靠名字筛** ⇒ 名字必须是**真实的注册名** ✓
  //   （拼错＝静默少一个 ✗ ⇒ 由 `tests/packages.spec.ts` 对着真实工具表核对 ✓）。
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const result = await next()
    const hidden = hiddenTools(active)
    return { ...result, tools: result.tools.filter(tool => !hidden.has(tool.name)) }
  })

  // ── ③ ★ 那段说明（文本固定 ⇒ 进缓存 ✓）────────────────────────────
  ctx.effect(() => ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: SECTION_ORDER,
    text: packagesSectionText(),
  }))

  // ── ④ ★ 查找工具：把一包装进本 turn ───────────────────────────────
  ctx.tools.register(defineTool({
    name: FIND_TOOLS_NAME,
    description: [
      'Load one tool package into this turn, so you can then call the tools inside it.',
      `Packages: ${TOOL_PACKAGES.map(item => item.name).join(', ')}.`,
      'The package listing in your system prompt says what each one contains.',
      'Loading takes effect from your next step; it lasts for this turn only.',
    ].join(' '),
    parameters: {
      package: {
        type: 'string',
        required: true,
        description: `Package name. One of: ${TOOL_PACKAGES.map(item => item.name).join(', ')}.`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          reason: { type: 'string' },
          tools: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? `Loaded. These tools are usable from your next step: ${(value.tools ?? []).join(', ')}`
          : `Could not load that package: ${value.reason ?? 'unknown reason'}`,
      }],
    },
    async execute(args) {
      const wanted = String(args.package ?? '').trim()
      const found = packageOf(wanted)
      if (found === undefined) {
        // ★ 报错要**列出合法值** ✓ —— 否则她只能瞎试 ✗。
        return {
          ok: false,
          reason: `no package named "${wanted}"; known packages: `
            + TOOL_PACKAGES.map(item => item.name).join(', '),
        }
      }
      active.add(found.name)
      return { ok: true, tools: [...found.tools] }
    },
  }))
}
