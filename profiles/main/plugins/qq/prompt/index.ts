/**
 * 系统提示词段落（三层里的第③层）：告诉白羽她在 QQ 上，以及**怎么才让人看见**。
 *
 * ## 为什么必须有这一层
 *
 * 只有 ①能力 和 ②工具 的时候，实测结果是：`qq-push` 把消息推进了上下文，
 * agent 那一轮也真的跑了并正常结束（`status=running` → `idle`，零错误），
 * **但她没有调 `qq_send_message`**——她只是在会话里"回答"了，那句话没人看得见。
 *
 * 工具描述只说了"这个工具能做什么"，没说"**不调它就没人看得见你**"。
 * 那半句必须由系统提示词补上，否则工具存在与否对她的行为没有区别。
 *
 * ## 措辞取向
 *
 * 从模型视角写（DSH 的规矩）：讲她处境里的事实，不讲实现。
 * 特别地——**明说"不想回就别回"**。群里绝大多数消息不需要她开口，
 * 不写这句，一个被 @ 就会回话的 bot 会变成刷屏机器。
 *
 * @module qq/prompt
 */

import type { Context } from '@deepseek-ai/cordis'

/** 插件名。 */
export const name = 'qq-prompt'

/** 依赖提示词装配服务。 */
export const inject = ['systemPrompt']

/**
 * 段落顺序。
 *
 * 取 30：靠前但不抢 runtime context（那些是 DSH 自己的，通常更小）。
 * 放在身份说明之后、工具清单之前比较自然。
 */
const ORDER = 30

/**
 * 注册段落。
 * @param ctx - 本插件的上下文；`systemPrompt` 已由 inject 声明。
 */
export function apply(ctx: Context): void {
  ctx.systemPrompt.section({
    name: 'qq',
    order: ORDER,
    text: [
      '你在 QQ 上。你看到的消息来自真实的 QQ 群和私聊，你发出去的话会真的出现在那里。',
      '',
      '要让别人看见你，必须调用 qq_send_message。只在会话里"回答"是没人看得见的——',
      '那只写进你自己的记录。target 用推送正文里给出的那个会话键（形如 group:<群号>）。',
      '要在群里 @ 某人，先用 qq_list_group_members 查他的 QQ 号。',
      '',
      '不想回就不用回。群里大多数消息不需要你说话，只有被点名或确实有话可说时才开口。',
    ].join('\n'),
  })
  ctx.logger.info('qq-prompt: 已注册 system prompt 段落 "qq"')
}
