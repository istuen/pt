# pt 命令双注册架构——command（人类）+ tool（LLM）

> **状态**：设计完成，待执行
> **执行者**：LLM coding agent（具备 read/bash/edit/write 工具）
> **前提**：已读 `src/index.ts` 全量 + `docs/extensions.md`（pi 扩展 API）+ `examples/extensions/reload-runtime.ts` + `examples/extensions/tool-override.ts`
> **验收**：`tsc --noEmit` + `npm run verify`（43→43+ tests）全过 + `/pt flows` 人类可用 + `pt_flows` tool 被 LLM 可见可调 + `pt_manual` tool 能创建实例文档

---

## 1. 背景与动机

### 1.1 现状

pt 当前 3 种触发机制**全部必须人类 input**：

| 机制 | 注册方式 | 触发主体 | LLM 可调? |
|---|---|---|---|
| `/<flow-name> <args>` | `api.on("input")` 文本匹配 | 人类 | ❌ |
| `/manual:<domain>` | `api.on("input")` 文本匹配 | 人类 | ❌ |
| `/pt` + `/pt-context` | `pi.registerCommand` | 人类 | ❌ |
| `/pt manual <proc>` | `pi.registerCommand`（子命令） | 人类 | ❌ |

后果：LLM 拿到「帮我实现 req-001」后，知道有 `deliver-feature` 手册（Trigger 索引常驻 system prompt），但**无法自主创建手册实例文档**——必须回复"请运行 /pt manual deliver-feature req-001"等人类输入。这割裂了 `deliver-feature` 的端到端自动化意图。

### 1.2 目标

让 pt 的**只读查询**和**手册实例化**操作同时支持人类（command）和 LLM（tool）触发，统一架构、零逻辑重复。`pt-context`（改 system prompt）保持只人类触发。

### 1.3 pi 的两套触发机制（独立注册表，不冲突）

| API | 触发主体 | 注册表 | 命名惯例 | 上下文 |
|---|---|---|---|---|
| `pi.registerCommand` | 人类输入 `/name` | `pi.getCommands()` | `kebab-case` | `ExtensionCommandContext`（含 `ctx.ui`/`ctx.reload`） |
| `pi.registerTool` | LLM 发 `tool_call` | `pi.getAllTools()` | `snake_case` | `ExtensionContext`（受限） |

两套 dispatch 完全独立，同名不撞——`/pt-flows`（人类打字）和 `pt_flows`（LLM tool_call）走不同路径。pi 官方 `examples/extensions/reload-runtime.ts` 示范了双注册先例。

---

## 2. 设计

### 2.1 三种模式对比与选型

| 模式 | 描述 | 优点 | 缺点 | 适用 |
|---|---|---|---|---|
| **A. reload-runtime 委托** | tool 用 `pi.sendUserMessage("/cmd")` 排队成 follow-up 用户消息，委托 command 执行 | 零逻辑重复；tool 拿不到的 command 能力（`ctx.reload` 等）能间接用 | 异步语义（followUp 等下轮才执行）；session 多一条 `/cmd` 消息污染上下文；LLM 拿不到真实返回值（只拿到 "Queued..."） | 操作依赖 command 独占能力时 |
| **B. 纯函数内核 + 双壳** | 抽纯函数内核，command 壳走 `ctx.ui.notify`，tool 壳走 `return { content: [{ text }] }` | 同步语义（tool 立即返回真实结果）；无 session 污染；参数一致 | 需重构出纯函数内核；tool 写文件要 `withFileMutationQueue` | 只读查询 + 可纯函数化的操作 |
| **C. 逻辑双写** | command 和 tool 各写一遍相同逻辑 | 无 | 逻辑重复，维护两份易漂移 | ❌ 不采用 |

**pt 选型**：**模式 B 为主，模式 A 为辅**。

- 只读查询（`pt_flows` / `pt_status`）→ 模式 B（同步返回，无污染）
- 手册实例化（`pt_manual`）→ 模式 B + `withFileMutationQueue`（tool 同步写文件，参与文件变更队列防竞态）
- pt 当前**无操作依赖 command 独占能力**（不需 `ctx.reload`），所以不用模式 A

### 2.2 统一架构图

```
                    ┌─ command 壳（人类 /xxx）── ctx.ui.notify(text) + ctx.ui.setStatus
纯函数内核 ─────────┤
（无 ctx 依赖）     └─ tool 壳（LLM tool_call）── return { content: [{ type:"text", text }], details }
```

**核心纪律**：内核纯函数不 import `ExtensionAPI`/`ExtensionCommandContext`，只读 `session` + 调 pt 内部模块（`bindFlowTemplate`/`findFlowInBlueprint` 等）。command 壳和 tool 壳各包一层呈现逻辑。这样「command 能跑 tool 就能跑，改的只是参数」。

### 2.3 操作分类与注册决策

| 操作 | 性质 | command | tool | 模式 |
|---|---|---|---|---|
| `/pt status` | 只读查询 | ✅ 已有 | ✅ 新增 `pt_status` | B |
| `/pt flows` | 只读列表 | ✅ 已有 | ✅ 新增 `pt_flows` | B |
| `/pt manual <proc>` | 写文件 + 启动流程 | ✅ 已有 | ✅ 新增 `pt_manual` | B + `withFileMutationQueue` |
| `/pt raw` / `/pt full` | debug dump | ✅ 已有 | ❌ 不做 | —（debug 用 read 工具读文件即可） |
| `/pt logs` / `logs:clear` | 日志维护 | ✅ 已有 | ❌ 不做 | —（用户维护操作） |
| `/pt sessions` | session 列表 | ✅ 已有 | ❌ 不做 | —（debug） |
| `/pt-context <name>` | 改 system prompt | ✅ 已有 | ❌ **不做** | —（见 §2.4） |

### 2.4 为什么 `/pt-context` 不做 tool

`pt-context` 切换 Profile = 替换 system prompt 本身。触碰 pt 核心假设：

1. **stable context 是 pt 价值根基**——system prompt 越稳定，provider prompt cache 越能命中。LLM 自主切 profile = profile 抖动 = cache 持续失效，破坏 token 经济性
2. **prompt injection 攻击面**——LLM 能换自己的 system prompt = 用户在 pt-chat（受限 domain）里说句"切到 pt-dev"，LLM 就能解锁完整开发知识。等于 LLM 能自己提权
3. **profile 选择是用户意图**——「这一轮要什么知识活跃」是用户决策。LLM 觉得"该切 pt-dev"时，正确做法是回复"建议运行 /pt-context pt-dev"让人类拍板
4. **多 profile 抖动丢上下文**——切 profile 后 cachedSegment 变，之前基于旧 segment 的推理可能失锚

### 2.5 命名规范

| command（kebab） | tool（snake） | 关系 |
|---|---|---|
| `pt`（含子命令 `status`/`flows`/`manual`） | `pt_status` / `pt_flows` / `pt_manual` | 一对多：`/pt status` ↔ `pt_status` |
| `pt-context` | — | 只 command |

tool 名用 `pt_` 前缀 + 操作名，与 command 子命令名一一对应。LLM 看 tool 列表见 snake_case，人类打 `/` 补全见 kebab-case，各看各的不混淆。

---

## 3. 执行步骤

### Phase 1: 抽纯函数内核（重构，无行为变化）

**目标**：把 `/pt status` / `/pt flows` / `/pt manual` 三个 handler 里内联的逻辑抽成纯函数，放 `src/commands.ts`（新文件）。command handler 改成薄壳调纯函数 + `ctx.ui.notify`。

**操作**：用 write 创建 `src/commands.ts`：

```typescript
// src/commands.ts — pt 命令纯函数内核
//
// v10.x：command + tool 双注册架构（docs/pt-command-tool-dual-registration.md）
//   - 纯函数内核：无 ExtensionAPI/ExtensionCommandContext 依赖，只读 session + 调内部模块
//   - command 壳（src/index.ts）：ctx.ui.notify 呈现
//   - tool 壳（src/index.ts）：return { content: [{ text }] } 呈现
//   - 纪律：改内核 = command 和 tool 同时生效，零逻辑重复

import { join } from "node:path";
import { MOD_MANUAL, MANUAL_DIR } from "./constants.js";
import { bindFlowTemplate, findFlowInBlueprint } from "./render/context-message.js";
import { session } from "./session.js";
import { filterDomainsByProfile } from "./agent/pi-adapter.js";  // 若未 export 则调整

/** /pt status 内核：返回状态摘要文本（单行 | 分隔）。 */
export function statusText(): string {
  const flowCount = session.cachedBundles?.reduce((acc, b) => {
    let n = 0;
    for (const d of b.domains) if (d.type === "workflow") {
      const tpls = Array.isArray(d.modules[MOD_MANUAL]) ? d.modules[MOD_MANUAL] : [];
      n += tpls.length;
    }
    return acc + n;
  }, 0) ?? 0;
  const domainCount = session.cachedBundles?.reduce((acc, b) => acc + b.domains.length, 0) ?? 0;
  const blueprintCount = session.cachedBundles?.reduce((acc, b) => acc + b.blueprints.length, 0) ?? 0;
  const profileCount = session.cachedBundles?.reduce((acc, b) => acc + b.profiles.length, 0) ?? 0;
  return [
    `pt profile: ${session.activeProfile ?? "(未激活)"}`,
    `pt agent: ${session.activeAdapter?.name ?? "(none)"}`,
    `pt domains: ${domainCount}, blueprints: ${blueprintCount}, profiles: ${profileCount}, flows: ${flowCount}`,
    `pt segment length: ${session.cachedSegment?.length ?? 0} chars`,
    `pt cache hit: ${session.lastCacheHit ? "yes" : "no"}`,
    `pt last built prompt: ${session.lastBuiltPrompt ? `${session.lastBuiltPrompt.length} chars` : "(未跑过 turn)"}`,
    `pt cwd: ${session.lastCwd}`,
  ].join(" | ");
}

/** /pt flows 内核：返回可用手册列表文本。无激活 Profile 返回提示串。 */
export function flowsText(): string {
  if (!session.cachedBundles || session.cachedBundles.length === 0 || !session.activeAdapter) {
    return "无激活 Profile，先用 /pt-context <name> 激活";
  }
  const flows = session.activeAdapter.listManuals?.(
    session.cachedContext!,
    session.cachedBlueprint!,
    filterDomainsByProfile(session.cachedBundles[0].domains, session.cachedProfile),
  ) ?? [];
  if (flows.length === 0) {
    return "当前 Profile 无可触发手册（context_message 注入点无 workflow-type Domain）";
  }
  const lines = flows.map((f) => `  ${f.name} ${f.hint ?? ""}  ← ${f.domain}`);
  return `可用手册（输入 /手册名 参数 或 /manual:<domain-name> 触发 Context Message）:\n${lines.join("\n")}`;
}

/** /pt manual 内核：构建手册实例文档内容 + 目标文件路径。不写文件（写文件由壳负责）。 */
export interface ManualDocResult {
  content: string;
  filePath: string;
  error?: string;
}

export function buildManualDoc(cwd: string, procedure: string, args: string): ManualDocResult {
  if (!procedure) {
    return { content: "", filePath: "", error: "用法: /pt manual <procedure-name> [args...]" };
  }
  if (!session.cachedBundles || session.cachedBundles.length === 0 || !session.cachedBlueprint) {
    return { content: "", filePath: "", error: "无激活 Profile，先用 /pt-context <name> 激活" };
  }
  const tpl = findFlowInBlueprint(
    session.cachedBlueprint,
    session.cachedBundles[0].domains,
    procedure,
  );
  if (!tpl) {
    return { content: "", filePath: "", error: `未找到手册: ${procedure}（用 /pt flows 查可用手册）` };
  }
  const bound = bindFlowTemplate(tpl, args);
  const domainName = session.cachedBundles[0].domains.find((d) => {
    if (d.type !== "workflow") return false;
    const manual = d.modules[MOD_MANUAL];
    return Array.isArray(manual) && manual.some((t: unknown) => (t as { name?: string }).name === procedure);
  })?.name ?? "";
  const now = new Date().toISOString();
  const ts = Date.now();
  const lines: string[] = [];
  lines.push("---");
  lines.push(`procedure: ${procedure}`);
  lines.push(`domain: ${domainName}`);
  lines.push(`created: ${now}`);
  lines.push("status: in-progress");
  lines.push(`args: ${args || "(无)"}`);
  lines.push("---");
  lines.push("");
  lines.push(`# ${procedure} 实例`);
  lines.push("");
  const boundLines = bound.split("\n");
  for (const line of boundLines) {
    if (line.startsWith("#")) continue;
    if (line.startsWith("_")) continue;
    const stepMatch = line.match(/^(\d+)\.\s+(.*)$/);
    if (stepMatch) {
      lines.push(`- [ ] ${stepMatch[2]}`);
    } else {
      lines.push(line);
    }
  }
  lines.push("");
  lines.push("## 产物");
  lines.push("<!-- 执行后用 edit 在此追加：路径 + 动作(created/modified) + 日期 -->");
  lines.push("");
  lines.push("## 更新指引");
  lines.push("执行完每个 step 后：用 edit 把对应 `- [ ]` 改成 `- [x]`。");
  lines.push("全部完成后：用 edit 在 ## 产物 下追加创建/修改的文件路径（每行一条）。");
  lines.push("status 全部完成后可改为 completed。");
  const content = lines.join("\n");
  const filePath = join(cwd, MANUAL_DIR, `${procedure}-${ts}.md`);
  return { content, filePath };
}
```

**注意**：
- `filterDomainsByProfile` 当前在 `src/agent/pi-adapter.ts`。执行者需确认其是否 export——若未 export，加 export 或移到 `src/commands.ts`。执行者用 `grep -n "filterDomainsByProfile" src/agent/pi-adapter.ts` 确认。
- `statusText`/`flowsText`/`buildManualDoc` 是纯函数——只读 `session`（模块单例），不依赖 `ctx`。

**验收**：
- `test -f src/commands.ts`
- `grep "^export function" src/commands.ts` 输出 `statusText` / `flowsText` / `buildManualDoc`
- `tsc --noEmit` 过

---

### Phase 2: command 壳改调纯函数内核

**目标**：`src/index.ts` 的 `/pt status` / `/pt flows` / `/pt manual` 三个 handler 改成调 `src/commands.ts` 的纯函数，`ctx.ui.notify` 呈现。行为不变（纯重构）。

**操作**：用 edit 改 `src/index.ts`。

edit 1（加 import）：

oldText:
```
import { bindFlowTemplate, findFlowInBlueprint } from "./render/context-message.js";
```

newText:
```
import { bindFlowTemplate, findFlowInBlueprint } from "./render/context-message.js";
import { statusText, flowsText, buildManualDoc } from "./commands.js";
```

edit 2（替换 /pt status handler 内联逻辑）：

oldText（从 `if (sub === "status" || sub === "") {` 到该 handler 的 `return;` 前 `ctx.ui.notify(session.cachedSegment, "info");` + `}`）—— 执行者需 read `src/index.ts` 227-253 行拿到精确文本。替换为：

newText:
```
      if (sub === "status" || sub === "") {
        ctx.ui.notify(statusText(), "info");
        if (sub === "" && session.cachedSegment) {
          ctx.ui.notify(session.cachedSegment, "info");
        }
        return;
      }
```

edit 3（替换 /pt flows handler 内联逻辑）：

oldText（从 `if (sub === "flows") {` 到该 handler 的 `return; }`）—— 执行者 read 255-273 行。替换为：

newText:
```
      if (sub === "flows") {
        ctx.ui.notify(flowsText(), "info");
        return;
      }
```

edit 4（替换 /pt manual handler 内联逻辑）：

oldText（从 `if (sub === "manual") {` 到该 handler 末尾的 `return; }`）—— 执行者 read 354-413 行。替换为：

newText:
```
      if (sub === "manual") {
        const parts = args.trim().split(/\s+/);
        const procedureName = parts[0];
        const procedureArgs = parts.slice(1).join(" ");
        const r = buildManualDoc(ctx.cwd, procedureName, procedureArgs);
        if (r.error) {
          ctx.ui.notify(r.error, "warning");
          return;
        }
        await mkdir(join(ctx.cwd, MANUAL_DIR), { recursive: true });
        await writeFile(r.filePath, r.content, "utf8");
        ctx.ui.notify(`手册实例已创建: ${r.filePath}`, "info");
        return;
      }
```

**验收**：
- `tsc --noEmit` 过
- `npm run verify` 43 tests 全过（行为不变）
- 手动 `/pt status` / `/pt flows` 输出与重构前一致

---

### Phase 3: 注册 tool 壳（pt_status / pt_flows / pt_manual）

**目标**：在 `src/index.ts` 用 `pi.registerTool` 注册 3 个 tool，调 Phase 1 的纯函数内核。

**操作**：用 edit 改 `src/index.ts`。

edit 1（顶部加 import）：

oldText:
```
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { mkdir, writeFile } from "node:fs/promises";
```

newText:
```
import { type ExtensionAPI, type ExtensionCommandContext, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { mkdir, writeFile } from "node:fs/promises";
import { Type } from "typebox";
```

edit 2（在 `pi.registerCommand("pt", {...})` 块之后、`// ========== AgentAdapter 注册 ========== ` 之前，插入 3 个 registerTool）—— 执行者 read 找到 `/pt` 命令 handler 块的结束位置（`ctx.ui.notify("用法: /pt [status|flows|raw|full|manual|logs|logs:clear|sessions]", "warning");` + `});` 之后）。插入：

newText:
```
  // ========== tool 壳：LLM 可调（与 command 共享纯函数内核，docs/pt-command-tool-dual-registration.md） ==========
  // 只读查询 + 手册实例化做 tool；pt-context（改 system prompt）不做 tool（见设计文档 §2.4）

  pi.registerTool({
    name: "pt_status",
    label: "Pt Status",
    description: "Show Pt compilation status: active profile, domain/flow counts, segment length, cache hit. Read-only.",
    promptSnippet: "Show Pt status (profile, counts, cache)",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: statusText() }], details: {} };
    },
  });

  pi.registerTool({
    name: "pt_flows",
    label: "Pt Flows",
    description: "List available FlowTemplate manuals in the active Profile. Call before starting a procedure to see what's available. Read-only.",
    promptSnippet: "List available Pt manuals (FlowTemplates)",
    promptGuidelines: ["Use pt_flows when you need to know which Pt manuals are available before starting a multi-step procedure."],
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: flowsText() }], details: {} };
    },
  });

  pi.registerTool({
    name: "pt_manual",
    label: "Pt Manual",
    description: "Create a manual instance document (.pt/manuals/<procedure>-<ts>.md) with checklist + artifact log. Use when starting a multi-step procedure like deliver-feature. Returns the file path.",
    promptSnippet: "Instantiate a Pt manual document with checklist for tracking",
    promptGuidelines: ["Use pt_manual when starting a multi-step procedure (e.g., deliver-feature, modify-schema) to get a persistent checklist + artifact log."],
    parameters: Type.Object({
      procedure: Type.String({ description: "FlowTemplate name, e.g. deliver-feature, modify-schema" }),
      args: Type.Optional(Type.String({ description: "Arguments for the procedure, e.g. 'req-001' or 'term my-concept'" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const r = buildManualDoc(ctx.cwd, params.procedure, params.args ?? "");
      if (r.error) {
        return { content: [{ type: "text", text: r.error }], details: { error: r.error } };
      }
      return withFileMutationQueue(r.filePath, async () => {
        await mkdir(join(ctx.cwd, MANUAL_DIR), { recursive: true });
        await writeFile(r.filePath, r.content, "utf8");
        return {
          content: [{ type: "text", text: `手册实例已创建: ${r.filePath}` }],
          details: { path: r.filePath },
        };
      });
    },
  });
```

**注意**：
- `pt_manual` 的 `execute` 用 `withFileMutationQueue(r.filePath, ...)`——tool 直接写文件必须进队列，否则与 `edit`/`write` 并发竞态（extensions.md §Custom Tools 明确要求）
- 3 个 tool 都调 Phase 1 的纯函数内核，零逻辑重复
- `promptSnippet` 让 tool 出现在 system prompt 的 `Available tools` 段；`promptGuidelines` 给 LLM 使用指引

**验收**：
- `tsc --noEmit` 过
- `grep "pi.registerTool" src/index.ts` 输出 3 处（`pt_status` / `pt_flows` / `pt_manual`）
- `npm run verify` 过

---

### Phase 4: 测试

**目标**：加测试覆盖纯函数内核 + tool 注册结构。

**操作**：用 edit 在 `tests/verify/phase9.test.ts` 末尾加一个新 describe 块（或在 `flows.test.ts` 加）。执行者 read 找到文件末尾插入：

newText:
```

// ========== 19. command + tool 双注册（纯函数内核） ==========
describe("19. command + tool 双注册", () => {
  it("statusText 返回状态摘要文本", async () => {
    const { statusText } = await import("../../src/commands.js");
    const text = statusText();
    expect(text).toContain("pt profile:");
    expect(text).toContain("pt segment length:");
  });

  it("flowsText 无激活 Profile 返回提示", async () => {
    const { flowsText } = await import("../../src/commands.js");
    const text = flowsText();
    expect(typeof text).toBe("string");
    expect(text.length).toBeGreaterThan(0);
  });

  it("buildManualDoc 未找到手册返回 error", async () => {
    const { buildManualDoc } = await import("../../src/commands.js");
    const r = buildManualDoc(process.cwd(), "nonexistent-proc", "");
    expect(r.error).toContain("未找到手册");
  });

  it("buildManualDoc 构建实例文档内容", async () => {
    const { buildManualDoc } = await import("../../src/commands.js");
    // 用 pt-dev profile 的 deliver-feature 手册
    const { loadAndTranspile } = await import("../../src/transpile.js");
    const { session } = await import("../../src/session.js");
    const r = await loadAndTranspile(process.cwd(), "pt-dev");
    session.cachedBundles = r.bundles;
    session.cachedBlueprint = r.blueprint;
    session.cachedContext = r.context;
    session.activeProfile = "pt-dev";
    session.activeAdapter = (await import("../../src/agent/index.js")).getAgentAdapter(r.blueprint.agent);
    session.activeAdapter.setContext(r.context, r.blueprint, r.domains);
    const doc = buildManualDoc(process.cwd(), "deliver-feature", "req-001");
    expect(doc.error).toBeUndefined();
    expect(doc.content).toContain("deliver-feature");
    expect(doc.content).toContain("- [ ]");
    expect(doc.content).toContain("## 产物");
    expect(doc.filePath).toContain("deliver-feature-");
  });

  it("index.ts 注册了 3 个 tool", async () => {
    const src = await readFile("src/index.ts", "utf8");
    expect(src).toContain('name: "pt_status"');
    expect(src).toContain('name: "pt_flows"');
    expect(src).toContain('name: "pt_manual"');
    expect(src).toContain("withFileMutationQueue");
  });
});
```

**注意**：
- 第 4 个测试用 pt-dev profile 预热 session（因为 `buildManualDoc` 读 `session.cachedBundles`）。测试结束应清 session 防污染——执行者可加 `afterAll(() => resetSession())` 或在 it 末尾 `Object.assign(session, createSessionState())`。执行者 read `src/session.ts` 确认 `resetSession`/`createSessionState` export。
- `readFile` 需在测试文件顶部已 import（`import { readFile } from "node:fs/promises"`）——执行者确认 phase9.test.ts 是否已 import，没有则加。

**验收**：
- `npm run verify` 43→48 tests 全过（43 + 5 新）

---

### Phase 5: 更新 usage domain（记录新 tool）

**目标**：让 pt 自身知识库知道新增了 3 个 LLM tool——在 `src/builtin/assets/domains/usage.md` Scene 段加项。

**操作**：用 edit 改 `src/builtin/assets/domains/usage.md`。执行者 read 找到 `### pt-manual-command` 项后追加：

oldText:
```
### pt-manual-command
- desc: /pt manual <procedure-name> [args...]（创建手册实例文档到 .pt/manuals/，含 checklist + 产物区，用于跟踪执行）。与 /manual:<domain>（ephemeral 参考）互补——前者持久化，后者即时注入。
```

newText:
```
### pt-manual-command
- desc: /pt manual <procedure-name> [args...]（创建手册实例文档到 .pt/manuals/，含 checklist + 产物区，用于跟踪执行）。与 /manual:<domain>（ephemeral 参考）互补——前者持久化，后者即时注入。

### pt-tools-llm
- desc: pt_status / pt_flows / pt_manual 三个 LLM tool（pi.registerTool）。与 /pt 命令族共享纯函数内核——人类打 /pt status，LLM 调 pt_status，结果一致。pt-context 不做 tool（改 system prompt 不该让 LLM 触发，见 docs/pt-command-tool-dual-registration.md §2.4）。
```

**验收**：
- `grep "pt-tools-llm" src/builtin/assets/domains/usage.md` 输出 1 行
- `tsc --noEmit` + `npm run verify` 过

---

## 4. 验收清单

全部 Phase 完成后，独立跑硬指标：

| # | 指标 | 验证命令 | 期望 |
|---|---|---|---|
| 1 | tsc 无错误 | `npm run typecheck` | exit 0 |
| 2 | vitest 全过 | `npm run verify` | 48 tests pass |
| 3 | 纯函数内核存在 | `test -f src/commands.ts && grep "^export function" src/commands.ts` | 3 函数 |
| 4 | command 壳调内核 | `grep "statusText()\|flowsText()\|buildManualDoc(" src/index.ts` | ≥3 处 |
| 5 | 3 个 tool 已注册 | `grep 'name: "pt_status"\|name: "pt_flows"\|name: "pt_manual"' src/index.ts` | 3 行 |
| 6 | pt_manual 用 withFileMutationQueue | `grep "withFileMutationQueue" src/index.ts` | ≥1 处 |
| 7 | pt-context 未注册 tool | `grep "pt_context\|pt-context.*registerTool" src/index.ts` | 无 tool 注册 |
| 8 | usage domain 记录 tool | `grep "pt-tools-llm" src/builtin/assets/domains/usage.md` | 1 行 |
| 9 | typebox import 在 | `grep "from \"typebox\"" src/index.ts` | 1 行 |
| 10 | 重构后 /pt status 行为不变 | 手动 `/pt status` | 输出含 profile / segment length |

### Git 提交纪律

每个 Phase 一个 commit：

- Phase 1: `git commit -m "Refactor: extract pt command kernels to src/commands.ts"`
- Phase 2: `git commit -m "Refactor: /pt command handlers call pure kernels"`
- Phase 3: `git commit -m "Add pt_status/pt_flows/pt_manual tools (LLM-callable)"`
- Phase 4: `git commit -m "test: cover command+tool dual registration kernels"`
- Phase 5: `git commit -m "Update usage domain: document pt LLM tools"`

### 完成后效果

| 角色 | 查 Pt 状态 | 列手册 | 创建手册实例 | 切 Profile |
|---|---|---|---|---|
| 人类 | `/pt status` | `/pt flows` | `/pt manual deliver-feature req-001` | `/pt-context pt-dev` |
| LLM | `pt_status` tool_call | `pt_flows` tool_call | `pt_manual` tool_call | ❌ 不允许 |

LLM 拿到「帮我实现 req-001」后：调 `pt_flows` 看可用手册 → 调 `pt_manual` 创建 deliver-feature 实例文档 → 按文档 checklist 逐 step 执行。**端到端自动化打通**——不再需要人类中途输入 `/pt manual`。

---

## 5. 设计决策记录

| 决策 | 选择 | 理由 |
|---|---|---|
| 架构模式 | B（纯函数内核 + 双壳）为主 | 同步语义、无 session 污染、参数一致；pt 无 command 独占能力需求，不用 A 委托 |
| pt_manual 写文件 | `withFileMutationQueue` | extensions.md 明确：tool 直接改文件不进队列与 edit/write 并发竞态 |
| pt-context 不做 tool | 只 command | 改 system prompt 触碰 stable-context 根基 + prompt injection 提权风险 |
| 命名 | command kebab / tool snake | pi 惯例；两套注册表独立不撞 |
| 内核位置 | `src/commands.ts` 新文件 | 与 index.ts 解耦，纯函数可单测 |
| 只读查询也做 tool | 是 | LLM 自省有用（看自己当前 profile/可用手册），是 deliver-feature 自主化的关键缺口 |
| debug 操作不做 tool | 否 | raw/full/logs/sessions 是 debug 用，LLM 用 read 工具读文件即可 |

---

## 6. 风险与边界

### 6.1 已知限制

- **tool 注册需 pi 支持 registerTool**——当前 pi 版本已支持（extensions.md §Custom Tools）。若 pi 降级到无 registerTool 版本，tool 壳不注册但 command 壳仍工作（降级安全）
- **pt_manual 的 withFileMutationQueue 需 import**——从 `@earendil-works/pi-coding-agent` 导入，已在 peerDeps
- **filterDomainsByProfile export**——执行者需确认 `src/agent/pi-adapter.ts` 是否 export 此函数，未 export 则加 export 或移到 commands.ts

### 6.2 不处理的

- **不监听 output 事件**——LLM 输出 `/<flow-name>` 仍不触发 FlowTemplate（保持人类 input 触发）。tool 化只覆盖 `/pt` 命令族，不覆盖 `/<flow-name>` 文本匹配
- **不给 pt-context 加 confirm 闸门**——即使加 confirm 也退化成人类触发，不如直接只 command
- **不做 Externals→registerTool**（pt-plugin-design.md §7）——那是把 FlowTemplate 元数据批量注册成 tool，本设计是手动注册 3 个 Pt 操作 tool，范围更小更可控

### 6.3 未来扩展

- 若 LLM 误触发 pt_manual（创建无意义实例文档）——加 `promptGuidelines` 收紧 + 考虑 `ctx.ui.confirm` 闸门
- 若要 LLM 自主切 profile——走 registerTool + 人类 confirm 闸门（但违反 §2.4 纪律，不推荐）
- Externals→registerTool 批量 tool 化所有 FlowTemplate——等真实需求
