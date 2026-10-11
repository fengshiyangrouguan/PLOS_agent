# `qq` 插件

通往 QQ 的能力层。协议端是 [SnowLuma](https://github.com/SnowLuma/SnowLuma)（OneBot v11），
我们把 QQ 会话变成模型能读能写的东西。

## 模块地图

```
protocol.ts     OneBot v11 线上类型（只声明我们真正读写的字段）
config.ts       配置面（schemastery）
face.ts         表情映射表
adapter.ts      ★ QqAdapter extends Service —— provide('qq')，WS 客户端 + 收发 API
   │
   ├── segments.ts  原始段 → ResolvedSegment[]（异步：所有 I/O 在这里）
   │      ├── forward.ts  递归展开合并转发（ForwardExpander）+ XML 摘要兜底
   │      └── card.ts     JSON 卡片文本化
   │
   ├── segment.ts  结构化中间表示（只有类型）
   └── render.ts   ResolvedSegment[] → LLM 文本（纯函数，零 I/O）

tools.ts        把 ctx.qq 包成模型可调用的工具
probe.ts        开发探针：渲染消息打日志 + 只读 API 一次性诊断
probe-send.ts   发送链路自检，默认关闭
render.spec.ts  render.ts 的格式自检（26 项）
```

## 一条必须守住的 seam

**`segments` 是唯一真相，渲染是可替换的一步。**

```
原始段 ──resolve()──▶ ResolvedSegment[] ──render()──▶ LLM 文本
        （有 I/O）        唯一真相          （纯函数）
```

- `resolve` 可以慢、可以有 I/O、可以降级
- `render` **必须纯**：需要的数据早已在段里
- VLM 图片描述是 `ImageDescriber`，由消费方**注入**（`setImageDescriber`）——
  适配器依赖 `ctx.llm` 会让这条 seam 变成环

这条边界继承自实验期（原设计写明「segments 是唯一真相、content 由 cortex 单写入」）。
那次把"补数据"和"拼格式"揉在一个类里，换渲染策略就得动适配器。

## 推 / 拉

白羽接入 QQ 有两条路径，**不是二选一，是两条并存**：

| | 机制 | 类比 |
|:--|:--|:--|
| **推** | 消息变成 `user` 推进上下文，**激活**白羽；之后她自己选择怎么反应 | 手机响了 |
| **拉** | 白羽主动调工具去看消息，自主决定回不回 | 人主动打开手机翻消息 |

这个区分来自 tulpa MCP 的设计。

**当前只实现了推的原料**：`adapter.ts` 把每条通过过滤的消息 `emit('qq/message')`。
推和拉都还没接——缺的是一个**消息缓冲**：

- **推**要从"刚到的消息"取料
- **拉**要从"上次看过之后累积的消息"取料，所以缓冲需要**每会话一个读游标**，
  `qq_check_messages` 返回的是增量，不是全部历史

裸的 `qq/message` 事件两个都满足不了：事件是瞬时的，错过就没了；也没有游标概念。

## 配置

默认 `blacklist` + 空名单 = **放行一切**。这是刻意的——自动生成的配置不该默认拒绝所有消息。
但这也意味着**不加限制时白羽会在所有群里收到事件**；要不要开口是上层（推/拉）的策略，不是适配器的。

密钥走环境变量，不进版本库：

```yaml
accessToken: !!js "process.env.QQ_ACCESS_TOKEN ?? ''"
```

值写在 `$DSH_HOME/.env`（已 gitignore），由 DSH 的 `loadLayeredEnv` 注入。

## 开发

```powershell
# 三层验证：类型 + 装配树 + 格式自检
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
| 事件收不到 | SnowLuma 的 `logs/snowluma-YYYY-MM-DD.log`（**按天滚动，跨午夜看新文件**） |
| 想知道到底发了什么 action | 同一份日志的 `[Bridge.Action]` 行——服务端视角，与我们的日志互相独立 |

### 调日志级别

`profiles/main/cordis.patch.yml` 里 `logger-console` 的 `levels`：

```yaml
levels:
  default: 1
  qq-adapter: 3   # 上线前调回 1
```

## 已知未做

- **VLM 图片描述**：注入点已留（`setImageDescriber`），无人实现
- **推 / 拉**：见上，缺消息缓冲与读游标
- **通知与请求事件**：`notice` / `request` 的 `post_type` 目前只记 debug 日志就丢
- **表情表**：只覆盖约 120 条高频；实验期完整表有已知格式瑕疵，不要原样搬
- `downloadImage` 与转发展开的**真实字节路径**未实测（格式已被 `render.spec.ts` 覆盖）
