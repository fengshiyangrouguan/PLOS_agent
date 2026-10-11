# PLOS_agent

PLOS（Pervasive Linguistic Optative System / 泛在语言型自主系统）的**AI 主体**工程。

本仓库是 DSH 的一个 **`$DSH_HOME`**：DSH 的运行时数据根。仓库的全部内容是"我们相对 DSH 的差异"，
DSH 自身作为上游 pin 在 `../deepseek-harness/`，**不进入本仓库**。

## 读什么

| 想做什么 | 去哪 |
|:--|:--|
| **理解 DSH 的结构、决定开发方向** | [docs/handbook/index.html](docs/handbook/index.html) —— DeepSeek Harness 源码导读（16 页，按子系统逐页拆） |
| 动手写插件、跑起来、看日志 | 本文档的[开发流程](#开发流程) |
| 查某个概念的定义 | 手册的[零基础预备课](docs/handbook/basics.html)（Cordis 四概念） |

手册目录：

```
docs/handbook/
  index.html                 总览与六步阅读路线
  basics.html                零基础预备课（Cordis 四概念）
  architecture.html          架构与阅读方法（五层装配 / seam / 事件三域 / 官方扩展点表）
  page-cordis.html           Cordis 内核
  page-boot.html             启动与装配
  page-map.html              代码地图（319 个包怎么找）
  page-session.html          会话事件溯源
  page-projection.html       投影与派生状态
  page-agent-loop.html       Agent 循环
  page-system-prompt.html    提示词装配
  page-tools.html            工具运行时
  page-llm.html              模型层
  page-approval.html         审批与沙箱
  page-persistence.html      持久化与存储
  page-extensions.html       运行时自修改
  page-plos.html             PLOS_agent 要做什么  ← 读完全部后的收口
```

用浏览器直接打开 `docs/handbook/index.html` 即可，无需构建。

> **改手册页面时注意**：每页开头必须有 `<meta charset="utf-8">`（必须在文件最前 1024 字节内）。
> 参考手册的模板没有这一行，本地打开会把中文按 ANSI 解码成乱码。重写整页时容易丢，改完请抽查。

## 为什么是这个形状

DSH 没有启动代码。它的装配模型是：

```
最终插件树 = 空根 + 各 bundle 的补丁层 + 我们的 profile 补丁层
```

- `cordis.yml` 是**空条目列表**（`[]`），由 DSH 每次启动重写，**不要编辑**。
- `cordis.patch.yml` 是**我们的补丁层**，DSH 自己的内部插件（session / llm / agent /
  tools / approval / …）由 `dsh-base` 的补丁层提供，我们在此之上 insert 自己的行、
  或按 `id` 覆盖 DSH 已有的行。

所以"我们的插件"和"DSH 的插件"走完全相同的路径，区别只在这两个文件在谁的目录里。

## 目录结构

```
PLOS_agent/                              ← 本仓库 = $DSH_HOME
├── cordis.patch.yml                     # home 层：对该 home 下所有 profile 生效
├── scripts/                             # 开发工具
│   ├── dev.ps1                          #  启动 + 日志落盘
│   └── check.ps1                        #  类型 + 装配树 快检
├── logs/                                # dev.ps1 的日志，已 gitignore
└── profiles/
    └── main/                            # profile：一个可启动的"应用"
        ├── package.json                 # dsh.profile.bundles + pnpm 成员名
        ├── cordis.patch.yml             # ★ 我们的补丁层
        ├── pnpm-workspace.yaml          # DSH 规定的树外插件 pnpm 设置（勿改）
        ├── tsconfig.json                # IDE / tsc 的 @deepseek-ai/* 解析
        ├── cordis.yml                   # 生成物，勿编辑，已 gitignore
        ├── node_modules/                # pnpm 产物，已 gitignore
        └── plugins/                     # ★★ 我们写的插件，一文件一插件
```

### profile 有两个"名字"，别混

| 名字 | 在哪 | 谁在用 |
|:--|:--|:--|
| **`main`** | 目录名 `profiles/main/` | **真正的身份**。`--profile main` 选的就是它；DSH 内部 `Profile.name = basename(dir)`（`profile.ts:765`） |
| **`dsh-profile-plos`** | `profiles/main/package.json` 的 `name` | **只有 pnpm 看**。profile 目录是 pnpm workspace 成员（见 `pnpm-workspace.yaml` 的 `packages: ['.']`），成员必须有 `name` |

DSH 的 `initProfile()` 按 `dsh-profile-${目录名}` 生成后者——因为**它自己的** profile 目录就叫
`web` / `headless` / `acp`，应用名与目录名天然一致。我们不跟这条规则：**项目身份是 PLOS，与它落在
哪个目录无关**；`PLOS_agent/` 只是开发时的容器。

**DSH 里没有任何逻辑读 `package.json` 的 `name`**——它只读 `dsh.profile.bundles` 和
`dependencies` / `peerDependencies`（`profile.ts:536-540`）。所以两者不一致不会出任何问题。

## 运行

```powershell
$env:DSH_HOME = 'E:\project\PLOS\PLOS_agent'
cd E:\project\PLOS\deepseek-harness
pnpm dsh --profile main
```

不需要 `pnpm run build`：DSH 的开发入口是源码直跑（`node --import tsx/esm`），
`lib/` 是发布用的 artifact plane。

## 常用诊断

```powershell
# 看叠完之后的完整装配树（不挂载，不需要 API key）
pnpm dsh --profile main --dump-config

# 只看 bundle 层（不含我们的补丁层）
pnpm dsh --profile main --dump-default-config
```

`--dump-config` 输出的每一段都带 `# == <来源>` 标注，可以据此判断某一行是谁加的、被谁改过。

## 开发流程

一次典型的循环：**写插件 → 挂进补丁层 → `check` 验证 → `dev` 跑起来看日志**。
插件源码有热重载，改文件不用重启。

### 0. 一个插件 = 一个模块，不一定是一个文件

Cordis 的"插件"是**一个模块**：具名导出 `name` / 可选 `inject` / 可选 `Config` / `apply`。
补丁层里的 `name` 指向的就是这个模块的入口。

| 情况 | 放法 | 补丁层里写 |
|:--|:--|:--|
| 单文件够用（多数情况） | `plugins/qq-tools.ts` | `'./plugins/qq-tools.ts'` |
| 需要拆子模块 | `plugins/qq-adapter/index.ts` + `ws.ts` + `segments.ts` | `'./plugins/qq-adapter/index.ts'` |

**先用单文件。** 超过两三百行、或需要私有子模块时再升级成目录——补丁层那行改个路径而已。

### 1. 写

`profiles/main/plugins/` 下建 `.ts`：

```ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'my-plugin'

export function apply(ctx: Context) {
  ctx.logger.info('activated')
}
```

#### 三条硬纪律（来自 DSH，违反会静默或难查）

1. **函数插件只具名导出 `name`/`inject`/`Config`/`apply`，绝不能有 `default` export。**
   Service 包反过来必须 default-export 服务类。混用会让 Loader 丢掉函数插件的命名空间。
2. **一切注册都必须是可逆副作用**：走 `ctx.effect()` / `ctx.on()`，或使用返回 disposer 的
   `register()`。卸载时框架会自动回收。
3. **waterfall 监听器必须调 `next()`** 才算委托；不调即短路整条链。

### 2. 挂进树

改 `profiles/main/cordis.patch.yml`：

```yaml
- insert:
    - id: my-plugin          # 稳定协调键；以后要改它的 config，用同一个 id 定位
      name: './plugins/my-plugin.ts'
```

`name` 的相对路径基准是 **profile 目录**（`profiles/main/`）。

**改完这个文件立即生效，不用重启**——DSH 的 hmr 默认监视 profile 配置。
（监视范围看启动日志里的 `hmr watching [...]` 那行。）

### 3. 验证（三层，从便宜到贵）

```powershell
# ① 类型 + 装配树 —— 秒级，不挂载、不需要 API key
.\scripts\check.ps1
```

它会跑 `tsc -p profiles/main/tsconfig.json`，然后 `--dump-config` 并摘出
「由我们补丁层贡献/修改」的行。**新插件没出现在这个列表里 = 没挂上**，先查 `id`/路径。

```powershell
# ② 真启动（挂载整棵树，看插件有没有激活）
.\scripts\dev.ps1
```

日志里看两件事：插件自己打的日志，以及末尾的 `dsh: warning: N entries did not activate`。

```powershell
# ③ 让模型真的调用你的工具 —— 需要一个 app bundle + API key
.\scripts\dev.ps1 -- --profile headless "试一下 plos_ping"
```

（目前 `dsh.profile.bundles` 只装了 `@deepseek-ai/dsh-base`，没有 app 层，
所以进程挂载完就常驻。要跑任务就加 `@deepseek-ai/dsh-headless`。）

#### 插件没激活时怎么查

| 日志 | 含义 | 查什么 |
|:--|:--|:--|
| 行根本不在 `--dump-config` 里 | 补丁没匹配上 | `id` 拼写、`name` 相对路径、YAML 缩进 |
| `X (...): failed to import` | 模块加载抛错 | **DSH 不打印原因**，单独 import 它拿真实错误（见「环境坑 1」） |
| `X: pending [missing]` | inject 的依赖没提供 | 那个服务的提供方插件挂了没 |
| 没有警告但也没有日志 | 激活了，只是没打日志 / 打早了 | 无 `inject` 的插件可能早于 logger exporter 挂上（见「环境坑 2」） |

### 4. 启动

```powershell
.\scripts\dev.ps1                       # 默认 profile: main
.\scripts\dev.ps1 -Profile main         # 显式指定
```

脚本做的三件事：设 `$DSH_HOME` 为本仓库、`cd` 到 `../deepseek-harness`、跑
`pnpm dsh --profile <名>`。等价的手工命令：

```powershell
$env:DSH_HOME = 'E:\project\PLOS\PLOS_agent'
cd E:\project\PLOS\deepseek-harness
pnpm dsh --profile main
```

**不需要 `pnpm run build`。** DSH 的开发入口是源码直跑（`node --import tsx/esm`），
`lib/` 是发布用的 artifact plane，只有 `tsconfig.json` 的类型解析依赖它。

### 5. 看日志

两个来源，都要用：

**① 控制台 / 日志文件。** `scripts/dev.ps1` 会把 stdout+stderr 同时 tee 到
`logs/<时间戳>-<profile>.log`（该目录已 gitignore）。**排查时认文件，滚动条会丢东西。**

日志级别在补丁层里配（`cordis-plugin-logger-console` 那行），
`0=ERROR 1=INFO 2=WARN 3=DEBUG`：

```yaml
- id: logger-console
  name: '@deepseek-ai/cordis-plugin-logger-console'
  config:
    levels:
      default: 1              # 想看更细就调到 3
      my-plugin: 3            # 也可以只给某个 logger 调
```

**② `--dump-config` 看装配树**，不挂载、不需要 key，是"某一行到底在不在树里"的权威答案。

### 6. 热重载

补丁层里已经开了：

```yaml
- id: hmr
  config:
    root: ['./plugins']      # 相对 profile 目录
```

| 改什么 | 效果 |
|:--|:--|
| `profiles/main/cordis.patch.yml` | **自动重载**（DSH 默认行为） |
| `profiles/main/plugins/*.ts` | **自动重载**（靠上面 `hmr.root`） |
| `tsconfig.json` | 不重载；那是给 IDE/tsc 的，与运行时无关 |
| DSH 安装本身（`deepseek-harness/`） | 不重载；重启进程 |

重载成功的日志长这样：

```
[PLOS_agent][A] hello activated — ...            ← 重新激活
2026-10-10 19:45:53 [I] hmr reload plugin at plugins\hello.ts
```

> `dsh-base` 里 hmr 的默认是 `root: []`（模块监视关闭），且补丁层对 `config` 是
> **整块替换**不是深合并——所以我们那行必须写完整。


## 在 IDE 里写插件（类型解析）

插件里的 `import { defineTool } from '@deepseek-ai/dsh-tools'` —— **运行时成功，IDE 报
"Cannot find module"**。这是正常的：运行时那套解析是 DSH 进程内装的拦截，TypeScript 看不见。

`profiles/main/tsconfig.json` 就是为这件事存在的：把同一批包告诉 TypeScript。
它指向**已构建的包目录**（artifact plane），依赖 DSH 的 `lib/` 产物。

```powershell
# 手动类型检查
cd E:\project\PLOS\deepseek-harness
node ./node_modules/typescript/bin/tsc -p ..\PLOS_agent\profiles\main\tsconfig.json
```

- 报找不到声明 → 先做下面的「坑 3」构建
- 新 import 了别的 DSH 包 → 在 tsconfig 的 `paths` 里补一行

### 为什么不直接继承上游那 500 行 `paths`

上游 [tsconfig.base.json](../deepseek-harness/tsconfig.base.json) 的 `paths` 指向各包的
**`src`**，配的是 project references（DSH 原话：*Project references, not declaration path
aliases, keep each package/vendor source compiled under its own tsconfig boundary*）。从我们这边
继承过来，会把 DSH 的**全部源码**拖进本次检查，而它们各自依赖自己的 tsconfig 选项——
实测得到几十条与插件毫无关系的报错。

所以：`extends` 只用来拿编译选项，`paths` 整体覆写指向 `lib/types`（子配置的
`compilerOptions.paths` 会替换父配置的，不会合并）。

## 环境坑（实测记录）

搭骨架时踩到三个，记在这里免得复踩。

### 1. profile 的 `package.json` 必须有 `"type": "module"`

否则 Node 把 profile 目录下的 `.ts` 当 CommonJS，插件加载抛：

```
Cannot require() ES Module ... in a cycle.
A cycle involving require(esm) is not allowed to maintain invariants mandated
by the ECMAScript specification.
```

DSH 自己的每个包都声明了 ESM，但 `initProfile()` 生成的 profile 清单**不含**这一项。

这个坑的排查难度在于：`dsh: warning: N entries did not activate` 只会显示
`<id> (<url>): failed to import`，**不带原因**。要拿到真实错误，得单独 import 那个文件：

```powershell
cd E:\project\PLOS\deepseek-harness
node --import tsx/esm -e "import('file:///E:/project/PLOS/PLOS_agent/profiles/main/plugins/hello.ts').catch(e=>console.error(e.message))"
```

### 2. console logger exporter 不在 `dsh-base` 里

`logger` 是 cordis 核心服务，但它的 **exporter 是独立插件**
（`@deepseek-ai/cordis-plugin-logger-console`）。base bundle 里没有任何 logger 行，
不装则 `ctx.logger.*` 的输出**没有去处，静默丢弃**。本仓库的补丁层已 insert 该行。

附带一个时序坑：**无 `inject` 的插件在装载瞬间就激活，可能早于 exporter 挂上**，
此时发出的日志被丢弃（同一个补丁层内的行序不代表激活序）。所以最早期的自检
用 `console.log` 直接写 stdout——见 `plugins/hello.ts`。

### 3. `typert-loader` 需要构建产物

源码直跑时 `typert-loader` 会报 8 个 contributor 失败：

```
@deepseek-ai/dsh-llm exports "./typert" but importing .../lib/typert.host.js failed:
Error: Cannot find module '.../lib/typert.host.js'
```

`lib/typert.host.js` 由 tsdown + typert 插件生成，源码直跑拿不到。
它是 RPC / 类型图层（Web 面与 remote 服务用），base-only 的 agent 暂时可以无视。
需要时跑（**不要**直接 `pnpm run build`，那会把 Electron desktop 也打一遍）：

```powershell
cd E:\project\PLOS\deepseek-harness
node --max-old-space-size=4096 ./node_modules/typescript/bin/tsc -b tsconfig.host.json
npx tsdown --config-loader native --env.DSH_BUILD_FACE host
```

## 依赖边界

| 目录 | 进 git？ | 说明 |
|:--|:--|:--|
| `profiles/*/plugins/` | ✅ | 我们的插件源码 |
| `profiles/*/cordis.patch.yml` | ✅ | 我们的补丁层 |
| `profiles/*/package.json` | ✅ | bundle 选择 |
| `profiles/*/pnpm-workspace.yaml` | ✅ | 承载"单一 cordis 实例"这条不变式 |
| `profiles/*/tsconfig.json` | ✅ | IDE / tsc 的 `@deepseek-ai/*` 解析 |
| `scripts/` | ✅ | 开发工具 |
| `profiles/*/cordis.yml` | ❌ | DSH 每次启动重写 |
| `profiles/*/node_modules/` | ❌ | pnpm 产物 |
| `logs/` | ❌ | 运行日志 |
| `storages/`、`.anonymous-user-id`、`sessions/`、`attachments/` | ❌ | $DSH_HOME 运行时数据 |
| `../deepseek-harness/` | ❌ | 上游，带自己的 `.git`，用 `git fetch && git checkout <SHA>` 升级 |

### 关于 `scripts/*.ps1` 的编码

**必须保存为 UTF-8 with BOM。** Windows PowerShell 5.1 会把无 BOM 的 `.ps1` 当 ANSI 读，
中文注释会直接把语法搞崩。改这些脚本时注意别把 BOM 弄丢。
