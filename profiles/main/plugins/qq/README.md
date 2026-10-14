# `qq` 领域

通往 QQ 的能力层。协议端是 [SnowLuma](https://github.com/SnowLuma/SnowLuma)（OneBot v11）。

## 目录结构

**分组在「包」级别，每个包内部保持扁平** —— 这是照 DSH 的分法
（`packages/<group>/<pkg>/src` 下没有任何子目录；查过 5 个包确认）。

```
protocol/     OneBot v11 线上类型（adapter 与 pipeline 共用，只有类型 + 两个小工具函数）
adapter/      ① 能力 seam（执行）—— provide('qq')，WS 客户端 + 收发 API + 消息缓冲
  index.ts      ★ 插件入口（Service 类，default export）
  config.ts
  buffer.ts     conversationOf() —— **全仓唯一写 `group:` / `private:` 的地方**
  tests/
pipeline/     消息段 → LLM 文本（库，被 adapter 拥有，**不是插件**）
  segment.ts     结构化中间表示（只有类型）
  segments.ts    原始段 → ResolvedSegment[]（异步，所有 I/O）
  render.ts      纯函数渲染，零 I/O
  forward.ts     转发递归展开
  card.ts / face.ts
  tests/
tools/        ② 工具包装（模型化）—— 8 个模型可调用的工具
signals/      ③ 领域 → 感知：注册信号源 + 消息存档
vlm/          ③ 领域 → 模型：把 `vlm2text` 接到图片描述钩子上
resident/     常驻会话
```

## 各层归谁

| 层 | 目录 | 与谁对接 |
|:--|:--|:--|
| ① 能力 seam（执行） | `adapter/` | 只认协议端（SnowLuma / OneBot） |
| ② 工具包装（模型化） | `tools/` | `ctx.tools` |
| ③ 领域接入 | `signals/` · `vlm/` · `resident/` | `ctx.perception` · `ctx.vlm2text` · `ctx.agents` |

**「③ 提示词」这一层已经不在这里了。** 早先有过一个 `qq/prompt/`
（把说明塞进系统提示词），它已经删掉 —— 现在**提示词归 TCB**
（`data/tcb.json` 的段落白名单 + `data/identity/`）。领域不该自己生产提示词。

同理，早先还有个 `qq/push/`（"推内容 + 硬塞指令"），也已经被 `signals/` 取代：
**领域只暴露结构化状态，渲染归感知层**（见下）。

## 一条必须守住的 seam

**`segments` 是唯一真相，渲染是可替换的一步。**

```
原始段 ──resolve()──▶ ResolvedSegment[] ──render()──▶ LLM 文本
        （有 I/O）        唯一真相          （纯函数）
```

- `resolve` 可以慢、可以有 I/O、可以降级
- `render` **必须纯**：需要的数据早已在段里

这条边界继承自实验期（原设计写明「segments 是唯一真相、content 由 cortex 单写入」）。

**图片描述遵守同一条**：VLM 描述属于"数据"，由 `resolve` 阶段填进
`ResolvedImage.description`，`render` 只是把它拼成 `[图片:描述]`。
描述器由 `vlm/` 从外面注入（`adapter` 自己**不认识模型**）。

## 推 / 拉

| | 机制 | 类比 |
|:--|:--|:--|
| **推** | 消息变成 `user` 推进上下文，**激活**白羽；之后她自己选择 | 手机响了 |
| **拉** | 白羽主动调工具去看消息，自主决定回不回 | 人主动打开手机翻消息 |

区分来自 tulpa MCP 的设计。

**方向（`docs/design.md` §四）：领域只暴露结构化状态，感知插件统一渲染，且不含内容。**
领域**不生产文本** —— `signals/` 的 `pull()` 返回的是结构化信号 + 模板，
简报由感知层拼出来。所以简报只说"有人 @ 了你"，不说"你该回话"。

已读语义同理（`docs/design.md` §4.7）：**点进去才算已读**，
`pull()` 用 `peek()`/`unread()`（**都不推进游标**），只有 `qq_read` 那个工具用 `drain()`。

## 配置

默认 `blacklist` + 空名单 = **放行一切**。刻意如此——自动生成的配置不该默认拒绝所有消息。
但这意味着不加限制时白羽会在所有群收到事件；要不要开口是上层（推/拉）的策略。

密钥走环境变量，不进版本库：

```yaml
accessToken: !!js "process.env.QQ_ACCESS_TOKEN ?? ''"
```

值写在 `$DSH_HOME/.env`（已 gitignore），由 DSH 的 `loadLayeredEnv` 注入。

## 开发

```powershell
# 三层验证：类型 + 装配树 + 自检脚本
cd E:\project\PLOS\PLOS_agent
& .\scripts\check.ps1

# 起协议端（另开窗口，别关）
cd E:\project\PLOS\SnowLuma
$env:SNOWLUMA_ACCEPT_EULA='1'; $env:SNOWLUMA_ACCEPT_PRIVACY='1'
.\node.exe .\index.mjs

# 起 DSH
$env:DSH_HOME='E:\project\PLOS\PLOS_agent'
cd E:\project\PLOS\deepseek-harness
pnpm dsh --profile main
```

### 排障入口

| 现象 | 先看哪 |
|:--|:--|
| 日志停在半路不更新 | node 的 stdout 接管道会缓冲；等心跳（30s）冲一次 |
| 连不上 3001 | SnowLuma 日志里的 `rejected unauthorized WebSocket upgrade` = token 不对 |
| 事件收不到 | SnowLuma 的 `logs/snowluma-YYYY-MM-DD.log`（**按天滚动**） |
| 想知道到底发了什么 action | 同一份日志的 `[Bridge.Action]` 行——服务端视角，与我们的日志互相独立 |
| 图片只有 `[图片]` 没有描述 | 看启动自述里 `vlm2text:` 那一行（TCB 配错是**静默**的）；再看它写的 warn |

### 调日志级别

日志出口是 **`dsh-logbook`**（补丁层 `- id: logs`），**不是 cordis 自带的
`logger-console`** —— 换掉它有两个原因，都写在 `cordis.patch.yml` 里：
cordis 的**数值级别是反的**（`error=0 info=1 warn=2 debug=3`，`default: 1` 会静默吞掉
warn 和 debug），而且它的 exporter disposer 有上游 bug（重载会摘掉别人的出口）。

```yaml
# profiles/main/cordis.patch.yml 的 `- id: logs`
stderr:
  types:
    default: info
    qq-adapter: debug   # 开发期看连接与收消息细节；上线前删掉这行
```

## 已知未做

- **通知与请求事件**：`notice` / `request` 的 `post_type` 目前只记 debug 日志就丢
- **表情表**：只覆盖约 120 条高频；实验期完整表有已知格式瑕疵，不要原样搬
- `downloadImage` 与转发展开的**真实字节路径**未实测（格式已被 `render.spec.ts` 覆盖）
- **图片存档**：`segment.ts` 只留描述文本，**原图字节不进库**。
  要不要留（以及留哪一张）是 QQ 自己的领域决策，`vlm2text` 不管
