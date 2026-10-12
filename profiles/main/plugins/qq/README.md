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
  buffer.ts
  tests/
pipeline/     消息段 → LLM 文本（库，被 adapter 拥有，**不是插件**）
  segment.ts     结构化中间表示（只有类型）
  segments.ts    原始段 → ResolvedSegment[]（异步，所有 I/O）
  render.ts      纯函数渲染，零 I/O
  forward.ts     转发递归展开
  card.ts / face.ts
  tests/
tools/        ② 工具包装（模型化）
prompt/       ③ 提示词（说明）
push/         「推」
resident/     常驻会话
```

**三层的对应**（计划 §0.2 的分层纪律）：

| 层 | 目录 |
|:--|:--|
| ① 能力 seam（执行） | `adapter/` |
| ② 工具包装（模型化） | `tools/` |
| ③ 提示词（说明） | `prompt/` |

## 一条必须守住的 seam

**`segments` 是唯一真相，渲染是可替换的一步。**

```
原始段 ──resolve()──▶ ResolvedSegment[] ──render()──▶ LLM 文本
        （有 I/O）        唯一真相          （纯函数）
```

- `resolve` 可以慢、可以有 I/O、可以降级
- `render` **必须纯**：需要的数据早已在段里

这条边界继承自实验期（原设计写明「segments 是唯一真相、content 由 cortex 单写入」）。

## 推 / 拉

| | 机制 | 类比 |
|:--|:--|:--|
| **推** | 消息变成 `user` 推进上下文，**激活**白羽；之后她自己选择 | 手机响了 |
| **拉** | 白羽主动调工具去看消息，自主决定回不回 | 人主动打开手机翻消息 |

区分来自 tulpa MCP 的设计。

> ⚠️ **当前实现与设计不一致，见 `PLOS/docs/design.md` §四。**
>
> 设计方向是：**领域只暴露结构化状态，感知插件统一渲染，且不含内容**。
> 领域**不生产文本**。现在 `push/` 是"推内容 + 硬塞指令"，方向是错的。

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
powershell -File scripts/check.ps1

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
| 模型调用无反应、token 用量为 0 | 见 `profiles/main/cordis.patch.yml` 里关于 `REQUEST_EXTENSION` 的注释 |

### 调日志级别

`profiles/main/cordis.patch.yml` 里 `logger-console` 的 `levels`：

```yaml
levels:
  default: 1
  qq-adapter: 3   # 上线前调回 1
```

## 已知未做

- **VLM 图片描述**：注入点已留（`setImageDescriber`），无人实现
- **推 / 拉的重新设计**：见 `PLOS/docs/design.md` §四、§七
- **通知与请求事件**：`notice` / `request` 的 `post_type` 目前只记 debug 日志就丢
- **表情表**：只覆盖约 120 条高频；实验期完整表有已知格式瑕疵，不要原样搬
- `downloadImage` 与转发展开的**真实字节路径**未实测（格式已被 `render.spec.ts` 覆盖）
- **冷却不生效**：`push/index.ts` 的 `pending.delete()` 把 `lastWokenAt` 一起删了