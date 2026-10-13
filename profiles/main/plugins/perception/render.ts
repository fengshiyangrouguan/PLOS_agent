/**
 * 感知层的渲染：**纯函数，零 I/O**。
 *
 * ## 为什么必须是纯的
 *
 * 和 `qq/pipeline/render.ts` 同一条纪律（计划 §0.2 的分层）：
 * `pull()` 负责取数据（可以慢、可以有 I/O、可以降级），
 * 渲染负责拼文本（**必须纯**，需要的数据早已在信号里）。
 *
 * ## 渲染成什么（docs/design.md §4.5）
 *
 * ```
 * 2026-10-13 20:00
 *
 * 【QQ】
 * 群「古乐の秘♂密基地（id:xxx）」里有人 @ 了你
 * 李四(id:xxx) 私聊了你
 *
 * 【手表】
 * 状态感知：进入睡眠2h，浅睡眠阶段
 * 心率：70
 * ```
 *
 * **领域给模板 + 数据，感知层负责拼装**（时间戳、`【域名】` 分节、`\n\n` 分段）。
 * 允许各领域用自己的话术 —— 手表的"浅睡眠阶段"和 QQ 的"有人 @ 了你"词汇完全不同，
 * 硬要统一反而别扭；但**统一性由这里保证**。
 *
 * 本模块只依赖 `types.ts`，可离线自检（`tests/render.spec.ts`）。
 *
 * @module perception/render
 */

import {
  PRIORITY_MAX, PRIORITY_PASSIVE,
  type PerceptionNotice, type ResolvedSignal, type Signal, type SignalSource,
} from './types.ts'

/** 一个领域本轮拉到的信号。 */
export interface DomainGroup {
  readonly source: SignalSource
  readonly signals: readonly Signal[]
}

/**
 * 把时间戳格式化成简报头（`YYYY-MM-DD HH:mm`，24 小时制，本地时区）。
 * @param at - 毫秒时间戳。
 * @returns 形如 `2026-10-13 20:00` 的字符串。
 */
export function formatTimestamp(at: number): string {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + ` ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * 把模板里的 `{key}` 用数据代入。
 *
 * **缺字段是错误，不静默留空** —— 一个渲染出 `{senderName}` 的简报
 * 会让她以为那就是人名。宁可拉取失败，也不要喂残缺的事实。
 *
 * @param template - 模板文本。
 * @param data - 占位符取值。
 * @returns 代入后的文本。
 * @throws 当模板引用了 `data` 里没有的键。
 */
export function applyTemplate(
  template: string,
  data: Readonly<Record<string, string | number>>,
): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => {
    const value = data[key]
    if (value === undefined) {
      throw new Error(`感知模板引用了不存在的字段 "{${key}}"（模板：${template}）`)
    }
    return String(value)
  })
}

/**
 * 算出一条信号生效的优先级。
 *
 * `Signal.priority` 覆盖领域的基准值；两者都缺时按**被动**（0）处理 ——
 * 一个没声明优先级的领域不该能唤醒她。
 *
 * @param signal - 信号。
 * @param domainPriority - 领域注册的基准优先级。
 * @returns 生效的优先级，已夹在 `0..100`。
 */
export function effectivePriority(signal: Signal, domainPriority?: number | undefined): number {
  const raw = signal.priority ?? domainPriority ?? PRIORITY_PASSIVE
  if (!Number.isFinite(raw)) return PRIORITY_PASSIVE
  return Math.min(PRIORITY_MAX, Math.max(PRIORITY_PASSIVE, Math.trunc(raw)))
}

/**
 * 渲染一轮简报。
 *
 * 领域顺序 = `groups` 的顺序（注册顺序）；组内保持 `pull` 返回的顺序。
 * **不做排序** —— 领域自己知道什么该先说。
 *
 * @param at - 本轮生成时间（毫秒）。
 * @param groups - 各领域本轮拉到的信号。
 * @returns 渲染好的感知条目。
 * @throws 当某条信号的 `kind` 在领域模板表里找不到。
 */
export function renderNotice(at: number, groups: readonly DomainGroup[]): PerceptionNotice {
  const resolved: ResolvedSignal[] = []
  const sections: string[] = []

  for (const group of groups) {
    if (group.signals.length === 0) continue
    const lines: string[] = []
    for (const signal of group.signals) {
      const template = group.source.templates[signal.kind]
      if (template === undefined) {
        throw new Error(
          `领域 "${group.source.domain}" 没有为信号种类 "${signal.kind}" 注册模板`
          + `（已注册：${Object.keys(group.source.templates).join('、') || '无'}）`,
        )
      }
      const line = applyTemplate(template, signal.data)
      lines.push(line)
      resolved.push({
        ...signal,
        domain: group.source.domain,
        priority: effectivePriority(signal, group.source.priority),
        line,
      })
    }
    sections.push(`【${group.source.domain}】\n${lines.join('\n')}`)
  }

  const text = sections.length === 0
    ? ''
    : `${formatTimestamp(at)}\n\n${sections.join('\n\n')}\n`

  const highest = resolved.reduce(
    (max, signal) => Math.max(max, signal.priority),
    PRIORITY_PASSIVE,
  )

  return {
    at,
    text,
    signals: resolved,
    highest,
    quiet: highest === PRIORITY_PASSIVE,
  }
}
