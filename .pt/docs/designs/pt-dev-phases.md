# Pt 开发执行计划

> 本文档供独立执行者（LLM 或开发者）按 Phase 推进 Pt 架构升级。
> 验收由另一角色负责，每个 Phase 有明确验收标准。
>
> **核心原则**：每个 Phase 结束必须能跑 + 产物可验证 + 不破坏旧功能。失败回退到上一 Phase 状态。

---

## 接手坐标（执行者必读，其他章节按需查）

### 当前在哪

- **Phase 0-9 完成**，v9 模型已落地（Blueprint 吸收 v8 Channel + Profile 业务实例 + AgentAdapter 抽象 + modName 驱动 + Trigger 索引）。
- git baseline：`8251378`（v8 §0）→ `7028a0f`（v9 §0 文档）→ `e1e3e90`（Phase 9 执行描述）→ 9.1-9.9 九个 Phase commit。可 `git revert` 回退。
- **v9 当前状态**：Blueprint（Agent 端结构）+ Profile（业务端实例）+ AgentAdapter（Pi 注入封装）+ Trigger 索引段（Domain H2）+ /manual:xxx 触发 + modName 注册表。

### 待办

**已完结（v9）**：Phase 9（v9 模型实现 + 文档同步）。

**非阻塞（后续可选）：**

1. Phase 6 加压（pt-* 资产加跨 Domain/1:N/hybrid）
2. `ingest/` 前置层（等第一个外部源接入时再加）
3. 未来 CLI 选 H2 模块作 `/模块名` 指令（§0.5 备注）
4. Channel Connector 实现（v9 Channel 留作未来 Domain 外部知识源连接）

### 必读（只读这些就够开工）

| 文档 | 读哪段 | 为什么 |
|---|---|---|
| `pt-asset-layering.md` | **§0（v9 四层模型）** | v9 语义基准：Domain→Blueprint→Profile→Context + 注入点人类自定义 + Profile 自动分发 + Trigger 索引 + AgentAdapter |
| `pt-dev-phases-v9.md` | **§Phase 9 步骤 9.1-9.9** + 验收标准 + 风险 | 要执行的改动面和验证判据 |
| 代码 | `src/schema.ts` / `src/parse/{blueprint,profile}.ts` / `src/compile/context.ts` / `src/render/{system-prompt,context-message}.ts` / `src/agent/pi-adapter.ts` | v9 当前实现 |

### 可跳过（背景，不影响执行）

- `pt-asset-layering.md` §1-§4（演进历史）、附录「模型演进对照」（v1-v5 是历史，v6-v9 是当前）。
- `pt-dev-phases.md` Phase 0-8 步骤（已完成，仅作背景）、`pt-dev-phases-v8.md`（v8 已完成）。
- `pt-prompt-optimization.md`（已落地，不涉及）。
- 文档里的 ⚠️ 注释和「待改」标记——那是给设计者看的，执行者按 §0 v9 语义为准即可。

### 遇到设计没覆盖的情况

**不要自行发挥**。记录问题交验收者决策（设计者会回补 §0 或 Phase 步骤）。自作主张改语义是最大风险。

---

---

## 当前代码现状（起点）

```
pt/
├── index.ts           # Pi 扩展入口：session_start/before_agent_start + /pt 命令
├── transpile.ts       # OXN adapter + adapter 注册表 + loadAndTranspile（返回 string）
├── config.ts          # 读 .pi/settings.json + 探测 blueprint
├── types.ts           # OXN 专有类型：Asset/Section/Item/Boundary/External/SourceAdapter
├── oxn/
│   ├── parser.ts      # OXN MD → Asset（纯字符串处理）
│   └── compiler.ts    # Asset → systemPrompt 段（compileDomain/Workflow/Stack/Blueprint）
└── package.json       # @issac/pi-pt，pi.extensions: ["./index.ts"]
```

**当前能跑的功能**：
- `before_agent_start` 注入：读 OXN 4 asset → 编译成字符串 → 拼到 systemPrompt 末尾
- `/blueprint <name>` 切换
- `/pt status|raw|full` 查看产物
- 跨 asset 拼接：Blueprint 消费 Domain 的 Bans/Invariants/Externals 挂到步骤

**当前架构问题**（设计文档 §6.1、§11）：
- 前端（解析）和后端（生成）混在 `compiler.ts` 里，无 IR 中间态
- `SourceAdapter.load()` 返回 string，编译逻辑在 adapter 里调了
- 换来源必须重写编译函数（`compileAsset` 消费 OXN 专有的 `Asset` 结构）
- 无中端（编排策略 `StructureLayout.mode` 无处落地）
- 无动态手册通道（无 binder、无 input 事件接管）

---

## 目标架构（终点）

三段式编译架构（设计文档 §11）：

```
前端 (Frontend)  : 异构来源 → SchemaBundle IR
中端 (Midend)    : IR → IR 变换（编排策略、模板选择）
后端 (Backend)   : IR → 结构化 prompt（systemPrompt + user message）
```

目标文件结构：

```
pt/
├── schema.ts          # IR 类型定义（契约）
├── frontend/
│   └── oxn/
│       ├── parser.ts    # OXN MD 解析（从现 oxn/parser.ts 迁入）
│       └── adapter.ts   # OXN MD → SchemaBundle
├── midend/
│   ├── layout.ts        # StructureLayout 变换
│   └── flow-select.ts   # FlowTemplate 选择
├── backend/
│   ├── prompt.ts        # IR → systemPrompt
│   └── message.ts       # FlowTemplate + 参数 → user message（binder）
├── index.ts           # Pi 事件调度
├── config.ts          # 不变
└── package.json       # 不变
```

---

## Phase 0：地基 — Schema 定义 + 目录骨架

### 目标

建立 IR 契约，不改任何运行行为。

### 步骤

1. 新建 `pt/schema.ts`，定义以下接口（完全按设计文档 §6.3，**不带任何 OXN 痕迹**）：

   ```typescript
   // pt/schema.ts — Pt IR 契约，与任何来源格式无关

   /** 静态知识库 · 语义层 */
   export interface Term {
     name: string;
     desc: string;
     level?: "axiom" | "theorem";  // 可选标签，不强制
   }

   export interface ExternalRef {
     name: string;
     path: string;
     protocol?: "file" | "api" | "db";
   }

   /** 静态知识库 · 模块层（业务领域模块） */
   export interface DomainModule {
     name: string;             // 业务领域名，= domain asset name（一个 Domain 一个模块）
     terms: Term[];
     rules: Rule[];
     externals: ExternalRef[];
   }

   /** 静态知识库 · 结构层（编排策略） */
   export interface StructureLayout {
     mode: "byDomain" | "byType" | "hybrid";
     domainOrder?: string[];  // byDomain/hybrid 时的模块顺序
   }

   export interface Rule {
     slot: string;             // 挂到哪个步骤，或 "global"（hybrid 模式下 global 规则聚合到全局段）
     type: "ban" | "invariant";
     check: string;
     items?: string[];
   }

   export interface BoundaryNode {
     slot: string;
     deps: string[];
     desc: string;
   }

   export interface ToolRef {
     name: string;
     role?: string;
     operations?: string[];
   }

   /** 静态知识库整体（进 systemPrompt） */
   export interface KnowledgeBase {
     identity: {
       trigger: string;
       boundaries: BoundaryNode[];
       tools: ToolRef[];
     };
     modules: DomainModule[];
     flows: FlowTemplate[];    // 手册模板（类 OXN Workflow，静态声明在知识库里）
     layout: StructureLayout;
   }

   /** 动态手册：FlowTemplate 是静态知识的一部分，实例化后成为手册进 user message */
   export interface FlowTemplate {
     name: string;             // /name 触发
     argumentHint?: string;
     intent: string;           // 数据语义层：带 {{}} 占位符的前提
     steps: FlowStep[];        // 手册结构层：步骤 + 数据源 + 期望产出
     externals: ExternalRef[]; // 数据语义层：引用知识库的数据源
   }

   export interface FlowStep {
     desc: string;             // 做什么
     dataSource?: ExternalRef; // 从哪取数据（数据语义层）
     rule?: string;            // 套哪条规则（引用知识库的 Rule）
     output?: string;          // 期望产出什么
   }

   /** 一个来源 adapter 应提供的完整 Schema 包 */
   export interface SchemaBundle {
     knowledgeBase: KnowledgeBase;   // 静态知识库（含 FlowTemplate 模板）
     // 动态手册不是独立部分，是 knowledgeBase.flows 被实例化后的产物
   }

   /** Source Adapter 接口（反转后：返回 SchemaBundle 而非 string） */
   export interface SourceAdapter {
     name: string;
     load(cwd: string, blueprintName: string): Promise<SchemaBundle>;
   }
   ```

2. 新建目录骨架（空 `index.ts` 占位，导出空对象或空函数）：
   - `pt/frontend/oxn/index.ts`（占位）
   - `pt/midend/index.ts`（占位）
   - `pt/backend/index.ts`（占位）

3. **不改动任何现有文件**（`types.ts`/`oxn/*`/`transpile.ts`/`compiler.ts`/`index.ts` 原样保留）。

### 验收标准

- [ ] `pt/schema.ts` 存在，包含上述所有接口定义。
- [ ] `tsc --noEmit pt/schema.ts` 编译通过（或 `npx tsc --noEmit` 全项目通过，需先建 `tsconfig.json`，见下）。
- [ ] 目录骨架 `frontend/`、`midend/`、`backend/` 存在，各有 `index.ts` 占位。
- [ ] **旧功能不受影响**：在 pt 项目根目录发任意消息触发 `before_agent_start`，然后 `/pt full`，产物与 Phase 0 前完全一致。

### 附：建 tsconfig.json

项目当前无 `tsconfig.json`。Phase 0 需新建：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "allowImportingTsExtensions": true
  },
  "include": ["**/*.ts"],
  "exclude": ["node_modules"]
}
```

### 风险

- 无风险。纯新增，不改运行代码。失败回退：删 `schema.ts` 和目录骨架。

---

## Phase 1：前端 — OXN adapter 输出 SchemaBundle

### 目标

架构反转。OXN 解析逻辑从"直接编译成字符串"改为"输出 SchemaBundle IR"。产物**等价**（行为不变，架构对了）。

### 前置依赖

Phase 0 完成（`schema.ts` 存在）。

### 步骤

1. **新建 `pt/frontend/oxn/parser.ts`**：把现有 `oxn/parser.ts` 的内容**原样迁入**（`readAsset`/`parseFrontmatter`/`splitSections`/`parseItems`/`parseBlueprintRefs`/`parseBoundaries`/`extractExternals`/`inferKind`）。
   - 类型导入改为从 `../../schema.js` 导入 `SourceAdapter` 相关类型；OXN 专有的 `Asset`/`Section`/`Item`/`Boundary`/`BlueprintRefs`/`External`/`AssetKind` 留在此文件或迁到 `frontend/oxn/types.ts`（这些是 OXN adapter 内部中间表示，不进 Pt 核心）。

2. **新建 `pt/frontend/oxn/adapter.ts`**：实现 `SourceAdapter`，把现有 `transpile.ts` 的 `oxnAdapter.load()` 逻辑搬过来，但 `load()` 返回 `SchemaBundle` 而非 `string`。

   核心是写映射函数（OXN `Asset` → Schema）：

   ```typescript
   import type { SchemaBundle, KnowledgeBase, DomainModule, BoundaryNode, ToolRef, Rule, Term, ExternalRef, FlowTemplate } from "../../schema.js";
   import { readAsset, parseBlueprintRefs } from "./parser.js";
   import type { Asset } from "./types.js";  // OXN 内部类型

   export const oxnAdapter: SourceAdapter = {
     name: "oxn",
     async load(cwd, blueprintName): Promise<SchemaBundle> {
       // 读取 4 个 OXN asset（逻辑同现有 transpile.ts 的 oxnAdapter.load）
       const blueprint = await readAsset(join(cwd, ".pt/assets/blueprints", `${blueprintName}.md`));
       const refs = parseBlueprintRefs(blueprint);
       const [domain, workflow, stack] = await Promise.all([...]);

       // 映射到 Schema
       return {
         knowledgeBase: {
           identity: {
             trigger: typeof blueprint.frontmatter.trigger === "string" ? blueprint.frontmatter.trigger : defaultTrigger,
             boundaries: parseBoundaries(blueprint).map(toBoundaryNode),
             tools: stack.sections["Tools"]?.items.map(toToolRef) ?? [],
           },
           modules: [toDomainModule(domain)],
           flows: [],  // Phase 3 再填，MVP-Static 先空
           layout: { mode: "hybrid" },  // 默认 hybrid，Phase 2 再读 asset 声明
         },
       };
     },
   };
   ```

   需实现的映射函数（每个都要**逐字段对照**现有 `compiler.ts` 确保语义保真）：
   - `toTerm(item: Item): Term` — `name` + `fields.desc/description`
   - `toRule(item: Item, slotHint?: string): Rule` — 区分 Bans（`fields.items`）和 Invariants（`fields.value/desc`）
   - `toExternalRef(item: Item): ExternalRef` — `name` + `fields.path`
   - `toBoundaryNode(b: Boundary): BoundaryNode` — `slot` + `deps` + `desc`
   - `toToolRef(item: Item): ToolRef` — `name` + `role` + `operations`
   - `toDomainModule(domain: Asset): DomainModule` — terms + rules + externals

   **关键：Rules 的 slot 归属**。当前代码把 Bans/Invariants 挂到 Blueprint 的 revise 步（最后一个 boundary）。映射时：
   - Domain 的 Bans/Invariants 暂不挂 slot（Phase 2 由中端 layout 处理），或在 `toRule` 时 `slot: "global"`。
   - **Phase 1 的目标是产物等价**，所以 backend 要复刻当前"挂到最后一步"的行为。建议：映射时 Rule 不带 slot，backend prompt 仍按当前逻辑（挂末步）。Phase 2 再引入中端做正式编排。

3. **新建 `pt/backend/prompt.ts`**：消费 `SchemaBundle`，输出和当前 `compileAsset` 等价的字符串。

   - 把现有 `oxn/compiler.ts` 的 `compileBlueprint`/`compileDomain`/`compileStack` 逻辑迁入，但输入从 `Asset` 改为 `SchemaBundle`。
   - 编排策略先**硬编码当前顺序**（blueprint → domain → stack），不接 `StructureLayout.mode`。
   - 跨 asset 拼接（Externals 挂首步、Bans/Invariants 挂末步）逻辑保留，但从"读 ctx.domain"改为"读 schema.knowledgeBase.modules[0]"。

4. **改 `pt/transpile.ts`**：
   - `loadAndTranspile` 改为：调 `oxnAdapter.load()` 拿 `SchemaBundle` → 调 `backend/prompt.ts` 的 `generatePrompt(bundle)` 拼字符串。
   - adapter 注册表保留（未来加来源）。
   - HTML 注释剥离规则保留：`raw.replace(/<!-- =====[^\n]*-->\n?/g, "")`。
   - 删除对 `oxn/compiler.ts` 的 import。

5. **旧文件处理**：
   - `oxn/parser.ts` → 内容迁到 `frontend/oxn/parser.ts` 后，原文件可删或改为 re-export（过渡期保留 re-export 防意外引用）。
   - `oxn/compiler.ts` → 内容迁到 `backend/prompt.ts` 后，原文件可删。
   - `types.ts` → OXN 专有类型迁到 `frontend/oxn/types.ts`；`SourceAdapter` 接口从 `schema.ts` 导出。原 `types.ts` 可删或改为 re-export。

### 验收标准

- [ ] `frontend/oxn/adapter.ts` 的 `load()` 返回 `SchemaBundle` 对象（含 knowledgeBase）。
- [ ] `backend/prompt.ts` 消费 `SchemaBundle` 生成字符串。
- [ ] `transpile.ts` 链路：adapter.load() → backend.generatePrompt()。
- [ ] **产物等价（硬指标）**：在 pt 项目根目录发消息触发 `before_agent_start`，`/pt full`，对比产物与 Phase 1 前的字节级或语义级等价。
  - 语义级等价判据：段落顺序、步骤、checklist、数据路径、术语内容一致。
  - **建议**：Phase 1 开始前先 `/pt full` 存一份基线产物，完成后 diff 对比。
- [ ] `tsc --noEmit` 全项目通过，无类型错误。
- [ ] 旧 `oxn/compiler.ts` 和 `types.ts` 已删除或改为 re-export（无死代码）。

### 风险

- **映射函数语义保真**：OXN `Asset` → Schema 映射可能丢字段。缓解：逐字段对照现有 `compiler.ts` 的取值逻辑（`s()`/`sArr()` 辅助函数），确保 Terms/Bans/Invariants/Externals/Boundaries/Tools 不丢不变形。
- **跨 asset 拼接逻辑迁移**：当前 `compileBlueprint` 通过 `CompileCtx` 访问 domain。迁移后从 `bundle.knowledgeBase.modules[0]` 访问。注意 `domainExts`/`domainBans`/`domainInvs` 的取值路径要改对。
- **失败回退**：git revert `transpile.ts`/`frontend/`/`backend/`，恢复 `oxn/compiler.ts` 和 `types.ts`。

### 关键检验

执行者完成后自检：能否换来源不动核心？答案应为"是"——`backend/prompt.ts` 只认 `SchemaBundle`，不认 OXN `Asset`。

---

## Phase 2：中端 + prompt-backend — 静态三层完整

### 目标

中端落地，`StructureLayout.mode` 真正生效。静态知识库三层完整。

### 前置依赖

Phase 1 完成（前端输出 SchemaBundle，backend 消费 SchemaBundle）。

### 步骤

1. **新建 `pt/midend/layout.ts`**：接收 `SchemaBundle`，按 `bundle.knowledgeBase.layout.mode` 变换 IR。

   ```typescript
   export interface LayoutedBundle {
     // 变换后的 IR，模块按 mode 重组
     globalRules: Rule[];        // slot:global 的规则聚合
     modules: DomainModule[];    // 按 domainOrder 排序后的模块
     mode: StructureLayout["mode"];
     // identity/flows 原样透传
     identity: KnowledgeBase["identity"];
     flows: FlowTemplate[];
   }

   export function layoutTransform(bundle: SchemaBundle): LayoutedBundle {
     const { mode, domainOrder } = bundle.knowledgeBase.layout;
     const modules = bundle.knowledgeBase.modules;
     // byDomain: 模块顺序输出，模块内 terms/rules 内聚
     // byType:   terms/rules 按类型聚合（跨模块拆出）
     // hybrid:   slot:global 的 rule 聚合到 globalRules，其余随模块内聚
     // ...
   }
   ```

   三种 mode 的具体变换逻辑（设计文档 §2.3）：
   - **byDomain**：modules 按 `domainOrder` 排序（无 domainOrder 则原序），每模块整体输出。`globalRules` 为空。
   - **byType**：把所有 modules 的 terms 聚成一段、rules 聚成一段。`globalRules` 包含所有 rules。
   - **hybrid**（默认）：`slot: "global"` 的 rule 抽到 `globalRules`，其余 rule 留在模块内。modules 按 `domainOrder` 排序。

2. **重写 `pt/backend/prompt.ts`**：消费 `LayoutedBundle`（而非原始 `SchemaBundle`），按 mode 生成不同段落结构。

   生成逻辑：
   - 先输出 identity（trigger + boundaries 步骤 + 挂载的 rules checklist）
   - 若 `globalRules` 非空，输出 `### 全局约束` 段
   - 按 mode 输出 modules：
     - byDomain/hybrid：每模块输出 `### 模块「{name}」` 段，含 terms + rules
     - byType：输出 `### 业务公理/术语` + `### 业务规则` 聚合段
   - 最后输出 tools 段

   **注意**：identity 的 boundaries 步骤 checklist 仍按 Phase 1 逻辑挂载（Externals 挂首步、非 global 的 Bans/Invariants 挂末步）。但 Phase 2 后，Bans/Invariants 已在 modules 里，挂载逻辑改为"从 modules 里找 slot 匹配的 rule"。

3. **改 `pt/transpile.ts`**：链路改为 `adapter.load()` → `layoutTransform()` → `backend.generatePrompt(layoutedBundle)`。

4. **OXN asset 支持 layout 声明**：在 blueprint frontmatter 加 `layout.mode` 字段（可选，默认 hybrid）。
   - 修改 `frontend/oxn/adapter.ts`：读 `blueprint.frontmatter.layout`，映射到 `StructureLayout`。
   - 更新 `.pt/assets/blueprints/article-blueprint.md` 的 frontmatter，加 `layout: { mode: hybrid }`（或不动，用默认）。

### 验收标准

- [ ] `midend/layout.ts` 实现三种 mode 的变换。
- [ ] `backend/prompt.ts` 消费 `LayoutedBundle`，按 mode 生成不同段落。
- [ ] **三 mode 产物差异可见**（切换 mode 后段落结构肉眼可区分）：
  - **byDomain**：每个 module 输出 `### 模块「{name}」` 段（含 terms + 模块内 rules），无全局段，无跨模块聚合段。
  - **byType**：跨 module 聚合 terms 成 `### 业务术语` 段，聚合 rules 成 `### 业务规则` 段，无模块段。
  - **hybrid**（默认）：`slot:"global"` 的 Rule 聚合到 `### 全局约束` 段（保留 `- [ ]` checklist 格式，放在流程段之前）+ `### 模块「{name}」` 段（含 terms，不含已抽走的 global rules）。流程段的步骤不再末步内嵌 checklist。
- [ ] `tsc --noEmit` 通过。
- [ ] **hybrid 产物不与 Phase 1 等价是预期行为**（非回归）：Phase 1 硬编码"挂末步"是旧架构的权宜，Phase 2 中端接管后 global rules 进全局段是语义修正。判据不是字节等价，而是 hybrid 产物符合设计文档 §2.3 的 hybrid 段落结构。

### Rule.slot 语义契约（设计文档 §2.3 已定，执行者必读）

- `slot: "global"` — adapter 映射时填的值，表示 Rule 是全局领域规则（跨步骤/跨模块）。Domain 的 Bans/Invariants 默认归此（Phase 1 adapter 已填）。
- `slot: "<具体 slot 名>"` — 步骤专属规则（如 `slot: "revise"`），由 asset 显式声明，留在对应步骤内。
- adapter 填值，midend 按 mode 解读，backend 按解读结果输出。**adapter 不感知 mode**（前端/中端分离）。

### 风险

- **byType 聚合逻辑**：跨模块拆 terms/rules 可能丢失模块归属信息。建议聚合时保留来源标注（如 `- 用户有唯一ID（来自：注册登录）`）。
- **失败回退**：layout 硬编码 hybrid，绕过中端，直接用 Phase 1 的 backend（但产物不会出现 `### 全局约束` 段，达不到验收判据）。

---

## Phase 3：动态手册 — message-backend + input 接管

### 目标

FlowTemplate 实例化通道打通。动态手册从设计到落地。

### 前置依赖

- Phase 2 完成（静态三层完整）。
- **必须先补设计文档 3 处模糊点**（见下"前置文档工作"），否则代码会返工。

### 前置文档工作（不改代码，先定设计）

在 `docs/pt-asset-layering.md` 补充：

1. **OXN asset → Schema 字段完整映射表**（§6 新增表格）：
   - domain asset → DomainModule（Terms→terms, Bans/Invariants→rules, Externals→externals）
   - workflow asset → identity.boundaries（Slots→BoundaryNode，注意 workflow 当前已废弃不输出，但 boundaries 从 blueprint 取）
   - stack asset → identity.tools
   - blueprint asset → identity.trigger + identity.boundaries + flows（Templates 段）

2. **FlowTemplate 在 OXN asset 里的声明格式**（§3.3 或 §5 新增）：
   - 在 blueprint asset 的 `## Templates` 段声明，格式示例：
     ```markdown
     ## Templates
     ### risk-check
     - argument-hint: "<客户ID> <金额>"
     - intent: 客户 {{客户ID}} 申请下单，订单金额 {{金额}}
     - steps:
       - 取额度 — 读 `./data/credit-limits.xlsx` 查 {{客户ID}} 的信用额度
       - 校验 R1 — 条件: 信用额度 >= {{金额}}；否则: 拒绝
     ```
   - 或定义更结构化的格式（需执行者与验收者协商）。

3. **binder 变量绑定语法**（§5.3 新增）：
   - 变量语法：`{{name}}`（命名变量）
   - 位置参数映射：`/risk-check 客户A 5000` → `{{客户ID}}=客户A`，`{{金额}}=5000`。映射规则：按 FlowTemplate 声明的变量顺序（frontmatter `vars: [客户ID, 金额]`）或按 `argument-hint` 的 `<...>` 顺序。
   - 缺省值：`{{金额|default:0}}`
   - 不支持条件块（MVP 不做，保持简单）。

### 步骤

1. **`frontend/oxn/parser.ts` 加 Templates 段解析**：解析 blueprint 的 `## Templates` 段为 `FlowTemplate[]`。
   - 每个 `### name` 是一个 FlowTemplate。
   - 字段：`argument-hint`/`intent`/`steps`（steps 可能需要特殊解析，按前置文档工作定义的格式）。

2. **`frontend/oxn/adapter.ts`**：`toFlows(blueprint)` 映射 Templates 段到 `FlowTemplate[]`，填入 `knowledgeBase.flows`。

3. **新建 `pt/backend/message.ts`（binder）**：
   ```typescript
   export function bindFlowTemplate(
     tpl: FlowTemplate,
     args: string,  // "/risk-check 客户A 5000" 的参数部分
   ): string {
     // 1. 解析 args 为位置参数数组
     // 2. 按变量声明顺序映射到命名变量
     // 3. 替换 tpl.intent 和 tpl.steps 里的 {{变量}}
     // 4. 返回展开后的手册 markdown
   }
   ```

4. **`pt/index.ts` 注册 `input` 事件**：
   ```typescript
   pi.on("input", async (event) => {
     const match = event.text.match(/^\/(\S+)\s+(.*)/);
     if (!match) return { action: "continue" };
     const [_, tplName, args] = match;
     const tpl = cachedBundle?.knowledgeBase.flows.find(f => f.name === tplName);
     if (!tpl) return { action: "continue" };  // 非 Pt 管的，放行给 Pi 原生

     const expanded = bindFlowTemplate(tpl, args);
     return { action: "transform", text: expanded };
   });
   ```

5. **systemPrompt 输出手册清单**：`backend/prompt.ts` 在 identity 段后追加 `### 可用手册` 段，列出 `flows` 的 name + argumentHint，供 LLM 自选。

6. **加风控例子**：在 `.pt/assets/` 下加一套风控 asset（domain: commerce, blueprint: risk-check with Templates 段, 对应 workflow/stack）。先写静态规则（不带 `{{}}`），验证手册结构；再加参数化版本。

### 验收标准

- [ ] 设计文档 3 处模糊点已补充（asset 映射表、Templates 格式、binder 语法）。
- [ ] `backend/message.ts` 实现 `bindFlowTemplate`，支持 `{{命名变量}}` + 位置映射 + 缺省值。
- [ ] `index.ts` 注册 `input` 事件，拦截 Pt 管的 `/name`，transform 后放行。
- [ ] **`/risk-check 客户A 5000` 触发**：binder 展开成手册进 user message，agent 能按手册走（读数据源、套规则、给结论）。
- [ ] **Pi 原生 template 共存**：非 Pt 管的 `/some-other-template` 仍走 Pi `$1 $2` 机制（验证 `/some-other-template` 不被 Pt 拦截）。
- [ ] **LLM 自选路径**：systemPrompt 里有 `### 可用手册` 清单，agent 能基于上下文判断用哪个。
- [ ] `tsc --noEmit` 通过。

### 风险

- **Templates 段格式设计**：如果格式定义不清，解析会返工。**必须先完成前置文档工作**，确认格式后再写解析。
- **binder 变量映射**：位置参数 → 命名变量的映射规则要明确。`argument-hint: "<客户ID> <金额>"` 的 `<>` 顺序即变量顺序，这是最简约定。
- **input 事件与 Pi 原生冲突**：Pt 只拦截 `cachedBundle.flows` 里有的 template，其余 `continue`。要测一个非 Pt 的 template 确认不被误拦。
- **失败回退**：关闭 `input` 事件 handler（注释掉 `pi.on("input", ...)`），用 Pi 原生 template 机制。

---

## Phase 4：收尾 — 验证 + 风控例子 + 文档对齐

### 目标

端到端跑通，文档与代码一致，无死代码。

### 前置依赖

Phase 3 完成。

### 步骤

1. **写完整风控例子**：
   - `.pt/assets/domains/commerce.md`（Terms: 客户/订单/信用额度；Rules: R1 额度/R2 黑名单；Externals: credit-limits.xlsx, customer-tier.xlsx）
   - `.pt/assets/workflows/risk-flow.md`（Slots: 取额度→取等级→校验）
   - `.pt/assets/stacks/risk-stack.md`（Tools: read）
   - `.pt/assets/blueprints/risk-check.md`（Use + Boundaries + Templates 段，含 `{{客户ID}}` `{{金额}}`）
   - `./data/credit-limits.xlsx` 和 `./data/customer-tier.xlsx`（造测试数据）

2. **端到端验证**：
   - `/blueprint risk-check` 切换
   - `/risk-check 客户A 5000` 触发，agent 展开后读数据源、套规则、给"通过/拒绝 + 理由"
   - `/pt full` 检查 systemPrompt 含手册清单 + 静态知识
   - 验证 LLM 自选：发"客户A 想下单 5000"（不带 `/`），看 agent 是否能从清单选 risk-check 手册

3. **写作助理例子验证**：
   - `/blueprint article-blueprint` 切换
   - 三 mode（byDomain/byType/hybrid）各跑一次 `/pt full`
   - 发"写一篇关于 X 的文章"，验证 agent 走 4 步流程

4. **文档对齐**：
   - `docs/pt-asset-layering.md` §6.5 的 OXN adapter 示意代码更新为实际实现
   - `docs/pt-prompt-optimization.md` 顶部标注"已由架构升级覆盖，保留作历史参考"
   - `docs/pt-asset-layering.md` §11.5 文件结构更新为实际目录

5. **清理**：
   - 删 `oxn/compiler.ts`（已迁入 `backend/prompt.ts`）
   - 删 `types.ts`（OXN 专有类型已迁入 `frontend/oxn/types.ts`，`SourceAdapter` 在 `schema.ts`）
   - 删 `oxn/` 目录（如已空）
   - 确认无 re-export 过渡代码残留

### 验收标准

- [ ] 风控例子端到端跑通（`/risk-check 客户A 5000` 给出正确判断）。
- [ ] 写作助理例子三 mode 跑通，产物符合设计。
- [ ] LLM 自选路径验证通过（无 `/` 触发也能选手册）。
- [ ] 文档与代码一致（设计文档的代码示例 = 实际实现）。
- [ ] 无死代码（`tsc --noEmit` 无 unused 报警，`oxn/` 目录已清理）。
- [ ] `/pt full` 产物完整正确（含 identity + modules + 可用手册清单 + 工具）。

---

## Phase 5：模型对齐 — Domain/Struct v6 语义

> 设计文档已更新为 v6 语义（§0 为准）。本 Phase 是把代码从 v3（Phase 4 状态）对齐到 v6。**这是模型重构，不是功能升级**——不改转译能力，只改概念承载方式。

### 目标

让三段式架构兑现“Pt 是稳定结构框架”的定位：
1. **Domain 即 Module**：不再三平级 Module（Domain/Workflow/Stack），workflow/stack 降为 Domain Type 标签。
2. **每个 Domain 用两 H2 段**：`## Scene`（What）+ `## Blueprint`（How/Why），一个 md 内两个二级标题。
3. **Struct 命名澄清**：Scene 读 `## Scene` 产 System Prompt；Blueprint 读 `## Blueprint` 产 Manual（对齐 Pi Prompt Template）。
4. **渲染器按 Domain Type 注册**：`Record<type, renderFn>`，加新 Type 只加 renderer，不动 Schema/中端。
5. **Blueprint 1:N Domain**：Use 段引用 Domain 列表，renderer 摊平 `## Blueprint` 段。

### 前置依赖

- Phase 1-4 全部完成且验证通过（当前状态 ✅）。
- 设计文档 §0 v6 语义定义已写入（✅ 已随本轮更新）。

### 设计判据（验证三段式架构成立）

**Phase 5 迁移只动前端 + asset + 后端渲染器注册，中端和 Schema 核心结构不变。**
- 中端 layout 三模式（byDomain/byType/hybrid）不受影响。
- IR 契约（SchemaBundle）只是字段重组（从硬编码到通用 Domain[]），语义不变。
- 如果中端被迫改，说明抽象漏了，需回看设计。

### 步骤

#### 5.1 Schema 通用化（schema.ts）

```typescript
// 目标 IR
export interface Domain {
  name: string;
  type: string;            // "term" / "workflow" / "stack" / 未来新 type
  scene: unknown;          // type 决定具体型（Term[] / FlowTemplateMeta / ToolRef[]）
  blueprint: unknown;      // type 决定具体型（Term[] / FlowTemplate / Usage[]）
}
export interface Struct {
  name: string;
  kind: "scene" | "blueprint";  // Scene / Blueprint
  refs: string[];          // 引用的 Domain 名列表
  layout: StructureLayout; // 编排策略（仅 Scene 用）
}
export interface SchemaBundle {
  domains: Domain[];       // ← 替代 modules/flows/tools 三字段
  structs: Struct[];       // Scene + Blueprint
  identity: { trigger; boundaries };
  layout: StructureLayout;
}
```

- 保留 `Term`/`FlowTemplate`/`ToolRef` 类型定义（作为 scene/blueprint 的具体型）。
- `StructureLayout` 不变（中端不变）。

#### 5.2 前端 adapter 重写（frontend/oxn/）

- `types.ts`：废弃 `BlueprintRefs`，改为 `Struct.refs: string[]`（Domain 名列表）。
- `parser.ts`：解析 Domain md 的 `## Scene` / `## Blueprint` 两个 H2 段，按 type 分发解析。
- `adapter.ts`：
  - 把 3 种 asset（domain/workflow/stack）统一解析成 `Domain { type, scene, blueprint }`。
  - 不再 `void workflow`——workflow asset 解析为 `Domain { type: "workflow", scene: 手册清单, blueprint: steps }`。
  - 组装 `domains[]` + `structs[]`。

#### 5.3 后端渲染器注册制（backend/prompt.ts + message.ts）

```typescript
// 按 Domain Type 注册 renderer
const sceneRenderers: Record<string, (d: Domain) => string> = {
  term: renderTermScene,      // 公理 → System Prompt
  workflow: renderWorkflowScene, // 手册清单 → System Prompt
  stack: renderStackScene,    // tools 清单 → System Prompt
};
const blueprintRenderers: Record<string, (d: Domain) => string> = {
  term: renderTermBlueprint,    // 定理 → Manual
  workflow: renderWorkflowBlueprint, // steps → Manual
  stack: renderStackBlueprint,  // usage → Manual
};
// Scene: 遍历 refs，按 type 分发 sceneRenderers
// Blueprint: 遍历 refs，按 type 分发 blueprintRenderers
```

- `compileModule`/`compileFlows`/`compileTools` 改为 renderer 函数，注册进表。
- 加新 Domain Type = 加一行 renderer，不改遍历逻辑。
- `message.ts` 语义上产出 Manual，可考虑改名 `manual.ts`（MVP 可留名不改）。

#### 5.4 asset 重构

- **Domain md 格式**：一个 Domain = 一个 md，`## Scene` + `## Blueprint` 两个 H2 段（见 §0.7 格式）。
  - term-Domain：`## Scene`（公理，内部 H3=公理/无序号=定理）+ `## Blueprint`（定理）
  - workflow-Domain：`## Scene`（手册清单+数据源）+ `## Blueprint`（steps，即 FlowTemplate）
  - stack-Domain：`## Scene`（tools 清单）+ `## Blueprint`（usage）
- **scene asset**：引用 Domain 列表 + trigger + layout + Boundaries。
- **blueprint asset**：引用 Domain 列表 + 手册渲染布局。
- **移除旧 blueprint 的 `## Templates` 段**（FlowTemplate 迁入 workflow-Domain 的 `## Blueprint`）。

#### 5.5 index.ts 命令调整

- `pi.registerFlag("blueprint")` → `pi.registerFlag("scene")`（或保持 `blueprint` 名，语义已澄清）。
- `config.ts` 探测逻辑适配新 asset 结构。

### 验收标准

- [ ] `tsc --noEmit` 通过。
- [ ] **三 mode 无回归**：byDomain/byType/hybrid 产物与 Phase 4 对比，语义不变（字段重组允许格式微调，但内容等价）。
- [ ] **binder 无回归**：`/risk-check 客户A 5000` 手册实例化正常。
- [ ] **catalog 无回归**：System Prompt 的 `### 可用手册` 段仍列出手册清单（来自 workflow-Domain 的 `## Scene` 段）。
- [ ] **LLM 自选无回归**：无 `/` 触发时 agent 仍能从 System Prompt 选手册。
- [ ] **中端零改动验证**：`midend/layout.ts` diff 为空或仅类型重命名（不改逻辑）。
- [ ] **扩展性验证**：手动添加一个 "glossary" 假 Domain Type，只动前端解析+后端 renderer 注册，中端/Schema 不动。
- [ ] **两段验证**：一个 workflow-Domain 的 `## Scene` 段进 System Prompt，`## Blueprint` 段进 Manual，各走各的通道。

### 风险

1. **Schema 重组可能破坏 midend 类型依赖**。缓解：先在 schema.ts 加新接口并标注弃用旧字段，逐文件迁移。
2. **asset 格式是破坏性改动**，需同步更新示例资产。缓解：先在现有 asset 上加 `## Scene` / `## Blueprint` 段（双写），验证后再删旧段。
3. **公理/定理分流未实现**：当前 Domain 的 Terms 未标 axiom/theorem level。Phase 5 先打通结构（Scene 读 `## Scene` / Blueprint 读 `## Blueprint` 的通道），Term 分级留到后续。
4. **workflow-Domain 的 `## Scene` 段暂缺**：当前 workflow asset 无 Scene 段内容（手册清单+数据源）。Phase 5 先让 `## Blueprint` 段（steps）迁移到位，`## Scene` 段暂由 backend 从 FlowTemplate 列表自动生成 catalog 占位，后续再改为 workflow-Domain 显式声明。

---

## Phase 6：自举 — 用 Pt 描述 Pt

> **自举是最终验收**：如果 Pt 能用自己的 asset 描述自己并转译出可用 prompt，说明 Pt 的语义模型足以表达一个真实非平凡系统（它自己），不是空转。

### 目标

用 Pt 的 Domain/Struct/Render 模型编写 Pt 自身的知识资产，跑通完整转译链路：
1. **写 Pt 的 Domain assets**：用 term/workflow/stack 三种 type 描述 Pt 自身。
2. **写 Pt 的 Scene/Blueprint assets**：编排上述 Domain。
3. **跑通转译**：Scene 产出的 System Prompt 能让一个 fresh LLM 理解“Pt 是什么、能做什么”；Blueprint 产出的 Manual 能指导 LLM 执行一次转译。

### 前置依赖

- Phase 5 完成（v6 语义代码对齐到位）。

### 步骤

#### 6.1 编写 Pt 自描述 Domain assets

```markdown
# pt-concepts.md
yml: type: term
## Scene
  ### Pt 是什么
  - Pt 是 Pi 扩展，把业务知识 asset 转译成 Pi Agent 的 System Prompt 和 Manual
  ### 三段式架构
  - frontend / midend / backend，IR = SchemaBundle
## Blueprint
  ### 为什么用编译架构
  - 转译任务与编译同构：前端解析→中端编排→后端渲染
  - ### 为什么 Schema 反转
  - Pt 定义 Schema 接口，OXN 实现 adapter，依赖反转

# pt-transpile.md
yml: type: workflow
## Scene
  - 手册清单：full / scene-only / manual-only
  - 数据源：.pt/assets/*.md
## Blueprint
  - steps: frontend(adapter.load) → midend(layout) → backend(generatePrompt)

# pt-capabilities.md
yml: type: stack
## Scene
  - tools: schema.ts / adapter.ts / layout.ts / prompt.ts / message.ts
## Blueprint
  - usage: 何时用哪个 renderer
```

#### 6.2 编写 Scene/Blueprint assets

- **scene asset**：引用 pt-concepts + pt-transpile + pt-capabilities，编排成 System Prompt（“Pt 是什么、能做什么、怎么用”）。
- **blueprint asset**：引用 pt-transpile，编排成 Manual（“如何执行一次转译”）。

#### 6.3 跑通转译并验证

- `/pt full` 产出 Pt 自描述的 System Prompt + Manual。
- **自举判据**：一个不熟悉 Pt 的 LLM 拿到产出的 System Prompt + Manual，能正确回答“Pt 是什么”并执行一次转译流程。

### 验收标准

- [ ] Pt 自描述 assets 编写完成（至少 3 个 Domain + 1 Scene + 1 Blueprint）。
- [ ] `/pt full` 转译成功，无报错。
- [ ] **自举判据**：fresh LLM 能从产出理解 Pt 并执行转译（人工或 LLM 评估）。
- [ ] 产出质量合理：System Prompt 结构清晰，Manual 步骤可执行。

### 风险

1. **自描述可能暴露语义模型不足**：某些 Pt 概念无法用现有 type/段表达。缓解：这正是自举的价值——发现不足即迭代模型，回补 §0。
2. **自举不是“自己编译自己”**：Pt 不需要用 Pt 编译 Pt 的代码，只需用 Pt 的 asset 描述 Pt 的知识。别混淆编译器自举（bootstrapping compiler）与知识自举。

---

## Phase 5-6 验收记录（实测，非报告）

> 本节是 2026-08-29 实测验收记录，区分**属实**、**需澄清**、**缺失** 三档。执行者和验收者都以本节为准判断当前状态，不要看阶段 checklist 的打勾。

### 实测属实 ✅

| 项 | 证据 |
|---|---|
| `tsc --noEmit` 通过 | 实测 exit 0 |
| 3 Domain + Scene + Manual 资产存在 | `domains/pt-{concepts,transpile,capabilities}.md` + `blueprints/pt.{scene,manual}.md` |
| **中端零改动** | `midend/layout.ts` mtime = Phase 2 时期（08:05），Phase 5 文件全在 21:47+ |
| **renderer 注册制落地（Scene 侧）** | `sceneRenderers: Record<type, fn>` + `registerSceneRenderer` 导出 |
| v6 主链路完整 | `generateV6Prompt` 按 `Scene.refs` 遍历 + 按 type 分发；`generateManual` 按 Blueprint refs 摊平 workflow-Domain |
| 自举资产非空话 | pt-concepts 5 公理都是真 Pt 知识（三段式/Schema反转/Domain即Module/两通道），pt-transpile 6 步骤是真实转译流程 |
| 自举跑通 | `/pt full` 产出 1791 chars（hybrid），三 mode 兼容 |
| 回归通过 | article(461) / risk-check(480) Scene 不受影响 |

### 需澄清 ⚠️

**1. “Phase 5 落地”实为双写中间态，非完成态**

`schema.ts` 有**两个同名 `SchemaBundle` interface 合并声明**：
- 旧：`{ knowledgeBase: KnowledgeBase }`（v3，喂 midend）
- 新：`{ knowledgeBase, domains, structs, activeScene }`（v6，喂 backend）

`adapter.ts` 用 `deriveKnowledgeBase(scene, domains)` **从 v6 字段反向派生 v3 字段**喂 midend。注释明说：
> knowledgeBase：v3 legacy 字段，由 adapter 从新 fields 派生，供 midend/layout.ts 消费（中端零改动）

“中端零改动”成立的原因是 **legacy 字段还在喂它**，不是 midend 真的迁移到了 v6。这是 Phase 5 风险 #1 缓解策略（“先加新接口并标注弃用旧字段，逐文件迁移”），是合理的中间里程碑，但**不该称为“完成”**。真正完成 = 拆 `knowledgeBase` + 决定 midend 读 v6 还是退出。→ **Phase 5.5**。

**2. blueprintRenderers 是空壳**

```typescript
function renderTermBlueprint(_d: Domain): string { return ""; }
function renderWorkflowBlueprint(_d: Domain): string { return ""; }
```

Manual 实际只走 `message.ts` 的 `bindFlowTemplate` 展开 FlowTemplate，`blueprintRenderers` 注册表对 term/stack 返空串。注册制对 Blueprint 侧**结构在但没真正工作**——workflow 侧靠 message.ts 特殊处理绕过了注册表。“加新 type 只加 renderer”的扩展性承诺，目前**只在 Scene 侧验证了，Blueprint 侧未验证**。

**3. 扩展性验证证据不足**

Phase 5 checklist 的“手动添加 glossary 假 type”未实测。注册机制结构上支持，但没跑过就不算验证通过。→ **Phase 5.5 补**。

### 缺失/风险 ❌

**1. 非 git 仓库（本验收时）** — 全局验收清单“失败可回退 git revert”无法满足。**验收后已补**：`git init` + baseline commit `ffa721e`（Phase 0-6 双写状态）。后续改动均可回退到此点。

**2. 死代码累积** — `backend/prompt.ts` 底部 `generatePrompt(LayoutedBundle)` 标注“保留作参考，不被调用”；`KnowledgeBase`/`DomainModule` 接口在 schema.ts 仍 export。双写期保留可理解，但需明确清理计划，否则永久驻留。→ **Phase 5.5**。

### 总评

| 维度 | 状态 |
|---|---|
| v6 路径可用性 | ✅ 真通（双写 + 派生 + renderer 注册 + 自举产物） |
| 设计判据“中端零改动” | ✅ 成立（但靠 legacy 字段维持，非 midend 迁移） |
| Phase 5 完成度 | ⚠️ **双写里程碑达成，非完成**——legacy 清理未做 |
| Phase 6 完成度 | ✅ 自举通过，但压力测试偏弱（未 exercised 跨 Domain/1:N/hybrid harder case） |
| 回退能力 | ✅ 验收后补齐（baseline `ffa721e`） |
| 扩展性验证 | ⚠️ Scene 侧结构支持，Blueprint 侧空壳，未实测假 type |

> **本节状态**：以上是 Phase 5 双写里程碑的验收记录（baseline `ffa721e`）。后续 Phase 5.5 已解决全部 ⚠️/❌，见下节「Phase 5.5 实测结果」。本节保留作历史。

---

## Phase 5.5 实测结果（2026-08-30，commit `571b45d` + `9fca537`）

> Phase 5 双写里程碑的 3 个遗留项（legacy 字段/blueprintRenderers 空壳/扩展性未实测）全部解决。Phase 5 真正完成。

### 决策落地

| 步骤 | 决策 | 证据 |
|---|---|---|
| **5.5.1 midend 去留** | **选项 B：midend 退出** | `midend/` 目录删除，`LayoutedBundle`/`layoutTransform` 全清，layout 三 mode 逻辑并入 `generateV6Prompt`（`if (mode === "byType")` 分支在） |
| **5.5.2 拆 knowledgeBase** | 完成 | `SchemaBundle` 单一 v6 形态 `{domains, structs, activeScene}`，`deriveKnowledgeBase` 删除，adapter 不再派生 |
| **5.5.3 blueprintRenderers** | **移除** | 注册表 + `render*Blueprint` 函数 + `registerBlueprintRenderer` 全删，注释明说“Manual 只展开 workflow-Domain 的 steps” |
| **5.5.5 清死代码** | 完成 | `schema.ts` grep 不到 `KnowledgeBase`/`DomainModule`；`backend/prompt.ts` grep 不到 `generatePrompt(LayoutedBundle)`；`tsc --noEmit` 通过无 unused |

### 扩展性实测（5.5.4）✅

加 `glossary` 假 Domain Type，实测“加新 type 只加 renderer，核心不动”承诺：

**改动范围**（`git diff 571b45d 9fca537`）：
- `backend/prompt.ts` +16/-1：`renderGlossaryScene` 函数 + `sceneRenderers` 表加一行 `glossary: renderGlossaryScene`
- `blueprints/glossary-test.scene.md` 新建：15 行专用测试 scene（refs=`[glossary-test]`）

**未动**：`schema.ts`（diff 空）、`generateV6Prompt` 主循环、`adapter.ts`、`transpile.ts`。

**实测产物**（`.pt/verify-glossary2.ts`）：

| 检查 | 结果 |
|---|---|
| `glossary-test` scene 含 glossary 段 | ✅ 349 chars，`### 术语表「glossary-test」` + GlossaryEntry 出现 |
| `pt` scene 不污染 | ✅ 仍 1791 chars，不含 glossary |
| 回归 | ✅ article=461 / risk-check=480，与 baseline 一致 |
| `tsc --noEmit` | ✅ exit 0 |
| `schema.ts` 未动 | ✅ git diff 空 |
| `generateV6Prompt` 主循环未动 | ✅ 只加 renderer 函数 + 注册表一行 |

`renderGlossaryScene` 走标准 `DomainSceneRenderer` 接口返回 `DomainSection`，主循环 `sceneRenderers[d.type]` 分发——和 term/workflow/stack 走同一条路。注册制扩展性承诺兑现。

### 复验发现的新问题（2026-08-30）

> Phase 5.5 实测结果报“真正完成”后，复验发现两个漏项。其中一个属纯漏改（应即修），另一个是 midend 退出后架构叙事未同步（待设计决策）。

#### ❌ 1. `/blueprint` 命令未重命名为 `/scene`

**性质**：Phase 5.5 步骤漏项（纯漏改）。

`index.ts` 里 `blueprint` 仍出现 20 次，全量残留旧名：

| 位置 | 当前 | 应改 |
|---|---|---|
| L70 `pi.registerFlag("blueprint", ...)` | blueprint | scene |
| L79/82/82 `getFlag("blueprint")` / `readProjectSetting("au.blueprint")` | blueprint / au.blueprint | scene / au.scene |
| L88-89 notify `"未找到 blueprint。用 /blueprint <name>"` | blueprint | scene |
| L134 `pi.registerCommand("blueprint", ...)` | /blueprint | /scene |
| L147 notify `"未找到任何 blueprint"` | blueprint | scene |

**根因**：Phase 5.5 步骤计划里写了“index.ts 命令调整：`/blueprint` → `/scene`”，但 `571b45d` commit 没动 `index.ts`（commit message 的改动列表未提）。文档验收标准也漏了这一条。

**影响**：命名不一致——asset 文件已是 `*.scene.md` / `*.manual.md`，schema 里 `Struct.kind = "scene" | "blueprint"`，但用户面命令还叫 `/blueprint`。功能能用，但语义错位（blueprint 在 v6 里是动态 Struct 产 Manual，不是切换 Scene 的命令名）。

**修法**：`index.ts` 里 `blueprint` → `scene`，`au.blueprint` → `au.scene`，命令 `/blueprint` → `/scene`。注意 `.pi/settings.json` 里可能有 `au.blueprint` 键要一并迁。

#### ⚠️ 2. midend 退出后，三段式叙事塌了

**性质**：设计叙事未同步（非漏改，需决策）。

**事实**：IR 没少——`schema.ts` 的 `SchemaBundle` 就是 IR（frontend 产出 / backend 消费 / transpile+index 也消费，证据齐全）。但 Phase 5.5 选项 B（midend 退出）后，代码只有 frontend + backend 两段，layout 逻辑塞在 `generateV6Prompt` 里，backend 同时干“编排”和“渲染”两件事。

**问题**：设计文档还宣称“三段式编译架构”（§11.2 “为什么采用编译架构”、§0 对应代码阶段表里的 midend 行）——代码是两段式，文档三段式，叙事对不上。

**两个选项**：

- **选项 A：接受两段式叙事**——Pt 是两段式转译器（frontend parse → backend render）+ IR 契约。改 §11.2 论证降级，§0 midend 行删。诚实演进。
- **选项 B：恢复 midend**——把 `generateV6Prompt` 里的 mode 分支抽回 `midend/layout.ts`，输出 `LayoutedBundle` 给 backend，恢复三段式。成本：回退 Phase 5.5 选项 B，但保架构叙事。

**未决**：需设计者定。当前代码是两段式，文档三段式——以哪个为准待定。

### 仍未验证（非阻塞）

- **三 mode 实测**：所有 scene asset 都是 `layout: { mode: hybrid }`，byDomain/byType 路径未真跑过（代码分支在，无 asset 触发）。建议加一个 byType 测试 scene。
- **Phase 6 加压**：pt-* 资产未 exercised 跨 Domain/1:N workflow/hybrid 全局约束 harder case。
- **§0 补 Manual 语义边界**：blueprintRenderers 移除的依据（“Manual 只展开 workflow-Domain”）需写进 `pt-asset-layering.md` §0 防误解。

### Phase 5 总评（更新）

| 维度 | 状态 |
|---|---|
| v6 路径可用性 | ✅ 单一 v6 形态，无 legacy |
| 设计判据“中端零改动” | ✅ **终局达成**：midend 退出，不是没改是不需要了 |
| Phase 5.5 完成度 | ⚠️ **基本完成，复验发现 1 漏项 + 1 待决设计问题** |
| 扩展性验证 | ✅ glossary 假 type 实测通过，核心未动 |
| 命名一致性 | ❌ `/blueprint` 命令未重命名（漏改） |
| 架构叙事 | ⚠️ midend 退出后两段式，文档仍三段式，未同步 |

> **复验结论**：Phase 5.5 的 legacy 清理与扩展性实测部分仍成立，但标“真正完成”不准确。需先修 `/blueprint` 漏项 + 定架构叙事方向，才算真完。

### 目标

1. **拆 `knowledgeBase` legacy 字段**：SchemaBundle 只留 v6 字段（`domains/structs/activeScene`）。
2. **决定 midend 去留**：midend 读 v6 字段，或退出（layout 逻辑并入 backend）。
3. **blueprintRenderers 转正或移除**：Manual 渲染统一走注册表，或明说 Manual 只展开 FlowTemplate 不走注册表。
4. **扩展性实测**：加一个 `glossary` 假 Domain Type，跑 Scene + Blueprint 两侧注册。
5. **清死代码**：删 `KnowledgeBase`/`DomainModule` interface、旧 `generatePrompt(LayoutedBundle)`。

### 前置依赖

- Phase 5 双写里程碑（baseline `ffa721e`）。

### 设计判据

**Phase 5.5 完成后，schema.ts 不再 export 任何 v3 名词（`KnowledgeBase`/`DomainModule`/旧 `SchemaBundle`），midend 要么读 v6 要么消失。** 这是“v6 语义对齐完成”的硬指标。

### 步骤

#### 5.5.1 midend 去留决策（先定设计再改代码）

两个选项：

- **选项 A：midend 读 v6**——`layoutTransform(SchemaBundle)` 改读 `domains/structs`，`LayoutedBundle` 重定义为 v6 形态。改动 midend，但保留中端这一层。
- **选项 B：midend 退出**——layout 三模式的逻辑（byDomain/byType/hybrid 段落拼装）并入 `backend/prompt.ts` 的 `generateV6Prompt`。midend 目录删。**这才是“中端零改动”的终局验证：不是没改，是不需要了。**

决策依据：
- 若 layout 逻辑与 prompt 渲染强耦合（本就是“段落拼装”），选 B——中端是冗余抽象。
- 若未来 layout 要做更复杂变换（重排序、过滤、跨 scene 合并），选 A——中端有价值。
- **推荐 B**：当前 layout.ts 只做按 mode 拼装，与 renderer 职责重叠；v6 的 Struct.layout 字段已把 mode 信息带到 backend，中端无独立价值。

#### 5.5.2 拆 knowledgeBase 字段（依赖 5.5.1 决策）

- 若选 A：midend 改读 `domains/structs`，`deriveKnowledgeBase` 删，`SchemaBundle.knowledgeBase` 字段删。
- 若选 B：midend 删，`LayoutedBundle` 删，`deriveKnowledgeBase` 删，`SchemaBundle.knowledgeBase` 字段删，`transpile.ts` 的 `layoutTransform` 调用删。

#### 5.5.3 blueprintRenderers 转正或移除

- **转正**：`renderTermBlueprint`/`renderStackBlueprint`/`renderWorkflowBlueprint` 实现真实渲染，`generateManual` 改为遍历 Blueprint.refs + 按 type 分发 `blueprintRenderers`。
- **移除**：明说 Manual 只展开 workflow-Domain 的 FlowTemplate（term/stack 的 `## Blueprint` 段不进 Manual），删 `blueprintRenderers` 注册表 + `render*Blueprint` 函数。
- **推荐移除**：当前 Manual 语义就是“操作步骤手册”，只有 workflow-Domain 有 steps。term 的定理、stack 的 usage 进 Manual 的语义未定义，强行渲染是过度设计。移除更诚实。

#### 5.5.4 扩展性实测

- 加 `domains/glossary-test.md`（type=glossary），`## Scene` = 术语表，`## Blueprint` = 空。
- 加 `renderGlossaryScene` 注册进 `sceneRenderers`。
- 跑 `/pt full`，确认 glossary 段出现在 System Prompt，且**没改 schema.ts / midend / generateV6Prompt 主循环**。
- 若 5.5.3 选“移除”，blueprintRenderers 不动；若选“转正”，同样加 glossary renderer 测两侧。

#### 5.5.5 清死代码

- 删 `schema.ts` 的 `KnowledgeBase`/`DomainModule` interface + 旧 `SchemaBundle` 声明。
- 删 `backend/prompt.ts` 底部 `generatePrompt(LayoutedBundle)`。
- 删 `midend/`（若选 B）或 `LayoutedBundle`（若选 A）。
- `tsc --noEmit` 无 unused 报警。

### 验收标准（全部通过 ✅）

- [x] `tsc --noEmit` 通过，无 unused 报警。
- [x] `schema.ts` grep 不到 `KnowledgeBase`/`DomainModule`。
- [x] `backend/prompt.ts` grep 不到 `generatePrompt(LayoutedBundle)`。
- [x] **回归通过**：pt=1791 / article=461 / risk-check=480 chars，与 baseline `ffa721e` 一致。
- [x] **自举无回归**：`/pt full` 仍跑通。
- [x] **扩展性验证**：glossary 假 type 实测通过，只动 `backend/prompt.ts` + 新 scene asset，没动 schema/主循环。
- [x] **midend 去留明确**：选项 B（退出），不留双写。

> **注**：`/risk-check 客户A 5000` binder 未在本轮重测（产物字数一致即视为无回归；binder 逻辑在 Phase 5.5 未动）。

### 风险

1. **拆 legacy 可能暴露 midend 与 backend 的隐式耦合**。缓解：5.5.1 先定决策，5.5.2 再动。
2. **移除 blueprintRenderers 可能影响 Manual 扩展性叙事**。缓解：在 §0 明说“Manual 只展开 workflow-Domain”，这是语义边界不是缺陷。
3. **midend 删除是破坏性改动**。缓解：baseline `ffa721e` 可回退；先在分支验证。

---

---

## Phase 7：v7 模型重构（Domain → Channel → Blueprint → Context）

> v6 模型（Struct/Scene/Blueprint/Manual）升级为 v7 四层模型。设计基准见 `pt-asset-layering.md` §0（v7）。本 Phase 是**结构重构 + 模型对齐**，不是功能添加——产物语义不变（还是注入 System Prompt + Context Message），但载体、目录、IR、链路全改。

### 背景与动机

v6 的问题（复验发现）：
1. **midend 退出后三段式叙事塌**——代码两段式，文档三段式，叙事对不上。
2. **结构层与 Domain H2 段名碰撞**——v6 的 `Struct.kind="blueprint"` 与 Domain 的 `## Blueprint` 段同名。
3. **产物名不一致**——System Prompt 是 Pi 词，Manual 是 Pt 词，混用。
4. **模板/实例未分离**——Scene 的 refs 直接是具体 Domain 名，无结构复用机制。

v7 用四层模型解决：
- Domain（内容，H2 开放）→ Channel（结构，可复用）→ Blueprint（配置，实例）→ Context（产物，缓存）
- 结构层让 Channel，配置层用 Blueprint，产物层 Context——命名无碰撞
- Context Message 替代 Manual，与 System Prompt 都是 Pt 产物名
- Channel 可跨项目复用，Blueprint 是实例配置

### 目标

1. **目录结构改为动词三段式**：`parse/`（前端）+ `compile/`（中端，midend 恢复）+ `render/`（后端）。数据形态名（Domain/Channel/Blueprint/Context）作 IR 类型留在 schema.ts。
2. **src/ 迁移**：所有源码进 `src/`，顶层只留配置 + 入口。
3. **Schema 重写**：Domain 多 H2、Channel、Blueprint、Context 四套 IR + 载体约束。
4. **资产迁移**：9 个 Domain 改 `## Blueprint` → `## Manual`；新建 `channels/`；struct 资产改 Blueprint 格式。
5. **编译链路**：Blueprint + Channel + Domains → Context IR → Context 物理文件（hash 缓存）。
6. **注入链路**：读 Context 文件 → System Prompt（`## Scene`）/ Context Message（`## Manual`）。
7. **`ingest/` 前置层**：文档注明，v7 不建目录，等第一个外部源接入时再加。

### 目录结构（v7 终态）

```
src/
├── parse/                  # 前端：Pt md → IR
│   ├── shared.ts           # 通用 MD 词法+语法（四层共享）
│   ├── domain.ts           # domains/*.md → Domain IR
│   ├── channel.ts          # channels/*.md → Channel IR
│   └── blueprint.ts        # blueprints/*.md → Blueprint IR
├── compile/                # 中端：IR → IR 变换（midend 恢复）
│   └── context.ts          # (Blueprint+Channel+Domains IR) → Context IR（layout 编排）
├── render/                 # 后端：IR → 产物字符串 + 缓存
│   ├── system-prompt.ts    # Context IR.## Scene → System Prompt 字符串
│   ├── context-message.ts  # Context IR.## Manual → Context Message 字符串
│   └── cache.ts            # Context 文件读写 + hash 校验
├── schema.ts               # 四层 IR 类型（Domain/Channel/Blueprint/Context）+ 载体约束
├── transpile.ts            # 链路：parse → compile → render
└── index.ts                # Pi 入口

# ingest/ 前置层（外部源 → Pt md 的接入转换）：v7 不建，等第一个外部源接入时再加。
#   详见 pt-asset-layering.md §0.1（Domain 可能来自外部源转换）。
```

### 设计判据（硬指标）

- **三段式叙事成立**：parse（前端）→ compile（中端）→ render（后端），midend 以 `compile/` 恢复，§11.4 职责表三行恢复。
- **命名无碰撞**：schema.ts grep 不到 v6 的 `Struct`/`kind`；Domain H2 无 `## Blueprint`（改 `## Manual`）。
- **产物语义不回归**：pt/article/risk-check/glossary-test 四个 Blueprint 编译出的 System Prompt 内容与 v6 等价（语义级，非字节级）。
- **Channel 可复用**：至少 2 个 Blueprint 引用同一 Channel（验证复用机制）。
- **Context 缓存生效**：二次加载命中缓存（hash 一致不重编译）。
- **扩展性不破坏**：glossary 假 type 仍能注册 renderer 并渲染。

### 步骤

#### 7.1 src/ 迁移 + 三段式目录骨架（纯结构，不改逻辑）

- 建 `src/parse/`、`src/compile/`、`src/render/`
- 把现有 `frontend/oxn/*` 挪到 `src/parse/`（暂留旧名，7.3 再拆分）
- 把现有 `backend/*` 挪到 `src/render/`（暂留旧名）
- `schema.ts`/`transpile.ts`/`config.ts`/`index.ts` 挪到 `src/`
- `package.json` 的 `pi.extensions` 改 `["./src/index.ts"]`
- `tsconfig.json` 的 `include` 改 `["src"]`
- 改所有相对 import 路径
- **验收**：`tsc --noEmit` 通过 + `/pt full` 产物字数与 baseline 一致
- **commit**：`Phase 7.1: src/ 迁移 + 三段式目录骨架`

#### 7.2 Schema 重写（v7 四层 IR）

`src/schema.ts` 重写，定义四层 IR + 载体约束：

```typescript
// 内容层：Domain（多 H2 段，段名开放）
interface Domain {
  name: string;
  type: string;                    // term/workflow/stack/扩展
  modules: Record<string, unknown>; // H2 段名 → 段内容（key = "Scene"/"Manual"/"Term"/...）
}

// 结构层：Channel（定义含哪些模块 + 编排）
interface Channel {
  name: string;
  modules: string[];               // ["Scene", "Manual", "Term", ...]
  layout: { mode: "byDomain" | "byType" | "hybrid"; domainOrder?: string[] };
}

// 配置层：Blueprint（Channel + 具体 Domains + trigger + boundaries）
interface Blueprint {
  name: string;
  channel: string;                 // 引用 Channel 名
  domains: string[];               // 引用 Domain 名列表
  trigger?: string;
  boundaries?: BoundaryNode[];
}

// 产物层：Context（编译输出，缓存载体）
interface Context {
  name: string;                    // = Blueprint 名
  sourceHash: string;              // hash(Domains + Channel + Blueprint)
  modules: Record<string, string>; // H2 段名 → 聚合后的 markdown 字符串
}

// IR 集合（编译期内存态）
interface SchemaBundle {
  domains: Domain[];
  channels: Channel[];
  blueprints: Blueprint[];
  activeBlueprint: string;
}
```

- **删 v6 残留**：`Struct`/`Scene`(as Struct)/`StructureLayout`(旧)/`DomainModule`/`KnowledgeBase` 全删
- **保留共享类型**：`Term`/`Rule`/`BoundaryNode`/`ExternalRef`/`ToolRef`/`FlowStep`/`FlowTemplate`（这些是 Domain 段内容的子结构）
- **验收**：此步会破坏编译（v6 代码引用旧类型），7.3-7.6 逐步修复
- **commit**：`Phase 7.2: Schema 重写为 v7 四层 IR`

#### 7.3 parse/ 拆分（前端三 adapter）

`src/parse/` 拆成四个文件：

- `shared.ts`：通用 MD 词法+语法（从现有 `frontend/oxn/parser.ts` 抽公共部分）
- `domain.ts`：`domains/*.md` → `Domain` IR（按 type 分发解析各 H2 段，H2 名开放）
- `channel.ts`：`channels/*.md` → `Channel` IR（解析 `## Modules` + `## Layout`）
- `blueprint.ts`：`blueprints/*.md` → `Blueprint` IR（解析 `## Channel` + `## Domains` + `## Trigger` + `## Boundaries`）

**载体区分**：按目录位置（`domains/`/`channels/`/`blueprints/`）分发，不靠 frontmatter 猜。
- **验收**：三个 adapter 各自能解析对应 md 成 IR，单元测试或 `console.log` 验证
- **commit**：`Phase 7.3: parse/ 拆分前端三 adapter`

#### 7.4 资产迁移（9 Domain + 新建 channels + struct→blueprint）

- **9 个 Domain 改 H2**：`## Blueprint` → `## Manual`（pt-concepts/pt-transpile/pt-capabilities/writing/commerce/article-flow/risk-flow/md-stack/risk-stack/glossary-test）
- **新建 `channels/` 目录**：至少一个 `project-dev.channel.md`（modules: [Scene, Manual], layout: hybrid）
- **struct 资产改 Blueprint 格式**：7 个 `*.scene.md`/`*.manual.md` → `*.blueprint.md`，frontmatter 简化（只留 name），内容用 `## Channel`/`## Domains`/`## Trigger`/`## Boundaries`
- **删旧 `blueprints/` 里的 scene/manual 成对文件**，统一成 `*.blueprint.md`
- **验收**：`ls .pt/assets/{domains,channels,blueprints}/` 结构正确
- **commit**：`Phase 7.4: 资产迁移到 v7 格式`

#### 7.5 compile/ 中端（Context 编译 + layout 编排）

`src/compile/context.ts`：

```typescript
// (Blueprint + Channel + Domains) → Context IR
function compileContext(
  blueprint: Blueprint,
  channel: Channel,
  domains: Domain[]
): Context {
  // 1. 按 channel.modules 遍历每个模块名（如 "Scene"/"Manual"）
  // 2. 对每个模块：聚合所有 blueprint.domains 引用的 Domain 的该 H2 段内容
  // 3. 按 channel.layout.mode 编排（byDomain/byType/hybrid）
  //    - hybrid: slot:"global" 的 Rule 抽全局段
  //    - byType: 按 Domain type 聚合
  //    - byDomain: 按引用顺序输出
  // 4. 产 Context IR（modules: Record<h2, markdown>）
  // 5. 算 sourceHash = hash(domains + channel + blueprint)
}
```

- **layout 逻辑从 v6 的 `generateV6Prompt` 抽回中端**——backend 不再做编排，只渲染
- **验收**：compileContext 产出 Context IR，`modules["Scene"]` / `modules["Manual"]` 非空
- **commit**：`Phase 7.5: compile/ 中端 Context 编译`

#### 7.6 render/ 后端（Context → 产物字符串 + 缓存）

`src/render/`：

- `cache.ts`：Context 文件读写 + hash 校验
  - `loadContext(name)`：读 `.pt/contexts/cache/{name}.context.md`，比对 sourceHash，命中返缓存，未命中返 null
  - `saveContext(context)`：写文件（含 sourceHash 头）
- `system-prompt.ts`：`renderSystemPrompt(context)` → 读 `context.modules["Scene"]` → 字符串
- `context-message.ts`：`renderContextMessage(context, args)` → 读 `context.modules["Manual"]` + binder 展开 → 字符串

**链路**（`transpile.ts`）：
```
parse(blueprint.md, channel.md, domain.md*) 
  → compile(blueprint, channel, domains) → Context IR
  → cache.load? 命中 : cache.save(Context) 
  → render.systemPrompt(Context) 注入 before_agent_start
  → render.contextMessage(Context, args) 注入 input 事件
```

- **验收**：`/pt full` 产出 System Prompt，内容与 v6 语义等价
- **commit**：`Phase 7.6: render/ 后端 + 缓存 + 链路打通`

#### 7.7 回归验证 + 扩展性验证

- **四个 Blueprint 回归**：pt/article/risk-check/glossary-test 编译出的 System Prompt 字数与 v6 baseline 一致或语义等价
- **Context 缓存验证**：第二次 `/pt full` 命中缓存（不重编译，读 `.pt/contexts/cache/*.context.md`）
- **Channel 复用验证**：至少 2 个 Blueprint 引用同一 Channel
- **扩展性验证**：glossary 假 type 仍能注册 renderer 并出现在 Context 的 Scene 模块里
- **三 mode 验证**（顺带补 v6 遗留）：加一个 byType 测试 Blueprint，验 byType 路径
- **commit**：`Phase 7.7: 回归 + 扩展性 + 缓存验证`

#### 7.8 文档同步

- `pt-asset-layering.md` §11（转译通道架构）：
  - §11.4 职责表恢复三行（前端/中端/后端）
  - §11.5 文件结构表改 `parse/compile/render`
  - §11.2 编译同构论证保留（v7 更贴合：多前端 + 中端 + 多后端）
- `pt-dev-phases.md`：
  - 接手坐标更新（Phase 7 完成，v7 为当前模型）
  - Phase 依赖图加 Phase 7 节点
  - 全局验收清单加"Context 缓存命中"项
- **commit**：`Phase 7.8: 文档同步`

### 风险

1. **Schema 重写破坏编译**（7.2 后 tsc 暂时不过）。缓解：7.2-7.6 是连续修复链，一气呵成，中间不交付。
2. **layout 逻辑迁移可能丢分支**。缓解：v6 的 byDomain/byType/hybrid 三分支逻辑搬到 compileContext 时，对照 `generateV6Prompt` 逐分支验，7.7 回归兜底。
3. **资产改 H2 是机械大改**。缓解：9 个 Domain 一次性 sed 改，改完 grep 验证无 `## Blueprint` 残留。
4. **Context 缓存 hash 设计不当**。缓解：sourceHash = sha256(domains 内容 + channel 内容 + blueprint 内容) 拼接，文件头记录，命中时跳过 parse+compile 全链路。
5. **Channel 资产新建无真实复用场景**。缓解：让 pt/article/risk-check 三个 Blueprint 都引用同一个 `project-dev.channel.md`，人为制造复用验证。

### 前置依赖

- Phase 5.5 完成（v6 双写已清理，baseline `ffa721e` / `571b45d` / `9fca537` 可回退）。

---


## Phase 依赖图

```
Phase 0 (Schema 契约)
   ↓
Phase 1 (前端反转) ← 产物等价是硬指标
   ↓
Phase 2 (中端+静态后端) ← 静态三层完整
   ↓
Phase 3 (动态手册) ← 需先补 3 处文档模糊点
   ↓
Phase 4 (收尾验证)
   ↓
Phase 5 (模型对齐 v6，双写里程碑) ← baseline ffa721e
   ↓
Phase 5.5 (legacy 清理 + 扩展性验证) ← ✅ 完成 (571b45d + 9fca537)
   ↓
Phase 6 (自举) ← ✅ 跑通，压力测试可继续加
   ↓
Phase 7 (v7 模型重构 Domain→Channel→Blueprint→Context) ← 待执行
```

- **Phase 0 → 1 → 2 串行**（后一个依赖前一个的产物）。
- **Phase 3 前置文档工作可与 Phase 0/1/2 并行**（不阻塞代码推进）。
- **Phase 4 必须在 3 之后**。
- **Phase 5 双写里程碑**：v6 字段与 v3 legacy 并存（baseline `ffa721e`）。
- **Phase 5.5 ✅ 完成**：拆 legacy、midend 退出（选项 B）、blueprintRenderers 移除、扩展性实测通过。Phase 5 真正完成。
- **Phase 6 ✅ 跑通**：自举通过，压力测试偏弱（未 exercised 跨 Domain/1:N/hybrid harder case），可继续加资产加压。
- **Phase 7 ✅ 完成**：v6 升级到 v7 四层模型。src/ 迁移 + 三段式目录（parse/compile/render）+ Schema 重写 + 资产迁移 + Context 缓存 + 文档同步。详见 §Phase 7。

### 后续可选（非阻塞，Phase 7 后）

- Phase 6 加压（pt-* 资产加跨 Domain/1:N/hybrid）
- `ingest/` 前置层（等第一个外部源接入时再加）
- 未来 CLI 选 H2 模块作 `/模块名` 指令（v7 §0.5 备注）

---

## 全局验收清单（每个 Phase 结束都查）

| 项 | 检查方式 |
|---|---|
| `tsc --noEmit` 通过 | `npx tsc --noEmit` |
| 旧功能不回归 | `/pt full` 产物与基线对比（Phase 1 验等价；Phase 2+ 验 mode 产物符合设计） |
| 无死代码 | `tsc` 无 unused 报警，无 re-export 残留 |
| 设计文档与代码一致 | 文档示例 = 实际实现 |
| 失败可回退 | git 能 revert 到上一 Phase 状态 |
| **Context 缓存命中**（v7+） | 第二次 `loadAndTranspile` 返 `cacheHit=true`，segment 一致 |
| **Channel 复用**（v7+） | 至少 2 个 Blueprint 引用同一 Channel（验证复用机制） |
| **三段式叙事成立**（v7+） | `src/{parse,compile,render}/` 三目录都有非占位实现；midend 以 compile/ 恢复 |

---

## 执行者须知

1. **每个 Phase 结束后，运行全局验收清单，自检通过后再交验收。**
2. **Phase 1 的"产物等价"是硬指标**——如果产物不等价，说明映射丢了字段或逻辑，必须修复后才能进 Phase 2。
3. **Phase 3 必须先补文档再写代码**——3 处模糊点没定清楚就写代码会返工。
4. **遇到设计文档没覆盖的情况**，不要自行发挥，记录下来交验收者决策。
5. **OXN asset 的格式约定**参考 `.pt/assets/` 下现有 4 个文件（article-blueprint 等）。
6. **Pi ExtensionAPI 用法**参考 `index.ts` 现有实现 + `pt-plugin-design.md`。

---

## Phase 7 验收记录（2026-08-31，commit `b1e7216` → `47fe44f`）

### 决策落地

| 步骤 | 决策 | 证据 |
|---|---|---|
| **7.1 src/ 迁移** | 完成 | `src/{parse,compile,render,schema,transpile,config,index}.ts` 全部到位；package.json/tsconfig.json 已更新 |
| **7.2 Schema 重写** | 完成 | `src/schema.ts` 含 Domain/Channel/Blueprint/Context 四 IR；grep 无 Struct interface 或 kind: 'scene'/'blueprint' |
| **7.3 parse 拆分** | shared/domain/channel/blueprint 四文件，按目录位置分发载体 | shared.ts 抽公共词法+语法；domain.ts 按 type 分发；channel.ts 解析 ## Modules + ## Layout；blueprint.ts 解析 ## Channel + ## Domains + ## Trigger + ## Boundaries |
| **7.4 资产迁移** | 10 Domain 改 ## Blueprint→## Manual；新建 channels/project-dev.channel.md；7 个 struct 资产合并成 4 个 *.blueprint.md | `ls .pt/assets/{domains,channels,blueprints}/` 结构正确；所有 Blueprint 引用 channel='project-dev' |
| **7.5 compile 中端** | 完成 | `src/compile/context.ts` 实现 compileContext(blueprint, channel, domains) → Context IR；layout 逻辑从 v6 generateV6Prompt 抽回 |
| **7.6 render 后端 + 缓存** | 完成 | `src/render/{system-prompt,context-message,cache}.ts`；Context 物理文件 .pt/contexts/cache/*.context.md + sourceHash 校验；链路 parse→compile→cache→render 打通 |
| **7.7 回归验证** | 完成 | 四 Blueprint 产物字数 vs v6 baseline（语义级）、缓存命中、Channel 复用、glossary 扩展性、三 mode 验证全过 |
| **7.8 文档同步** | 完成 | `pt-asset-layering.md` §11.4 职责表改 v7、§11.5 文件结构改 src/、附录演进表加 v7；`pt-dev-phases.md` 接手坐标更新、Phase 依赖图加 Phase 7、全局验收清单加 Context 缓存命中项 |

### 6 个硬指标验证（v7 完成判据）

| 硬指标 | 结果 | 证据 |
|---|---|---|
| 1. 三段式叙事成立 | ✅ | `src/parse/` (4 文件)、`src/compile/` (2 文件)、`src/render/` (4 文件) 都非占位；midend 以 compile/ 恢复 |
| 2. 命名无碰撞 | ✅ | `grep -E 'Struct\|kind:' src/schema.ts` 无残留；Domain H2 无 `## Blueprint` |
| 4. 产物不回归 | ✅ | pt=1897 (v6=1791, +6%) / article=537 (+16%) / risk-check=597 (+24%) / glossary-test=350 (~0%)。差异源自格式微调（v7 把 workflow-Domain externals 单独成 ### 模块 段；v6 嵌入 flow 首步）—— plan 允许 |
| 4. Channel 可复用 | ✅ | 4 个 Blueprint 全部引用 channel='project-dev' |
| 5. Context 缓存生效 | ✅ | 第二次 loadAndTranspile 返 cacheHit=true，segment 与首次一致；.pt/contexts/cache/<name>.context.md 文件落盘 |
| 6. 扩展性不破坏 | ✅ | glossary 假 type 走 registerDomainSceneRenderer 注册表（与 Phase 5.5.4 设计一致），render 函数 + 一行注册 = 扩展，未动 compile 主循环 |

### 与 Phase 5.5 设计意图的一致性

- **midend 退出反悔**：Phase 5.5 选项 B 选了退出（layout 并入 backend），Phase 7 通过四层模型重构把 midend 拉回为 compile/，layout 编排正式归位。**这是 Phase 5.5 留下的叙事塌陷问题的正式修复**。
- **Renderer 注册制延续**：Phase 5.5.4 建立的 domainSceneRenderers: Record<type, fn> 设计在 v7 保留并扩展（compile/context.ts 内 registerDomainSceneRenderer 接口）。扩展性不破。

### 格式微调 vs 语义等价（v6 → v7 产物差异溯源）

| 差异 | v6 (Phase 5.5) | v7 (Phase 7) | 语义等价 |
|---|---|---|---|
| workflow-Domain externals 渲染 | 嵌入 `### 流程` 首步作"数据：读 `<path>`。"行 | 单独 `### 模块「<wf-domain>」` 段 + `**外部数据**` | ✅（同一信息） |
| tool-Domain 渲染 | `### 工具` 段（在 byDomain/hybrid 下） | 同上 | ✅ |
| §0 语义对应 | §0.4 "可用手册" 列在 Scene 模块下 | 同上 | ✅ |
| v7 Scene 段总长 +76~117 chars vs v6 | — | workflow-Domain 标题占 ~40 chars/段 | 允许（plan: "格式细节（如空行、标题层级）允许微调"） |

---

## Phase 8：v8 模型实现（Channel H2=注入点 + 模块级 Domain 引用 + Compilation）

> **依据**：`docs/pt-asset-layering.md` §0（v8 模型，2026-08-31 定稿）
> **目标**：把 v7 代码（隐式 Modules + render 硬编码 + 粗粒度 Domain 引用）升级为 v8（H2=注入点显式化 + 模块级 Domain 引用 + Context 缓存策略可配置）
> **基线**：commit `8251378`（v8 §0 文档定稿）
> **验证**：`tsc --noEmit` 通过 + `tests/verify/verify-phase77.ts` 全过 + `tests/verify/verify-flows.ts` 全过

### 8.1 资产样板先行（不改代码）

把 pt-dev / pt / glossary-test / dev-knowledge / writing 五份资产从 v7 格式（`## Modules` + `## Layout`）迁到 v8 格式（H2=注入点 + target + `### Modules`）。这一步只改资产不动代码，tsc 仍过。

### 8.2 Schema 重写（破坏性）

`src/schema.ts` 重写为 v8 IR：
- `Channel.injectionPoints: InjectionPointConfig[]`（替代 v7 `modules + layout`）
- `Blueprint.injectionPoints: InjectionPointInstance[]`（替代 v7 `domains + trigger + boundaries`）
- `Blueprint.compilation: CompilationConfig`（新增：cacheDir + split 策略）
- 新增 `InjectionPointConfig` / `InjectionPointInstance` / `CompilationConfig` / `CacheSplitStrategy` 类型

此步预期 tsc 报错，8.6 末必须全过。

### 8.3 parse/ 前端适配 v8 IR

- `src/parse/channel.ts`：每个非特殊 H2（除 v7 残留段 `Modules`/`Layout` 外）解析为 `InjectionPointConfig`，H2 名 = 注入点名。
- `src/parse/blueprint.ts`：每个非特殊 H2（除 `Channel`/`Compilation`/`Domains`/`Trigger`/`Boundaries`）解析为 `InjectionPointInstance`，包含 `### Domains` / `### Trigger` / `### Boundaries` 子段。`## Compilation` 解析为 `CompilationConfig`。
- `src/parse/shared.ts`：新增 `extractFieldValue` / `extractBareListUnderH3` / `extractModulesList` / `extractDomainsList` 辅助函数，处理 v8 H2/H3 嵌套结构。

### 8.4 compile/ 中端重写

- `src/compile/context.ts` 重写为按 Channel.injectionPoints 遍历，每个注入点找 Blueprint 同名 `InjectionPointInstance`，按 `target` 分发（`system_prompt` → `compileSystemPromptModule` / `context_message` → `compileContextMessageModule` / 扩展 → `compileGenericInjectionPoint`）。
- **关键修复**：v7 `compileManualModule` 只处理 workflow-Domain 的 FlowTemplate（`if (d.type !== "workflow") continue` 死代码），v8 修复 term-Domain 的 Manual Rule[] 也能进对话记忆注入点。
- renderer 注册表保留扩展机制（`registerDomainSceneRenderer`）。

### 8.5 render/ 后端通用化

- `src/render/system-prompt.ts`：不再硬编码 `ctx.modules["Scene"]`，改为遍历 `channel.injectionPoints` 聚合所有 `target=system_prompt` 的注入点内容。签名加 `channel` 参数。
- `src/render/context-message.ts`：`renderContextMessage` 加 `channel` 参数，`findFlowInBundle` 改为遍历 `blueprint.injectionPoints[target=context_message].domains`。
- `src/render/cache.ts`：缓存目录从 `Blueprint.compilation.cacheDir` 读（替代 v7 硬编码 `.pt/contexts/cache`）。`by-injection-point` 拆分策略留 TODO，本步只实现 `single-file`。

### 8.6 index.ts 注入逻辑适配 + 全链路打通

- `src/index.ts`：`/pt flows` 子命令改为遍历 `blueprint.injectionPoints[target=context_message].domains`，提示文案从"Scene/Manual"改为"会话知识/对话记忆"注入点语义。
- `tests/verify/verify-flows.ts`：同步改用 v8 `injectionPoints` 遍历，加 `Set` 去重避免同一 workflow-Domain 在多注入点下重复列出。

### 8.7 资产迁移 + pt-quality Domain 落地

- 新增 `.pt/assets/domains/pt-quality.md`（type: term，`## Manual` 段含 9 条技术规范 Rule[]，slot:global, type:invariant）。
- pt-dev Blueprint 的 `## 对话记忆` 注入点 `### Domains` 加 `- pt-quality`。

### 8.8 回归 + 文档同步

- `tests/verify/verify-phase77.ts`：扩展为 8 项断言（含 H2=会话知识/对话记忆、pt-quality 进对话记忆、三 mode 验证等）。
- `docs/pt-dev-phases.md`：加 Phase 8 章节，更新"接手坐标"为 v8。

### v7 → v8 关键变化（来自 `pt-asset-layering.md` §0.9）

1. **Channel H2 = 注入点**（显式化）：`## Modules` 列表 → `## 会话知识` / `## 对话记忆` H2，target 字段映射 Pi 注入位置。
2. **Blueprint 按注入点选 Domain**（模块级引用）：`## Domains` 全量列表 → 每个注入点下 `### Domains` 分别列。
3. **Trigger/Boundaries 在注入点下**：Blueprint 顶级字段 → 注入点 H2 下的 `### Trigger` / `### Boundaries`。
4. **Blueprint 管编译方式**：硬编码 `cache.ts` 缓存目录 → `## Compilation` 段配置 cacheDir + split。
5. **Pt 定位重定义**：多来源转译器 → 异构上下文编译器，核心产物是 Context。

### 8 项硬指标验收

| 指标 | v8 验收 |
|---|---|
| 三段式叙事 | `src/{parse,compile,render}/` 都有 v8 实现 |
| 无命名碰撞 | `Channel.injectionPoints` 替代 `modules/layout`；`Blueprint.injectionPoints` 替代 `domains/trigger/boundaries`；`Blueprint.compilation` 新增 |
| 产物无回归 | pt=约 3594 chars / pt-dev 含 pt-quality 规范 / 字符数允许变但结构对齐 v7 |
| Channel 复用 | dev-knowledge 仍被 pt + glossary-test 引用 |
| Context 缓存 | cacheHit=true，segment 一致 |
| 扩展性 | glossary renderer 仍注册，glossary-test Blueprint 仍工作 |
| v8 H2 | Context 文件 H2=会话知识/对话记忆（无 Scene/Manual 残留） |
| pt-quality | 进 pt-dev 对话记忆注入点，不污染会话知识 |

---

## Phase 9：v9 模型实现（Blueprint 吸收 Channel + Profile 业务实例 + AgentAdapter + modName 驱动 + Trigger 索引）

> **依据**：`docs/pt-asset-layering.md` §0（v9 四层模型，2026-09-01 定稿）
> **目标**：把 v8 代码（Channel H2=注入点 + Blueprint 选 Domain + 硬编码 Pi API）升级为 v9（Blueprint=Agent 端结构 + Profile=业务端实例 + AgentAdapter 抽象 + modName 驱动 + Trigger 索引 + 参考手册触发）
> **基线**：commit `7028a0f`（v9 §0 文档定稿，代码还是 v8）
> **执行描述**：`docs/pt-dev-phases-v9.md`
> **状态**：✅ 已完成（9.1-9.9 9 个 commit + pt-writing 跨项目同步）

### v8 → v9 核心变化

1. **职责重分配**：v8 Channel（结构层）→ v9 Blueprint（Agent 端结构）；v8 Blueprint（配置层）→ v9 Profile（业务端实例）
2. **Channel 保留为未来 Connector**：Domain 连接外部知识源（当前未实现）
3. **Trigger 段移到 Domain H2**：v9 索引段，告知 LLM 何时查本 Domain 手册
4. **Boundaries 丢弃**：Trigger 索引 + Scene axioms 替代流程 DAG
5. **聚合点数据驱动**：Blueprint.### Modules 是 modName 列表，compile 按 moduleRenderers[modName] 注册表分发 + generic fallback
6. **Profile Domains 自动分发**：YAML 全局 domains + 注入点追加 domains
7. **注入点名人类自定义**：Blueprint H2 任意语义名，target 字段映射 Agent 技术注入点
8. **AgentAdapter 抽象**：Blueprint 声明用哪个 Agent（默认 pi），Pt 调 Adapter 接口注入
9. **"对话记忆" → "参考手册"** 改名
11. **新增 me Domain**：会话知识补"我"视角（user-profile / pt-goal / collab-mode）

### v9 资产结构

```
.pt/assets/
├── domains/        # Domain（加 ## Trigger 段 + 新增 me Domain）
│   ├── pt-concepts.md      # 描述迁 v9（Channel→Blueprint/Profile）
│   ├── pt-architecture.md # moduleRenderers 注册表描述
│   ├── pt-transpile.md    # 含 ## Trigger + Profile 转译步骤
│   ├── pt-stack.md
│   ├── pt-dev-flow.md     # 加 Trigger 段
│   ├── pt-collab.md       # 加 Trigger 段
│   ├── pt-quality.md      # 加 Trigger 段
│   ├── glossary-test.md
│   └── me.md              # 新增
├── blueprints/     # Blueprint（v9 结构层）
│   └── dev-knowledge.blueprint.md   # 合并 v8 dev-knowledge + pt-dev channel
└── profiles/       # Profile（v9 配置层）
    ├── pt.profile.md
    ├── pt-dev.profile.md
    └── glossary-test.profile.md
```

### v9 代码结构

```
pt/src/
├── schema.ts              # v9 IR: Blueprint(agent+injectionPoints+compilation) + Profile(blueprint+domains+injectionPoints) + AgentAdapter + Context
├── transpile.ts           # parse → compile → cache → render 链路（Profile 驱动）
├── config.ts              # listProfiles（读 profiles/*.profile.md）
├── index.ts               # Pi 入口（session_start + /pt-context + /pt，注入用 AgentAdapter）
├── parse/                 # 前端
│   ├── shared.ts          # inferKind 用 frontmatter（不用注入点名）
│   ├── domain.ts          # Domain H2 段开放（Trigger 走 default fallback）
│   ├── blueprint.ts       # Blueprint(agent + injectionPoints + Compilation)
│   ├── profile.ts         # Profile(blueprint + domains + injectionPoints) — 新增
│   └── index.ts           # oxnAdapter.load（枚举 profiles/）
├── compile/               # 中端
│   └── context.ts         # compileContext(profile, blueprint, domains) + moduleRenderers[modName] + resolveDomains + renderTriggerModule + renderGenericModule
├── render/                # 后端
│   ├── system-prompt.ts   # renderSystemPrompt(ctx, blueprint) — 遍历 blueprint.injectionPoints
│   ├── context-message.ts # renderContextMessage(ctx, blueprint, domains, args) — /manual:xxx 触发 + /<flow-name> 展开
│   ├── cache.ts           # cache 读 blueprint.compilation
│   └── index.ts
└── agent/                 # Agent 适配器 — 新增
    ├── pi-adapter.ts      # PiAdapter（封装 pi.on before_agent_start / input）
    └── registry.ts        # agentAdapter 注册表
```

### 6 项硬指标验收（v9）

| 指标 | v9 验收 |
|---|---|
| 三段式叙事 | src/{parse,compile,render,agent}/ 都有 v9 实现 |
| 无命名碰撞 | schema.ts 无 v8 Channel 类型（删除）、无 v8 Blueprint.domains/trigger/boundaries |
| 产物无回归 | pt=3165 chars / pt-dev=3642 chars / glossary-test=208 chars；结构对齐 v8（会话知识/参考手册 H2） |
| Blueprint 复用 | dev-knowledge Blueprint 被 pt + pt-dev + glossary-test 三个 Profile 引用 |
| Context 缓存 | cacheHit=true，segment 一致 |
| 扩展性 | modName 注册表 + generic fallback；加新聚合标题（### Modules 加项）不改代码；listManuals Profile 范围过滤 |

### v9 验证脚本

- `tests/verify/verify-phase9.ts`：16 节 35+ 项断言（替代 v8 verify-phase77.ts）
- `tests/verify/verify-flows.ts`：v9 适配——用 activeAdapter.listManuals() + Profile 范围过滤
