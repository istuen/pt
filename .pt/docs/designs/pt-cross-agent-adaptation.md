# Pt 跨 Agent 适配架构分析

> **基线**：commit `db25b60`（fix: inject context after manual profile switch）
> **分析日期**：2026-09-02
> **分析范围**：`src/index.ts` / `src/agent/*` / `src/schema.ts`（AgentAPI + AgentAdapter）/ `src/render/*` / `src/transpile.ts` / `src/session.ts` / `src/commands.ts`
> **用途**：评估"为 Pi 以外的 Agent（Codex / Claude Code / OpenCode / Cursor / MCP host）做适配"的可行性、当前抽象的真实程度、所需改动面与决策点。执行者按本文分阶段落地。
>
> **关联文档**：
> - `pt-asset-layering.md` §0.11 AgentAdapter（v9 设计承诺：加新 Agent 只加 Adapter，不改 compile/render 核心）
> - `pt-tech-debt-audit.md` P1.1（AgentAPI 缺 ui 能力，已修）/ T9
> - `pt-design.md`（au-core 阶段提及"多 Agent 不同身份/工具白名单"，本文是其前置条件）
>
> **本文回答四个问题**：
> 1. v9 的 AgentAdapter 抽象"诚实"吗？承诺"加新 Agent 只加 Adapter"是否成立？（§1–§2）
> 2. Pi 耦合具体在哪？哪些可复用、哪些不可？（§2）
> 3. 要真正兑现承诺，目标架构长什么样？（§3）
> 4. 落地分几步？需要哪些架构决策？（§4–§5）

---

## 一、设计承诺 vs 现状

### 1.1 v9 的承诺（pt-asset-layering.md §0.11）

> "加 Codex 支持 = 加 `CodexAdapter` 类 + 在注册表加一行，**不改 compile/render/transpile 核心**。Blueprint 改 `agent: codex` 即可用。"
>
> "AgentAdapter 不直接依赖 Pi 的 `ExtensionAPI`——通过 **AgentAPI** 接口隔离。"
>
> "target 由 AgentAdapter 解释，Pt 核心不硬编码 `"system_prompt"` 字符串判断。"

三句承诺合起来就是：**Pt 核心是 agent-agnostic 的；Pi 只是一个可插拔 Adapter；加新 Agent 是加法不是改法**。

### 1.2 现状结论

**接口是诚实的，用法是不诚实的。**

- 接口定义（`AgentAdapter` / `AgentAPI` / `supportedTargets` / `registerInject`）方向正确。
- 但 `index.ts` 把"Pi 宿主契约"和"Pt 编排核心"耦合在一个入口函数里；`AgentAPI` 形态实为 Pi ExtensionAPI 的子集伪装；render 层硬编码 Pi 的 target 字面量——三处使承诺目前**不成立**。

具体证据见 §2。

---

## 二、抽象边界盘点

### 2.1 已经 agent-agnostic 的核心（可直接复用给任意 Host）

| 模块 | 证据 |
|---|---|
| `schema.ts` IR 契约 | `Context` / `Blueprint` / `Profile` / `Domain` / `SchemaBundle` 无任何 Pi 痕迹 |
| `parse/` | MD → IR，只依赖 `SourceAdapter` 接口（依赖反转已兑现） |
| `compile/context.ts` | IR → Context IR，按注入点名聚合 |
| `render/cache.ts` + `transpile.ts` | 文件缓存 + 三段式编排（parse→compile→cache→render），无 Pi 依赖 |
| `verify/` | `runVerify(cwd, name, params)` 纯函数 |
| `commands.ts` | `statusText` / `flowsText` / `buildManualDoc` / `filterDomainsByProfile`——注释明写"内核不依赖 ExtensionAPI / ExtensionCommandContext" |
| `log.ts` PtLogger | agent-agnostic |
| `session.ts` SessionState | 数据结构无 Pi 依赖（但 `loadedFrom` 来源链当前在 index.ts 内联，见 §2.3） |

### 2.2 Pi 耦合的四个集中点

| 耦合点 | 文件 | 性质 |
|---|---|---|
| **Pi 扩展入口** | `src/index.ts` | `export default function (pi: ExtensionAPI)`——是 Pi Extension 契约，不是 Pt 通用入口 |
| **PiAdapter** | `src/agent/pi-adapter.ts` | 唯一 Adapter 实现，硬编码 `on("before_agent_start")` / `on("input")` |
| **AgentAPI 形状** | `src/schema.ts` AgentAPI | 表面抽象，实为 Pi ExtensionAPI 子集 |
| **render 硬编码 target** | `src/render/system-prompt.ts:16` / `src/render/context-message.ts:192` / `src/agent/pi-adapter.ts:139` | 按 `"system_prompt"` / `"context_message"` 字面量分发 |

### 2.3 六个具体 Gap

#### Gap 1：AgentAPI 是"Pi 子集伪装成抽象"

`AgentAPI` 当前形态（`src/schema.ts`）：

```ts
interface AgentAPI {
  on(event: string, handler: (...args: unknown[]) => unknown): void;
  registerCommand(name: string, spec: unknown): void;
  registerFlag(name: string, spec: unknown): void;
  getFlag(name: string): unknown;
  ui?: AgentUI;
  log?: { debug/info/warn/error };
  onInjected?: (systemPrompt: string) => void;
}
```

- `on(event, ...)` 的 event 名（`before_agent_start` / `input` / `session_start` / `turn_*` / `tool_call` / `tool_result` / `agent_settled`）全是 **Pi 事件名**。Codex / Claude Code / OpenCode 没有这些事件。
- `registerCommand(name, spec)` 的 spec 形状（`description` + `getArgumentCompletions` + `handler`）是 Pi 命令契约。
- `registerFlag` / `getFlag` 是 Pi CLI flag 概念，其他 Agent 根本没有。
- `toAgentAPI(pi, ctx)`（`src/index.ts:382`）只是把 Pi ExtensionAPI **结构子集化**，没有真正翻译语义。

**后果**：写 `CodexAdapter` 时，`registerInject(api, ...)` 拿到的 `api` 不存在——没有 Codex runtime 提供 `on("before_agent_start")`。要么 bridge 全是 stub，要么 Adapter 绕过 AgentAPI 直接调 Codex 原生 API（那 AgentAPI 抽象就形同虚设）。

#### Gap 2：index.ts 把"Pi 宿主"和"Pt 编排核心"耦合在一起

`src/index.ts` 一个文件混了两类职责：

- **Pi 宿主职责**（不可复用）：
  - `pi.registerFlag` / `pi.registerCommand` / `pi.registerTool`
  - `pi.on(session_start / session_shutdown / turn_* / tool_call / tool_result / agent_settled)`
  - `pi.appendEntry`（Pi session JSONL 持久化）
  - `ctx.sessionManager.getEntries()`（Pi SessionManager）
  - `ctx.ui.select` / `ctx.ui.notify` / `ctx.ui.setStatus`（Pi UI）
  - `ctx.getSystemPrompt()`（Pi 基础 prompt 访问器）
  - `withFileMutationQueue`（Pi 文件写队列）

- **Pt 编排核心**（应可复用，当前内联在 Pi 入口）：
  - profile fallback 链（flag > settings > session > auto）
  - `transpileActive(cwd, name, notify)`
  - `registerInjectionIfReady(pi, ctx)`
  - `switchProfile(pi, ctx, name)`
  - turn 级 trace（`turn_start` / `turn_end` / `tool_call` / `tool_result`）
  - `persistProfileToSession` / `readProfileFromSession`

给 Codex 做 host 时，这些编排逻辑要么复制一遍，要么先重构出来。

#### Gap 3：render 按 Pi 的 target 硬编码分发，不是 Adapter 解释

设计文档宣称"target 由 AgentAdapter 解释，Pt 核心不硬编码 `"system_prompt"` 字符串判断"（`pt-asset-layering.md:182 / 552`）。但代码里：

```ts
// src/render/system-prompt.ts:16
if (ip.target === "system_prompt") { ... }

// src/render/context-message.ts:192
blueprint.injectionPoints.some((ip) => ip.target === "context_message")

// src/agent/pi-adapter.ts:139
if (ip.target !== "context_message") continue;
```

`renderSystemPrompt` / `renderContextMessage` 只认 Pi 的两个 target 字面量。若 Codex 用 `target: agents_md` 或 `target: turn_hook`，render 层不会产出任何东西——Adapter 拿不到字符串。

**根因**：render 没把"产出字符串"和"target 语义"解耦。Adapter 无法复用 render 为新 target 产出内容。

#### Gap 4：`context_message` target 隐含"input transform"能力假设

Pi 的 `input` 事件可拦截用户文本（`/manual:xxx`、`/<flow>`）并改写后再喂给 LLM——这是 **Pi 独有的运行时能力**。其他 Agent：

| Agent | 是否支持 input transform | 替代机制 |
|---|---|---|
| Pi | ✓（`on("input")` transform） | — |
| Codex | ✗ | slash command 输出 / MCP |
| Claude Code | △（`UserPromptSubmit` hook 可增强，不能改写） | slash command（markdown 模板）+ MCP |
| Cursor | ✗ | `.cursorrules`（仅 session 级） |
| OpenCode | △（视版本） | slash command / MCP |

所以 `context_message` 作为 target **假设了一个并非普遍存在的能力**。Adapter 要么降级（把 `/manual:xxx` 注册成 slash command，输出文本进对话），要么声明不支持。当前接口没有表达"降级"的机制。

#### Gap 5：命令/工具注册是 Pi 专属形态

`/pt-context`、`/pt`、`pt_status` / `pt_flows` / `pt_manual` / `pt_verify` 通过 `pi.registerCommand` / `pi.registerTool` 注册，spec 带 Pi 专属字段：

- command spec：`description` + `getArgumentCompletions` + `handler(args, ctx)` + `ctx.hasUI` + `ctx.ui.select`
- tool spec：`promptSnippet` + `promptGuidelines` + TypeBox `parameters` + `withFileMutationQueue`

其他 Agent 的工具/命令形态完全不同：

- Codex / Claude Code / OpenCode：MCP tools（JSON-Schema 参数，独立进程）
- Claude Code：slash command 是 `.md` 文件 + frontmatter
- 各家的 command completion / UI picker 协议各异

**核心函数可复用**（`statusText` / `flowsText` / `buildManualDoc` / `runVerify` 都是纯函数），但**注册壳不可复用**。

#### Gap 6：session 持久化 / UI 选择器 Pi 专属

- `persistProfileToSession` → `pi.appendEntry(PT_PROFILE_ENTRY, ...)`（Pi session JSONL）
- `readProfileFromSession` → `ctx.sessionManager.getEntries()`（Pi SessionManager）
- `/pt-context` 无参 → `ctx.ui.select(...)`（Pi UI picker）
- `/pt full` → `ctx.getSystemPrompt()`（Pi 基础 prompt 访问器）

这些是 Pi runtime 独有概念。非 Pi host 需要各自的等价物（Codex 的 `config.toml`、Claude Code 的 `settings.json` + `.claude/` 目录、Cursor 的 `.cursorrules` 等）。

---

## 三、目标架构：三层分离

把当前"入口 + 编排 + Adapter"三合一拆成清晰三层：

```
┌─────────────────────────────────────────────────────────────┐
│  Core（agent-agnostic）                                      │
│  schema / parse / compile / render / transpile /             │
│  verify / commands / log  +  core/orchestration              │
│  （profile fallback / transpileActive / switchProfile）      │
└─────────▲──────────────────────────────────▲─────────────────┘
          │ HostAPI                          │ AgentAPI
┌─────────┴──────────┐            ┌─────────┴───────────────┐
│  Host（per-agent）  │            │  Adapter（per-agent）    │
│  hosts/pi.ts        │── bridge ──│  PiAdapter               │
│  hosts/codex.ts     │── bridge ──│  CodexAdapter            │
│  hosts/claude.ts    │── bridge ──│  ClaudeAdapter           │
│  hosts/mcp.ts       │── bridge ──│  McpAdapter              │
└────────────────────┘            └──────────────────────────┘
   原生扩展契约                       target → 注入机制
   （Pi Extension /                  （before_agent_start /
    Codex plugin /                    AGENTS.md write /
    Claude hook /                     CLAUDE.md section /
    MCP server）                      slash command）
```

### 3.1 三层职责

| 层 | 职责 | 依赖 |
|---|---|---|
| **Core** | IR 契约 + 三段式编译 + 编排（fallback / transpile / switchProfile）+ 纯函数命令内核 | 只依赖自身 + HostAPI / AgentAPI 接口 |
| **Host** | 实现某 Agent 的扩展契约；桥接原生 API → `HostAPI`（给编排核心用）+ `AgentAPI`（给 Adapter 用）；注册命令/工具壳 | 原生 Agent SDK + Core |
| **Adapter** | 解释 target；决定把 Context 字符串送到哪（事件 handler / 文件写 / slash command / hook） | Core + AgentAPI |

### 3.2 关键不变量

- Core **不 import** 任何 `hosts/*` 或 `agent/*-adapter.ts`——反向依赖（Host/Adapter 依赖 Core）。
- Host 和 Adapter 是**成对**的：Host 提供 runtime，Adapter 解释 target。加新 Agent = 加一对文件。
- `AgentAPI` 是 Host 暴露给 Adapter 的能力面，**不再伪装成通用抽象**——它的形状由"Adapter 需要什么"决定，而不是"Pi 恰好提供什么"。

---

## 四、决策点（需架构师拍板）

### 决策 A：AgentAPI 形状——窄接口 vs Pt 事件词汇表

| 方案 | 形态 | 优劣 |
|---|---|---|
| **A1 窄接口** | `injectSystemPrompt(seg)` / `onTurnStart(cb)` / `onUserInput(cb): transform` / `notify(msg)` / `registerSlashCommand(name,fn)` / `registerTool(name,schema,fn)` / `writeFile(path,content)` | 每个方法语义明确；Host 实现时直译；新增能力要改接口（但可控）；类型安全 |
| **A2 Pt 事件词汇表** | `on("pt:session_start" / "pt:before_turn" / "pt:user_input" / "pt:turn_end", cb)`，Host 把原生事件翻译成 Pt 事件 | 接口稳定；事件名是 Pt 的；但"翻译表"隐式耦合；`transform` 这类需要返回值的语义用 event 表达别扭 |

**倾向 A1**：`input` transform 的"返回值改写"语义用 `on(event)` 表达本就勉强（PiAdapter 现在靠返回 `{action:"transform", text}` 约定），窄接口更显式、类型更安全，符合 pt-quality `modules-type-safety` 与"类型安全"偏好。

### 决策 B：render 归属——Adapter 自带 render vs render 通用化

| 方案 | 形态 |
|---|---|
| **B1 Adapter 自带 render** | `AgentAdapter.render(ctx, blueprint, target) → string`，每个 Adapter 决定怎么把注入点内容变成字符串。PiAdapter 复用现有 `renderSystemPrompt`；CodexAdapter 可能为 `agents_md` target 产出带 frontmatter 的 md 段落 |
| **B2 render 通用化** | render 按"注入点名"产出字符串（不判 target），Adapter 拿到后自己决定去向。target 语义完全归 Adapter |

**倾向 B2**：render 本质就是"注入点名 → 聚合后的 markdown"，target 的解释（送到哪）才是 Adapter 的事。把 `if (ip.target === "system_prompt")` 从 render 删掉，改成"产出所有注入点的字符串，Adapter 按 target 挑选用哪个"——改动小、解耦彻底。B1 会让每个 Adapter 重复实现 render 逻辑，违反 pt-quality `no-duplicate-type` 精神。

### 决策 C：target 词汇——保持 Pi 名 vs 抽象化

| 方案 | target 取值 |
|---|---|
| **C1 保持 Pi 名** | `system_prompt` / `context_message` 作为通用语义名，各 Adapter 自行解释（CodexAdapter 把 `system_prompt` 映射到 AGENTS.md；ClaudeAdapter 映射到 CLAUDE.md section） | 命名带 Pi 痕迹，但用户资产已用这名，零迁移成本 |
| **C2 抽象化** | `session-knowledge` / `turn-context` 作为 Pt 通用 target，PiAdapter 映射到 `system_prompt` / `context_message` | 更干净，但现有 Blueprint 资产要改（`.pt/assets/blueprints/*.md` + 内建 + 文档） |

**倾向 C1 起步**：保资产兼容，把 `system_prompt` / `context_message` 重新定义为"Pt 通用 target 语义名"（session 级知识 / 轮次级上下文），各 Adapter 解释。未来需要新 target（如 `agents_file` / `rules_file`）再加——开放枚举本来就是 v9 设计意图（`InjectionTarget = "system_prompt" | "context_message" | string`）。

### 决策 D：context_message 降级策略

非 Pi Agent 多半没有 input transform。Adapter 需要一个**能力声明 + 降级**机制：

- `supportedTargets: string[]` 已存在，但只用于"是否支持"，没有"以什么形态支持"。
- 可加 `targetCapabilities?: Record<target, "transform" | "command" | "file" | "unsupported">`，让 Adapter 声明 `context_message` 是用 transform 还是降级成 slash command。
- Host 据此决定 `/manual:xxx` 是注册成 input handler 还是 slash command。

**待决策**：降级是 Adapter 内部透明处理（Adapter 自己把 context_message 实现成 slash command，Host 不感知），还是 Host 显式按 capability 分发（Host 看 capability 决定注册哪种形态）？

- 前者更解耦，Adapter 自治；
- 后者更显式，但 Host 要懂 Pt 的 target 语义。

**倾向前者**（Adapter 内部透明）：Host 只提供原语（`registerSlashCommand` / `onUserInput`），Adapter 选原语。这保住"Host 不懂 Pt 语义"的边界。

### 决策 E：工具/命令注册抽象

| 方案 | 形态 |
|---|---|
| **E1 ToolRegistrar 接口** | Core 定义 `registerCommand(name, spec)` / `registerTool(name, schema, fn)` agent-agnostic 签名，各 Host 实现并转译成原生形态 |
| **E2 各 Host 自注册** | Core 只暴露纯函数（`statusText` / `runVerify` / `buildManualDoc` / `flowsText`），各 Host 用原生 API 自己注册壳 |

**倾向 E1**：纯函数已经共享了，注册壳的"spec → 原生形态"翻译是 Host 职责，用接口统一签名能避免每个 Host 重写一遍壳逻辑。spec 的 agent-agnostic 形态可参考 MCP tool 定义（JSON-Schema 参数 + handler），各 Host 翻译时加自家专属字段（Pi 的 `promptSnippet` / Claude 的 frontmatter）。

---

## 五、分阶段路径

| Phase | 目标 | 改动面 | 风险 | 可独立交付？ |
|---|---|---|---|---|
| **P1** | 抽 HostAPI + 拆 index.ts：`core/orchestration.ts`（fallback 链 / transpileActive / switchProfile / registerInjectionIfReady）+ `hosts/pi.ts`（现 index.ts 瘦身后入 host）；`HostAPI` 接口定义 | `index.ts` 大改，`session.ts` 部分上移到 core；行为不变 | 中（要保 34 tests 过 + Pi 行为零回归） | ✅ |
| **P2** | render 解耦 target（B2）+ AgentAPI 重塑（A1）：render 删 `target === "system_prompt"` 判断；AgentAPI 改窄接口；PiAdapter 重写用新 AgentAPI | `schema.ts` AgentAPI、`render/*.ts`、`pi-adapter.ts` | 高（接口 breaking，需版本号升级 v9→v10） | ✅（与 P1 可合并） |
| **P3** | 第二个 Host 验证抽象：选 Codex 或 Claude Code 做 host + adapter，跑通"同一份资产、不同 Agent 注入" | 新增 `hosts/<agent>.ts` + `agent/<agent>-adapter.ts` | 验证期，可回退 | ✅（feature flag） |
| **P4** | 能力声明 + 降级机制（若 P3 暴露 context_message 问题）：`targetCapabilities` + 降级策略（决策 D 落地） | `schema.ts`、各 Adapter | 视 P3 结果 | 视情况 |

### 5.1 P1 的具体拆分清单

从 `index.ts` 抽出到 `core/orchestration.ts`：

- `transpileActive` → 签名改为 `transpileActive(host: HostAPI, cwd, name, notify)`
- `switchProfile` → `switchProfile(host: HostAPI, name)`
- `registerInjectionIfReady` → 用 HostAPI 替代 `pi` + `ctx`
- profile fallback 链（`session_start` 内的 flag/settings/session/auto 判定）→ `pickInitialProfile(host, cwd) → { name, source }`
- turn trace → `core/trace.ts`（`onTurnStart` / `onTurnEnd` / `onToolCall` / `onToolResult` 纯函数，host 调）
- `persistProfileToSession` / `readProfileFromSession` → 抽成 `ProfileStore` 接口，Pi host 实现用 `sessionManager`，其他 host 实现各自等价物

留在 `hosts/pi.ts`：

- `export default function (pi: ExtensionAPI)` 入口
- `toHostAPI(pi, ctx): HostAPI` 桥接
- `toAgentAPI(pi, ctx): AgentAPI` 桥接（P2 后形态改变）
- 命令/工具注册壳（P2 后抽 ToolRegistrar，壳留在 host）

### 5.2 P2 的具体改动清单

`render/system-prompt.ts`：

```ts
// Before
export function renderSystemPrompt(ctx, blueprint) {
  for (const ip of blueprint.injectionPoints) {
    if (ip.target === "system_prompt") { ... }  // ← 删
  }
}
// After: 产出所有注入点为 Map<name, string>，Adapter 按 target 挑
export function renderModules(ctx, blueprint): Record<string, string> { ... }
```

`AgentAPI`（A1 窄接口）：

```ts
interface AgentAPI {
  injectSystemPrompt(segment: string): void;       // session 级
  onUserInput(handler: (text: string) => { action: "continue" | "transform"; text?: string }): void;
  onTurnStart?(cb: () => void): void;
  onTurnEnd?(cb: (info: TurnInfo) => void): void;
  notify(msg: string, level: "info" | "warning" | "error"): void;
  setStatus(name: string, text: string): void;
  log?: PtLogWriter;
  registerSlashCommand?(name: string, handler: (args: string) => string): void;  // 决策 D 降级原语
  writeFile?(path: string, content: string): Promise<void>;                       // AGENTS.md / CLAUDE.md 注入
}
```

`PiAdapter.registerInject` 改用窄接口；`CodexAdapter` 用 `writeFile` + `registerSlashCommand` 组合。

---

## 六、结论

**当前 v9 的 AgentAdapter 是"接口诚实、用法不诚实"**——抽象点画对了（Adapter + AgentAPI + target 由 Adapter 解释），但三处使"加新 Agent 只加 Adapter"这句承诺目前不成立：

1. `index.ts` 把 Pi 宿主和 Pt 编排耦合在一起（Gap 2）
2. `AgentAPI` 是 Pi 子集伪装成抽象（Gap 1）
3. render 硬编码 Pi target 字面量（Gap 3）

**最小可行路径**：P1（拆 host）+ P2（render 解耦 + AgentAPI 重塑）做完，"加 CodexAdapter 不改 core"才真正兑现。P3 用第二个 host 证伪或修正抽象。

**决策顺序建议**：先定 A（AgentAPI 形状）和 B（render 归属）——这两个是 P2 的硬约束；C（target 词汇）和 D（降级策略）可在 P3 验证期再定；E（工具注册）独立于前四个，可晚些。

---

## 附：与既有 Tech Debt 的关系

| 本文档 Gap | 对应 `pt-tech-debt-audit.md` 条目 | 状态 |
|---|---|---|
| Gap 1（AgentAPI Pi 子集） | T9 / P1.1（已部分修：加了 ui/log） | 本文深化——ui/log 加了，但事件词汇仍 Pi 专属 |
| Gap 3（render 硬编码 target） | 未记录 | 本文新增 |
| Gap 2（index.ts 职责混杂） | T11（session 状态收拢，已修） | 本文延伸——状态收拢了，编排逻辑仍内联 |
| Gap 4 / 5 / 6 | 未记录 | 本文新增 |

本文档不替代 tech-debt-audit，而是补其未覆盖的"跨 Agent 适配"维度。P1–P2 落地后，相关条目应回写到 tech-debt-audit。
