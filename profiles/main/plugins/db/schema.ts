/**
 * 数据库表结构与迁移。
 *
 * ## 为什么单独一层
 *
 * 迁移只依赖 `node:sqlite`，**不认识 cordis** —— 所以能离线自检
 * （`tests/schema.spec.ts` 用内存库跑）。cordis 那一层在 `index.ts`。
 *
 * ## 迁移是必须的（Shiraha_OS 最大的教训）
 *
 * 实验期只有 `create_all` —— **只建不改**。字段演进时它不会报错，
 * 而是静默丢数据。这里用 SQLite 的 `user_version` pragma 记录版本，
 * 每次打开按序补齐。
 *
 * ## "建表 = effect" 的准确含义
 *
 * 计划 §6.1 写的是「建表 = effect」。**但卸载时不能删表** ——
 * 我们的补丁层开着 HMR，改一次插件文件就会卸载重装，
 * 若 disposer 去 DROP TABLE，等于每改一次代码清空一次数据库。
 *
 * 所以：**迁移在激活时跑（effect 作用域内），disposer 只关连接**。
 * 建表动作是幂等的（`IF NOT EXISTS`），重装无害。
 *
 * @module db/schema
 */

import type { DatabaseSync } from 'node:sqlite'

/** 一条迁移。`up` 必须幂等可重放。 */
export interface Migration {
  /** 递增版本号，从 1 开始，**不可跳号、不可改已发布的**。 */
  readonly version: number
  /** 人类可读的名字，写进日志。 */
  readonly name: string
  /** 应用迁移。由调用方包在事务里。 */
  readonly up: (db: DatabaseSync) => void
}

/**
 * 全部迁移，按 `version` 升序。
 *
 * **只许追加，不许修改已发布的条目** —— 已经跑过的库不会重放，
 * 改了等于新旧库结构分叉。
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: '初始表结构',
    up: (db) => {
      // ── 完整消息存档 ──────────────────────────────────────────────
      // 这是**搜索工具的数据源**（设计 §7.3：5 命中 × 上下各 10）。
      // 设计原则：进上下文只给最新 20 条（at 消息除外），但**库里一条不漏** ——
      // 搜索是唯一的回看通道。
      //
      // `content` 是渲染后的纯文本（给搜索用）；`segments` 存原始段的 JSON
      // （唯一真相是 segments，渲染是可替换的一步 —— 保留原文以备重渲染）。
      db.exec(`
        CREATE TABLE IF NOT EXISTS messages (
          platform          TEXT    NOT NULL,
          message_id        TEXT    NOT NULL,
          conversation_id   TEXT    NOT NULL,
          conversation_type TEXT    NOT NULL,
          conversation_name TEXT,
          sender_id         TEXT,
          sender_name       TEXT,
          time              INTEGER NOT NULL,
          content           TEXT    NOT NULL,
          segments          TEXT,
          PRIMARY KEY (platform, message_id)
        )
      `)
      db.exec('CREATE INDEX IF NOT EXISTS idx_messages_conv_time ON messages (conversation_id, time)')
      db.exec('CREATE INDEX IF NOT EXISTS idx_messages_time ON messages (time)')

      // ── 感知历史 ──────────────────────────────────────────────────
      // 设计 §6.4：极简 —— 时间 + 领域 + 来源 + 摘要 + 是否被拉取过。
      // `pulled` 是**感知层是否拉过**，不是模型是否读过；
      // 模型层的已读语义由 `qq_read` 自己的游标管（设计 §4.7）。
      db.exec(`
        CREATE TABLE IF NOT EXISTS perception_history (
          id      INTEGER PRIMARY KEY AUTOINCREMENT,
          time    INTEGER NOT NULL,
          domain  TEXT    NOT NULL,
          source  TEXT    NOT NULL,
          summary TEXT    NOT NULL,
          pulled  INTEGER NOT NULL DEFAULT 0
        )
      `)
      db.exec('CREATE INDEX IF NOT EXISTS idx_perception_time ON perception_history (time)')

      // ── events（照搬 Shiraha_OS） ─────────────────────────────────
      // 用户定案：**完全照搬** `Shiraha_OS/src/infrastructure/database/database_model.py:71`
      // 的 `EventDB`，**但两条外键降级为普通索引字段**。
      //
      // 原因：原文的 `conversation_id` / `user_id` 指向 `conversation_info`
      // 和 `user_info` —— 那两张在 Shiraha 里是 **0 行死表**（全仓无生产代码
      // 写入，只有 images 105 行、stickers 263 行真在跑）。照搬它们等于照抄错误。
      //
      // 但**保留字段 + 索引**，不删列 —— 将来补上那两张表时不必改这张。
      //
      // 类型映射：原文的 `JSON` 列在 SQLite 里就是 TEXT（存 JSON 字符串）。
      db.exec(`
        CREATE TABLE IF NOT EXISTS events (
          event_id          TEXT PRIMARY KEY,
          platform          TEXT    NOT NULL,
          event_type        TEXT    NOT NULL,
          time              INTEGER NOT NULL,
          conversation_id   TEXT,
          conversation_type TEXT    NOT NULL,
          conversation_name TEXT,
          user_id           TEXT,
          user_nickname     TEXT,
          user_cardname     TEXT,
          tags              TEXT,
          event_content     TEXT,
          event_metadata    TEXT
        )
      `)
      db.exec('CREATE INDEX IF NOT EXISTS idx_events_time ON events (time)')
      db.exec('CREATE INDEX IF NOT EXISTS idx_events_conversation ON events (conversation_id)')
      db.exec('CREATE INDEX IF NOT EXISTS idx_events_user ON events (user_id)')

      // ── 待办（plan） ──────────────────────────────────────────────
      // 注意力转移模型（docs/m5-preemption.md §20）：**原任务优先级 > n**、
      // 且中断**持续超过 T** 时，由快照 subagent 写一条待办并浮进上下文，
      // 供下一次唤醒时"想起来还有件事没做完"。
      //
      // **回看坐标是两列，各自一个消费者**：
      //   `turn` —— 给人 / 给模型看的说法（"从第 7 轮继续"）
      //   `seq`  —— **给工具的坐标**。DSH 原生的 `session_event_read` 收的是 `seq`，
      //             所以这一列是**必须存**的那个；`turn` 只是更好读。
      //
      // ⚠️ **中断那一刻不写这张表**：正文要等 T 才知道（快照 subagent 到那时才收到
      // "写待办"的命令）。所以那段窗口里**没有任何持久化状态需要存活** ——
      // 崩了就崩了，而她的会话本来就还留着那件被打断的事。
      db.exec(`
        CREATE TABLE IF NOT EXISTS interrupt_plan (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          created_at INTEGER NOT NULL,
          session_id TEXT    NOT NULL,
          turn       INTEGER NOT NULL,
          seq        INTEGER NOT NULL,
          priority   INTEGER NOT NULL,
          what       TEXT    NOT NULL,
          why        TEXT    NOT NULL,
          state      TEXT    NOT NULL DEFAULT 'surfaced',
          expires_at INTEGER NOT NULL,
          settled_at INTEGER
        )
      `)
      db.exec('CREATE INDEX IF NOT EXISTS idx_interrupt_plan_state ON interrupt_plan (state, expires_at)')
    },
  },
]

/** 最新版本号。 */
export const LATEST_VERSION: number = MIGRATIONS.reduce(
  (max, migration) => Math.max(max, migration.version),
  0,
)

/** 读当前 schema 版本（SQLite 的 `user_version`）。 */
export function currentVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined
  return row?.user_version ?? 0
}

/** 一次迁移的结果，供日志使用。 */
export interface MigrateResult {
  readonly from: number
  readonly to: number
  /** 本次实际应用了哪些版本。 */
  readonly applied: readonly string[]
}

/**
 * 把库补到最新版本。
 *
 * - 幂等：已是新版就什么都不做
 * - **每条迁移一个事务**：中途失败不会留下半截结构
 * - 版本号比代码新时**抛错**（库来自更新的构建，贸然降级会丢数据）
 *
 * @param db - 已打开的数据库句柄。
 * @returns 迁移结果。
 * @throws 当库的 schema 版本高于本构建已知的版本。
 */
export function migrate(db: DatabaseSync): MigrateResult {
  const from = currentVersion(db)
  if (from > LATEST_VERSION) {
    throw new Error(
      `数据库 schema 版本 ${String(from)} 高于本构建已知的 ${String(LATEST_VERSION)}——`
      + '这个库来自更新的构建，请升级而不是降级（降级会静默丢字段）',
    )
  }

  const applied: string[] = []
  for (const migration of MIGRATIONS) {
    if (migration.version <= from) continue
    db.exec('BEGIN')
    try {
      migration.up(db)
      // user_version 不接受参数绑定，版本号来自本文件的常量，无注入面。
      db.exec(`PRAGMA user_version = ${String(migration.version)}`)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    applied.push(`v${String(migration.version)} ${migration.name}`)
  }

  return { from, to: currentVersion(db), applied }
}
