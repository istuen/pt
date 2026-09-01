Pt 在 Pi Agent 中以**斜杠命令 + 启动 flag + UI 通知**三件套形式暴露给用户。本页面向刚接入 Pt 的初级开发者，把所有日常会用到的命令、它们的输出长什么样、以及在哪里看转译产物一次性梳理清楚。所有命令都注册在 [src/index.ts](src/index.ts#L68-L260) 里，本质是 Pi ExtensionAPI 的 `registerFlag` 与 `registerCommand` 调用。

## 一、命令全景图

Pt 暴露给用户的命令表面只有两条（`/pt-context` 与 `/pt`），但配合启动 flag 和文件落盘产物，可以覆盖"激活—检查—导出—复用"四类调试需求。

```mermaid
flowchart TD
    A[启动 Pi Agent] --> B{指定了 --pt-context flag?}
    B -- 是 --> C[加载指定 Blueprint]
    B -- 否 --> D{读 .pi/settings.json<br/>的 au.pt-context?}
    D -- 有 --> C
    D -- 无 --> E{blueprints/ 下<br/>只有一个 Blueprint?}
    E -- 是 --> C
    E -- 否 --> F[status: 'pt: 无 context'<br/>notify: 用 /pt-context 选择]

    C --> G[解析 + 编译 + 缓存]
    G --> H[每轮 before_agent_start<br/>把 segment 注入 systemPrompt]

    H --> I{调试?}
    I -- 切换场景 --> J[/pt-context name]
    I -- 看状态 --> K[/pt status]
    I -- 列手册 --> L[/pt flows]
    I -- 导 segment --> M[/pt raw]
    I -- 导完整 prompt --> N[/pt full]
```

Sources: [src/index.ts](src/index.ts#L76-L100), [src/index.ts](src/index.ts#L130-L163), [src/index.ts](src/index.ts#L164-L259)

## 二、启动期：flag 与默认 Blueprint

### `--pt-context` 启动 flag

Pt 把启动 flag 定义在 `pi.registerFlag` 上，描述是"启动时激活的 Blueprint 名（编译成 Context 注入 System Prompt）"。`session_start` 阶段会按"**CLI flag > 项目 settings.json > 自动探测**"的优先级决定激活哪个 Blueprint。

```bash
# 启动 Pi Agent 并直接激活名为 pt 的 Blueprint
pi --pt-context=pt

# 等价写法
pi --pt-context pt
```

如果三个来源都没拿到名字，Pt 会把状态条置为 `pt: 无 context`，并弹一条 info 级通知提醒用 `/pt-context <name>` 选择，或在 `.pi/settings.json` 里加 `"au.pt-context": "<name>"`。注意：自动探测只有 `blueprints/*.blueprint.md` 文件**恰好一个**时才生效，避免误选。

Sources: [src/index.ts](src/index.ts#L69-L73), [src/index.ts](src/index.ts#L76-L98), [src/config.ts](src/config.ts#L51-L57)

### 项目级默认：`.pi/settings.json`

在仓库根目录的 `.pi/settings.json`（不是 `.pt/`）里加一个 `au.pt-context` 字段，就能给所有 session 一个默认 Blueprint。这样每次启动不用传 flag，也不用依赖自动探测。

```json
{
  "packages": [".."],
  "au.pt-context": "pt-dev"
}
```

`readProjectSetting<string>(cwd, "au.pt-context")` 会走 dotted key 解析，文件不存在或解析失败都安全降级到下一步。

Sources: [src/config.ts](src/config.ts#L19-L32), [src/index.ts](src/index.ts#L81-L82)

## 三、激活期：`/pt-context` 命令

`/pt-context` 是切换 Blueprint 的唯一运行时入口，注册在 `pi.registerCommand("pt-context", ...)`。它支持三种调用形态：直接传名字、传部分前缀触发补全、不传参数走选择器。

### 1. 带参切换

```bash
/pt-context pt-dev
# → status: 'pt: pt-dev'
# → notify (info): "已切换到 pt-dev，下一轮生效（已重编译）"
```

切换由 `switchBlueprint` 实现：先 `transpileActive` 重转译，再用 `ctx.ui.setStatus` 更新 footer，最后 `ctx.ui.notify` 告诉用户这次是缓存命中还是重编译。如果转译失败，会走 error 级通知，并把 footer 置为 `pt: 加载失败`。

Sources: [src/index.ts](src/index.ts#L36-L53), [src/index.ts](src/index.ts#L130-L163)

### 2. Tab 补全

`getArgumentCompletions` 会调 `listScenes(cwd)` 扫 `.pt/assets/blueprints/*.blueprint.md`，去掉 `.blueprint.md` 后缀作为补全项。例如 `blueprints/` 下有 `pt.blueprint.md` 和 `pt-dev.blueprint.md`，输入 `/pt-context p` 会补全到 `pt`，输入 `/pt-context pt-` 会补全到 `pt-dev`。

Sources: [src/index.ts](src/index.ts#L133-L141), [src/config.ts](src/config.ts#L36-L48)

### 3. 无参选择器

不传名字时，命令会先 `listScenes` 拿所有 Blueprint 名，再用 `ctx.ui.select("选择 Blueprint", names)` 弹选择器。**注意**：选择器依赖 `ctx.hasUI`，在纯 CLI 非交互模式会提示 `/pt-context（无参）在非交互模式不可用，请指定名称` 并退出。

Sources: [src/index.ts](src/index.ts#L142-L160)

## 四、检查期：`/pt` 子命令

`/pt` 是产物检查的"瑞士军刀"。`args.trim().toLowerCase()` 后匹配四个分支，**无参**等价于 `status` 且会把当前 segment 也打到通知里。子命令一览：

| 子命令 | 作用 | 落盘位置 | 何时用 |
|---|---|---|---|
| `/pt` 或 `/pt status` | 打印当前 session 状态摘要 | 不落盘 | 想知道"现在到底激活的是啥、有没有缓存命中" |
| `/pt flows` | 列出当前 Blueprint 下所有可触发的 FlowTemplate 手册 | 不落盘 | 想知道 `target=context_message` 注入点下哪些 `/name` 会被 Pt 接管 |
| `/pt raw` | 把 `cachedSegment`（仅 Pt 注入的那段 markdown）写到文件 | `.pt/raws/segment-<ts>.md` | 想看 Pt 自己产出的那段，不夹杂 Pi 原生 systemPrompt |
| `/pt full` | 把"Pi 原生 systemPrompt + cachedSegment"完整拼接后落盘 | `.pt/fulls/prompt-<ts>.md` | 想看 Agent 真实看到的完整 systemPrompt，方便逐字审查 |

**用法提示**：每个 `/pt` 子命令都依赖 `cachedSegment` / `cachedBundles`（在 `session_start` 或 `/pt-context` 时填充）。如果还没激活 Blueprint 就直接 `/pt raw`，会弹 warning `无 segment 可显示`；`/pt full` 在没 segment 时也只会写基础 systemPrompt，并补一条 warning。

Sources: [src/index.ts](src/index.ts#L164-L259)

### `/pt status` 输出长什么样

`status` 分支把六个字段用 `|` 拼成一行 info 级通知。运行示例：

```
pt context: pt-dev | pt domains: 8, channels: 2, blueprints: 3, flows: 4
| pt segment length: 6983 chars | pt cache hit: no
| pt last built prompt: 12450 chars | pt cwd: /Users/issac/pro/pt
```

字段含义对照表：

| 字段 | 来源 | 调试意义 |
|---|---|---|
| `pt context` | `activeBlueprint` 内存变量 | 当前激活的 Blueprint 名；若为 `(未激活)` 说明从未 `transpileActive` 成功 |
| `pt domains / channels / blueprints` | `cachedBundles` 三个数组 `.length` | 验证资产扫到多少；与磁盘 `ls .pt/assets/*/` 对照可发现文件命名不符被静默过滤 |
| `pt flows` | 所有 `type=workflow` 的 Domain 下 `Manual` 模块模板数 | 与 `/pt flows` 输出的数量一致；为 0 时说明没有 workflow-type 资产 |
| `pt segment length` | `cachedSegment.length` | 注入 systemPrompt 的字符串长度；与 `.pt/contexts/cache/<name>.context.md` 大致同量级 |
| `pt cache hit` | `lastCacheHit`（来自 `loadContext` 命中） | `yes` 表示本次是 cache 命中、`no` 表示重编译；频繁 `no` 说明 sourceHash 频繁变化 |
| `pt last built prompt` | `lastBuiltPrompt.length`（来自 `before_agent_start`） | `(未跑过 turn)` 说明本 session 还没发过任何消息 |

> 调用 `/pt` 不带任何参数时，除了打印上面那行，还会再发一条 notify 把完整 `cachedSegment` 贴出来——方便快速肉眼检查。

Sources: [src/index.ts](src/index.ts#L168-L194)

### `/pt flows` 输出长什么样

遍历当前 Blueprint 的 `injectionPoints`，找出所有 `target=context_message` 注入点引用的 `workflow-type` Domain，列出每个 FlowTemplate 的 `name` 和 `argumentHint`：

```
可用手册（输入 /手册名 参数 触发 Context Message）:
  /risk-check <客户ID> <金额>  ← pt-dev-flow
  /quote-tier <客户ID>  ← pt-dev-flow
  /explain-axiom <术语>  ← pt-concepts
```

如果当前 Blueprint 的 `target=context_message` 注入点没引用任何 workflow Domain，会提示 `当前 Blueprint 无可触发手册（target=context_message 注入点无 workflow-type Domain）`。

Sources: [src/index.ts](src/index.ts#L196-L222)

### `/pt raw` 与 `/pt full` 文件落地格式

两个写文件的子命令都用 `Date.now()` 作为时间戳后缀，避免重名覆盖。`mkdir({ recursive: true })` 保证 `.pt/raws/` 与 `.pt/fulls/` 在第一次写入时自动创建。

```bash
# 查看最近一次 raw 落盘
ls -lt .pt/raws/ | head -3
# 典型文件名：segment-1725171234567.md

# 查看最近一次 full 落盘
ls -lt .pt/fulls/ | head -3
# 典型文件名：prompt-1725171234567.md
```

落盘完成后会弹 info 级通知，例如 `已写入 /Users/issac/pro/pt/.pt/raws/segment-1725171234567.md（6983 chars）`。**`/pt full` 的亮点**是现拼而非读 `lastBuiltPrompt`：它直接 `ctx.getSystemPrompt() + "\n\n## 当前任务上下文\n\n" + cachedSegment`，所以切换 Blueprint 后立即 `/pt full` 就能拿到新产物的完整视图，**不需要先发一轮对话触发 `before_agent_start`**。

Sources: [src/index.ts](src/index.ts#L223-L255)

## 五、调试输出在哪看

Pt 的运行时反馈分布在四个通道：footer 状态条、toast 通知、控制台日志、磁盘文件。理解每个通道的形态，能大幅缩短排障时间。

### 1. Footer 状态条（`setStatus`）

`ctx.ui.setStatus("pt", ...)` 写到 Pi 主界面的底部状态栏。Pt 在三种情况下更新它：

| 状态文本 | 触发时机 | 含义 |
|---|---|---|
| `pt: 无 context` | `session_start` 三种来源都没拿到 Blueprint 名 | 资产目录里没东西，或 `.pi/settings.json` 没配 |
| `pt: <name>` | `session_start` 或 `/pt-context` 切换成功后 | 当前激活的 Blueprint 名 |
| `pt: 加载失败` | `session_start` 转译抛异常 | 见 toast 通知的 error 文案定位 |

Sources: [src/index.ts](src/index.ts#L48), [src/index.ts](src/index.ts#L88), [src/index.ts](src/index.ts#L94-L97)

### 2. Toast 通知（`ctx.ui.notify`）

Pt 用 `ctx.ui.notify(message, level)` 在 Pi 主界面弹 toast，level 决定配色（`info` / `warning` / `error`）。所有出现过的通知文案如下表：

| level | 文案 | 触发命令 / 路径 |
|---|---|---|
| info | `已切换到 <name>，下一轮生效（缓存命中）` | `/pt-context` 切换命中缓存 |
| info | `已切换到 <name>，下一轮生效（已重编译）` | `/pt-context` 切换重编译 |
| error | `切换失败：<errmsg>` | `/pt-context` 切换抛异常 |
| info | `Pt：未找到 Blueprint。用 /pt-context <name> 选择，或在 .pi/settings.json 设 au.pt-context。` | `session_start` 无 Blueprint |
| error | `Pt 加载失败：<errmsg>` | `session_start` 转译抛异常 |
| warning | `未找到任何 Blueprint（.pt/assets/blueprints/*.blueprint.md）` | `/pt-context` 无参但 `blueprints/` 为空 |
| warning | `/pt-context（无参）在非交互模式不可用，请指定名称` | `/pt-context` 无参 + 非交互 |
| info | `pt context: ... \| pt domains: ... \| ...` | `/pt status` 或裸 `/pt` |
| warning | `无激活 Blueprint，先用 /pt-context <name> 激活` | `/pt flows` 无 cachedBundles |
| info | `当前 Blueprint 无可触发手册...` | `/pt flows` 但无 workflow Domain |
| info | `可用手册（输入 /手册名 参数 触发 Context Message）:\n  /name hint ← domain\n  ...` | `/pt flows` 正常输出 |
| warning | `无 segment 可显示` | `/pt raw` 无 cachedSegment |
| info | `已写入 <path>（<N> chars）` | `/pt raw` 落盘成功 |
| warning | `警告：无 cachedSegment（未加载 Blueprint）。用 /pt-context <name> 选择` | `/pt full` 无 segment |
| info | `完整 systemPrompt 已写入 <path>（<N> chars）` | `/pt full` 落盘成功 |
| warning | `用法: /pt [status|flows|raw|full]` | `/pt <未知子命令>` |

Sources: [src/index.ts](src/index.ts#L36-L259)

### 3. 控制台日志（`console.warn` / `console.error`）

Pt 在 Node 端用 `console.warn` 打 warning、`console.error` 打 error，**只在解析或编译阶段出错时输出**。在 Pi 终端里能看到的关键日志有：

- `[pt] adapter <name> failed: <err>` — 某个 SourceAdapter 加载失败（当前只有 `oxn` 一个），失败会被 try/catch 吞掉并继续
- `[pt] Blueprint "<name>" 引用了未知 Channel "<channel>"` — Blueprint 引用的 Channel 在 `channels/` 下找不到，**该 Blueprint 会被跳过**
- `[pt] Blueprint "<name>" 引用了未知 Channel "<channel>"`（来自 `loadAndTranspile`）— 同上
- `[pt] parse <dir>/<file> failed: <err>` — 单个 `.md` 资产解析失败，文件被静默跳过

如果一个 Blueprint 引用的 Channel 名字拼错，**`/pt status` 仍会显示 blueprints 计数正确，但该 Blueprint 的 segment 永远是空字符串**——务必打开终端查 `console.warn`。

Sources: [src/transpile.ts](src/transpile.ts#L54-L57), [src/parse/index.ts](src/transpile.ts#L54-L57), [src/parse/index.ts](src/parse/index.ts#L75-L92)

### 4. 磁盘文件：`.pt/contexts/cache/*.context.md`

每次 `loadAndTranspile` 都会把编译产物写到 Blueprint 配置的 `cacheDir`（默认 `.pt/contexts/cache/`）。文件结构是 YAML frontmatter + 按注入点切分的 H2 段：

```markdown
---
source-hash: fc783f9d-00002e35
name: pt
---

## 会话知识

> 当用户询问 Pt 自身相关知识...

### 全局约束
- [ ] parse / compile / render 三层职责互不渗透...

### 流程
① **identify-topic** — ...
② **cite-domain** — ...

### 模块「pt-concepts」

**术语**
- **Pt 是什么**：...
```

**`source-hash`** 是失效依据——`loadContext` 会读 frontmatter 的 `source-hash` 和 `computeSourceHash(...)` 现算的对一遍，不一致就返 `null` 触发重编译。修改任意 Domain / Channel / Blueprint 都会让 hash 变化，缓存自然失效。**`split: by-injection-point`** 模式下每个注入点一个文件，但当前版本留 TODO 走 fallback。

Sources: [src/render/cache.ts](src/render/cache.ts#L26-L111), [src/compile/context.ts](src/compile/index.ts#L3-L3)

## 六、典型调试流程

把命令和输出串起来，常见排障路径有三条。

### 路径 A：segment 是空的

1. `/pt status` — 看 `pt context:` 是不是 `(未激活)`
2. `ls .pt/assets/blueprints/*.blueprint.md` — 确认资产文件在
3. 终端找 `[pt] Blueprint "..." 引用了未知 Channel` — 检查 frontmatter.channel 与 channels/*.md 的 name 对齐
4. 终端找 `[pt] parse ... failed` — 某资产 YAML/H2 解析失败
5. `/pt context pt` — 重激活一次触发重编译
6. `/pt full` — 落盘对比 Pi 原生 prompt 末尾有没有 "## 当前任务上下文"

Sources: [src/transpile.ts](src/transpile.ts#L54-L57), [src/index.ts](src/index.ts#L168-L194)

### 路径 B：缓存没命中（编译太慢）

1. `/pt status` — 看 `pt cache hit:`
2. `cat .pt/contexts/cache/<name>.context.md` — 对比 frontmatter 的 `source-hash`
3. 检查是否改了 Domain 的某行小文案——`sourceHash` 把整文件 hash 进去，小改也会失效
4. 故意改一次 Blueprint 的 `name:` —— 强制重置 sourceHash

Sources: [src/render/cache.ts](src/render/cache.ts#L60-L70)

### 路径 C：`/name` 没触发手册

1. `/pt flows` — 确认手册名是否在列表里
2. 如果列表空：检查 Blueprint 注入点中是否有 `target=context_message`
3. 检查引用的 Domain `frontmatter.type` 是不是 `workflow`
4. 检查 Domain 是否有 `## Manual` 段（FlowTemplate 解析依赖它）

Sources: [src/index.ts](src/index.ts#L196-L222), [src/render/context-message.ts](src/render/context-message.ts#L1-L50)

## 七、最小调试速查表

| 我想… | 命令 |
|---|---|
| 启动时直接激活某个 Blueprint | `pi --pt-context=<name>` |
| 给当前项目设默认 Blueprint | 在 `.pi/settings.json` 加 `"au.pt-context": "<name>"` |
| 切换到另一个 Blueprint | `/pt-context <name>` 或 `/pt-context`（弹选择器） |
| 看当前激活状态 + 计数 | `/pt status` |
| 看 segment 原文（一次性） | `/pt`（裸命令，会打印） |
| 看 segment 落盘 | `/pt raw` |
| 看完整 prompt 落盘 | `/pt full` |
| 列所有可触发手册 | `/pt flows` |
| 查缓存是否命中 | `/pt status` 看 `pt cache hit` |
| 读缓存文件 | `cat .pt/contexts/cache/<name>.context.md` |

## 下一步读什么

调试工具熟悉后，下一步可以从这两页继续深入：

- **[查看与导出转译产物（/pt status|raw|full|flows）](6-cha-kan-yu-dao-chu-zhuan-yi-chan-wu-pt-status-raw-full-flows)** — `/pt` 四个子命令的逐项详尽解释（产物结构、文件命名、典型场景）。
- **[v8 四层模型：Domain→Channel→Blueprint→Context](7-v8-si-ceng-mo-xing-domain-channel-blueprint-context)** — 理解 `cachedSegment` 是怎么从 H2 段拼出来的，对调试"为什么某个 Domain 没出现"很有帮助。
- **[Context 缓存序列化与 sourceHash 失效策略](16-context-huan-cun-xu-lie-hua-yu-sourcehash-shi-xiao-ce-lue)** — 想搞懂为什么 `source-hash` 总是变、缓存何时失效，读这页。
- **[端到端验证流程与回归用例](20-duan-dao-duan-yan-zheng-liu-cheng-yu-hui-gui-yong-li)** — 用 `tests/verify/verify-flows.ts` 之类的脚本批量验证 Pt 产物时用得上。