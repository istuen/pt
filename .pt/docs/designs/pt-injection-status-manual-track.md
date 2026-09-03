# pt 注入状态检测 + Manual 实例追踪

> **状态**：设计完成，待执行
> **执行者**：LLM coding agent（具备 read/bash/edit/write 工具）
> **前提**：已读 `src/index.ts` + `src/session.ts` + `src/agent/pi-adapter.ts` + `src/commands.ts` + pi 扩展类型定义（`dist/core/extensions/types.d.ts` 的 `ExtensionUIContext` / `BeforeAgentStartEvent`）
> **验收**：`tsc --noEmit` + `npm run verify`（基线 +新增测试）全过 + footer 三态文字可见 + pt_manual 后 widget 出现 aboveEditor + `--session` resume 继承 activeManual

---

## 1. 背景与动机

### 1.1 两个独立但相关的可观测性缺口

#### 缺口 A：注入状态不可见

pt 的 footer 当前只显示 `pt: pt-chat`（profile 名），且只在 `session_start` / `switchProfile` 时设一次（`src/index.ts:180/213`）。但 pt 真正的注入发生在每轮 `before_agent_start`（`src/agent/pi-adapter.ts`），三个分支：

| 分支 | 当前行为 | 用户看到 |
|---|---|---|
| 成功返回 `{systemPrompt: final}` | 只 `onInjected(final)` + log | footer 静态不变 |
| 无 segment → `return undefined` | 静默 | footer 仍显示旧 profile 名（误导） |
| `catch` 异常 | `notify` + log | footer 仍显示旧 profile 名（误导） |

用户无法从 UI 判断"pt 这轮到底注入了没"。

**为什么不检测 Pi 的 system prompt**：`ctx.getSystemPrompt()`（types.d.ts:248 "current **effective** system prompt"）返回 Pi 组装的**基线**，不含 `before_agent_start` 注入的内容（注入结果通过 `BeforeAgentStartEventResult.systemPrompt` 返回，pi 未暴露读取 API）。pt 是注入方，**自报**比事后检测准。

#### 缺口 B：Manual 实例无追踪

LLM 调 `pt_manual` 工具（或人类 `/pt manual`）后，会在 `.pt/manuals/<procedure>-<ts>.md` 写一个实例文件（frontmatter `status: in-progress` + checklist）。但：

- 用户/LLM 无法从 UI 知道"当前 session 在跑哪个手册、跑到第几步"
- 手册实例文件是持久化的，但 session 重启（`--session`/resume）后追踪状态丢失
- `/pt status` 只显示编译产物信息，不显示 manual 实例

**不是新能力**：pt_manual 已存在，本设计只做**追踪**——把已有的实例文件状态反映到 UI。

### 1.2 目标

| 目标 | 手段 |
|---|---|
| 注入状态可见 | footer `setStatus` 三态文字（ok/pending/failed/idle） |
| Manual 实例可见 | `setWidget` aboveEditor 常驻组件（有 manual 才显示） |
| Manual 追踪跨 session 继承 | `appendEntry` 持久化 + session_start fallback 读取 |
| 进度真实 | 进度从实例文件 parse，不存 session（文件 = single source of truth） |

### 1.3 非目标

- **不自动选 Manual**——纯追踪 LLM 已调用的 pt_manual
- **不检测 Pi 的 system prompt**——自报更准
- **不动 IR/编译层**——状态检测在 agent 层，manual 追踪在运行时层
- **不用 setFooter/setHeader**——成本高、和 pi 内置布局冲突

---

## 2. 设计

### 2.1 状态模型（SessionState 新增字段）

```ts
// src/session.ts 新增

/** pt 注入到 System Prompt 的状态（自报，非检测 Pi）。 */
export type InjectionState = "idle" | "pending" | "injected" | "failed";

/** 当前追踪的 Manual 实例（LLM 调 pt_manual 写入后触发）。 */
export interface ActiveManual {
  filePath: string;       // .pt/manuals/<procedure>-<ts>.md
  procedure: string;
  args: string;
  activatedAt: number;    // Date.now()，排序/去重用
}
```

SessionState 新增三字段：
- `injectionState: InjectionState`（默认 `"idle"`）
- `injectionError: string | null`（默认 `null`，failed 时存错误消息）
- `activeManual: ActiveManual | null`（默认 `null`）

**不在 session 存 manual 进度**（stepDone/stepTotal）——进度是文件派生数据，存 session 会和文件不同步。进度每次渲染时从文件 parse。

### 2.2 数据流

| 触发点 | 写 session 字段 | 刷新 UI |
|---|---|---|
| `session_start` 加载 Profile 成功 | `injectionState = "pending"` | footer |
| `before_agent_start` 成功返回 | `injectionState = "injected"` | footer |
| `before_agent_start` 无 segment | `injectionState = "idle"` | footer |
| `before_agent_start` catch | `injectionState = "failed"` + `injectionError` | footer |
| `pt_manual` tool execute 成功 | `activeManual = { filePath, procedure, args, activatedAt }` | widget + footer |
| `pt_verify` tool execute 后 | （不写字段） | widget 重新 parse 文件 |
| `/pt manual` 命令成功 | 同 pt_manual | widget + footer |
| manual 文件 `status: completed` 检出 | `activeManual = null` | 撤 widget |
| `session_shutdown` | resetSession 清空 | — |

**关键**：`pt_verify` 不改 session 字段，只触发"重读文件刷新 widget"。因为 LLM 可能手动 edit checklist 不一定走 pt_verify，文件才是真相。

### 2.3 注入状态 → footer 文本

文字方案（清晰可见，不依赖终端字体）：

| InjectionState | profile=null | profile="pt-chat" |
|---|---|---|
| `idle` | `pt: 无 context` | `pt: pt-chat idle` |
| `pending` | — | `pt: pt-chat pending` |
| `injected` | — | `pt: pt-chat ok` |
| `failed` | — | `pt: pt-chat failed` |

有 activeManual 时追加后缀：`pt: pt-chat ok · manual: deliver-feature 3/6`

### 2.4 Manual 进度解析（纯函数，不进 parse/ 层）

实例文件格式（已确认，见 `.pt/manuals/*.md`）：
```markdown
---
procedure: deliver-feature
domain: development
created: 2026-09-02T10:02:04.954Z
status: in-progress
args: req-001
---
# deliver-feature 实例
- [x] plan-implementation ...
- [ ] 按计划走 modify-* ...
- [ ] ...
## 执行状态
| Step | Outcome | Message |
...
```

解析结果：
```ts
interface ManualProgress {
  procedure: string;        // frontmatter.procedure
  stepDone: number;         // 数 "- [x]"
  stepTotal: number;        // 数 "- [ ]" + "- [x]"
  status: string;           // frontmatter.status（in-progress/completed）
  nextStep: string | null;  // 第一个 "- [ ]" 的文本（去前缀）
}
```

用轻量 parse（读 frontmatter + 正则数 checklist），**不进 parse/ 层**——manual 实例文件不是 Pt 资产（不是 Domain/Blueprint/Profile），不污染 IR 契约。

### 2.5 Widget 呈现（aboveEditor）

```
pt ▶ deliver-feature  step 3/6  (in-progress)
  next: 按计划走 modify-* / add-* / update-* 手册
  file: .pt/manuals/deliver-feature-1788343324954.md
```

- `setWidget("pt-manual", lines, { placement: "aboveEditor" })`
- 无 activeManual 时 `setWidget("pt-manual", undefined)` 撤掉，不留空框
- 用 `string[]` 形态（最低成本），不传 factory component

### 2.6 持久化（复用 v10.x appendEntry 模式）

```ts
const PT_MANUAL_ENTRY = "pt:active-manual";
// 写：pi.appendEntry(PT_MANUAL_ENTRY, { filePath, procedure, args })
// 读：session_start fallback 链里加一步——读最后一个 pt:active-manual entry
```

**读出后校验**（关键，避免追踪已删/已完成的文件）：
1. 文件存在？（`fs.access`）
2. frontmatter `status !== "completed"`？
3. 不满足 → 当作无 activeManual，不恢复

fallback 顺序（在 activeProfile 之后）：
```
flag > settings > session(activeProfile) > auto   ← 已有
                              ↓
                  + 读 pt:active-manual entry      ← 新增（独立于 profile 链）
```

manual 持久化与 profile 持久化**独立**：profile 失败不影响 manual 追踪恢复（manual 只依赖文件存在 + status）。

### 2.7 生命周期状态机

```
注入状态：                    Manual 追踪：

idle ──session_start──> pending     no-active
                              │            │
              before_agent_start        pt_manual ok
                  success │              │
                         ▼              ▼
                      injected      active(tracking)
                         │              │
                   (异常 catch)    pt_verify / before_agent_start
                         │              │ refresh widget
                         ▼              ▼
                       failed       active(refreshed)
                                       │
                                 文件 status=completed
                                       │
                                       ▼
                                  no-active(cleared)
```

### 2.8 模块边界

**新增 `src/injection-status.ts`**（纯函数内核，不依赖 ExtensionAPI）：
```ts
export function renderInjectionFooter(
  state: InjectionState,
  profile: string | null,
  error: string | null
): string
```

**新增 `src/manual-track.ts`**（纯函数内核，不依赖 ExtensionAPI）：
```ts
export interface ManualProgress { ... }
export function parseManualProgress(filePath: string): Promise<ManualProgress | null>
export function renderManualWidgetLines(filePath: string, p: ManualProgress): string[]
export function renderManualFooterSuffix(p: ManualProgress): string  // "· manual: deliver-feature 3/6"
export function isManualActive(filePath: string): Promise<boolean>  // 文件存在 + status!==completed
```

**改动 `src/session.ts`**：加 `injectionState` / `injectionError` / `activeManual` 三字段 + `createSessionState` 默认值。

**改动 `src/agent/pi-adapter.ts`**：`before_agent_start` 三分支写 `session.injectionState` + 调 `api.ui?.setStatus`。`AgentAPI.ui` 已含 `setStatus`（`src/index.ts` toAgentAPI 的 `Pick<..., "notify" | "setStatus">`，现成）。

**改动 `src/index.ts`**：
- `pt_manual` execute 成功后：写 `session.activeManual` + `persistManualToSession(pi, ...)` + `refreshManualWidget(ctx.ui)`
- `pt_verify` execute 后：`refreshManualWidget(ctx.ui)`
- `/pt manual` 命令成功后：同 pt_manual
- `session_start`：加读 `pt:active-manual` fallback + 初始 footer
- `session_shutdown`：已有 `resetSession` 覆盖（清三字段）

**不改**：`src/commands.ts`（statusText 可选追加 manual 行，但 widget 是主承载，footer 已有后缀，不强改）、parse/、compile/、render/、schema.ts。

### 2.9 边界纪律

- **不检测 Pi system prompt**——自报状态
- **不自动选 Manual**——只追踪已调用的 pt_manual
- **不在 session 存 manual 进度**——文件是真相
- **manual-track.ts 不进 parse/ 层**——manual 实例不是 Pt 资产
- **widget 用 string[] 不用 factory**——先验证形态，进阶样式后续
- **不动 AgentAPI 接口**——`ui` 已含 `setStatus`，`setWidget` 通过 `ExtensionUIContext` 直接调（tool execute 的 `ctx` 是 `ExtensionContext`，含 `ui: ExtensionUIContext`）

### 2.10 已知未修复的局限

v11.x 假设 "per-process = per-session"（`src/session.ts` 头注释"Pi Extension 是模块单例"），
状态全是 Node.js 模块级单例：

- `src/session.ts` 的 `session: SessionState`（含 `injectionState` / `activeManual`）
- `src/index.ts` 的 `cachedManualProgress: ManualProgress | null`

**TUI 模式（pi CLI）下这个假设正确**：单进程 = 单 session，状态语义自洽。

**Web 模式（pi-web）下假设不成立**：Next.js 单进程服务多个 browser tab / leaf session，
多 session 共享同一份 module-level state，会互串。具体表现：

- tab A 调 `pt_manual` → tab B 也显示该 manual 的 widget
- tab A `before_agent_start` 触发 → tab B footer 也变 `injected`
- 多 tab 不同 session 时 widget / footer 高频串

**本次 v11.x 不修**：

- TUI 模式不受影响（设计正确）
- Web 单 tab 单 session 不受影响
- 多 session 串状态是 v11.x 已知 caveat，留作后续观察

**升级路径**：见 [`../issues/module-state-pi-web-multisession.md`](../issues/module-state-pi-web-multisession.md)
（status: open, severity: medium）。当 pi-web 多 session 并发成为高频场景 / 用户反馈出现时，
启动方案 B 重构——把 module-level state 改成 per-session `Map<sessionId, SessionState>`。

**代码注释强化**（实施时同步加，非本次范围）：在 `src/session.ts` 头注释加一行
warning，标记 "module-level state assumes per-process=per-session; pi-web multi-session may conflict"，
避免后续开发者忽视这个假设。

---

## 3. 执行步骤

### Step 1：session.ts 加状态字段（类型先行）

`SessionState` 接口新增：
```ts
injectionState: InjectionState;
injectionError: string | null;
activeManual: ActiveManual | null;
```
`createSessionState` 默认值：`"idle"` / `null` / `null`。
导出 `InjectionState` / `ActiveManual` 类型。

**验收**：`tsc --noEmit` 过。

### Step 2：injection-status.ts 纯函数 + 单测

`renderInjectionFooter(state, profile, error)`：
- `idle` + profile=null → `pt: 无 context`
- `idle` + profile → `pt: <profile> idle`
- `pending` → `pt: <profile> pending`
- `injected` → `pt: <profile> ok`
- `failed` → `pt: <profile> failed`（error 非空时追加 `: <error 前 40 字>`）

单测：4 态 × 有/无 profile = 8 case。

**验收**：`npm run verify` 新增 injection-status 测试过。

### Step 3：manual-track.ts 纯函数 + 单测

`parseManualProgress(filePath)`：
- 读文件 → 抽 frontmatter（`---` 之间）→ 正则数 `- [x]` / `- [ ]`
- 文件不存在 / 解析失败 → `null`
- `nextStep` = 第一个 `- [ ]` 行去前缀的文本

`renderManualWidgetLines(filePath, p)`：
- 返回 `string[]`（3 行：标题 / next / file）
- `status: completed` → 标题加 `✓ done`

`renderManualFooterSuffix(p)`：
- ` · manual: <procedure> <done>/<total>`
- completed → ` · manual: <procedure> done`

`isManualActive(filePath)`：文件存在 + `status !== "completed"`。

单测：用 `tests/fixtures/manuals/` 建两个夹具（in-progress + completed）。

**验收**：`npm run verify` 新增 manual-track 测试过。

### Step 4：pi-adapter.ts 接注入状态检测

`before_agent_start` handler 三分支：
```ts
// 成功分支
session.injectionState = "injected";
session.injectionError = null;
api.ui?.setStatus("pt", renderInjectionFooter("injected", session.activeProfile, null));

// 无 segment 分支（return undefined 前）
session.injectionState = "idle";
api.ui?.setStatus("pt", renderInjectionFooter("idle", session.activeProfile, null));

// catch 分支
session.injectionState = "failed";
session.injectionError = msg;
api.ui?.setStatus("pt", renderInjectionFooter("failed", session.activeProfile, msg));
```

需要 import `session` + `renderInjectionFooter`。

**验收**：`tsc --noEmit` 过；手动验证（下一轮注入后 footer 变 `ok`）。

### Step 5：index.ts 接 widget 刷新 + 持久化

新增辅助函数：
```ts
const PT_MANUAL_ENTRY = "pt:active-manual";

function persistManualToSession(pi: ExtensionAPI, m: ActiveManual): void {
  try {
    if (typeof pi.appendEntry !== "function") return;
    pi.appendEntry(PT_MANUAL_ENTRY, { filePath: m.filePath, procedure: m.procedure, args: m.args });
  } catch (e) { slog("warn", "persistManualToSession failed", { ... }); }
}

async function refreshManualWidget(ui: ExtensionUIContext): Promise<void> {
  const m = session.activeManual;
  if (!m) { ui.setWidget("pt-manual", undefined); return; }
  const p = await parseManualProgress(m.filePath);
  if (!p || p.status === "completed") {
    session.activeManual = null;
    ui.setWidget("pt-manual", undefined);
    return;
  }
  ui.setWidget("pt-manual", renderManualWidgetLines(m.filePath, p), { placement: "aboveEditor" });
}
```

`pt_manual` tool execute 成功后（writeFile 之后）：
```ts
session.activeManual = { filePath: r.filePath, procedure: params.procedure, args: params.args ?? "", activatedAt: Date.now() };
persistManualToSession(pi, session.activeManual);
await refreshManualWidget(ctx.ui);
```

`pt_verify` tool execute 后（return 前）：
```ts
await refreshManualWidget(ctx.ui);
```

`/pt manual` 命令成功后（switchProfile 同位置）：同 pt_manual。

**注意**：`pt_manual` / `pt_verify` 的 `ctx` 是 `ExtensionContext`，`ui` 是完整 `ExtensionUIContext`（含 `setWidget`）——可直接调。但 tool execute 签名里 `pi` 不在参数——需要从 `toAgentAPI` 缓存的 pi 拿，或在 tool execute 里用 `ctx` 调 `appendEntry`。

**appendEntry 来源**：`ExtensionContext` 不含 `appendEntry`（只在 `ExtensionAPI` 顶层）。解法：tool execute 的 `ctx` 是 `ExtensionContext`，但 `persistManualToSession` 需要 `pi`——把 `pi` 存到模块级变量（`index.ts` default export 的 `pi` 参数），或让 `refreshManualWidget` 不做持久化（持久化只在能拿到 `pi` 的地方做：`session_start` / 命令 handler / tool execute 都能拿到 `pi`？需确认 tool execute ctx 是否暴露 `api`）。

**备选**：`persistManualToSession` 改用 `ctx.sessionManager`（`ExtensionContext` 有 `sessionManager: ReadonlySessionManager`，但只读不能 append）。最终：**tool execute 的 `ctx` 不含 `appendEntry`**——需要把 `pi` 存模块级。在 default export 顶部加 `let piRef: ExtensionAPI | null = null; piRef = pi;`，`persistManualToSession` 用 `piRef`。

**验收**：`tsc --noEmit` 过；`pt_manual` 调用后 widget 出现 aboveEditor。

### Step 6：session_start 加 manual fallback

`session_start` handler 在 profile 加载后、`registerInjectionIfReady` 后：
```ts
// 读 manual entry
const manualEntry = readManualFromSession(ctx.sessionManager);
if (manualEntry) {
  const active = await isManualActive(manualEntry.filePath);
  if (active) {
    session.activeManual = { ...manualEntry, activatedAt: Date.now() };
    await refreshManualWidget(ctx.ui);
  }
}
```

`readManualFromSession` 仿 `readProfileFromSession`，读最后一个 `pt:active-manual` entry。

**验收**：`--session` resume 后 widget 恢复。

### Step 7：session_start 初始 footer + switchProfile 同步

`session_start` profile 加载成功后：
```ts
session.injectionState = "pending";
ctx.ui.setStatus("pt", renderInjectionFooter("pending", picked, null));
```
（替换原 `ctx.ui.setStatus("pt", \`pt: ${picked}\`)`）

`switchProfile` 成功后：
```ts
session.injectionState = "pending";  // 切换后待下一轮注入
ctx.ui.setStatus("pt", renderInjectionFooter("pending", name, null));
```
（替换原 `ctx.ui.setStatus("pt", \`pt: ${name}\`)`）

**验收**：切换后 footer 显示 `pending`，下一轮变 `ok`。

### Step 8：verify + typecheck 全量回归

```bash
npm run typecheck
npm run verify
```

**验收**：全过；无残留 `as` 断言（pt-quality #1）；无 console.error（pt-quality #3）。

---

## 4. 风险与备选

### 4.1 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| `setWidget` 在非 TUI 模式（rpc/json/print）行为未明 | widget 可能不显示或报错 | `ctx.hasUI` guard（只 TUI 模式调 setWidget） |
| manual 文件被外部删/改 | parse 返回 null 或进度错 | `parseManualProgress` 容错返回 null；widget 撤掉不崩溃 |
| `appendEntry` 在 ephemeral session 失败 | 持久化丢失 | 已有 try/catch 静默降级（同 activeProfile 模式） |
| pi 升级改 `setWidget` 签名 | 编译错 | tsc 拦截；peerDependencies 锁版本 |

### 4.2 备选（未采用）

- **setFooter 自定义整条 footer**：能整合所有信息，但要自己实现 footer 组件，和 pi 内置 `FooterComponent` 完全替换——成本高、pi 升级易碎。当前需求不需要。
- **检测 Pi system prompt**：`getSystemPrompt()` 不含注入后内容，检测不到。自报更准。
- **session 存 manual 进度**：双写不同步风险。文件 = single source of truth 更稳。

---

## 5. 关联

- **代码**：`src/index.ts`（session_start / pt_manual / pt_verify / switchProfile）、`src/session.ts`、`src/agent/pi-adapter.ts`
- **设计文档**：`pt-manual-instantiation.md`（实例文档机制）、`pt-command-tool-dual-registration.md`（双注册架构）
- **pi API**：`dist/core/extensions/types.d.ts` 的 `ExtensionUIContext.setStatus/setWidget`、`BeforeAgentStartEvent/Result`、`ExtensionAPI.appendEntry`
- **issue**：
  - [`../issues/module-state-pi-web-multisession.md`](../issues/module-state-pi-web-multisession.md) — v11.x 已知未修复的局限（pi-web 多 session 串 module-level state），见 §2.10
