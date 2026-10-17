/**
 * `notice.ts` 的自检 —— 通知／申请 → 感知信号的映射。
 *
 * 跑法（和其它 spec 一样，从 `deepseek-harness` 跑）：
 * ```powershell
 * cd E:\project\PLOS\deepseek-harness
 * node --import tsx/esm E:\project\PLOS\PLOS_agent\profiles\main\plugins\qq\signals\tests\notice.spec.ts
 * ```
 *
 * ## 这里重点验什么
 *
 * ★★ 素材**全部是抓帧抓到的真实帧** ✓（2026-10-15，见 `PLOS/docs/qq-notifications.md` §二/§三 ✓）——
 * 不是照着印象编的 ✗（这条在 `AGENTS.md` §一 里已经付过代价 ✓）。
 *
 * 1. ★★★ **`notify/input_status` 必须被丢掉** —— 实测它占 11 个 notice 里的 3 个，
 *    而且**对方每打一个字都推** ⇒ 收了它 = 她被无限唤醒 ✗✗。**这是本文件最重要的一条** ✓。
 * 2. ★★ **"是不是我"看 `user_id === selfId`**，不是看 `sub_type` ✓（实测证实 ✓）
 * 3. ★★ **申请类全是 `todo` ＋ 带 `flag`** ✓（要等她处理完才清 ✓）；**没有 `flag` 的要丢掉** ✗
 * 4. ★ **级别**：申请／戳／进退群 = 20 ✓；禁言／撤回／别人当管理 = 0 ✓
 * 5. ★ **指纹稳定**（同一件事 ⇒ 同一个指纹 ⇒ 只进列表一次 ✓）
 * 6. ★ **未知通知 ⇒ undefined**（宁可先丢 ✓）
 *
 * @module qq/signals/notice-spec
 */

import assert from 'node:assert/strict'
import {
  PRIORITY_DIRECT,
  PRIORITY_PASSIVE,
  mapNotice,
  mapRequest,
  requestPendingKey,
} from '../notice.ts'

let passed = 0
let failed = 0

/**
 * 跑一个断言。
 *
 * @param label - 说明。
 * @param fn - 断言体（抛错即失败 ✓）。
 */
function check(label: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`  ok   ${label}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${label}`)
    console.log(`       ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 机器人自己（她是 352699068 ✓）。 */
const SELF = '352699068'

/** 测试用的映射上下文（★ 兜底由调用方给 ✓ —— 这里模拟"库里没有名字" ✓）。 */
const CTX = {
  selfId: SELF,
  nameOfGroup: (id: string) => (id === '784394807' ? '测试群' : `群${id}`),
  nameOfConversation: (id: string) => (id === 'private:2673439877' ? '冯氏羊肉馆' : id),
}

// ── ★★★ 最重要的一条：input_status 必须丢掉 ─────────────────────────
check('★★★ `notify/input_status`（对方正在输入）**被丢掉** ✗ —— 否则对方每打一个字都唤醒她', () => {
  const frame = {
    time: 1792057655, self_id: 352699068, post_type: 'notice',
    notice_type: 'notify', sub_type: 'input_status', user_id: 2215397214,
    event_type: 2, status_text: '对方正在输入...',
  }
  assert.equal(mapNotice(frame, CTX), undefined)
})

check('未知的 `notify` 子类型也丢掉（白名单制 ✓）', () => {
  assert.equal(mapNotice({ notice_type: 'notify', sub_type: 'something_new' }, CTX), undefined)
})

// ── 戳一戳（★ 私聊 / 群 两种说法 ✓）─────────────────────────────────
check('私聊戳一戳 ⇒ `pokePrivate` ＋ 20 级', () => {
  const mapped = mapNotice({
    time: 1792057707, notice_type: 'notify', sub_type: 'poke',
    user_id: 2673439877, sender_id: 2673439877, target_id: 352699068,
    action: '戳了戳', suffix: '', action_img_url: 'http://x/y.jpg',
  }, CTX)
  assert.ok(mapped !== undefined)
  assert.equal(mapped.kind, 'pokePrivate')
  assert.equal(mapped.priority, PRIORITY_DIRECT)
  assert.equal(mapped.signalClass, 'event')
  assert.equal(mapped.data.sender, '冯氏羊肉馆')
})

check('群戳一戳 ⇒ `pokeGroup`（带群名与群号 ✓）', () => {
  const mapped = mapNotice({
    notice_type: 'notify', sub_type: 'poke', group_id: 784394807,
    user_id: 2673439877, sender_id: 2673439877,
  }, CTX)
  assert.ok(mapped !== undefined)
  assert.equal(mapped.kind, 'pokeGroup')
  assert.deepEqual(mapped.data, { name: '测试群', id: '784394807', sender: '2673439877' })
  assert.equal(mapped.source, 'group:784394807')
})

// ── 进群（★ 判"是不是我"）─────────────────────────────────────────
check('★★ 她被邀请进群 ⇒ `joinedSelf`（`user_id` 是她 ⇒ sub_type=invite）', () => {
  const mapped = mapNotice({
    time: 1792057801, notice_type: 'group_increase', sub_type: 'invite',
    group_id: 784394807, operator_id: 2673439877, user_id: 352699068,
  }, CTX)
  assert.ok(mapped !== undefined)
  assert.equal(mapped.kind, 'joinedSelf')
  assert.equal(mapped.data.operator, '2673439877')
})

check('她自己被批准进群 ⇒ `joinedSelfApprove`（同一种 notice，靠 user_id 分 ✓）', () => {
  const mapped = mapNotice({
    notice_type: 'group_increase', sub_type: 'approve',
    group_id: 784394807, operator_id: 2673439877, user_id: 352699068,
  }, CTX)
  assert.ok(mapped !== undefined)
  assert.equal(mapped.kind, 'joinedSelfApprove')
})

check('★ 别人进群 ⇒ `memberJoined`（还是 20 级 —— 用户定案 ✓）', () => {
  const mapped = mapNotice({
    time: 1792057882, notice_type: 'group_increase', sub_type: 'approve',
    group_id: 784394807, operator_id: 2673439877, user_id: 3904591191,
  }, CTX)
  assert.ok(mapped !== undefined)
  assert.equal(mapped.kind, 'memberJoined')
  assert.equal(mapped.priority, PRIORITY_DIRECT)
  assert.equal(mapped.data.user, '3904591191')
})

// ── 退群（四种 sub_type ✓）────────────────────────────────────────
check('★ 她被踢 ⇒ `kickedSelf`', () => {
  const mapped = mapNotice({
    time: 1792057777, notice_type: 'group_decrease', sub_type: 'kick_me',
    group_id: 784394807, operator_id: 2673439877, user_id: 352699068,
  }, CTX)
  assert.equal(mapped?.kind, 'kickedSelf')
  assert.equal(mapped?.priority, PRIORITY_DIRECT)
})

check('群解散 ⇒ `groupDisbanded`', () => {
  const mapped = mapNotice({
    notice_type: 'group_decrease', sub_type: 'disband', group_id: 784394807, user_id: 1,
  }, CTX)
  assert.equal(mapped?.kind, 'groupDisbanded')
})

check('★ 别人被踢 ⇒ `memberKicked`（20 级 ✓）', () => {
  const mapped = mapNotice({
    time: 1792057965, notice_type: 'group_decrease', sub_type: 'kick',
    group_id: 784394807, operator_id: 2673439877, user_id: 3904591191,
  }, CTX)
  assert.equal(mapped?.kind, 'memberKicked')
  assert.equal(mapped?.data.user, '3904591191')
})

check('★ 别人退群 ⇒ `memberLeft`（20 级 —— 用户定案 ✓）', () => {
  const mapped = mapNotice({
    notice_type: 'group_decrease', sub_type: 'leave', group_id: 784394807, user_id: 42,
  }, CTX)
  assert.equal(mapped?.kind, 'memberLeft')
  assert.equal(mapped?.priority, PRIORITY_DIRECT)
})

check('★ 未知的 group_decrease 子类型 ⇒ 当"有人退了"报出来（不静默丢 ✗）', () => {
  const mapped = mapNotice({
    notice_type: 'group_decrease', sub_type: 'brand_new_kind', group_id: 784394807, user_id: 42,
  }, CTX)
  assert.equal(mapped?.kind, 'memberLeft')
})

// ── 禁言（⬜ 形状来自转换器源码 —— 还没抓到样本 ✓）──────────────────
check('禁言 ⇒ `muted` ＋ 0 级 ＋ duration 写成人话', () => {
  const mapped = mapNotice({
    notice_type: 'group_ban', sub_type: 'ban', group_id: 784394807,
    operator_id: 2673439877, user_id: 42, duration: 600,
  }, CTX)
  assert.ok(mapped !== undefined)
  assert.equal(mapped.kind, 'muted')
  assert.equal(mapped.priority, PRIORITY_PASSIVE)
  assert.equal(mapped.data.duration, '10 分钟')
})

check('解除禁言 ⇒ `unmuted`（`duration` 是 0 ⇒ 空串 ✓）', () => {
  const mapped = mapNotice({
    notice_type: 'group_ban', sub_type: 'lift_ban', group_id: 784394807, user_id: 42, duration: 0,
  }, CTX)
  assert.equal(mapped?.kind, 'unmuted')
  assert.equal(mapped?.data.duration, '')
})

// ── 管理权限（★ 她是 20，别人是 0 ✓）───────────────────────────────
check('★ 她成了管理 ⇒ `adminSelf` ＋ 20 级', () => {
  const mapped = mapNotice({
    time: 1792057858, notice_type: 'group_admin', sub_type: 'set',
    group_id: 784394807, user_id: 352699068,
  }, CTX)
  assert.equal(mapped?.kind, 'adminSelf')
  assert.equal(mapped?.priority, PRIORITY_DIRECT)
})

check('★ 别人成了管理 ⇒ `adminOther` ＋ 0 级', () => {
  const mapped = mapNotice({
    notice_type: 'group_admin', sub_type: 'set', group_id: 784394807, user_id: 99,
  }, CTX)
  assert.equal(mapped?.kind, 'adminOther')
  assert.equal(mapped?.priority, PRIORITY_PASSIVE)
})

// ── 撤回 ──────────────────────────────────────────────────────────
check('群撤回 ⇒ `groupRecall` ＋ 0 级（指纹用 message_id ✓）', () => {
  const mapped = mapNotice({
    time: 1792057789, notice_type: 'group_recall', group_id: 1063864763,
    operator_id: 3569735266, user_id: 3569735266, message_id: 1445111480,
  }, CTX)
  assert.equal(mapped?.kind, 'groupRecall')
  assert.equal(mapped?.priority, PRIORITY_PASSIVE)
  assert.equal(mapped?.fingerprint, 'grecall:1445111480:1792057789')
})

check('★ 私聊撤回 ⇒ `friendRecall` ＋ 20 级（用户定案 ✓）', () => {
  const mapped = mapNotice({
    notice_type: 'friend_recall', user_id: 2673439877, message_id: 777,
  }, CTX)
  assert.equal(mapped?.kind, 'friendRecall')
  assert.equal(mapped?.priority, PRIORITY_DIRECT)
})

// ── ★★ 申请：全是待办型 ＋ 带 flag ────────────────────────────────
check('★★ 加好友申请 ⇒ `friendRequest` / `todo` / 带 flag（她据此处理 ✓）', () => {
  const mapped = mapRequest({
    time: 1792057663, post_type: 'request', request_type: 'friend', user_id: 2215397214,
    comment: '我是来自群聊"藤原 白羽…"的冯氏羊癫疯',
    flag: 'u_BRFKUDGs7v8nn1DiQ0N-dw',
  }, CTX)
  assert.ok(mapped !== undefined)
  assert.equal(mapped.kind, 'friendRequest')
  assert.equal(mapped.signalClass, 'todo')
  assert.equal(mapped.priority, PRIORITY_DIRECT)
  assert.equal(mapped.flag, 'u_BRFKUDGs7v8nn1DiQ0N-dw')
  // ★★ 附言必须原样给她 ✓（她据此决定批不批 ✓）
  assert.equal(mapped.data.comment, '我是来自群聊"藤原 白羽…"的冯氏羊癫疯')
})

check('★★ 加群申请 ⇒ `groupRequest` / `todo` ＋ **验证问答原样给她** ✓', () => {
  const mapped = mapRequest({
    time: 1792057872, request_type: 'group', sub_type: 'add', group_id: 784394807,
    user_id: 3904591191, comment: '问题：你好\n答案：测试通知2',
    flag: 'slreq:1:1792057872305286:784394807:2:0',
  }, CTX)
  assert.ok(mapped !== undefined)
  assert.equal(mapped.kind, 'groupRequest')
  assert.equal(mapped.signalClass, 'todo')
  assert.equal(mapped.data.comment, '问题：你好\n答案：测试通知2')
  assert.equal(mapped.flag, 'slreq:1:1792057872305286:784394807:2:0')
})

check('★ 群邀请 ⇒ `groupInvite` / `todo`（`sub_type=invite` ✓）', () => {
  const mapped = mapRequest({
    time: 1792057801, request_type: 'group', sub_type: 'invite', group_id: 784394807,
    user_id: 2673439877, invited_id: 352699068, comment: '',
    flag: 'slreq:1:1792057777550848:784394807:1:0',
  }, CTX)
  assert.equal(mapped?.kind, 'groupInvite')
  assert.equal(mapped?.signalClass, 'todo')
  assert.equal(mapped?.data.operator, '2673439877')
})

check('★★ 没有 `flag` 的申请**丢掉** ✗（她没有身份去处理它 ✓）', () => {
  assert.equal(mapRequest({ request_type: 'friend', user_id: 1, comment: 'hi' }, CTX), undefined)
})

check('未知的 `request_type` 也丢掉（白名单制 ✓）', () => {
  assert.equal(mapRequest({ request_type: 'guild', flag: 'x' }, CTX), undefined)
})

// ── 指纹 ──────────────────────────────────────────────────────────
check('★ 同一帧 ⇒ **同一个指纹**（同一件事只进列表一次 ✓）', () => {
  const frame = {
    time: 100, notice_type: 'group_increase', sub_type: 'approve',
    group_id: 784394807, operator_id: 1, user_id: 3904591191,
  }
  assert.equal(mapNotice(frame, CTX)?.fingerprint, mapNotice(frame, CTX)?.fingerprint)
})

check('★ 不同时间 ⇒ **不同指纹**（两件不同的事 ✓）', () => {
  const base = { notice_type: 'group_increase', sub_type: 'approve', group_id: 1, user_id: 2 }
  const a = mapNotice({ ...base, time: 100 }, CTX)?.fingerprint
  const b = mapNotice({ ...base, time: 200 }, CTX)?.fingerprint
  assert.notEqual(a, b)
})

check('★ 待办型的指纹就是 `flag`（★ 重启后也认得出来 ✓）', () => {
  const mapped = mapRequest({ request_type: 'friend', user_id: 1, flag: 'u_abc' }, CTX)
  assert.equal(mapped?.fingerprint, 'req:u_abc')
})

// ── ★★ 待办型的**清空键**两面必须一致（2026-10-17 真机故障 ✗）─────────
//
// ★ 症状：★ 加好友时**好友通知反复跳、无法被消费** ✓。
// ★★ 根因：★ 生成指纹的是 `mapRequest` ✓，而**删它的是 `signals/index.ts` 的监听器** ✗ ——
//   两边各拼一次 `req:<flag>` ⇒ ★ 歪了就删不掉 ⇒ 每次 `tick()` 重报 ✓。
// ⇒ ★ 所以收成 `requestPendingKey()` ✓，下面三条把它钉死 ✓。
check('★★ 清空键与 `mapRequest` 的指纹**同一个值**（歪了就删不掉 ✗）', () => {
  const mapped = mapRequest({ request_type: 'friend', user_id: 1, flag: 'u_abc' }, CTX)
  assert.equal(requestPendingKey('u_abc'), mapped?.fingerprint)
})

check('★★ 群申请也一致（★ 三类待办共用同一个键函数 ✓）', () => {
  const add = mapRequest({ request_type: 'group', sub_type: 'add', group_id: 9, user_id: 1, flag: 'g_x' }, CTX)
  const invite = mapRequest({ request_type: 'group', sub_type: 'invite', group_id: 9, user_id: 1, flag: 'g_y' }, CTX)
  assert.equal(requestPendingKey('g_x'), add?.fingerprint)
  assert.equal(requestPendingKey('g_y'), invite?.fingerprint)
})

check('★ 键的形如 `req:<flag>`（★ 前缀写死在一处 ✓）', () => {
  assert.equal(requestPendingKey('u_abc'), 'req:u_abc')
})

// ── 边界 ──────────────────────────────────────────────────────────
check('★ 完全没有字段的帧 ⇒ undefined（不抛错 ✓）', () => {
  assert.equal(mapNotice({}, CTX), undefined)
  assert.equal(mapRequest({}, CTX), undefined)
})

check('★ 群名拿不到时用调用方的兜底（`群<id>` ✓ —— 不能是空串 ✗）', () => {
  const mapped = mapNotice({
    notice_type: 'group_increase', sub_type: 'approve', group_id: 999, user_id: 1,
  }, CTX)
  assert.equal(mapped?.data.name, '群999')
})

console.log(`\n通过 ${passed}，失败 ${failed}`)
if (failed > 0) process.exitCode = 1
