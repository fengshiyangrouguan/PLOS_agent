/**
 * 原始帧采集 —— **实验素材**，不是运行日志。
 *
 * ## 它解决什么问题
 *
 * OneBot 的帧有十几类（`message` / `meta_event` / `notice` / `request` /
 * `message_sent` / 调用回执……），而我们现在**只解析其中两类**，其余连形状都没留下。
 * 于是每次要动一个没处理过的类型（合并转发、戳一戳、撤回、好友请求……），
 * 都只能靠"造一条真消息再看"—— 而造不出来的（越权、敏感、别人的私聊）就永远查不了。
 *
 * 有了它，**素材是先攒着的**，要用的时候直接翻。
 *
 * ## ★ 为什么是"计数 + 每类 N 条样本"，不是全量日志
 *
 * 全量写会**无限增长**（两个几百人的群天天刷，加上每条调用的回执），
 * 而"要素材"这个目标需要的恰恰是**样本**。消息的全量归档已经由 `messages` 表在做，
 * 这里再存一份全量是重复。
 *
 * 所以：每类记一个**计数**（看频率分布）＋ 前 `samplesPerKind` 条**完整原始帧**
 * （看形状）。文件大小因此有硬上限，与流量无关。
 *
 * ## 落盘时机
 *
 * 新增一条样本时**立刻**落盘（样本稀少，值得立刻保住）；
 * 计数则按 `FLUSH_MS` 定期落盘 —— 只有计数变化时每次写盘太费。
 * 卸载时再落一次。
 *
 * **整体是覆盖写，不是追加**：它表达的是"本次运行攒到的素材"这一份快照。
 * 用临时文件 + 改名落盘，避免半截文件（与 `ctx.pointer` 同一套做法）。
 *
 * ## ⚠️ 里面是**原样**的私聊与群聊内容
 *
 * 不脱敏 —— 脱敏后的素材就没用了（要的就是原样的字段名与形状）。
 * 所以它必须落在**不进版本库**的地方（`data/` 已被 `.gitignore` 覆盖），
 * 而且**默认关**：它是"要素材时才开"的东西，不是常开日志。
 *
 * @module qq/adapter/capture
 */

import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** 采集配置。 */
export interface CaptureOptions {
  /** 落盘路径。 */
  readonly path: string
  /** 每类保留多少条完整样本。 */
  readonly samplesPerKind: number
}

/** 计数定期落盘的间隔（毫秒）。 */
const FLUSH_MS = 10_000

/** 一类的账。 */
interface KindRecord {
  /** 见过多少条。 */
  count: number
  /** 前若干条完整样本。 */
  samples: unknown[]
}

/**
 * 原始帧采集器。
 */
export class FrameCapture {
  private readonly options: CaptureOptions
  private readonly kinds = new Map<string, KindRecord>()
  private timer: NodeJS.Timeout | undefined

  /**
   * @param options - 采集配置。
   */
  constructor(options: CaptureOptions) {
    this.options = options
  }

  /** 起定期落盘的定时器。 */
  start(): void {
    this.timer = setInterval(() => { this.flush() }, FLUSH_MS)
  }

  /** 停定时器并落最后一次盘。 */
  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
    this.flush()
  }

  /**
   * 记一帧。
   *
   * @param kind - 帧的类别（`echo` / `message` / `notice` / …）。
   * @param frame - **完整原始帧**（原样，不裁剪 —— 素材的价值就在字段全）。
   * @param request - 回执帧专用：我们**发出去**的 action 与 params。
   *   「我发了什么 / 它回了什么」必须成对看，否则一个 `{status:'failed'}` 不知道对应哪个请求。
   */
  note(kind: string, frame: unknown, request?: unknown): void {
    let record = this.kinds.get(kind)
    if (record === undefined) {
      record = { count: 0, samples: [] }
      this.kinds.set(kind, record)
    }
    record.count += 1

    if (record.samples.length >= this.options.samplesPerKind) return
    record.samples.push(request === undefined ? { frame } : { request, frame })
    // 样本稀少（每类最多 N 条），值得立刻保住。
    this.flush()
  }

  /** 把当前快照覆盖写到盘上。 */
  flush(): void {
    const body = `${JSON.stringify({
      // 时间是给人看的，用来判断"这份素材是什么时候攒的"。
      flushedAt: Date.now(),
      samplesPerKind: this.options.samplesPerKind,
      kinds: Object.fromEntries(
        [...this.kinds.entries()].map(([kind, record]) => [kind, {
          count: record.count,
          samples: record.samples,
        }]),
      ),
    }, null, 2)}\n`
    try {
      mkdirSync(dirname(this.options.path), { recursive: true })
      const tmp = `${this.options.path}.tmp`
      writeFileSync(tmp, body, 'utf8')
      renameSync(tmp, this.options.path)
    } catch {
      // 采集失败**绝不能影响收消息** —— 它只是素材，丢了就丢了。
      // 这里是唯一刻意吞掉异常的地方（连 `logger` 都不打：logger 本身也可能有问题）。
    }
  }
}
