/**
 * `qq` × `vlm2text` 的桥：**把领域无关的图片描述服务，接到 `qq` 适配器的图片钩子上**。
 *
 * ## 为什么这一层要单独存在（不能省）
 *
 * 两边的**方向**是相反的，必须有个人把它们对上：
 *
 * | | |
 * |:--|:--|
 * | `vlm2text` | **不认识 QQ**。它只提供 `ctx.vlm2text.describe(...)`，谁有图片字节谁来调 |
 * | `qq/adapter` | **不认识模型**。它只留了一个 `setImageDescriber` 的注入点（`:823`），**自己不实现它** |
 *
 * 于是：
 * - 让 `vlm2text` 去 `ctx.get('qq')` ⇒ 它就得认识 QQ，**领域无关性当场没了**
 * - 让 `qq/adapter` 去 `ctx.llm` ⇒ 能力 seam 变成一个环（`:744` 就是为这个原因留空的）
 *
 * **所以桥接放在 QQ 这一侧**（谁认识 `qq` 谁接线）——这也是 `qq/adapter:744-746`
 * 早就写下的意图：「由那一侧实现 `ImageDescriber` 并通过 `qq` 服务的可选钩子注入」。
 *
 * ## 它是能力 seam 的 Consumer 角色
 *
 * `qq` 是 Service Definition + Provider；`qq/signals`、`qq/tools`、本插件都是
 * **消费者**，各消费一处能力。多一个消费者是正常的，不是重复。
 *
 * ## 走的是"源头描述"
 *
 * 描述发生在**消息解析那一刻**（`qq/pipeline/segments.ts:88-97`），于是
 * 描述**本身就是消息正文**（`render.ts` 渲染成 `[图片:描述]`），从一开始就进 log。
 * 所以"请求是 session log 的纯函数"成立 —— 详见 `vlm2text/index.ts` 的模块注释。
 *
 * **顺带**：描述就地占住图原来那个段位，所以"哪张图在消息的哪个位置"天然精确。
 *
 * @module qq/vlm
 */

import type { Context } from '@deepseek-ai/cordis'

/** 插件名。 */
export const name = 'qq-vlm'

/** 需要 QQ（钩子挂在它上面）与图片描述服务（真正干活的那个）。 */
export const inject = ['qq', 'vlm2text']

/**
 * 挂上图片描述钩子。
 *
 * `describe` **永不抛错**（失败返回空串），而调用方
 * （`qq/pipeline/segments.ts`）把空串渲染成 `[图片]` —— 所以这里不需要
 * 再包一层 try/catch，也不需要关心失败。
 *
 * @param ctx - 插件上下文。
 */
export function apply(ctx: Context): void {
  // 注册即 effect：插件卸载时把钩子摘掉，免得它指向一个已经不在的服务。
  ctx.effect(() => {
    ctx.qq.setImageDescriber(image => ctx.vlm2text.describe(image))
    return () => { ctx.qq.setImageDescriber(undefined) }
  })
}
