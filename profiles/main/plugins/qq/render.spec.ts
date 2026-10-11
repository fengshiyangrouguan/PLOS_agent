/**
 * `render.ts` 的自检脚本。
 *
 * ## 为什么不是测试框架
 *
 * 这个 profile 没有测试运行器，而为了渲染器引一整套测试基建不划算。这里用
 * `node:assert` 直接断言，跑法：
 *
 * ```powershell
 * cd E:\project\PLOS\deepseek-harness
 * node --import tsx/esm E:\project\PLOS\PLOS_agent\profiles\main\plugins\qq\render.spec.ts
 * ```
 *
 * 之所以能这么跑，是因为 `render.ts` **只 import 类型**，运行时零依赖。
 *
 * ## 它的价值
 *
 * 那些方括号和冒号是模型要反复读的形状，改一个字符都可能影响理解。真实 QQ 流量
 * 又不可能稳定复现每种段型（尤其转发、嵌套、降级），所以格式必须**离网钉死**。
 *
 * @module qq/render.spec
 */

import assert from 'node:assert/strict'
import { renderSegments, renderForwardBlock } from './render.ts'
import type { ForwardBlock, ResolvedSegment } from './segment.ts'

let passed = 0
let failed = 0

/**
 * 断言渲染结果。
 * @param label - 用例名。
 * @param segments - 输入段。
 * @param expected - 期望文本。
 */
function check(label: string, segments: ResolvedSegment[], expected: string): void {
  const actual = renderSegments(segments)
  try {
    assert.equal(actual, expected)
    passed += 1
    console.log(`  ok   ${label}`)
  } catch {
    failed += 1
    console.log(`  FAIL ${label}`)
    console.log(`       期望: ${JSON.stringify(expected)}`)
    console.log(`       实际: ${JSON.stringify(actual)}`)
  }
}

console.log('render.ts 自检')

// ── 基础段 ──────────────────────────────────────────────────────────
check('纯文本', [{ kind: 'text', text: '你好' }], '你好')

check('文本直拼无分隔符', [
  { kind: 'text', text: 'a' },
  { kind: 'text', text: 'b' },
], 'ab')

check('表情（表里的值已带方括号）', [
  { kind: 'text', text: '笑死' },
  { kind: 'face', label: '[表情：笑哭]' },
], '笑死[表情：笑哭]')

check('@ 带昵称（尾随一个空格）', [
  { kind: 'mention', display: '张三', userId: '123' },
  { kind: 'text', text: '在吗' },
], '@张三 在吗')

check('@ 查不到昵称时降级', [
  { kind: 'mention', display: 'user_id=123', userId: '123' },
], '@user_id=123 ')

check('@全体成员', [
  { kind: 'mention', display: '全体成员', userId: 'all' },
], '@全体成员 ')

// ── 图片三态 ────────────────────────────────────────────────────────
check('图片有描述', [
  { kind: 'image', sticker: false, description: '一只猫', failed: false },
], '[图片:一只猫]')

check('图片下载失败', [
  { kind: 'image', sticker: false, description: '', failed: true },
], '[图片:(下载失败)]')

check('图片无描述（未接 VLM）', [
  { kind: 'image', sticker: false, description: '', failed: false },
], '[图片]')

check('动画表情', [
  { kind: 'image', sticker: true, description: '熊猫头', failed: false },
], '[动画表情:熊猫头]')

// ── 引用 ────────────────────────────────────────────────────────────
check('引用有正文', [{
  kind: 'reply', messageId: '123', senderName: '张三', preview: '早上好',
}], '[回复张三的消息:早上好(msg_id=123)]:')

check('引用无正文', [{
  kind: 'reply', messageId: '123', senderName: '张三', preview: undefined,
}], '[回复张三的消息:[消息(msg_id=123)]]:')

check('引用查不到（连发送者都没有）', [{
  kind: 'reply', messageId: '123', senderName: undefined, preview: undefined,
}], '[回复消息(msg_id=123)]:')

// ── 其余单段 ────────────────────────────────────────────────────────
check('视频', [{ kind: 'video', url: 'http://x', localPath: undefined }], '[视频消息]')

check('卡片', [{ kind: 'card', text: '标题 - 描述 (http://x)' }], '[卡片: 标题 - 描述 (http://x)]')

check('卡片解析失败', [{ kind: 'card', text: undefined }], '[卡片: 暂时无法处理该类型的消息]')

check('未知段', [{ kind: 'unknown', type: 'mface' }], '[mface]')

// ── 转发 ────────────────────────────────────────────────────────────
const block: ForwardBlock = {
  title: '群聊的聊天记录',
  messageId: '999',
  messages: [
    { senderName: '张三', segments: [{ kind: 'text', text: '早上好' }], nested: undefined },
    {
      senderName: '李四',
      segments: [
        { kind: 'text', text: '早' },
        { kind: 'image', sticker: false, description: '一只猫', failed: false },
      ],
      nested: undefined,
    },
  ],
  truncated: 0,
}

check('转发展开（转发内图片用裸描述，不加包裹）', [
  { kind: 'forward', block, xmlSummary: undefined },
], [
  '[群聊的聊天记录(msg_id = 999)]',
  '  张三: 早上好',
  '  李四: 早 一只猫',
].join('\n'))

check('转发达上限补一行', [
  {
    kind: 'forward',
    block: { ...block, truncated: 48 },
    xmlSummary: undefined,
  },
], [
  '[群聊的聊天记录(msg_id = 999)]',
  '  张三: 早上好',
  '  李四: 早 一只猫',
  '  …（已达展开上限 50 条，其余省略）',
].join('\n'))

check('转发完全解析失败', [
  { kind: 'forward', block: undefined, xmlSummary: undefined },
], '[聊天记录(解析失败)]')

check('转发有 XML 摘要时优先用摘要（原样，不缩进）', [
  { kind: 'forward', block: undefined, xmlSummary: '张三: 早上好\n李四: 早' },
], '张三: 早上好\n李四: 早')

// ── 嵌套与省略 ──────────────────────────────────────────────────────
const nested: ForwardBlock = {
  title: '聊天记录',
  messageId: '888',
  messages: [{ senderName: '王五', segments: [{ kind: 'text', text: '在的' }], nested: undefined }],
  truncated: 0,
}

check('嵌套块缩进 +1 层（与实验期不同，见 render.ts 注释）', [
  {
    kind: 'forward',
    block: {
      title: '群聊的聊天记录',
      messageId: '999',
      messages: [{
        senderName: '张三',
        segments: [{ kind: 'text', text: '看这个' }],
        nested,
      }],
      truncated: 0,
    },
    xmlSummary: undefined,
  },
], [
  '[群聊的聊天记录(msg_id = 999)]',
  '  张三: 看这个',
  '  [聊天记录(msg_id = 888)]',
  '    王五: 在的',
].join('\n'))

check('嵌套超深度省略', [
  { kind: 'forward', block: undefined, xmlSummary: undefined },
], '[聊天记录(解析失败)]')

// `renderForwardBlock` 单独验证"已省略"与"解析失败"的区别。
try {
  assert.equal(renderForwardBlock(undefined, 1), '  [嵌套转发已省略]')
  assert.equal(renderForwardBlock(undefined, 1, true), '  [聊天记录(解析失败)]')
  passed += 1
  console.log('  ok   嵌套省略 vs 解析失败（缩进保留）')
} catch {
  failed += 1
  console.log('  FAIL 嵌套省略 vs 解析失败')
}

// ── 边界 ────────────────────────────────────────────────────────────
check('空段数组', [], '')

check('转发内空正文不占行', [
  {
    kind: 'forward',
    block: {
      title: '聊天记录',
      messageId: '1',
      messages: [
        { senderName: '张三', segments: [], nested: undefined },
        { senderName: '李四', segments: [{ kind: 'text', text: '有内容' }], nested: undefined },
      ],
      truncated: 0,
    },
    xmlSummary: undefined,
  },
], [
  '[聊天记录(msg_id = 1)]',
  '  李四: 有内容',
].join('\n'))

console.log(`\n通过 ${passed}，失败 ${failed}`)
if (failed > 0) process.exitCode = 1
