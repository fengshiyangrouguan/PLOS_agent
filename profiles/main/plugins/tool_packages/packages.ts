/**
 * 工具包的**清单与纯逻辑** —— 「渐进式披露」的数据面。
 *
 * ★ 这个模块**不认识 cordis**（不吃 `ctx` ✓）—— 包表、"哪些工具平时藏起来"、
 * 给模型看的那段说明，全在这儿 ✓ ⇒ 能离线验 ✓（同 `attention/preempt.ts` 的形状 ✓）。
 *
 * ## 为什么做这件事
 *
 * ★ 实测（2026-10-15）：她的工具表有 **49 个**，`toolsTokens ≈ 5872` ✓，**每轮都带** ✗。
 * ★★ 更麻烦的是**她自己装不下** ✗：让她列举时**只列到第 10 个 `qq_*`** ✗
 * —— 而那些工具**其实是活的** ✓（让她调 `qq_qzone_list` 立刻成功 ✓）。
 * ⇒ ★ 所以这是**注意力／上下文**问题 ✓，不是载入问题 ✓。
 *
 * ## 做法（用户定案，见 `PLOS/docs/decisions.md` TODO 13）
 *
 * ① 不常用的工具**收进包** ⇒ 平时**不在 `tools` 里** ✗；
 * ② 每个包在**系统提示词**里留一段说明（★ **内容 ＋ 适用范围 ＋ 包含的工具** ✓）；
 * ③ 加一个**查找工具** ⇒ 她按需把某一包**取进本 turn 的 `tools`** ✓；
 * ④ **turn 结束回落** ✓ —— ★ 因为 `tools` 是**每次装配重算**的 ✓，不是累积状态 ✓。
 *
 * ## ⚠️ 三条硬约束（都实测过 ✓）
 *
 * · ★★ **能不能调用，只取决于 `tools`** ✗ —— 光在 tool role 里写 schema **调不了** ✓
 *   （provider 只接受对已声明工具的调用 ✓）。
 * · ★★ **取包会改变工具表前缀 ⇒ 那一次请求断缓存** ✗（实测命中率 **95.1%** ✓ ⇒ 可接受 ✓）；
 *   回落之后**重新命中** ✓。
 * · ★★ **包文本与顺序必须写死** ✗ —— 否则前缀抖动、缓存全废 ✓。
 *
 * @module qq/../tool_packages/packages
 */

/** 一个工具包。 */
export interface ToolPackage {
  /** 包名（她查找时用它 ✓，也是排序键 ✓ —— ★ 顺序稳定才能保住缓存 ✓）。 */
  readonly name: string
  /** 一句话说明这个包**是干什么的**（进系统提示词 ✓）。 */
  readonly summary: string
  /** 什么时候该用它（进系统提示词 ✓）。 */
  readonly when: string
  /** 包里的工具名（★ 必须与真实注册名逐字相同 ✗ —— 拼错等于静默少一个 ✓）。 */
  readonly tools: readonly string[]
}

/**
 * ★★ **七个包**（用户 2026-10-16 定案 ✓，逐字照抄 ✓）。
 *
 * ★ `name` 同时也是**排序键** ✓ ⇒ 同一组包**总得到同样的顺序** ✓ ⇒ 缓存能命中 ✓。
 */
export const TOOL_PACKAGES: readonly ToolPackage[] = [
  {
    name: 'qzone',
    summary: 'QQ 空间（说说）：发一条、看别人的、评论、点赞。',
    when: '想发说说、想看看好友动态、想评论或点赞某条说说时。',
    tools: ['qq_qzone_list', 'qq_qzone_post', 'qq_qzone_comment', 'qq_qzone_like', 'qq_qzone_feeds'],
  },
  {
    name: 'group-admin',
    summary: '群管理：禁言某人或全体、解除禁言、看还在禁言里的人、看群成员名单。',
    when: '需要管理群秩序，或者要查某个人的 QQ 号（发消息前 @ 人要用）时。',
    tools: ['qq_set_group_ban', 'qq_group_muted', 'qq_list_group_members'],
  },
  {
    name: 'requests',
    summary: '申请处理：通过或拒绝加好友、通过或拒绝加群、看还没处理的群申请。',
    when: '收到加好友／加群申请，要决定批不批时。',
    tools: ['qq_approve_friend', 'qq_approve_group', 'qq_group_requests'],
  },
  {
    name: 'agents',
    summary: '子代理与工作流：开一个子代理帮你做事、给它发消息、让它停下、写一段工作流并行跑。',
    when: '一件事太大、要拆开并行做，或者要回头找之前开的子代理时。',
    tools: ['subagent', 'subagent_fork', 'workflow', 'interrupt_agent', 'list_agents', 'send_message'],
  },
  {
    name: 'jobs',
    summary: '待办与后台作业：记一条待办、看后台跑着的作业、取它的输出、停掉它。',
    when: '要把一件事记下来以后做，或者启动了后台作业要看结果时。',
    tools: ['todo_write', 'job_list', 'job_output', 'job_kill'],
  },
  {
    name: 'memory',
    summary: '记忆与档案：翻自己过去的会话、按关键字找某条消息、看某件事是怎么一步步发生的、'
      + '以及按消息 id 读一条消息的原文。',
    when: '想不起以前聊过什么、要确认某件事的来龙去脉时。',
    tools: [
      'qq_read_message',
      'session_search',
      'session_event_search',
      'session_event_read',
      'session_trace',
      'session_event_trace',
    ],
  },
  {
    name: 'misc',
    summary: '其他：看一眼图片里有什么。',
    when: '需要理解一张图片的内容时。',
    tools: ['read_image'],
  },
]

/**
 * ★★ **彻底卸载的工具**（用户原话：「他不用」✓）—— 任何时候都不进 `tools` ✓，
 * **也不在任何包里** ✗（⇒ 连查找也取不到 ✓）。
 */
export const UNINSTALLED_TOOLS: readonly string[] = [
  'create_goal',
  'get_goal',
  'update_goal',
  'exit_plan_mode',
]

/** 查找工具自己的名字 —— ★ 它**永远可见** ✓（否则取不到任何包 ✗）。 */
export const FIND_TOOLS_NAME = 'find_tools'

/** 包名 → 包（★ 查表用 ✓）。 */
const BY_NAME: ReadonlyMap<string, ToolPackage> = new Map(
  TOOL_PACKAGES.map(item => [item.name, item]),
)

/**
 * 按名字取一个包。
 *
 * @param name - 包名（★ 大小写敏感 ✗ —— 提示词里写的就是小写 ✓）。
 * @returns 包；不存在则 `undefined` ✓。
 */
export function packageOf(name: string): ToolPackage | undefined {
  return BY_NAME.get(name)
}

/**
 * ★★ **包里那些工具对应的"什么时候用它"提示段名**（`tool:<…>` ✓）。
 *
 * ## 为什么需要它
 *
 * 那些段由**各个工具插件**注册 ✓，再经 `tcb` 的 `sections` 白名单放行 ✓
 * （`data/tcb.json` 里列着 `tool:pwsh` / `tool:subagent` / `tool:session-query` … ✓）。
 *
 * ★★ **问题**：工具被收进包之后**平时不在 `tools` 里** ✗ —— 而那段提示**还在** ✓
 * ⇒ 她会读到「什么时候用 subagent」却**根本调不动** ✗✓。
 * ⇒ ★ 所以要**跟着包一起出现／一起收起来** ✓。
 *
 * ## 为什么写成一张表、而不是从工具名推
 *
 * ★ 段名与工具名**不是**机械对应 ✗ —— 例如
 * `session_search` / `session_event_search` / … 这一族对应的是**一个**段
 * `tool:session-query` ✓。★ 推导会错 ✗，所以**显式列** ✓。
 *
 * ★ 只列**真的在白名单里**的那些 ✓（`tool:pwsh` / `tool:read` / … 属于留日常的工具 ✓，
 * 不在这里 ⇒ 永远不被藏 ✓）。
 */
export const PACKAGE_SECTIONS: Readonly<Record<string, readonly string[]>> = {
  agents: ['tool:subagent'],
  jobs: ['tool:jobs'],
  memory: ['tool:session-query'],
}

/**
 * ★★ **当前该藏起来**的工具名 —— 本次装配**不进 `tools`** 的那些 ✓。
 *
 * 判据：
 *  · 卸载名单里的 ⇒ **永远藏** ✓
 *  · 包里、且**该包没被取用** ⇒ 藏 ✓
 *  · 包里、且**该包已取用** ⇒ **不藏**（加回去 ✓）
 *  · 不在任何包里 ⇒ **不藏**（日常工具 ✓）
 *
 * @param active - ★ **已取用的包名**（本 turn 内 ✓；turn 结束清空 ⇒ 回到全藏 ✓）。
 * @returns 该从 `tools` 里筛掉的名字集合 ✓。
 */
export function hiddenTools(active: ReadonlySet<string>): ReadonlySet<string> {
  const hidden = new Set<string>(UNINSTALLED_TOOLS)
  for (const item of TOOL_PACKAGES) {
    if (active.has(item.name)) continue
    for (const tool of item.tools) hidden.add(tool)
  }
  return hidden
}

/**
 * ★★ **当前该藏起来**的提示段名（`tool:<…>` ✓）—— 与 {@link hiddenTools} 配套 ✓。
 *
 * 判据同前 ✓：段的包**没被取用** ⇒ 藏 ✓。
 * ★ 目的：★ **别让她读到"什么时候用某个工具"，而那个工具又调不动** ✗✓。
 *
 * @param active - 已取用的包名。
 * @returns 该从 `sections` 里筛掉的段名集合 ✓。
 */
export function hiddenSections(active: ReadonlySet<string>): ReadonlySet<string> {
  const hidden = new Set<string>()
  for (const [pack, sections] of Object.entries(PACKAGE_SECTIONS)) {
    if (active.has(pack)) continue
    for (const section of sections) hidden.add(section)
  }
  return hidden
}


/**
 * ★★ **进系统提示词的那段说明** —— 「包里有什么、什么时候用、可以按需取用」✓。
 *
 * ## 为什么文本要**固定**
 *
 * ★ 提示词缓存命中靠**前缀稳定** ✓（实测命中率 **95.1%** ✓）。这段文本**每轮一样** ⇒
 * 它在缓存里，几乎不花钱 ✓✓。★ 所以：★ **不要**在这里塞"当前取过哪些包"之类的动态内容 ✗
 * —— 那会让前缀每轮都变 ✓（取用状态由查找工具的**返回值**表达 ✓，那是一次性记录 ✓）。
 *
 * ## 措辞要点
 *
 * ★★ 要写「**可以按需取用**」✓ —— **不是**「我有这些工具」✗：
 * 包里的工具**平时不在工具表里** ✗，turn 一结束还会回落 ✓。
 *
 * @returns 多行说明文本 ✓。
 */
export function packagesSectionText(): string {
  const lines = [
    '## 工具包（需要时先取用）',
    '',
    '下面这些能力**平时不在你的工具表里**，但可以随时取用：'
      + `调用 \`${FIND_TOOLS_NAME}\`（参数写包名）就会把那一包的工具**装进你这一轮**。`,
    '取用后本轮一直有效；下一轮会自动回到上面这些常用工具。**要用就取，不用管别的。**',
    '',
  ]
  // ★ 按包名排序 ⇒ 文本与顺序都固定 ✓（缓存靠这个 ✓）。
  for (const item of [...TOOL_PACKAGES].sort((a, b) => a.name.localeCompare(b.name))) {
    lines.push(`- **${item.name}** —— ${item.summary}`)
    lines.push(`  什么时候用：${item.when}`)
    lines.push(`  里面有：${item.tools.join('、')}`)
  }
  return lines.join('\n')
}
