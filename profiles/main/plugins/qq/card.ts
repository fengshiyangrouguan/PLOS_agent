/**
 * JSON 卡片（分享链接、小程序、音乐等）的文本化。
 *
 * 迁移自实验期 `utils/json_card.py`。`data.data` 是一段**字符串化的 JSON**，
 * 结构由腾讯定义且不保证存在任何字段，所以这里全程防御式取值。
 *
 * @module qq/card
 */

/** 卡片 JSON 里我们认识的字段。 */
interface CardShape {
  prompt?: unknown
  meta?: {
    detail_1?: {
      title?: unknown
      desc?: unknown
      url?: unknown
      qqdocurl?: unknown
    }
    [key: string]: unknown
  }
  [key: string]: unknown
}

/** 取字符串字段；非字符串或空串返回 undefined。 */
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * 把 `json` 段的 `data.data` 解析成一句话。
 *
 * 优先级沿用实验期：`prompt` 优先，其次 `title - desc`，再其次两者之一，
 * 都没有才给 `(无法解析该卡片)`。`url` 非空时以 ` (url)` 追加。
 * @param raw - `data.data`，可能是字符串化 JSON，也可能已经是对象。
 * @returns 卡片文本；**完全解析不出来时返回 undefined**（调用方负责兜底成占位符）。
 */
export function parseJsonCard(raw: unknown): string | undefined {
  let parsed: CardShape
  if (typeof raw === 'string') {
    try {
      const value = JSON.parse(raw) as unknown
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
      parsed = value as CardShape
    } catch {
      return undefined
    }
  } else if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    parsed = raw as CardShape
  } else {
    return undefined
  }

  const detail = parsed.meta?.detail_1
  const title = str(detail?.title)
  const desc = str(detail?.desc)
  const prompt = str(parsed.prompt)
  // `qqdocurl` 优先于 `url`——前者是 QQ 文档链接，后者常是分享短链。
  const url = str(detail?.qqdocurl) ?? str(detail?.url)

  let text: string
  if (prompt !== undefined) {
    text = title === undefined ? prompt : `${title} - ${prompt}`
  } else if (title !== undefined && desc !== undefined) {
    text = `${title} - ${desc}`
  } else if (title !== undefined) {
    text = title
  } else if (desc !== undefined) {
    text = desc
  } else {
    text = '(无法解析该卡片)'
  }

  return url === undefined ? text : `${text} (${url})`
}
