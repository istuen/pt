# Pt 插件设计（实现级）

> 基于 `pt-design.md`（架构设计）+ Pi 0.84.2 源码核实（`dist/core/extensions/types.d.ts`）。本文给出**可落地的插件设计**：修正 API 误用、补全未定义函数、给出文件结构与包清单。读完可直接动手写 `pt.ts`。

---

## 0. API 核实与修正

`pt-design.md` 第八节骨架有 3 处与真实 ExtensionAPI 不符，先修正。

### 0.1 `pi.getSettings?.()` 不存在

查证 `ExtensionAPI` 接口（`types.d.ts` 867-1107 行）：**没有 `getSettings` 方法**。ExtensionAPI 只暴露 `getFlag/getActiveTools/getAllTools/getCommands/getThinkingLevel/getSessionName` 等查询方法，不暴露 settings 访问。

settings 由 `SettingsManager` 管理（`settings-manager.js`：global=`~/.pi/agent/settings.json`，project=`<cwd>/.pi/settings.json`），但 `SettingsManager` 不在 `ExtensionContext` 里。

**修正方案**：用 `registerFlag` + `getFlag` 读启动时选定（CLI 优先），settings.json 的 `au.blueprint` 作为 fallback 自己读文件。

```typescript
// 注册 CLI flag（工厂里调）
pi.registerFlag("blueprint", {
  description: "启动时激活的 OXN blueprint 名",
  type: "string",
});

// session_start 里读：CLI flag > settings.json > 自动探测
const flag = pi.getFlag("blueprint") as string | undefined;
const fromSettings = await readProjectSetting(ctx.cwd, "au.blueprint");
const active = flag ?? fromSettings ?? await detectSingleBlueprint(ctx.cwd);
```

`readProjectSetting` 自己读 `<cwd>/.pi/settings.json`（用导出的 `CONFIG_DIR_NAME` 常量，不要硬编码 `.pi`）。

### 0.2 命令 handler 的 `args` 是字符串，不是数组

查证 `RegisteredCommand.handler` 签名（`types.d.ts` 857 行）：

```typescript
handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
```

`args` 是 `/blueprint ` **之后的整串原始文本**（如 `article-blueprint` 或 `article blue`），不是 `ctx.args[0]`。

**修正**：

```typescript
pi.registerCommand("blueprint", {
  description: "切换当前 blueprint，即时重转译",
  getArgumentCompletions: async (prefix) => {
    const names = await listBlueprints(lastCwd);
    const items = names.map((n) => ({ value: n, label: n }));
    const hit = items.filter((i) => i.value.startsWith(prefix));
    return hit.length > 0 ? hit : null;
  },
  handler: async (args, ctx) => {
    const name = args.trim();
    if (!name) {
      // 无参：弹出选择器
      const names = await listBlueprints(ctx.cwd);
      if (names.length === 0) {
        ctx.ui.notify("未找到任何 blueprint（.openxenon/assets/blueprints/*.md）", "warning");
        return;
      }
      const picked = await ctx.ui.select("选择 blueprint", names);
      if (!picked) return;
      await switchBlueprint(picked, ctx);
    } else {
      await switchBlueprint(name, ctx);
    }
  },
});
```

### 0.3 `before_agent_start` 返回形状正确

查证 `BeforeAgentStartEventResult`（`types.d.ts`）：`{ message?: ...; systemPrompt?: string }`，`systemPrompt` 链式覆盖。设计文档的 `return { systemPrompt: event.systemPrompt + cachedSegment }` 正确，无需改。

### 0.4 额外查证（设计文档未提但需用）

- `ctx.ui.notify(message, "info"|"warning"|"error")` — 已确认
- `ctx.ui.setStatus(key, text | undefined)` — 已确认，用于 footer 显示当前 blueprint
- `ctx.cwd` — `ExtensionContext.cwd`，已确认
- `ctx.isProjectTrusted()` — 已确认；Pt 在 `.pi/extensions/` 下，**本身要信任后才加载**，所以 OXN 资产读取时项目已信任
- `CONFIG_DIR_NAME` 从 `@earendil-works/pi-coding-agent` 导出 — 已确认（`dist/index.d.ts` 第 2 行）
- `truncateHead` / `DEFAULT_MAX_BYTES` 从主包导出 — 已确认

---

## 1. 插件文件结构

MVP 单文件（`pt-design.md` 要求 ~200 行）。但为可维护性与未来分包，**内部按层分函数模块**，物理上先单文件，发布时升级为目录包。

### 1.1 MVP（单文件）

```
.pi/extensions/pt.ts        # ~250 行（含解析/转译/注入/命令）
```

或全局：`~/.pi/agent/extensions/pt.ts`。

### 1.2 发布为包（目录形态）

```
pt/
├── package.json            # pi manifest + peerDeps
├── index.ts                # 入口：工厂函数 + 事件/命令注册
├── config.ts               # 读 .pi/settings.json + flag + 自动探测
├── oxn/
│   ├── parser.ts           # OXN asset markdown → AST（Asset 对象）
│   ├── compiler.ts         # Asset → systemPrompt 段（4 个 compile 函数）
│   └── externals.ts        # Externals → ToolDefinition
├── transpile.ts            # sourceAdapters 注册表 + 合并
└── types.ts                # Asset / Boundary / External 等类型
```

`package.json`：

```json
{
  "name": "@your-org/pi-pt",
  "version": "0.1.0",
  "type": "module",
  "keywords": ["pi-package"],
  "pi": { "extensions": ["./index.ts"] },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-ai": "*",
    "typebox": "*"
  }
}
```

> peerDeps 不 bundle（Pi 用独立 module root 加载，共享会冲突）。无 runtime deps 时 `dependencies` 可省。

---

## 2. 数据模型（types.ts）

```typescript
// OXN asset 的统一抽象
export interface Asset {
  kind: "domain" | "workflow" | "stack" | "blueprint";
  name: string;          // 文件名去后缀
  frontmatter: Record<string, unknown>;
  body: string;          // frontmatter 之后的 markdown
  sections: Record<string, Section>;  // H2 段名 → 内容（预解析）
}

export interface Section {
  heading: string;       // "## Terms"
  raw: string;           // 段内 markdown（含 H3 子项）
  items: Item[];         // H3 子项解析结果
}

export interface Item {
  name: string;          // H3 标题（如 "文章"、"select-topic"）
  fields: Record<string, string[]>;  // "- desc: ..." / "- deps: [a, b]" 等
}

// Blueprint 的 Boundaries（slot DAG）
export interface Boundary {
  slot: string;
  operate: string[];     // ["read", "write"]
  deps: string[];
  desc: string;
}

// Blueprint 的 Use 段（引用的 domain/workflow/stack）
export interface BlueprintRefs {
  domain: string;
  workflow: string;
  stack: string;
}

// Externals 声明（4 种 asset 都可能有，blueprint 除外）
export interface External {
  assetKind: Asset["kind"];
  assetName: string;
  path: string;          // "./data/keyword-stats.xlsx"
  name?: string;         // 可选工具名，缺省由 path 推导
}
```

---

## 3. 解析层（oxn/parser.ts）

把 OXN asset markdown 解析成 `Asset`。**纯字符串处理，无依赖**。

### 3.1 `readAsset(filePath): Promise<Asset>`

1. `readFile` 读全文
2. 分离 frontmatter（`---\n...\n---`）与 body
3. `parseFrontmatter`（简易 YAML：只处理 `key: value` 与 `key: [a, b]`，够 OXN 用）
4. `splitSections(body)`：按 `## ` 切 H2 段
5. 每段 `parseItems`：按 `### ` 切 H3，每个 H3 下解析 `- key: value` / `- key: [a, b]`
6. 返回 `Asset`

### 3.2 关键函数签名

```typescript
export async function readAsset(path: string): Promise<Asset>
export function parseFrontmatter(text: string): { fm: Record<string, unknown>; body: string }
export function splitSections(body: string): Section[]
export function parseItems(sectionRaw: string): Item[]
export function parseListField(value: string): string[]  // "[a, b]" → ["a","b"]
```

### 3.3 Blueprint 专用解析

```typescript
export function parseBlueprintRefs(asset: Asset): BlueprintRefs | null
// 从 sections["Use"].items 读 domain/workflow/stack 三个字段

export function parseBoundaries(asset: Asset): Boundary[]
// 从 sections["Boundaries"].items 读，每个 item.name=slot，fields.operate/fields.deps/fields.desc
```

### 3.4 Externals 解析

```typescript
export function extractExternals(asset: Asset): External[]
// 从 sections["Externals"].items 读，每个 item.fields.path / item.fields.name
// assetKind/assetName 从 asset 取
```

### 3.5 边界情况

- 文件不存在 → `throw`（上层 catch 后 notify + 跳过该来源）
- frontmatter 缺失 → `fm = {}`，不报错
- H2 段名不规范（如 `## externals` 小写）→ 解析时统一 `toLowerCase` 比对，但保留原始 heading 存 `Section.heading`
- H3 下无 `- key: value` 行 → `items[i].fields = {}`

---

## 4. 转译层（oxn/compiler.ts）

把 `Asset` 转成 systemPrompt markdown 段。**每个 assetKind 一个 compile 函数**，输出格式见 `pt-design.md` 第六节。

### 4.1 函数签名

```typescript
export function compileDomain(d: Asset): string
export function compileWorkflow(w: Asset): string
export function compileStack(s: Asset): string
export function compileBlueprint(
  b: Asset,
  d: Asset,   // 已转译的 domain（引用其 Bans，不重复列）
  w: Asset,   // 已转译的 workflow（引用其 Slots，不重复列）
  s: Asset,   // 已转译的 stack（引用其 Tools）
): string
```

### 4.2 各 compile 输出规范

**compileDomain**（`pt-design.md` 第六节格式）：
```
<!-- ===== Domain: {name} ===== -->
### 业务术语
- **{term}**：{desc}

### 业务禁忌
- 标题禁止使用：{items 用 / 连接}。

### 业务不变量
- {invariant desc}
```
- Terms 段：每个 item 输出 `- **{name}**：{fields.desc}`
- Bans 段：每个 ban 输出 `- {fields.desc ?? name}：禁止 {fields.items 用 / 连接}`
- Invariants 段：每个输出 `- {fields.desc ?? fields.value}`
- 任一段为空 → 该 `###` 子标题省略（不留空标题）

**compileWorkflow**：
```
<!-- ===== Workflow: {name} ===== -->
### 执行流程
按以下 slot 顺序执行：
1. {slot}（{desc}）
2. {slot}（{desc}）— 依赖 {deps}
```
- deps 为空 → 不输出 "— 依赖"
- deps 非空 → `— 依赖 {deps.join(", ")}`

**compileStack**：
```
<!-- ===== Stack: {name} ===== -->
### 技术约束
- {tool}: {role}
- 可用工具：{operations 用 / 连接}
```
- Tools 段每个 item：`- {name}: {fields.role ?? fields.operations}`
- `operations` 汇总所有 tool 的 operations 字段，去重后 `可用工具：...`

**compileBlueprint**（方式 B：重组 Boundaries）：
```
<!-- ===== Blueprint: {name} ===== -->
### 当前任务蓝图
你要执行的是"{name}"任务，按以下计划走：

**第 1 步 · {slot}**
- 依赖：{deps 或 "无"}
- 操作：{operate.join(", ")}
- 目标：{desc}

**第 2 步 · {slot}**
...
```
- **不重复** Terms/Slots/Tools（前面三段已有）
- 按 Boundaries 顺序输出步骤（Boundary 顺序即 slot DAG 的拓扑序，OXN 已保证）
- 每个 step 的 `操作` 从 Boundary.operate 取（不从 Stack 重映射，operate 已是 Stack tool 名）

### 4.3 章节缺失的降级

- blueprint 无 `## Boundaries` → `compileBlueprint` 返回空串（上层 filter 掉）
- domain 无 `## Terms` → 跳过该子标题
- 任一 asset 读取失败 → 上层 catch，整段省略，notify warning

---

## 5. 注入层（index.ts 的事件 handler）

### 5.1 per-session 内存态

```typescript
// 模块级 = 每进程隔离 = 每会话隔离（pt-design.md 第二节 v3 方案）
let activeBlueprint: string | null = null;
let cachedSegment: string | null = null;
let registeredExternalNames: string[] = [];  // 已注册工具名（切换时先注销）
let lastCwd: string = "";                     // /blueprint 补全用
```

### 5.2 session_start handler

```typescript
pi.on("session_start", async (event, ctx) => {
  lastCwd = ctx.cwd;
  try {
    const flag = pi.getFlag("blueprint") as string | undefined;
    const fromSettings = await readProjectSetting(ctx.cwd, "au.blueprint");
    const auto = await detectSingleBlueprint(ctx.cwd);
    activeBlueprint = flag ?? fromSettings ?? auto;

    if (!activeBlueprint) {
      ctx.ui.setStatus("pt", "pt: 无 blueprint");
      return;
    }

    cachedSegment = await loadAndTranspile(ctx.cwd, activeBlueprint);
    ctx.ui.setStatus("pt", `pt: ${activeBlueprint}`);

    // 注册 Externals 工具
    await registerExternalsFor(ctx.cwd, activeBlueprint, pi);
  } catch (err) {
    ctx.ui.notify(`Pt 加载失败：${errMsg(err)}`, "error");
    ctx.ui.setStatus("pt", "pt: 加载失败");
    cachedSegment = null;
  }
});
```

**要点**：
- `reason` 包含 `reload`/`resume`/`fork`，都要重转译（内存态可能因 session 切换失效）
- 失败不抛（避免阻塞启动），降级为 `cachedSegment = null`（`before_agent_start` 就不注入）

### 5.3 before_agent_start handler

```typescript
pi.on("before_agent_start", async (event, _ctx) => {
  if (!cachedSegment) return undefined;
  return {
    systemPrompt: event.systemPrompt + "\n\n## 业务知识（来自多来源）\n\n" + cachedSegment,
  };
});
```

- 不返回 `undefined` = 不覆盖（保持 Pi base systemPrompt）
- 内容稳定（来源选定不变）→ provider prompt cache 命中（`pt-design.md` 第二节已论证）

### 5.4 session_shutdown handler（清理）

```typescript
pi.on("session_shutdown", async () => {
  // 注销本会话注册的 external 工具（避免跨 session 残留）
  // Pi 无 unregisterTool，但 setActiveTools 可过滤
  const remaining = pi.getActiveTools().filter((n) => !registeredExternalNames.includes(n));
  if (registeredExternalNames.length > 0) {
    pi.setActiveTools(remaining);
    registeredExternalNames = [];
  }
  cachedSegment = null;
  activeBlueprint = null;
});
```

> 查证：ExtensionAPI **无 `unregisterTool`**。切换 blueprint 时用 `setActiveTools` 过滤掉旧 external，再注册新的。但 `setActiveTools` 是全量替换，需保留内置工具与其它扩展工具——用 `pi.getActiveTools()` 差集计算。

---

## 6. 命令层（/blueprint）

见 §0.2 修正版。`switchBlueprint` 辅助函数：

```typescript
async function switchBlueprint(name: string, ctx: ExtensionCommandContext): Promise<void> {
  try {
    // 1. 注销旧 externals
    if (registeredExternalNames.length > 0) {
      const keep = pi.getActiveTools().filter((n) => !registeredExternalNames.includes(n));
      pi.setActiveTools(keep);
      registeredExternalNames = [];
    }

    // 2. 重转译
    cachedSegment = await loadAndTranspile(ctx.cwd, name);
    activeBlueprint = name;
    ctx.ui.setStatus("pt", `pt: ${name}`);

    // 3. 注册新 externals
    await registerExternalsFor(ctx.cwd, name, pi);

    ctx.ui.notify(`已切换到 ${name}，下一轮生效`, "info");
  } catch (err) {
    ctx.ui.notify(`切换失败：${errMsg(err)}`, "error");
  }
}
```

**即时生效原理**：`cachedSegment` 是模块级变量，`before_agent_start` 下一轮就读新值。无需 `/reload`（`pt-design.md` 第四节 C 方案）。

---

## 7. Externals → 工具（oxn/externals.ts）

### 7.1 设计原则

External 声明"这个 asset 需要哪个动态数据文件"。转译成**只读工具**：工具名由 path 推导，工具体读文件并截断返回。

### 7.2 工具名推导

```typescript
function externalToolName(ext: External): string {
  if (ext.name) return ext.name;
  // ./data/keyword-stats.xlsx → read-keyword-stats
  const base = ext.path.split("/").pop()!.replace(/\.[^.]+$/, "");
  return `read-${base.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
}
```

### 7.3 工具注册

```typescript
import { Type } from "typebox";
import { truncateHead, DEFAULT_MAX_BYTES, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";

export async function registerExternalsFor(
  cwd: string,
  blueprintName: string,
  pi: ExtensionAPI,
): Promise<void> {
  const externals = await oxnAdapter.loadExternals(cwd, blueprintName);
  for (const ext of externals) {
    const toolName = externalToolName(ext);
    const absPath = resolve(cwd, ext.path);

    pi.registerTool({
      name: toolName,
      label: `Read ${ext.path}`,
      description: `读取 ${ext.assetKind}:${ext.assetName} 声明的外部数据文件 ${ext.path}。返回文件内容（文本）。`,
      promptSnippet: `读取 ${ext.path} 的外部数据`,
      parameters: Type.Object({}),
      async execute(_id, _params, signal, _onUpdate, _ctx) {
        if (signal?.aborted) return { content: [{ type: "text", text: "Cancelled" }] };
        // 只读文件，无需 mutation queue；但用 queue 与内置 read 一致无妨
        return withFileMutationQueue(absPath, async () => {
          const buf = await readFile(absPath);
          const text = buf.toString("utf8");
          const t = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES });
          let out = t.content;
          if (t.truncated) out += `\n\n[输出已截断：${t.outputLines}/${t.totalLines} 行]`;
          return { content: [{ type: "text", text: out }], details: { path: ext.path } };
        });
      },
    });
    registeredExternalNames.push(toolName);
  }

  // 把新工具加入 active set（保留现有）
  if (registeredExternalNames.length > 0) {
    const current = pi.getActiveTools();
    pi.setActiveTools([...new Set([...current, ...registeredExternalNames])]);
  }
}
```

### 7.4 二进制文件处理

xlsx/csv/json/md 都是文本可读。若未来要支持真二进制（图片等），execute 里按扩展名分支：文本→`readFile` utf8；二进制→返回 path 让 LLM 用内置 `read`。MVP 只做文本。

### 7.5 Externals 工具与 `@` 文件引用的关系

LLM 已能用 `@./data/keyword-stats.xlsx` 引用文件。External 工具的额外价值：
- 工具名语义化（`read-keyword-stats` 比 `@path` 更易选）
- `promptSnippet` 进 system prompt，LLM 知道这数据"存在且该用"
- 工具 description 带 asset 上下文（"domain:writing 声明的外部数据"）

**如果觉得冗余**，MVP 可跳过 Externals→工具，只在 systemPrompt 段里列 `### 外部数据\n- keyword-stats: ./data/keyword-stats.xlsx`，让 LLM 自己 `@` 引用。**推荐**：MVP 先只列文本、不注册工具（减少复杂度），第二迭代再加工具。本文 §7 保留设计以备升级。

---

## 8. 配置层（config.ts）

### 8.1 读项目 settings

```typescript
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { readFile } from "node:fs/promises";

export async function readProjectSetting<T = unknown>(
  cwd: string,
  dottedKey: string,
): Promise<T | undefined> {
  const path = join(cwd, CONFIG_DIR_NAME, "settings.json");
  let json: any;
  try {
    json = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;  // 文件不存在或解析失败 → 静默
  }
  return dottedKey.split(".").reduce<any>((acc, k) => acc?.[k], json) as T;
}
```

### 8.2 自动探测单 blueprint

```typescript
import { readdir } from "node:fs/promises";
import { join } from "node:path";

export async function detectSingleBlueprint(cwd: string): Promise<string | null> {
  const dir = join(cwd, ".openxenon", "assets", "blueprints");
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return null;
  }
  const bps = files.filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3));
  if (bps.length === 1) return bps[0];   // 仅一个 → 自动选
  return null;                           // 0 个或多个 → 不自动选
}
```

### 8.3 优先级

```
--blueprint flag  >  .pi/settings.json 的 au.blueprint  >  自动探测（仅当唯一）  >  不注入
```

### 8.4 listBlueprints（命令补全用）

```typescript
export async function listBlueprints(cwd: string): Promise<string[]> {
  const dir = join(cwd, ".openxenon", "assets", "blueprints");
  try {
    return (await readdir(dir))
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.slice(0, -3));
  } catch {
    return [];
  }
}
```

---

## 9. Source Adapter 注册表（transpile.ts）

`pt-design.md` 第八节的 polyglot 接入点。MVP 只注册 OXN。

```typescript
export interface SourceAdapter {
  name: string;
  load(cwd: string, blueprintName: string): Promise<string>;          // 返回 systemPrompt 段
  loadExternals(cwd: string, blueprintName: string): Promise<External[]>;
}

const sourceAdapters: SourceAdapter[] = [
  oxnAdapter,
  // markdownAdapter,  // 未来
  // configAdapter,    // 未来
];

export async function loadAndTranspile(cwd: string, blueprintName: string): Promise<string> {
  const segs = await Promise.all(
    sourceAdapters.map((a) => a.load(cwd, blueprintName).catch((e) => {
      console.error(`[pt] adapter ${a.name} failed:`, e);
      return "";
    })),
  );
  return segs.filter(Boolean).join("\n\n");
}
```

**容错**：单个 adapter 失败不影响其它（返回空串被 filter 掉）。OXN adapter 内部某 asset 失败也只丢该段，不崩整体。

### 9.1 OXN Adapter

```typescript
export const oxnAdapter: SourceAdapter = {
  name: "oxn",
  async load(cwd, blueprintName) {
    const bpPath = join(cwd, ".openxenon/assets/blueprints", `${blueprintName}.md`);
    const blueprint = await readAsset(bpPath);
    const refs = parseBlueprintRefs(blueprint);
    if (!refs) return "";

    const [domain, workflow, stack] = await Promise.all([
      readAsset(join(cwd, ".openxenon/assets/domains", `${refs.domain}.md`)),
      readAsset(join(cwd, ".openxenon/assets/workflows", `${refs.workflow}.md`)),
      readAsset(join(cwd, ".openxenon/assets/stacks", `${refs.stack}.md`)),
    ]);

    return [
      compileDomain(domain),
      compileWorkflow(workflow),
      compileStack(stack),
      compileBlueprint(blueprint, domain, workflow, stack),
    ].filter(Boolean).join("\n\n");
  },
  async loadExternals(cwd, blueprintName) {
    const bp = await readAsset(join(cwd, ".openxenon/assets/blueprints", `${blueprintName}.md`));
    const refs = parseBlueprintRefs(bp);
    if (!refs) return [];
    const [d, w, s] = await Promise.all([
      readAsset(join(cwd, ".openxenon/assets/domains", `${refs.domain}.md`)),
      readAsset(join(cwd, ".openxenon/assets/workflows", `${refs.workflow}.md`)),
      readAsset(join(cwd, ".openxenon/assets/stacks", `${refs.stack}.md`)),
    ]);
    return [...extractExternals(d), ...extractExternals(w), ...extractExternals(s)];
    // blueprint 自身无 Externals
  },
};
```

---

## 10. 错误处理与降级矩阵

| 场景 | 行为 | 用户感知 |
|---|---|---|
| `.openxenon/assets/` 不存在 | `detectSingleBlueprint` 返回 null，不注入 | footer: `pt: 无 blueprint` |
| blueprint 文件不存在 | `session_start` catch → notify error | footer: `pt: 加载失败`，不阻塞启动 |
| refs 引用的 domain/workflow/stack 缺失 | `oxnAdapter.load` 抛 → adapter 返回空串 | 该来源段缺失，其它来源照常 |
| blueprint 无 `## Boundaries` | `compileBlueprint` 返回空串 | blueprint 段省略，前 3 段照常 |
| Externals path 文件不存在 | 工具 execute 抛 → LLM 收到 error | LLM 自行处理（重试或跳过） |
| settings.json 解析失败 | `readProjectSetting` 静默返回 undefined | 用 flag 或自动探测 |
| `/blueprint` 名字错 | `switchBlueprint` catch → notify error | 保持原 blueprint 不变 |

**核心原则**：任何来源失败不阻塞 Pi 启动、不阻塞 agent turn。降级为"少注入一段"或"不注入"。

---

## 11. 实现顺序（建议）

1. **types.ts** — 数据模型（§2）
2. **oxn/parser.ts** — `readAsset` + `parseFrontmatter` + `splitSections` + `parseItems` + blueprint/externals 解析（§3）。可用 `pt-design.md` 第六节的 4 个 asset 文件做单测。
3. **oxn/compiler.ts** — 4 个 compile 函数（§4）。对照 §4.2 输出规范验。
4. **config.ts** — `readProjectSetting` + `detectSingleBlueprint` + `listBlueprints`（§8）
5. **transpile.ts + oxnAdapter** — `loadAndTranspile` + OXN adapter（§9）
6. **index.ts 骨架** — `registerFlag` + `session_start` + `before_agent_start` + `session_shutdown` + `/blueprint` 命令（§5、§6）。**先不做 Externals 工具**。
7. **本地验证**：`.pi/extensions/pt.ts` + `pt-design.md` 第六节的 4 个 asset，`pi -e ./.pi/extensions/pt.ts`，敲 `/blueprint article`，看 systemPrompt（用 `/debug` 或 `ctx.getSystemPrompt()` log）。
8. **Externals 工具**（§7）— 第二迭代。
9. **包化** — 拆目录 + `package.json`（§1.2），`pi install` 验证。

---

## 12. 与 pt-design.md 的差异总结

| 项 | pt-design.md | 本设计 | 理由 |
|---|---|---|---|
| 读配置 | `pi.getSettings?.()` | `registerFlag`+`getFlag` + 自读 settings.json | API 不存在，查证修正 |
| 命令 args | `ctx.args[0]` | `args.trim()` + 无参 select | handler 签名是 `(args: string, ctx)` |
| 命令补全 | 无 | `getArgumentCompletions` 列蓝图 | 可用 API，UX 提升 |
| Externals | session_start 注册工具 | MVP 先不注册（systemPrompt 列路径），第二迭代加 | 减负，`@` 引用已够用 |
| session_shutdown | 未提 | 注销 external 工具 + 清内存态 | session 切换/重载时清理 |
| footer 状态 | 未提 | `ctx.ui.setStatus("pt", ...)` | 可见性，用户知道当前蓝图 |
| 错误处理 | 未提 | 降级矩阵（§10） | 任何失败不阻塞 |
| 文件结构 | ~200 行单文件 | MVP 单文件，发布拆 5 模块 | 可维护 + 包分发 |
| `CONFIG_DIR_NAME` | 硬编码 `.pi` | 用导出常量 | fork/rebrand 友好 |

架构层（per-session 内存态、before_agent_start 注入、cache 友好、polyglot adapter 注册表、Skill 分工、方式 B 转译）**全部保留不变**，本设计只在实现层补全。
