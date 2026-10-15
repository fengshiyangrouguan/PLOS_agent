/**
 * `vlm2text` 能力 seam：**把图片变成一句话**。
 *
 * ## ★ 为什么它是个"服务"，而不是挂在 agent 瀑布上的插件
 *
 * 最初的设想是"在 `agent/request` 里把图换成文字"。**那条路走不通**，两条独立的理由：
 *
 * 1. **`agent/request` 改不了消息。** 它的载荷是 `LlmCallConfig`，只有
 *    provider / model / reasoningEffort / temperature / maxTokens / stop
 *    （`packages/llm/llm/src/call-config.ts:23-30`）——**没有 messages**。
 *    它自己的文档写着：「Model-visible content must use logged channels;
 *    **this waterfall cannot mutate messages**」
 *    （`packages/core/agent/src/runtime-types.ts:327-329`）。
 * 2. **就算能改也不该改。** LOOP 构造的请求是**深冻结**的，而且
 *    "**请求是 session log 的纯函数**"（`packages/llm/llm/src/index.ts:67-72`）。
 *    描述要调外部 VLM，是**非确定性**的 —— 在发请求那一刻现算，就等于让请求
 *    依赖 log 之外的东西。上游把这条路当作**已排除的备选**明确记过：
 *    "**Transform only the outgoing request** … A send-time transformation does
 *    not cover these consumers"（`2026-09-11-plugin-owned-message-projections.md:29`）。
 *
 * **所以它在【源头】把图变成文字**：领域解析消息时就描述掉，于是描述
 * **本身就是消息正文**，从一开始就进 log。请求仍然是 log 的纯函数。
 *
 * ## ★ 它顺带解掉的另一件事：位置是精确的
 *
 * 描述**就地占住图片原来那个段位**（`qq/pipeline/render.ts` 按段序渲染
 * `[图片:描述]`）。所以"哪张图在消息的哪个位置"天然精确 ——
 * 不存在"在文字里回溯不到图在哪"的问题。这是"源头描述"相比
 * "发请求时替换 content block"多出来的一个好处。
 *
 * ## ★ 为什么它仍然"领域无关"
 *
 * 它不认识 QQ，也不知道字节从哪来：只暴露 `ctx.vlm2text.describe(...)`，
 * 谁来调都行（QQ 现在从 `qq/adapter` 的图片描述钩子调；将来的手表 / 新闻 /
 * 手机推送同理）。**领域无关性在"服务"这一层，不在"挂在哪个瀑布"上。**
 *
 * ## 降级
 *
 * **任何失败都返回空串，绝不抛错、绝不阻断消息流转** —— 调用方
 * （`qq/pipeline/segments.ts:88-97`）把空描述渲染成 `[图片]`。
 * 失败**不写缓存** ⇒ 同一张图下次自动重试。判定逻辑全在 `describe.ts`。
 *
 * ## 导出形态
 *
 * 遵守 DSH 的 service 包约定。**不具名导出**。
 *
 * @module vlm2text
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { BlockAssembler, LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, RequestMessage } from '@deepseek-ai/dsh-llm'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { recordStartupLine } from '../_startup-log.ts'
import { Config as ConfigSchema, type Config } from './config.ts'
import { describeWithCache, type DescribeInput, type DescribeResult } from './describe.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 图片 → 一句话。**领域无关**：谁有图片字节谁来调。 */
    vlm2text: VlmToText
  }
}

/**
 * 图片描述设施，注册为 `ctx.vlm2text`。
 */
export class VlmToText extends Service {
  static Config: z<Config> = ConfigSchema

  /**
   * `llm` 调 VLM；`db` 存描述缓存；`tcb` 拿 VLM 的模型配置；
   * `attachments` 把字节变成耐久附件 —— **图片进请求只能是附件引用**
   * （`ImageBlock.attachment` 是 `ImageAttachmentRef`，不是 base64）。
   */
  static inject = ['llm', 'db', 'tcb', 'attachments']

  private readonly config: Config

  /**
   * ★ **单飞表**：同一张图**还没落定**时只调一次 VLM。
   *
   * 键直接用 **base64 ＋ MIME** —— 它本来就是"这张图是什么"的唯一标识，
   * 不必再算一遍哈希（`describe.ts` 里那次哈希是给**缓存**用的，这里不需要）。
   *
   * ## 为什么需要它（实测 2026-10-15）
   *
   * 同一张图会被**两条路**各调一次：
   *   · `qq/signals` 的 **归档**（`archive` → `render`）
   *   · **她自己的读取**（`qq_read` → `render`）
   * 两条路并行 ⇒ 两次调用可能都在跑（实测 VLM 单次 1.2~38.5 秒）⇒ **白花钱、白等**。
   *
   * ⚠️ 存的必须是**没被超时赛跑过的那个 promise**（`describeWithCache` 的完整 promise）——
   * 这样第二个调用方**有自己的超时窗口**：第一个在 10 秒超时返回占位之后，
   * 第二个仍可能等到描述落定 ✓（若存赛跑后的，第二个会立刻拿到空占位）。
   */
  private readonly inflight = new Map<string, Promise<string>>()

  /**
   * @param ctx - 本插件的上下文。
   * @param config - 配置。
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'vlm2text')
    this.config = config
  }

  /**
   * 构造完成之后运行：把"用哪个模型描述图片"登记进启动自述。
   *
   * 值得自述，因为 VLM 配错的**表现是静默的** —— 图片全都变成 `[图片]`，
   * 看起来跟"没接描述"一模一样。在这里点出 TCB 的名字和模型，
   * 排障时一眼能看出是不是写错了 id。
   */
  async *[Service.init](): AsyncGenerator<() => void, void, void> {
    yield () => { /* 没有待清理的资源：缓存归 db 管，服务是无状态的 */ }

    const tcb = this.ctx.tcb.get(this.config.vlmTcb)
    recordStartupLine(
      tcb === undefined
        ? `vlm2text: ★ TCB "${this.config.vlmTcb}" 不在 data/tcb.json 里 —— 图片描述会全部降级为 [图片]`
        : `vlm2text: 用 TCB "${tcb.id}"（${tcb.model.provider}/${tcb.model.model}）描述图片，缓存进 db`,
    )
  }

  /**
   * 描述一张图。**永不抛错** —— 失败返回空串。
   *
   * @param input - base64 字节、MIME 类型、是否表情包。
   * @returns 一句话描述；任何失败都返回空串（调用方据此渲染 `[图片]`）。
   */
  async describe(input: DescribeInput): Promise<string> {
    // ★★ **超时不是 abort，而是"先还占位、让整条路继续跑完"。**
    //
    //   `describeWithCache` 本来就以**写缓存**结尾，所以只要**让这个 promise 活着**，
    //   它跑完就会把描述写进缓存 ⇒ 第二阶段用 `render(…, { fresh: true })` 重渲染
    //   就能命中缓存、拿到真描述 ⇒ 那次「【图片已渲染完成】」的唤醒才**有物可等**。
    //
    //   （早先这里是 `AbortController` 超时即中止，**那就永远等不到"好了"**。）
    //
    //   超时返回**空串** = 走 `describe.ts` 已有的"失败"那条路：不写缓存、
    //   渲染成 `[图片]`、下次同一张图自动重试 ✓
    // ★ **单飞**：这张图若**已经在调**，就搭同一趟车，别再调一次。
    //
    //   两条路会同时要同一张图的描述（`signals` 的归档 ＋ 她自己的 `qq_read`），
    //   而 VLM 单次实测 1.2~38.5 秒 ⇒ 不去重就是白花钱、白等。
    //
    //   ⚠️ 存进去的是**没被赛跑过的那个 promise**：第二个调用方因此有**自己的超时窗口**
    //   （第一个 10 秒超时返回占位之后，第二个仍可能等到描述落定）。
    const key = `${input.mimeType}:${input.base64}`
    let full = this.inflight.get(key)
    if (full === undefined) {
      full = describeWithCache({
        cache: this.ctx.db.imageDescriptions,
        call: (bytes, mediaType) => this.callVlm(bytes, mediaType),
        now: () => Date.now(),
        log: (level, message) => {
          if (level === 'warn') this.ctx.logger.warn(message)
          else this.ctx.logger.debug(message)
        },
      }, input)
      this.inflight.set(key, full)
      // 落定就摘（成功失败都摘）—— 成功的结果归**缓存**管，这里只管"在飞的"。
      // `describeWithCache` 永不抛错，`.catch` 只是防御。
      void full.finally(() => { this.inflight.delete(key) }).catch(() => { /* 不会发生 */ })
    }

    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<string>((resolve) => {
      timer = setTimeout(() => { resolve('') }, this.config.timeoutMs)
    })
    try {
      return await Promise.race([full, timeout])
    } finally {
      // 只清定时器，**不动 `full`** —— 它要继续跑完才会写缓存。
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /**
   * 真正去调 VLM：把字节存成附件，构造一条带图的请求，收集返回的文本。
   *
   * @param bytes - 图片原始字节。
   * @param mediaType - 已收窄的图片类型。
   * @returns 描述文本与"能不能缓存"。
   * @throws 当 TCB 不存在、附件存不进去、或请求以失败结束时。
   */
  private async callVlm(bytes: Uint8Array, mediaType: ImageMediaType): Promise<DescribeResult> {
    const tcb = this.ctx.tcb.get(this.config.vlmTcb)
    if (tcb === undefined) throw new Error(`TCB "${this.config.vlmTcb}" 不在 data/tcb.json 里`)

    // 图片只能以**耐久附件**的形式进请求。所以先把字节存进附件仓库、拿一个引用。
    // ★ 这只是**运输** —— 这个引用不进 session log（描述才是进 log 的东西），
    //   所以它不破坏"请求是 log 的纯函数"：这一条请求本来就不经过 loop。
    const ref = await this.ctx.attachments.saveImage({ data: bytes, mediaType })

    const messages: RequestMessage[] = [
      deepFreeze({
        role: 'user',
        content: [
          { type: 'text', text: this.config.prompt },
          { type: 'image', attachment: ref },
        ],
      }),
    ]

    const options: GenerateOptions = {
      provider: tcb.model.provider,
      model: tcb.model.model,
      messages,
      ...tcb.model.temperature === undefined ? {} : { temperature: tcb.model.temperature },
      ...tcb.model.maxTokens === undefined ? {} : { maxTokens: tcb.model.maxTokens },
    }

    const assembler = new BlockAssembler()
    // ⚠️ **这里刻意不设超时、也不 abort。**
    //
    // 超时发生在**上一层**（`describe` 用 `Promise.race`）：那里超时后**提前返回占位**，
    // 而**这一次调用继续跑完并写缓存** —— 那正是第二阶段
    // （`render(…, { fresh: true })` ⇒ 缓存命中 ⇒ 真描述 ⇒ 【图片已渲染完成】）成立的前提。
    //
    // 曾经这里是 `AbortController` 超时即 `abort()`。**那是错的**：被中止的调用
    // **永远不会有"好了"** ⇒ 第二次唤醒无物可等。（我还在提交信息里写了
    // "后台那次仍会跑完并写缓存" —— 与 abort 直接矛盾。）
    for await (const chunk of this.ctx.llm.stream(options)) {
      assembler.push(chunk)
    }

    const finish = assembler.finish
    if (finish.kind === 'error' || finish.kind === 'aborted') {
      // 带上 provider 的结构化失败事实（`code` 是共享分类，如 AUTH / RATE_LIMIT）。
      throw new LlmError(finish.failure.message, finish.failure.code, finish.failure)
    }

    const text = assembler.blocks()
      .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
      .map(block => block.text)
      .join('')
      .trim()

    if (text === '') {
      throw new Error(`VLM（${tcb.model.model}）没有返回任何文本（finish=${finish.kind}）`)
    }

    // ★ 截断的描述**这次照用，但不写缓存** —— 它是残句，不该被固化下来；
    //   下次遇到同一张图会再要一份完整的（见 describe.ts 的三条不变量）。
    return {
      text,
      provider: tcb.model.provider,
      model: tcb.model.model,
      cacheable: finish.kind !== 'max-tokens',
    }
  }
}

export default VlmToText
