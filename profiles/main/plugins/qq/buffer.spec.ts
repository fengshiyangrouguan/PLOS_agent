/**
 * `buffer.ts` 的自检脚本。
 *
 * 跑法（从 deepseek-harness 跑——tsx 装在那里）：
 * ```powershell
 * cd E:\project\PLOS\deepseek-harness
 * node --import tsx/esm E:\project\PLOS\PLOS_agent\profiles\main\plugins\qq\buffer.spec.ts
 * ```
 *
 * 能这么跑是因为 `buffer.ts` **只 import 类型**，运行时零依赖。
 *
 * 这里重点是**游标语义**：它是"拉"的正确性所在。读多一条会让白羽重复回话，
 * 读少一条会让她漏掉消息，溢出时游标算错更是会静默丢历史。
 *
 * @module qq/buffer.spec
 */

import assert from 'node:assert/strict'
import { MessageBuffer, conversationOf, parseConversation } from './buffer.ts'
import type { QqIncoming } from './adapter.ts'

let passed = 0
let failed = 0

/**
 * 断言相等。
 * @param label - 用例名。
 * @param actual - 实际值。
 * @param expected - 期望值。
 */
function check(label: string, actual: unknown, expected: unknown): void {
  try {
    assert.deepEqual(actual, expected)
    passed += 1
    console.log(`  ok   ${label}`)
  } catch {
    failed += 1
    console.log(`  FAIL ${label}`)
    console.log(`       期望: ${JSON.stringify(expected)}`)
    console.log(`       实际: ${JSON.stringify(actual)}`)
  }
}

/** 造一条入站消息。 */
function msg(id: string, groupId: string | undefined, userId = '1'): QqIncoming {
  return {
    messageId: id,
    groupId,
    userId,
    senderName: `u${userId}`,
    time: Number(id),
    segments: [{ type: 'text', data: { text: `m${id}` } }],
    mentionsSelf: false,
    atUserIds: [],
    groupName: undefined,
    raw: {},
  }
}

console.log('buffer.ts 自检')

// ── 会话键 ──────────────────────────────────────────────────────────
check('群的会话键', conversationOf(msg('1', '999')), 'group:999')
check('私聊的会话键', conversationOf(msg('1', undefined, '42')), 'private:42')
check('会话键往返', parseConversation('group:999'), { kind: 'group', id: '999' })
check('会话键往返（私聊）', parseConversation('private:42'), { kind: 'private', id: '42' })
check('非法会话键', parseConversation('group:'), undefined)
check('非法会话键（无冒号）', parseConversation('999'), undefined)
check('非法会话键（未知类型）', parseConversation('channel:1'), undefined)

// ── 游标：拉的核心 ──────────────────────────────────────────────────
{
  const buffer = new MessageBuffer({ perConversation: 10, conversations: 5 })
  buffer.push(msg('1', 'g'))
  buffer.push(msg('2', 'g'))
  check('初始未读 = 全部', buffer.unread('group:g'), 2)

  const first = buffer.drain('group:g')
  check('drain 返回全部', first.map(m => m.messageId), ['1', '2'])
  check('drain 后未读归零', buffer.unread('group:g'), 0)

  buffer.push(msg('3', 'g'))
  const second = buffer.drain('group:g')
  check('drain 只给增量', second.map(m => m.messageId), ['3'])
  check('增量读后未读归零', buffer.unread('group:g'), 0)
}

// ── peek 不推进 ─────────────────────────────────────────────────────
{
  const buffer = new MessageBuffer({ perConversation: 10, conversations: 5 })
  buffer.push(msg('1', 'g'))
  check('peek 返回内容', buffer.peek('group:g').map(m => m.messageId), ['1'])
  check('peek 不推进游标', buffer.unread('group:g'), 1)
  check('peek 可以再来一次', buffer.peek('group:g').map(m => m.messageId), ['1'])
  check('peek limit 取最近的', (() => {
    buffer.push(msg('2', 'g'))
    buffer.push(msg('3', 'g'))
    return buffer.peek('group:g', 2).map(m => m.messageId)
  })(), ['2', '3'])
}

// ── 会话隔离 ────────────────────────────────────────────────────────
{
  const buffer = new MessageBuffer({ perConversation: 10, conversations: 5 })
  buffer.push(msg('1', 'a'))
  buffer.push(msg('2', 'b'))
  check('两个会话各自独立', buffer.drain('group:a').map(m => m.messageId), ['1'])
  check('另一个会话不受影响', buffer.unread('group:b'), 1)
  check('未知会话返回空', buffer.drain('group:nope'), [])
  check('已知会话列表', buffer.known().sort(), ['group:a', 'group:b'])
}

// ── 溢出：游标记的是序号，不是下标 ──────────────────────────────────
{
  const buffer = new MessageBuffer({ perConversation: 3, conversations: 5 })
  buffer.push(msg('1', 'g'))
  buffer.drain('group:g')
  buffer.push(msg('2', 'g'))
  buffer.push(msg('3', 'g'))
  buffer.push(msg('4', 'g'))
  buffer.push(msg('5', 'g')) // 溢出：丢 2（1 已被 drain 且早已丢弃）
  check('溢出后只保留最近的', buffer.peek('group:g').map(m => m.messageId), ['3', '4', '5'])
  check('溢出不影响未读判定', buffer.unread('group:g'), 3)
  check('溢出后 drain 只给未读', buffer.drain('group:g').map(m => m.messageId), ['3', '4', '5'])
}

// ── 溢出发生在游标之前时，未读仍正确 ────────────────────────────────
{
  const buffer = new MessageBuffer({ perConversation: 2, conversations: 5 })
  buffer.push(msg('1', 'g'))
  buffer.push(msg('2', 'g'))
  buffer.push(msg('3', 'g')) // 丢 1
  // 一条都没读过：游标还是 0，缓冲里剩下 2、3，都该算未读。
  check('游标为零时溢出，未读 = 剩余全部', buffer.unread('group:g'), 2)
  check('drain 给出剩余全部', buffer.drain('group:g').map(m => m.messageId), ['2', '3'])
}

// ── rewind 让已读的重新算未读 ───────────────────────────────────────
{
  const buffer = new MessageBuffer({ perConversation: 10, conversations: 5 })
  buffer.push(msg('1', 'g'))
  buffer.push(msg('2', 'g'))
  buffer.drain('group:g')
  check('rewind 前未读为零', buffer.unread('group:g'), 0)
  buffer.rewind('group:g')
  check('rewind 后全部重新未读', buffer.unread('group:g'), 2)
}

// ── 会话数淘汰 ──────────────────────────────────────────────────────
{
  const buffer = new MessageBuffer({ perConversation: 10, conversations: 2 })
  buffer.push(msg('1', 'a'))
  buffer.push(msg('2', 'b'))
  buffer.push(msg('3', 'c')) // 淘汰最久未活动的 a
  check('会话数超限淘汰最旧的', buffer.known().sort(), ['group:b', 'group:c'])
  check('被淘汰的会话查不到', buffer.drain('group:a'), [])
}

// ── 触摸已存在会话会刷新活跃度 ──────────────────────────────────────
{
  const buffer = new MessageBuffer({ perConversation: 10, conversations: 2 })
  buffer.push(msg('1', 'a'))
  buffer.push(msg('2', 'b'))
  buffer.push(msg('3', 'a')) // a 重新变活跃
  buffer.push(msg('4', 'c')) // 该淘汰 b 而不是 a
  check('触摸过的会话不被淘汰', buffer.known().sort(), ['group:a', 'group:c'])
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
if (failed > 0) process.exitCode = 1
