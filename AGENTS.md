# AGENTS.md — PLOS_agent

这个仓库是 PLOS 的 AI 主体工程（`$DSH_HOME`）。本文件记录**在这个仓库里做事的方法**，
以及踩过之后不该再踩的坑。

设计文档在 `PLOS/docs/design.md`（设计定稿）与 `PLOS/docs/decisions.md`（决策台账）。

---

## 一、动手之前：先读，再判断

**这一条是本仓库最贵的教训。** 同一个错在一轮工作里犯了三次，每次都是"先下结论，后查证"：

| 犯的错 | 本该先做的 |
|:--|:--|
| 给感知条目加了冗余的 `trigger` 字段 | 先问"这信息能不能从已有的 `highest` 推出来"——能，所以它不该存在 |
| 把间隔上下限写成常量 | 先读 `deepseek-harness/packages/AGENTS.md`：「No hardcoded tunables in plugins: deployment-varying choices are validated `Config` fields」——**规矩就写在那儿** |
| 写"群名拿不到"的 TODO | 先读 adapter —— `QqIncoming.groupName` 早就有了；而字段名错了这件事，**抓一次原始 JSON 就能定论，不该靠反推** |

**具体做法**：

1. **改任何东西之前，先读已有的同类实现**。`deepseek-harness/packages/**` 里有大量可抄的
   模式（`Service.init`、`ctx.effect`、声明合并、能力 seam 的三段式）。
2. **参考代码要读"为什么"，不只读"怎么做"**。比如 `credentials-local` 的
   `Service.init` 是生成器 —— 它 `yield` 出来的就是 disposer；这个形状说明了
   "类插件的激活期工作与清理该写在哪"。
3. **数据能直接看就不要反推**。反推会给出看起来很确定的错误答案（我们据
   `conversation_name` 全空推出"协议端不发群名"，实际是字段名读错了）。
4. **拿不准就停下来问**，不要在装饰性细节上连开四轮验证。

---

## 二、分层：上面干净，脏的分支沉到底

**越靠上层，抽象越简洁；跟平台耦合的条件分支，全部封装在 adapter / api 底层。**

这条来自 Shiraha_OS 的 `conversation_info` —— 它存在的意义就是把**群和私聊统一成一个
`conversation` 概念**；但当时的实现里，adapter 内部仍写满 `if group ... else private ...`，
底层照样按平台分开处理。**抽象建了，分叉没有收进去。**

本仓库的形状（正例）：

```
adapter/buffer.ts:69    conversationOf()  ← 全仓唯一写 group:/private: 的地方
                            ↑ 抽象在边界上，分支也只在边界里
上层（tools / signals / attention / perception）
                         ← 只认 conversation id 字符串，不做类型分叉
```

**判断标准**：`group:` / `private:` 这类平台分叉，或者 OneBot 的 `send_group_msg` /
`send_private_msg` 这类 API 差异，**只许出现在 `qq/adapter`（和 `qq/protocol`）里**。
上层出现第二处，就是这次这种重复。

---

## 三、DSH 的几条硬规矩（违反了会直接坏）

| 规矩 | 具体 |
|:--|:--|
| **导出形态不能混** | 服务包 `export default class extends Service`；函数插件 `export name/inject/Config/apply`，**没有 default**。混了 Loader 会丢掉命名空间 |
| **类插件用 `Service.init`** | 激活期工作 + disposer 放这里（生成器，`yield` 出来的就是 disposer）。**构造函数里 `this.ctx` 的属性代理对拓扑敏感** —— `this.ctx.logger` 在那里是 `undefined` |
| **`logger` 不是可注入的服务** | `static inject = ['logger']` 会让插件**永不激活**（它等一个不会出现的服务）。`logger` 是 Context 的自有属性（`vendor/cordis/src/context.ts:81`） |
| **服务要声明合并** | `declare module '@deepseek-ai/cordis' { interface Context { db: Db } }`，否则消费者拿不到 `ctx.db` 的类型 |
| **source plane vs artifact plane 不能混** | tsconfig 的 `paths` 指 `src/`，但 `@deepseek-ai/dsh-session/fork` 这类子路径要指 `lib/types/*.d.ts`。混了报"类型不兼容"，看着像 bug 其实是面混了 |
| **注册即 effect** | `ctx.effect(() => register(...))` |
| **`emit` 是一个抛错全饿死** | cordis 的 `emit` 用 `Array.map`，**一个监听器抛错会饿死后面的**。监听器自己包 try/catch |
| **无硬编码可调项** | 部署可变的都放进 `Config` |
| **配置错了要响** | 宁可 `ValidationError` 不激活，也不要静默用一个错值 |

---

## 四、验证手段（选可靠的通道）

| 要验什么 | 用什么 |
|:--|:--|
| 纯逻辑 | `tests/*.spec.ts`，从 `deepseek-harness` 跑 `node --import tsx/esm <spec>` |
| 三层一致性 | `scripts/check.ps1`（类型 + 装配树 + 全部 spec） |
| 插件真激活了 | 启动后看 `did not activate` 计数 |
| **服务真的跑到了** | **写一行数据进库**，别信日志（`Service.init` 有没有被调用，就是这么确认的） |
| **要看原始事件** | **写文件**（`appendFileSync`）。`ctx.logger` 打 JSON 会被格式化吃掉（内容含 `%`），`console.log` 走管道会被缓冲 |
| 数据库内容 | 直接 `node -e` 用 `node:sqlite` 查，不猜 |
| ★ **运行时查别的服务** | **别在 `apply` 里立刻查。** 插件的激活序由**依赖满足**决定，**不是补丁层的行序** —— 在 `apply` 里马上 `ctx.llm.listModels(...)` 会拿到 `no adapter registered for provider "xxx"`，而那只说明**那个插件还没激活**（实测：同一个 provider 等 1.5~3 秒就就绪）。**这个假象和"配置没生效"长得一模一样**，会把人骗去改配置 |
| ★ **临时运行时探针** | 写一个 `plugins/_probe-xxx.ts` ＋ 临时补丁行：它 `inject` 目标服务，**重试等待**到就绪，把结论 `appendFileSync` 到 `%TEMP%`，然后**用完就删**（连同补丁行）。这是"服务真的跑到了"之外的第二种确认 |
| ★★ **`systemPrompt.assemble()` 的 scope** | **照 `assembleContextFor()` 的写法传 `{ agent, scope: agent }`** —— `scope` 要的是 **Agent 对象本身**，不是 `agent.scope`（`core/agent/src/dispatch.ts:174-176`）。传错层**不报任何错**，只会静默给出两个假象：① agent 注册的段落全变 **0 字** ② `tcb` 的 `sections` 白名单**看起来没生效**。**我为此误判过一次"人设没进提示词"，差点去改好的 `tcb.apply`** —— 而且"不带 scope"与"传 `agent.scope`"**犯的是同一个错**，拿它们互为对照会得出"两边一致 ⇒ 不是作用域问题"的错误结论。**探针的对照组必须有一组是真的走对的那条路** |
| ★★ **强杀会撕坏会话帧** | 会话日志是**多帧 zstd**，撕在帧中间就是残帧，而**下次开机读它会报 `corrupt session log`**（`assertStoredIdentity` 要校验头）。实测：一晚 `Stop-Process -Force` 十几次之后，`session.v4.jsonl.zstd` 停在 **259 字节**、**再也不长**，而且**没有任何报错** —— 1632 个事件只在内存里，进程一停就没了。**别拿 `-Force` 当默认停机方式** |
| ★★ **改 `sessionId` 要连文件头里的 `id` 一起改** | 路径与**头里的 `id`** 必须一致，否则 `assertStoredIdentity` 拒收 ⇒ **`dsh` 直接 `fatal load failure`、起不来**。只改目录名就是这个后果。**要么连头一起改（解帧 → 改 id → 重压），要么干脆从空会话重来** |
| ★★ **`create` 出来的会话不落盘、也不报错** | 只有 **`resume`** 会「打开持久化会话以便写入」（`core/agent/src/index.ts:192-193`）。`create` 建的是**纯内存**会话：`sessions.flush()` **不报错也不写**（没有写句柄 ⇒ 无事可做 ⇒ 静默）。★ 而 `interrupt_plan` 的待办**只存 `sessionId + seq`**，指望 `session_event_read` 回去看原文 ⇒ **盘上没有，整条恢复路径就是断的**。★ 首次建出来的还要**显式 flush 一次**落个文件，否则下次开机 `stat` 找不到、永远进不了 `resume` |
| ★★ **往模型组／白名单里写 id 之前，先在 provider catalog 里查它存不存在** | 我往 `main` 的 `models` 组里写了 `DeepSeek-R1` / `V3`，**而它们没在 `llm-pi-ai` 里声明** ⇒ 均衡换过去之后**那一轮在出网之前就死** ⇒ **她醒着却不回话，而且探针里连失败的记录都没有**。为此付了**两次**真机故障，而且两次都把原因错判到"架构缺一层"上 ✗。**一次 grep 就能避免** |
| ★★ **两个"改请求"的 seam 分工不同** | `agent/request`（返回 `LlmCallConfig`）**才是"每个请求决定 `provider`/`model`"的那一层** —— 代码里的报错信息自己写着 *"or supply both via the `agent/request` waterfall"*（`core/agent-loop/src/agent.ts:581`）。而 **`llm/stream` 的 `options` 改不动**（适配器早就解析完了）⇒ 在那里改写 `options.model` 会让**日志与实际出网的不一致**、请求**构造不出来**。**在这两个 seam 上动手之前，先读这两处的代码** |
| ★★ **加工具时 `defineTool` 有两处硬要求** | ① **必填参数要逐字段写 `required: true`** —— ⚠️ 这与 JSON-Schema 的 `required: [...]` 数组**不是一回事**（这里是**逐字段** ✓）。不写 ⇒ `args.x` 被当成 `string \| undefined` ⇒ `TS2345`。② **`output` 必须同时有 `schema` 和 `render(args, value) => ContentBlock[]`** ⇒ 只写 `schema` 报 `TS2741`；**两个都不写**则结果类型被推成 **`never`** ⇒ `Type '…' is not assignable to '… => Promise<never>'`（**实测：一次加 10 个工具全挂在这一条上，来回失败两次、两次都得 `git checkout` 回退** ✗）。★ **对照模板：`qq_recall_message`（最短最干净）** —— 加工具前先读它 |

> ★ **上面那条的教训比它本身更重要**：两次失败都源于"只读了工具的**结尾**"（`execute` 的 `return`），
> 而关键全在**开头** —— 这正是 §一 那条「**改任何东西之前，先读已有的同类实现**」，
> 而我在**同一轮里犯了两次** ✗。

---

## 五、工具坑（Windows / PowerShell 5.1）

- `$p` 和 `$P` 是**同一个变量**（大小写不敏感），循环变量会覆盖
- `if (git check-ignore -q ...)` 测的是**输出**不是退出码 —— 用 `$LASTEXITCODE`
- 大段中文 here-string 传 `pwsh -Command` 会解析失败 —— **写入临时文件再 `git commit -F`**
- `Get-Content` 默认按 ANSI 解 —— 看文件内容用 `read` 工具（UTF-8），否则会看到假乱码
- `git mv` 到**不存在的目录**会静默失败；紧接着的 `Remove-Item` 会把源删掉。**先建目录**
- 删/改之前确认路径。`Remove-Item -Recurse` 在路径写错时没有第二次机会

---

## 六、当前进度

见 `PLOS/docs/design.md` **§十三** 的实施顺序（M1–M6）。
M1（数据库设施）、M2（感知）、M3（attention 重写）、M4（qq 领域改造）、
M5（注意力转移：`attention` 收缩 + `pointer` 退化成焦点 + `tcb` + **`interrupt_plan`**）
已完成。

**M6（收尾）也已完成**：唯一的真功能是 **`vlm2text`**（图片 → 一句话），
落点是**领域无关的服务** + QQ 侧一行接线，外加一堆文档收尾。

> ⚠️ **M6 的原方案里有一个后来被推翻的判断**，写在 `PLOS/docs/m6.md` 里，别重新踩：
> 原设计打算"在 `agent/request` 瀑布里把图换成文字"。**那条路走不通** ——
> `agent/request` 的载荷 `LlmCallConfig` **没有 messages 字段**，而且
> "**请求是 session log 的纯函数**"，非确定性的 VLM 描述只能在**源头**进 log。
> 要动图片这条路之前先读 `docs/m6.md` 与 `plugins/vlm2text/index.ts` 的模块注释。

**M5 的权威设计是 `PLOS/docs/m5-preemption.md` §20**（不是 §6–§19 —— 那几节是
被取代的 RTOS 嵌套模型，保留作"已排除的选项"）。要动 `attention` /
`interrupt_plan` / `pointer` 之前先读 §20。

---

## 七、★ 别把"将来的纪律"套到"现在的情况"上

这是第一节那个毛病的**第二种形状**，而且更隐蔽——因为它引用的规矩**本身是对的**。

**实例**：要删掉数据库里一张已经没人用的表（`current_session`，被 `ctx.pointer` 取代）。
我提议**加一条迁移 v2**，理由是"只许追加、不许改已发布的迁移"。

**用户一句话点破**：

> 这是升级用的吗？但是我们之前的那个架构压根没派上用场，也就是**根本不是发布版**，
> 现在只是在 **V1 内部做修正**。

**"只许追加"这条纪律的前提是「有升不动的数据」**：

| 阶段 | 该怎么做 |
|:--|:--|
| **现在**（没有不可再生数据） | **直接改 v1**，删掉测试库让它重建 |
| **将来**（有白羽的记忆、消息存档） | **必须**追加式迁移——那些数据丢了补不回来 |

**我引用了将来才成立的纪律，来解释现在该做的事。**

**判据**（问自己三句）：

1. **有人能被我这次的改动弄坏吗？** —— 没有别人，只有我自己造的测试数据 → 随便改
2. **有不可再生的东西吗？** —— 消息存档、记忆、会话日志才算；测试库不是
3. **这条规矩的前提在当前成立吗？** —— 前提是"已发布 / 有存量数据"，那就要先确认它存在

**顺带一条**：不要拿"顺便验证机制"当理由加代码（我拿"顺便验证迁移能跑第二次"当过理由）。
真需要覆盖某条路径，等它真的需要存在时，**连测试一起写**。

**同类错误的前三次**（第一节）：冗余 `trigger` 字段、常量化的上下限、靠反推断定"群名拿不到"。
**共同点始终是：先套规则/先下结论，后看情况。** 这一节把它推广到"规矩本身没错、但不适用于当下"。

---

## 八、★ 部署：`data/tcb.json` **不进版本库**，而它有"骨架"的一半

**症状**（★ 它是**静默**的 ✗，所以值得单独记）：

```
★ 换机器 / 重装 / 从旧备份恢复 ⇒
   ★ `tcb` 的 `sections` 白名单里**漏了几个段** ✗
   ⇒ 那些段**进不了系统提示词** ✓
   ⇒ ★★ **不报错** ✗ —— 只表现为"她不知道有这件事" ✓
```

**为什么危险**：★★ 我们的**工具包**机制正是靠这个 ✓ ——
那段"**有哪些包可以取、包里有什么**"是一个 section（名字 `tool-packages` ✓）。
★ 而包里的工具**平时不在 `tools` 里** ✗（★ 那正是设计 ✓）⇒
★★★ **名单漏了 `tool-packages` ⇒ 那些能力对她等于不存在** ✗✗。

**为什么它不进版本库**：`data/` 整个被 gitignore ✓（★ 因为它一半是私密的 ✓ ——
`identity: "data/identity/shiraha.md"` 指向**她的人设** ✗）。

**做法**：

| 文件 | 内容 | 在版本库吗 |
|:--|:--|:--|
| ★ `profiles/main/tcb.example.json` | ★★ **骨架**：`default` ✓／**全部段名** ✓／模型组 ✓；`identity` 用 **占位符** ✓ | ★ **是** ✓ |
| ★ `data/tcb.json` | ★ 真实配置（★ 含**她的**人设路径 ✗） | ✗ 否（gitignored ✓） |

★ **新机器上**：★ 把模板拷成 `data/tcb.json` ✓ ⇒ ★ 改 `identity` 与模型组 ✓ ⇒ 起 ✓。

★★ **而两边的一致性有自检** ✓：`plugins/tcb/tests/tcb-template.spec.ts`
（★ 逐字比对段名列表 ✓ —— **谁加了段而忘了更新模板，它就红** ✓✓）。
⚠️ `data/tcb.json` **不存在时它跳过** ✓（★ 新 clone 的机器正是那种状态 ✓ —— 不该失败 ✓）。

★ **加段的清单**（★ 少一步就是这次这个静默故障 ✗）：
```
① 插件里注册 section ✓
② **补进 `data/tcb.json` 的 `sections`** ✗ ← ★ 漏这里 ⇒ 她看不见 ✓
③ **补进 `profiles/main/tcb.example.json`** ✗ ← ★ 漏这里 ⇒ 换机器就坏 ✓
   （★ ② ③ 都补完，自检会自己确认 ✓）
```


