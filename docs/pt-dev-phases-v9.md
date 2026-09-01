# Phase 9：v9 模型实现执行描述

> **依据**：`docs/pt-asset-layering.md` §0（v9 模型，2026-09-01 定稿）
> **目标**：把 v8 代码（Channel H2=注入点 + Blueprint 选 Domain + 硬编码 Pi API）升级为 v9（Blueprint=Agent 端结构 + Profile=业务端实例 + AgentAdapter 抽象 + 聚合点 modName 数据驱动 + Trigger 索引 + 参考手册触发注入）
> **基线**：commit `7028a0f`（v9 §0 文档定稿，代码还是 v8）
> **验证**：`tsc --noEmit` 通过 + `tests/verify/verify-phase9.ts` 全过 + `tests/verify/verify-flows.ts` 全过

---

## 执行者须知

本任务由执行者按子步顺序完成，每步一个 commit。执行者必须：

1. **按顺序执行**：9.1→9.2→9.3→9.4→9.5→9.6→9.7→9.8→9.9，不可跳步。Schema（9.2）会破坏全链路，后续 9.3-9.7 是连续修复链。
2. **每步 commit**：commit message 用 `Phase 9.X: ...` 前缀，附本步改动摘要。
3. **每步验证**：改完跑 `tsc --noEmit`，能跑通才 commit。Schema 步（9.2）允许 tsc 暂时不过（预期破坏），但 9.7 结束时必须全过。
4. **不改动 docs/§1-§11**：历史章节保留，§0 已定稿（本次不动）。
5. **资产迁移用脚本批量 + 手动校验**：路径替换后 grep 确认零残留。
6. **遇到歧义按 §0 文档为准**：本文档是执行描述，语义基准在 `pt-asset-layering.md` §0。
7. **"对话记忆"→"参考手册"全局替换**：资产 H2、代码注释、verify 脚本、提示文案全改。技术名 `context_message` 不改。

---

## v8 → v9 核心映射（执行者必读）

v9 的资产目录结构变化：

```
v8 资产:                          v9 资产:
.pt/assets/                       .pt/assets/
├── domains/    (不变)             ├── domains/    (加 ## Trigger 段 + me Domain)
├── channels/   (删除)             ├── blueprints/ (v8 channel 内容 + agent + Compilation)
└── blueprints/ (改名 profiles/)   └── profiles/   (v8 blueprint 的 Domains 选择部分)
```

**三向拆并**：
- v8 `channels/*.md`（注入点结构 target/Modules）+ v8 `blueprints/*.md` 的 `## Compilation` → v9 `blueprints/*.md`（加 `agent` 字段）
- v8 `blueprints/*.md` 的 `## <注入点> ### Domains` → v9 `profiles/*.md`（加 YAML `blueprint` + `domains` 全局）
- v8 `blueprints/*.md` 的 `### Trigger` + `### Boundaries` → **丢弃**（Trigger 移到 Domain H2 段，Boundaries 删除）

v8 的两个 Channel（`dev-knowledge` + `pt-dev`）结构完全相同（会话知识+对话记忆，target/modules 一样），v9 合并为一个 `dev-knowledge` Blueprint。

---

## 9.1 资产样板先行（不改代码）

**目的**：先把 pt-dev 的 Blueprint + Profile + Domain 改成 v9 格式，作为后续代码改动的参照样板。

**改动**：

### 9.1.1 新增 `.pt/assets/blueprints/dev-knowledge.blueprint.md`

v8 的 `channels/dev-knowledge.channel.md` + `channels/pt-dev.channel.md` 合并（两者结构相同），加 `agent` 字段 + `## Compilation`（从 v8 blueprint 搬来）+ Modules 加 `Trigger` + 对话记忆→参考手册：

```markdown
---
name: dev-knowledge
agent: pi
---

# dev-knowledge (blueprint)

## 会话知识
target: system_prompt
mode: hybrid
### Modules
- Scene
- Trigger

## 参考手册
target: context_message
### Modules
- Manual

## Compilation
cache-dir: .pt/contexts/cache/
split: single-file
```

### 9.1.2 新增 `.pt/assets/profiles/pt-dev.profile.md`

v8 `blueprints/pt-dev.blueprint.md` 的 Domains 选择部分，加 YAML `blueprint` + 全局 `domains`：

```markdown
---
name: pt-dev
blueprint: dev-knowledge
domains: [pt-architecture, pt-stack, pt-concepts]
---

# pt-dev (profile)

## 会话知识
### Domains
- pt-quality
- pt-collab

## 参考手册
### Domains
- pt-dev-flow
- pt-collab
- pt-quality
```

**注意**：v8 Blueprint 的 `### Trigger` + `### Boundaries` **丢弃**——Trigger 移到 Domain（9.1.4），Boundaries 删除。

### 9.1.3 新增 `.pt/assets/profiles/pt.profile.md` + `glossary-test.profile.md`

同 9.1.2 方式，从 v8 `blueprints/pt.blueprint.md` + `glossary-test.blueprint.md` 转换。

pt profile：
```markdown
---
name: pt
blueprint: dev-knowledge
domains: [pt-concepts, pt-architecture, pt-transpile, pt-stack]
---
## 参考手册
### Domains
- pt-transpile
```

glossary-test profile：
```markdown
---
name: glossary-test
blueprint: dev-knowledge
domains: [glossary-test]
---
```

### 9.1.4 给 pt-quality + pt-collab Domain 加 `## Trigger` 段

pt-quality Domain 加 Trigger 段（索引——告诉 LLM 何时查本 Domain 的手册）：

```markdown
## Trigger
### pt-quality-trigger
- desc: 改 Pt 代码时参考；含 9 条技术规范（modules-type-safety 等）
- hint: /manual:pt-quality 查看完整规范
```

pt-collab Domain 加 Trigger 段：
```markdown
## Trigger
### pt-collab-trigger
- desc: 派任务/验收时参考；含任务描述/进度报告/验收/baseline 规范
- hint: /manual:pt-collab 查看完整规范
```

### 9.1.5 "对话记忆" → "参考手册" 全局替换

所有资产的 `## 对话记忆` → `## 参考手册`。v8 代码此时读不了新资产名，但 9.1 不改代码——这是预期的。

**验证**：此步不改代码，tsc 仍过（v8 代码编译旧资产，但资产已变——v8 代码此时跑会失败，但 tsc 不跑代码只查类型）。资产改完后手动读一遍确认格式正确。

**commit**：`Phase 9.1: 资产样板先行 — pt-dev Blueprint/Profile + Trigger 段 + 参考手册改名`

---

## 9.2 Schema 重写（破坏性，预期 tsc 暂时不过）

**目的**：定义 v9 IR 类型，跟 v8 不兼容。这是破坏点，后续 9.3-9.7 修复全链路。

**改动 `src/schema.ts`**：

### 9.2.1 新增 `AgentAdapter` 接口 + `AgentAPI` 类型

```typescript
/** Agent 注入 API 的最小接口（AgentAdapter 用，不直接依赖 Pi ExtensionAPI）。 */
export interface AgentAPI {
  on(event: string, handler: (...args: unknown[]) => unknown): void;
  registerCommand(name: string, spec: unknown): void;
  registerFlag(name: string, spec: unknown): void;
  getFlag(name: string): unknown;
}

/** Agent 适配器——适配不同 Agent 的注入机制。
 *  Pt 核心调 Adapter 接口，不直接调 Agent API。加新 Agent 只加 Adapter。 */
export interface AgentAdapter {
  /** Agent 名（pi / codex / opencode / ...） */
  name: string;
  /** 该 Agent 支持的技术注入点 target 名（Pi: system_prompt, context_message） */
  supportedTargets: string[];
  /** 启动时注册：把 Context 注入到 Agent（session_start 调用） */
  registerInject(api: AgentAPI, ctx: Context, blueprint: Blueprint): void;
  /** 轮次级触发：参考手册注入（/manual:xxx 调用） */
  triggerManual?(ctx: Context, blueprint: Blueprint, domains: Domain[], name: string, args: string): string | null;
  /** 查询可用手册（/pt flows 用） */
  listManuals?(ctx: Context, blueprint: Blueprint, domains: Domain[]): Array<{ name: string; hint?: string; domain: string }>;
}
```

### 9.2.2 改 `Blueprint` IR（吸收 v8 Channel + 加 agent）

```typescript
/** v9 Blueprint：Agent 端注入点结构，结构层模块。
 *  - agent：声明用哪个 AgentAdapter（默认 "pi"）。
 *  - injectionPoints：注入点列表（H2=注入点，人类自定义名），含 target + Modules + mode。
 *  - compilation：编译方式（缓存目录 + 拆分策略）。
 *  跨项目复用。 */
export interface Blueprint {
  name: string;
  /** 声明用哪个 AgentAdapter（默认 "pi"）。 */
  agent: string;
  /** 注入点列表（H2=注入点），定义 target + Modules 聚合点 + mode。 */
  injectionPoints: InjectionPointConfig[];
  /** 编译方式（缓存目录 + 拆分策略）。 */
  compilation: CompilationConfig;
}
```

**v8 `Channel` 接口删除**（或保留为空 stub 注释"预留 Connector"）。`InjectionPointConfig` 从 Channel 拥有变为 Blueprint 拥有（字段不变，注释更新）。

### 9.2.3 新增 `Profile` IR（替代 v8 Blueprint 的配置角色）

```typescript
/** v9 Profile：业务端实例，配置层模块。
 *  - blueprint：引用哪个 Blueprint（结构复用）。
 *  - domains：YAML 全局 Domain 列表，自动分发到所有注入点（有匹配 H2 段则贡献）。
 *  - injectionPoints：注入点实例化（H2 = 注入点名，与 Blueprint 同名），其下 ### Domains 是追加列表。
 *  项目级，不跨项目复用。 */
export interface Profile {
  name: string;
  /** 引用的 Blueprint 名（结构复用）。 */
  blueprint: string;
  /** 全局 Domain 列表，自动分发到所有注入点。 */
  domains: string[];
  /** 注入点实例化（与 Blueprint 的 InjectionPointConfig 同名）。 */
  injectionPoints: InjectionPointInstance[];
}

/** v9 InjectionPointInstance：只保留 domains（drop trigger/boundaries）。 */
export interface InjectionPointInstance {
  /** 注入点名（与 Blueprint 的 InjectionPointConfig.name 对应）。 */
  name: string;
  /** 追加到本注入点的 Domain 列表（只贡献该注入点）。 */
  domains: string[];
}
```

**v8 `InjectionPointInstance` 的 `trigger` + `boundaries` 字段删除**。`BoundaryNode` 类型保留（Channel 预留层未来可能用，且 glossary-test 扩展可能用——但 v9 不强制）。

### 9.2.4 改 `SchemaBundle`

```typescript
export interface SchemaBundle {
  domains: Domain[];
  blueprints: Blueprint[];
  profiles: Profile[];
  /** 当前激活的 Profile 名。 */
  activeProfile: string;
}
```

`channels` 字段删除，`blueprints` 语义变（v8 配置层 → v9 结构层），新增 `profiles`，`activeBlueprint` → `activeProfile`。

### 9.2.5 改 `SourceAdapter`

```typescript
export interface SourceAdapter {
  name: string;
  load(cwd: string, profileName: string): Promise<SchemaBundle>;
}
```

参数 `blueprintName` → `profileName`（用户面是 Profile）。

### 9.2.6 保留不变的类型

Domain、Domain Type、Term、Rule、FlowTemplate、FlowStep、ExternalRef、ToolRef、StructureLayout、InjectionTarget、InjectionPointConfig、CompilationConfig、CacheSplitStrategy、Context——这些都不变。Context.modules 的 key 仍是注入点名（语义名），结构不变。

### 9.2.7 删除 `findChannel` 辅助函数

`findChannel` 不再需要（Channel 删除）。`findBlueprint` 保留。新增 `findProfile`：

```typescript
export function findProfile(profiles: Profile[], name: string): Profile | undefined {
  return profiles.find((p) => p.name === name);
}
```

**验证**：tsc 此时会报大量错误（parse/compile/render/index 全引用旧字段），**这是预期的**。不要在此步修代码，直接 commit。

**commit**：`Phase 9.2: Schema 重写为 v9 IR — Blueprint 吸收 Channel + 新增 Profile + AgentAdapter 接口`

---

## 9.3 parse/ 前端适配 v9 IR

**目的**：parse/blueprint.ts + 新增 parse/profile.ts + 改 parse/shared.ts + 改 parse/index.ts。

**改动 `src/parse/shared.ts`**：

`inferKind` 不再用注入点名正则判断文件类型——改用 frontmatter 字段：

```typescript
function inferKind(fm: Record<string, unknown>, body: string): AssetKind {
  // v9：用 frontmatter 字段判断，不用注入点名（注入点名是人类自定义的）
  if (typeof fm.blueprint === "string") return "profile";        // Profile 有 blueprint 字段
  if (typeof fm.agent === "string") return "blueprint";           // Blueprint 有 agent 字段
  if (typeof fm.type === "string") return "domain";               // Domain 有 type 字段
  // fallback：body 特征
  if (/^##\s+Compilation\b/m.test(body)) return "blueprint";      // Blueprint 有 Compilation 段
  if (/^##\s+Slots\b/m.test(body)) return "workflow";
  if (/^##\s+Tools\b/m.test(body)) return "stack";
  return "domain";
}
```

**注意**：`readAsset` 当前不传 fm 给 inferKind——改签名让 inferKind 接收 frontmatter。或者直接在 readAsset 里先解析 fm 再 inferKind。

**改动 `src/parse/blueprint.ts`**：

解析 v9 Blueprint（agent + injectionPoints + Compilation）。v8 的 `## Channel` 段删除（Blueprint 不再引用 Channel，自己就是结构层）。v8 的 `### Trigger` + `### Boundaries` 不再解析（已删除）。

```typescript
export async function parseBlueprint(cwd: string, fileName: string): Promise<Blueprint> {
  const asset = await readAsset(join(cwd, ".pt/assets/blueprints", fileName));
  
  const agent = typeof asset.frontmatter.agent === "string" ? asset.frontmatter.agent : "pi";
  
  // injectionPoints：每个非特殊 H2 = 一个注入点（target + mode + ### Modules）
  const injectionPoints: InjectionPointConfig[] = [];
  for (const [h2Name, section] of Object.entries(asset.sections)) {
    if (h2Name === "Compilation") continue;
    injectionPoints.push(parseInjectionPointConfig(h2Name, section));
  }
  
  const compilation = parseCompilationFromSection(asset.sections["Compilation"]);
  return { name: stripBlueprintSuffix(asset.name), agent, injectionPoints, compilation };
}
```

`parseInjectionPointConfig` 逻辑跟 v8 `parse/channel.ts` 的 `parseInjectionPointFromSection` 一样（读 target/mode/### Modules），只是搬到这里。

**改动 `src/parse/channel.ts`**：删除文件（或改为空 stub + 注释"v9 Channel 预留 Connector，未来实现"）。

**新增 `src/parse/profile.ts`**：

```typescript
/** 读 profiles/<fileName>.md → Profile { name, blueprint, domains, injectionPoints } */
export async function parseProfile(cwd: string, fileName: string): Promise<Profile> {
  const asset = await readAsset(join(cwd, ".pt/assets/profiles", fileName));
  
  const blueprint = typeof asset.frontmatter.blueprint === "string" ? asset.frontmatter.blueprint : "";
  const domains = sArr(asset.frontmatter.domains);  // YAML 全局 domains
  
  // injectionPoints：每个 H2 = 注入点实例化（只读 ### Domains 追加列表）
  const injectionPoints: InjectionPointInstance[] = [];
  for (const [h2Name, section] of Object.entries(asset.sections)) {
    const appendDomains = extractDomainsList(section);
    injectionPoints.push({ name: h2Name, domains: appendDomains });
  }
  
  return { name: stripProfileSuffix(asset.name), blueprint, domains, injectionPoints };
}
```

**改动 `src/parse/index.ts`**：

`oxnAdapter.load` 改为枚举 `profiles/` 而非 `blueprints/`（用户面是 Profile）。`loadAllChannels` 删除，新增 `loadAllProfiles`：

```typescript
async load(cwd, profileName): Promise<SchemaBundle> {
  const domains = await loadAllDomains(cwd);
  const blueprints = await loadAllBlueprints(cwd);   // 结构层
  const profiles = await loadAllProfiles(cwd);        // 配置层（新增）
  const active = findProfile(profiles, profileName);
  // ... 返回 { domains, blueprints, profiles, activeProfile }
}
```

**改动 `src/parse/domain.ts`**：

Domain 的 H2 段解析不变（H2 已开放，`## Trigger` 会走 `default` 分支用 `toTerms` fallback 解析）。但确认 Trigger 段的 H3 + `- desc` / `- hint` 能被 `toTerms` 正确解析为 `Term[]`（name + desc）。如果 hint 字段需要保留，可以扩展 `toTerms` 或用 generic fallback。

**验证**：parse 模块独立可测——写临时脚本验证 parseBlueprint/parseProfile 能正确解析 9.1 的样板资产。tsc 此时 compile/render/index 还报错，预期。

**commit**：`Phase 9.3: parse/ 适配 v9 IR — Blueprint 吸收 Channel 结构 + 新增 Profile 解析 + inferKind 用 frontmatter`

---

## 9.4 compile/ 中端重写（核心改动）

**目的**：compileContext 按 v9 IR 编译——Profile 提供选定的 Domains，Blueprint 提供注入点结构，modName 驱动聚合。

**改动 `src/compile/context.ts`**：

### 9.4.1 compileContext 主函数重写

```typescript
export function compileContext(
  profile: Profile,
  blueprint: Blueprint,
  domains: Domain[],
): Context {
  const domainByName = new Map(domains.map((d) => [d.name, d]));
  const modules: Record<string, string> = {};
  
  for (const ipConfig of blueprint.injectionPoints) {
    // 找 Profile 对应的注入点实例化（同名）
    const ipInstance = profile.injectionPoints.find((i) => i.name === ipConfig.name);
    
    // v9 Domains 分发：全局 domains + 注入点追加，按 Blueprint Modules 过滤
    const refDomains = resolveDomains(profile, ipInstance, ipConfig, domainByName);
    
    modules[ipConfig.name] = dispatchInjectionPoint(ipInstance, ipConfig, refDomains, blueprint);
  }
  
  const sourceHash = computeSourceHash(profile, blueprint, domains);
  return { name: profile.name, sourceHash, modules };
}
```

### 9.4.2 新增 `resolveDomains`（Domains 自动分发）

```typescript
/** v9 Domains 分发：全局 domains + 注入点追加，按 Blueprint Modules 过滤。
 *  规则：Domain 有该注入点 Modules 列出的 H2 段 → 贡献；没有 → 跳过。 */
function resolveDomains(
  profile: Profile,
  ipInstance: InjectionPointInstance | undefined,
  ipConfig: InjectionPointConfig,
  domainByName: Map<string, Domain>,
): Domain[] {
  // 合并：全局 domains + 注入点追加（去重，保序）
  const allNames = [...profile.domains];
  if (ipInstance) {
    for (const dn of ipInstance.domains) {
      if (!allNames.includes(dn)) allNames.push(dn);
    }
  }
  
  // 过滤：Domain 有该注入点 Modules 列出的任一 H2 段才贡献
  return allNames
    .map((n) => domainByName.get(n))
    .filter((d): d is Domain => !!d)
    .filter((d) => ipConfig.modules.some((m) => d.modules[m] !== undefined));
}
```

### 9.4.3 `dispatchInjectionPoint` 改为 modName 驱动

v8 按 target 分发（`if (target === "system_prompt")`）。v9 按 **modName 驱动聚合**，target 只决定注入位置（由 AgentAdapter 处理，compile 不判断 target）：

```typescript
function dispatchInjectionPoint(
  _ipInstance: InjectionPointInstance | undefined,
  ipConfig: InjectionPointConfig,
  refDomains: Domain[],
  _blueprint: Blueprint,
): string {
  const parts: string[] = [];
  
  // 遍历 Blueprint.Modules 列出的聚合标题
  for (const modName of ipConfig.modules) {
    const renderer = moduleRenderers[modName] ?? renderGenericModule;
    const modParts: string[] = [];
    for (const d of refDomains) {
      const content = d.modules[modName];
      if (content === undefined) continue;
      const rendered = renderer(d, content, ipConfig.mode);
      if (rendered) modParts.push(rendered);
    }
    if (modParts.length > 0) parts.push(modParts.join("\n\n"));
  }
  
  return parts.join("\n\n");
}
```

### 9.4.4 `moduleRenderers` 注册表（替代 `domainSceneRenderers`）

v8 按 type 分发（`domainSceneRenderers[type]`），内部 modName 硬编码。v9 按 **modName 分发**，renderer 内部按 type 特化：

```typescript
type ModuleRenderer = (d: Domain, content: unknown, mode?: string) => string;

const moduleRenderers: Record<string, ModuleRenderer> = {
  Scene: renderSceneModule,
  Trigger: renderTriggerModule,
  Manual: renderManualModule,
};

export function registerModuleRenderer(modName: string, fn: ModuleRenderer): void {
  moduleRenderers[modName] = fn;
}
```

### 9.4.5 `renderSceneModule`（原 `renderTermSceneSection` 等 type 分发的合并）

renderer 内部按 type 特化取内容格式：

```typescript
function renderSceneModule(d: Domain, content: unknown, _mode?: string): string {
  const lines: string[] = [`### 模块「${d.name}」`];
  switch (d.type) {
    case "term": {
      const terms = (content as Term[]) ?? [];
      if (terms.length > 0) {
        lines.push("", "**术语**");
        for (const t of terms) {
          lines.push(t.desc ? `- **${t.name}**：${t.desc}` : `- **${t.name}**`);
        }
      }
      break;
    }
    case "workflow": {
      const scene = content as { externals?: ExternalRef[] };
      const exts = scene?.externals ?? [];
      if (exts.length > 0) {
        lines.push("", "**外部数据**");
        for (const ext of exts) lines.push(`- ${ext.name}：\`${ext.path}\``);
      }
      break;
    }
    case "stack": {
      // stack 的 tools 在聚合段输出，不进 section
      return "";
    }
    default:
      return renderGenericModule(d, content);
  }
  return lines.join("\n").trimEnd();
}
```

### 9.4.6 新增 `renderTriggerModule`（索引聚合）

```typescript
/** 渲染 Trigger 段——聚合成索引，告诉 LLM 有什么手册可查。 */
function renderTriggerModule(d: Domain, content: unknown): string {
  const items = (content as Array<{ name: string; desc?: string; hint?: string }>) ?? [];
  if (items.length === 0) return "";
  const lines: string[] = [];
  for (const t of items) {
    if (t.desc) lines.push(`- **${t.name}**：${t.desc}`);
    else lines.push(`- **${t.name}**`);
    if (t.hint) lines.push(`  ${t.hint}`);
  }
  return lines.join("\n");
}
```

**注意**：Trigger 段聚合时不加 `### 模块「xxx」` 标题——Trigger 是索引段，所有 Domain 的 Trigger 项合并成一个列表。如果需要区分来源，可以在每项后加 `（来自：${d.name}）`。

### 9.4.7 `renderManualModule`（原 `compileContextMessageModule` 逻辑搬入）

```typescript
function renderManualModule(d: Domain, content: unknown): string {
  const lines: string[] = [`### 模块「${d.name}」`, ""];
  switch (d.type) {
    case "workflow": {
      const tpls = (content as FlowTemplate[]) ?? [];
      for (const t of tpls) {
        const hint = t.argumentHint ? ` ${t.argumentHint}` : "";
        lines.push(`- **/${t.name}**${hint}`);
      }
      break;
    }
    case "term": {
      const rules = (content as Rule[]) ?? [];
      for (const r of rules) {
        if (r.type === "invariant") lines.push(`- [ ] ${r.check}`);
        else if (r.type === "ban" && r.items) lines.push(`- [ ] ${r.check}：${r.items.join(" / ")}`);
      }
      break;
    }
    default:
      return renderGenericModule(d, content);
  }
  return lines.join("\n").trimEnd();
}
```

### 9.4.8 `renderGenericModule`（fallback）

```typescript
/** generic fallback：原样输出 H3 标题 + 列表项，不解析内容格式。
 *  加新聚合标题（如 ## Glossary）不用注册 renderer，自动用 fallback 聚合。 */
function renderGenericModule(_d: Domain, content: unknown): string {
  if (!Array.isArray(content)) return "";
  const lines: string[] = [];
  for (const item of content) {
    if (item && typeof item === "object" && "name" in item) {
      const t = item as { name: string; desc?: string };
      if (t.desc) lines.push(`- **${t.name}**：${t.desc}`);
      else lines.push(`- **${t.name}**`);
    }
  }
  return lines.join("\n");
}
```

### 9.4.9 删除 v8 的 `compileSystemPromptModule` / `compileContextMessageModule` / `compileGenericInjectionPoint` / `compileFlow` / `domainSceneRenderers` / `renderTermSceneSection` 等

这些被 `dispatchInjectionPoint` + `moduleRenderers` + `renderSceneModule` 等替代。`compileFlow`（Boundaries DAG）删除——Boundaries 丢弃。`renderGlobalRules` / `renderAggregatedTerms` 等辅助函数：如果 `renderSceneModule` 的 hybrid mode 需要全局约束段，保留 `renderGlobalRules` 但从 `renderSceneModule` 内部调用（不再从主函数调）。

### 9.4.10 `computeSourceHash` 改签名

```typescript
export function computeSourceHash(
  profile: Profile,
  blueprint: Blueprint,
  domains: Domain[],
): string {
  // hash 逻辑不变，输入对象形状变了
}
```

**验证**：compile 模块独立可测——临时脚本验证 compileContext(profile, blueprint, domains) 能产出 v9 Context。tsc 此时 render/index 还报错，预期。

**commit**：`Phase 9.4: compile/ 重写 — modName 注册表 + Domains 自动分发 + Trigger 索引 + generic fallback`

---

## 9.5 render/ 后端通用化 + 参考手册触发注入

**目的**：render 按 Blueprint.injectionPoints 的 target 分发（不硬编码注入点名）+ 修复 `renderContextMessage` 死代码（实现 `/manual:xxx` 触发）。

**改动 `src/render/system-prompt.ts`**：

```typescript
/** 渲染 System Prompt：聚合所有 target=system_prompt 的注入点内容。
 *  v9：遍历 Blueprint.injectionPoints（不再 Channel.injectionPoints）。 */
export function renderSystemPrompt(ctx: Context, blueprint: Blueprint): string {
  const parts: string[] = [];
  for (const ip of blueprint.injectionPoints) {
    if (ip.target === "system_prompt") {
      const content = ctx.modules[ip.name];
      if (content) parts.push(content);
    }
  }
  return parts.join("\n\n");
}
```

签名从 `(ctx, channel)` → `(ctx, blueprint)`。

**改动 `src/render/context-message.ts`**：

修复死代码——`renderContextMessage` 不再返回 `null`，实现 `/manual:xxx` 触发：

```typescript
/**
 * v9：触发参考手册注入。
 *  - /manual:<domain-name>：注入该 Domain 的 Manual 段内容（term→Rule[] checklist / workflow→FlowTemplate 列表）
 *  - /<flow-name> <args>：展开 workflow-Domain 的 FlowTemplate（v8 逻辑保留）
 */
export function renderContextMessage(
  ctx: Context,
  blueprint: Blueprint,
  domains: Domain[],
  args: string,
): string | null {
  const m = args.trim().match(/^\/(\S+)\s*(.*)$/);
  if (!m) return null;
  const [, name, rest] = m;

  // /manual:<domain-name> 触发
  if (name === "manual") {
    const domainName = rest.trim();
    const d = domains.find((x) => x.name === domainName);
    if (!d) return null;
    const manual = d.modules["Manual"];
    if (!manual) return null;
    // 复用 renderManualModule 逻辑（或直接调）
    return renderDomainManual(d, manual);
  }

  // /<flow-name> <args> 触发（v8 逻辑）
  const tpl = findFlowInBlueprint(blueprint, domains, name);
  if (tpl) return bindFlowTemplate(tpl, rest);

  return null;
}
```

`findFlowInBundle` 改名为 `findFlowInBlueprint`，签名从 `(blueprint, domains, tplName)` → `(blueprint, domains, tplName)`（逻辑不变，只是名字更准确——不再叫 Bundle）。

**改动 `src/render/cache.ts`**：

cache 读 `blueprint.compilation`（v8 读 `blueprint.compilation`，v9 的 Compilation 在 Blueprint 里——逻辑不变，只是调用方传 blueprint 而非 blueprint）。

**改动 `src/render/index.ts`**：导出新签名函数。

**验证**：render 模块可独立测——临时脚本验证 renderSystemPrompt(ctx, blueprint) + renderContextMessage(ctx, blueprint, domains, "/manual:pt-quality") 能产出正确字符串。tsc 此时 index.ts 可能还报错，预期。

**commit**：`Phase 9.5: render/ 通用化 — Blueprint.injectionPoints 遍历 + renderContextMessage 死代码修复 + /manual:xxx 触发`

---

## 9.6 AgentAdapter + PiAdapter（新增 src/agent/）

**目的**：抽出 AgentAdapter 接口 + 实现 PiAdapter，封装现有 index.ts 的 Pi API 调用。

**新增 `src/agent/pi-adapter.ts`**：

```typescript
import type { AgentAdapter, AgentAPI, Blueprint, Context, Domain } from "../schema.js";
import { renderSystemPrompt } from "../render/system-prompt.js";
import { renderContextMessage } from "../render/context-message.js";

/** PiAdapter：封装 Pi Agent 的注入机制。
 *  - system_prompt → pi.on("before_agent_start") 每轮注入
 *  - context_message → pi.on("input") 拦截 /manual:xxx 和 /<flow-name> 触发 */
export class PiAdapter implements AgentAdapter {
  name = "pi";
  supportedTargets = ["system_prompt", "context_message"];

  private segment: string | null = null;
  private ctx: Context | null = null;
  private blueprint: Blueprint | null = null;
  private domains: Domain[] = [];

  /** 设置编译产物（transpile 后调） */
  setContext(ctx: Context, blueprint: Blueprint, domains: Domain[]): void {
    this.ctx = ctx;
    this.blueprint = blueprint;
    this.domains = domains;
    this.segment = renderSystemPrompt(ctx, blueprint);
  }

  registerInject(api: AgentAPI): void {
    // system_prompt 注入
    api.on("before_agent_start", async (event: { systemPrompt: string }) => {
      if (!this.segment) return undefined;
      const final = event.systemPrompt + "\n\n## 当前任务上下文\n\n" + this.segment;
      return { systemPrompt: final };
    });

    // context_message 触发（/manual:xxx + /<flow-name>）
    api.on("input", async (event: { text: string }) => {
      if (!this.ctx || !this.blueprint) return { action: "continue" };
      const result = renderContextMessage(this.ctx, this.blueprint, this.domains, event.text);
      if (result === null) return { action: "continue" };
      return { action: "transform", text: result };
    });
  }

  triggerManual(_ctx: Context, _blueprint: Blueprint, _domains: Domain[], name: string, _args: string): string | null {
    // /manual:xxx 由 input 事件处理，这里给 /pt flows 查询用
    return null;
  }

  listManuals(_ctx: Context, blueprint: Blueprint, domains: Domain[]): Array<{ name: string; hint?: string; domain: string }> {
    const flows: Array<{ name: string; hint?: string; domain: string }> = [];
    for (const ip of blueprint.injectionPoints) {
      if (ip.target !== "context_message") continue;
      // ... 遍历 domains 找 workflow-Domain 的 FlowTemplate + term-Domain 的 Rule
    }
    return flows;
  }
}
```

**新增 `src/agent/registry.ts`**：

```typescript
import type { AgentAdapter } from "../schema.js";
import { PiAdapter } from "./pi-adapter.js";

const agentAdapters: Record<string, AgentAdapter> = {
  pi: new PiAdapter(),
  // 未来: codex: new CodexAdapter(), opencode: new OpenCodeAdapter(), ...
};

export function getAgentAdapter(name: string): AgentAdapter {
  return agentAdapters[name] ?? agentAdapters.pi;
}
```

**验证**：AgentAdapter 模块可独立编译——tsc 检查类型。index.ts 此时还报错（未适配），预期。

**commit**：`Phase 9.6: AgentAdapter 抽象 + PiAdapter 实现 — 封装 Pi API 注入逻辑`

---

## 9.7 index.ts 适配 + 全链路打通

**目的**：index.ts 用 Profile（用户面）+ AgentAdapter（注入），全链路 tsc 通过。

**改动 `src/index.ts`**：

### 9.7.1 全局状态适配

```typescript
let activeProfile: string | null = null;
let cachedSegment: string | null = null;
let cachedBundles: SchemaBundle[] | null = null;
let lastCwd: string = "";
let lastCacheHit: boolean = false;
let lastBuiltPrompt: string | null = null;
// AgentAdapter 实例（从 Blueprint.agent 取）
let activeAdapter: AgentAdapter | null = null;
```

### 9.7.2 `transpileActive` 改用 Profile + AgentAdapter

```typescript
async function transpileActive(cwd: string, profileName: string): Promise<void> {
  const result = await loadAndTranspile(cwd, profileName);
  cachedSegment = result.segment;
  cachedBundles = result.bundles;
  activeProfile = profileName;
  lastCacheHit = result.cacheHit;
  // 设置 AgentAdapter 的编译产物
  activeAdapter = getAgentAdapter(result.blueprint.agent);
  activeAdapter.setContext(result.context, result.blueprint, result.domains);
}
```

### 9.7.3 `session_start` 改用 Profile

```typescript
pi.on("session_start", async (_event, ctx) => {
  lastCwd = ctx.cwd;
  const flag = pi.getFlag("pt-context");
  const flagVal = typeof flag === "string" && flag.trim() ? flag.trim() : undefined;
  const fromSettings = await readProjectSetting<string>(ctx.cwd, "au.pt-context");
  const auto = await detectSingleProfile(ctx.cwd);  // 改名
  const picked = flagVal ?? fromSettings ?? auto;
  if (!picked) { /* ... */ return; }
  await transpileActive(ctx.cwd, picked);
  // 注册 AgentAdapter 注入
  if (activeAdapter) activeAdapter.registerInject(pi as unknown as AgentAPI);
  ctx.ui.setStatus("pt", `pt: ${picked}`);
});
```

### 9.7.4 删除 `before_agent_start` + `input` 事件（移到 PiAdapter）

这两个事件的逻辑已移到 `PiAdapter.registerInject`——index.ts 不再直接注册。

### 9.7.5 `/pt-context` 改用 Profile

```typescript
pi.registerCommand("pt-context", {
  description: "切换当前 Profile（编译成 Context 注入 System Prompt）",
  getArgumentCompletions: async (prefix) => {
    const cwd = lastCwd || process.cwd();  // Q1 修复
    const names = await listProfiles(cwd);
    // ...
  },
  handler: async (args, ctx) => {
    // ... switchProfile(ctx.cwd, name)
  },
});
```

### 9.7.6 `/pt` 命令适配

- `status`：`activeProfile` 替代 `activeBlueprint`，加 `agent: ${activeAdapter?.name}`
- `flows`：用 `activeAdapter.listManuals()`
- `full`：用 `cachedSegment + ctx.getSystemPrompt()`（逻辑不变）

### 9.7.7 `config.ts` 改名

`listScenes` → `listProfiles`（读 `profiles/*.profile.md`）。`detectSingleScene` → `detectSingleProfile`。

### 9.7.8 `transpile.ts` 链路适配

`loadAndTranspile` 返回值加 `context` + `blueprint` + `domains`（给 AgentAdapter.setContext 用）：

```typescript
export interface TranspileResult {
  segment: string;
  bundles: SchemaBundle[];
  cacheHit: boolean;
  // v9 新增（给 AgentAdapter 用）
  context: Context;
  blueprint: Blueprint;
  domains: Domain[];
}
```

compile 链路：`findProfile(bundles.profiles, activeProfile)` → `findBlueprint(bundles.blueprints, profile.blueprint)` → `compileContext(profile, blueprint, domains)`。

**验证**：全链路 tsc 必须通过。跑 verify-phase9（9.9 写）+ verify-flows。

**预期产物变化**：
- Context 文件的 H2 从 `## 会话知识`/`## 对话记忆` 变成 `## 会话知识`/`## 参考手册`
- System Prompt 内容含 Scene axioms + Trigger 索引（新增）
- `/manual:pt-quality` 能触发参考手册注入（新功能）

**commit**：`Phase 9.7: index.ts 适配 v9 + 全链路打通 — Profile 用户面 + AgentAdapter 注入 + tsc 全过`

---

## 9.8 资产全量迁移 + me Domain + Trigger 段

**目的**：9.1 只改了样板，此步把所有资产迁 v9 + 新增 me Domain + 所有相关 Domain 加 Trigger 段。

**改动**：

### 9.8.1 删除 `.pt/assets/channels/` 目录

v8 的两个 Channel 文件（`dev-knowledge.channel.md` + `pt-dev.channel.md`）内容已合并到 `blueprints/dev-knowledge.blueprint.md`（9.1.1）。

### 9.8.2 删除 v8 `.pt/assets/blueprints/*.blueprint.md`

v8 的 3 个 Blueprint 文件内容已拆到 v9 `blueprints/` + `profiles/`（9.1.2/9.1.3）。

### 9.8.3 新增 `.pt/assets/profiles/` 目录

9.1.2/9.1.3 已创建 pt-dev/pt/glossary-test 三个 Profile。确认格式正确。

### 9.8.4 新增 `me` Domain

```markdown
---
type: term
name: me
---
# me

## Scene
### user-profile
- desc: 软件开发者，偏好类型安全、模块化架构、数据驱动设计

### pt-goal
- desc: Pt 要成为异构上下文编译器，把领域知识编译成 Pi 的 System Prompt + Context Message

### collab-mode
- desc: 共同设计者——用户提需求/决策，LLM 推理设计内容并产出代码/文档
```

### 9.8.5 所有相关 Domain 加 Trigger 段

- pt-quality：9.1.4 已加
- pt-collab：9.1.4 已加
- pt-dev-flow：加 Trigger 段（`/manual:pt-dev-flow` 查看开发手册）
- pt-transpile：加 Trigger 段（`/manual:pt-transpile` 查看转译流程手册）
- 其他 Domain（pt-concepts/pt-architecture/pt-stack/glossary-test）：有 Manual 段的加 Trigger，无 Manual 的不加

### 9.8.6 Profile 全局 domains 加 me

pt-dev profile 的 YAML domains 加 me：
```yaml
domains: [pt-architecture, pt-stack, pt-concepts, me]
```

### 9.8.7 pt-writing 项目同步迁移

- `/Users/issac/pro/pt-writing/.pt/assets/channels/` → 删除
- `/Users/issac/pro/pt-writing/.pt/assets/blueprints/writing.blueprint.md` → v9 Blueprint 格式（agent: pi + injectionPoints + Compilation）
- `/Users/issac/pro/pt-writing/.pt/assets/profiles/writing.profile.md` → 新建

### 9.8.8 "对话记忆" → "参考手册" 全局 grep 确认零残留

```bash
grep -rn "对话记忆" .pt/assets/ src/ tests/ docs/pt-dev-phases*.md
# 应只在 docs/pt-asset-layering.md §0.10 变更说明里出现（对比 v8/v9 用）
```

**验证**：清缓存重编译 pt-dev，确认：
- Context 含 `## 会话知识`（Scene + Trigger 索引）+ `## 参考手册`（Manual）
- 会话知识段含 me Domain 的 user-profile/pt-goal/collab-mode
- `/manual:pt-quality` 能触发

**commit**：`Phase 9.8: 资产全量迁移 — channels/ 删除 + profiles/ 建立 + me Domain + Trigger 段 + pt-writing 同步`

---

## 9.9 回归 + 文档同步 + 验收

**目的**：全量回归 + 更新文档 + 验收。

**改动**：

### 9.9.1 新增 `tests/verify/verify-phase9.ts`

替代 `verify-phase77.ts`（v8 断言），断言 v9 结构：

```typescript
// 1. tsc 通过（外部跑）
// 2. pt-dev Context 含 ## 会话知识 + ## 参考手册（不再 ## 对话记忆）
// 3. pt-dev Context 会话知识段含 Trigger 索引（### pt-quality-trigger 等）
// 4. pt-dev Context 会话知识段含 me Domain（user-profile/pt-goal/collab-mode）
// 5. pt-dev Context 参考手册段含 pt-quality 规范条目
// 6. pt-quality 不污染 pt-dev 会话知识段（只贡献 Trigger + 参考手册 Manual）
// 7. renderSystemPrompt 不含硬编码 "Scene"（grep 确认）
// 8. compile/context.ts 不含 domainSceneRenderers（grep 确认 modName 注册表替代）
// 9. Blueprint.agent 字段存在
// 10. Profile.blueprint + Profile.domains 字段存在
// 11. InjectionPointInstance 无 trigger/boundaries 字段
// 12. Channel 目录不存在（.pt/assets/channels/）
// 13. profiles/ 目录存在
// 14. /manual:pt-quality 触发能返回内容（renderContextMessage 不返 null）
// 15. pt-writing 跨项目编译成功
// 16. grep "对话记忆" 零残留（§0.10 变更说明除外）
```

### 9.9.2 更新 `tests/verify/verify-flows.ts`

适配 v9：`bp.injectionPoints` → `profile.injectionPoints`（Profile 是用户面），`blueprint.injectionPoints` 用于结构层。`/pt flows` 用 `activeAdapter.listManuals()`。

### 9.9.3 更新 `docs/pt-dev-phases.md`

加 Phase 9 章节（9.1-9.9 记录）。更新"接手坐标"为 v9。

### 9.9.4 更新 Domain 资产措辞

pt-concepts / pt-architecture / pt-transpile 等 Domain 里提到的 "v8 模型" 措辞改为 "v9 模型"。Channel→Blueprint、Blueprint→Profile 等概念同步。

### 9.9.5 6 项硬指标验收

| 指标 | v9 验收标准 |
|---|---|
| 三段式叙事 | src/{parse,compile,render,agent}/ 都有 v9 实现 |
| 无命名碰撞 | schema.ts 无 v8 Channel 类型（删除）、无 v8 Blueprint.domains/trigger/boundaries |
| 产物无回归 | pt/pt-dev Context 含会话知识+参考手册；字数允许变但结构对 |
| Blueprint 复用 | dev-knowledge Blueprint 被 pt + pt-dev + glossary-test 三个 Profile 引用 |
| Context 缓存 | cacheHit=true，segment 一致 |
| 扩展性 | modName 注册表 + generic fallback；加新聚合标题不改代码 |

**commit**：`Phase 9.9: 回归 + 文档同步 — 6 项硬指标全过`

---

## 风险与回退

### 风险

1. **Schema 破坏期长**：9.2-9.7 之间 tsc 不过，约 5 个 commit。执行者要一口气做完，不要中途停。
2. **资产三向拆并复杂**：v8 channels/ + blueprints/ → v9 blueprints/ + profiles/ 是三向拆并，容易搞混。9.1 先做样板（pt-dev）确认映射关系，9.8 再全量迁移。
3. **AgentAdapter 抽象边界**：PiAdapter 封装 Pi API 时，AgentAPI 接口要够用但不过度抽象。MVP 可以是 Pi ExtensionAPI 的子集类型别名。
4. **modName 注册表重构**：v8 的 `domainSceneRenderers[type]` + `compileSystemPromptModule` 逻辑较复杂，v9 重构为 `moduleRenderers[modName]` 要保留 hybrid mode 的全局约束段逻辑。
5. **renderContextMessage 死代码修复**：`/manual:xxx` 触发是新功能，要正确处理 term-Domain 的 Rule[] 和 workflow-Domain 的 FlowTemplate 两种路径。
6. **Trigger 段解析**：Domain 的 `## Trigger` 段走 `parseDomainSection` 的 `default` 分支（`toTerms` fallback），需确认 `hint` 字段不丢失（可能要扩展 `toTerms` 或加 `toTriggerItems`）。

### 回退

- 基线 `7028a0f`（v9 §0 文档定稿，代码还是 v8）
- 任一步失败可 `git reset --hard 7028a0f` 回到 v8 代码 + v9 文档状态
- 资产已迁 v9（9.1/9.8）但代码回退 v8 时，v8 代码读不了 v9 资产——回退要连资产一起回退

---

## 验收清单

执行者完成后，验收者（assistant）独立检查：

- [ ] `tsc --noEmit` 通过
- [ ] `npx tsx tests/verify/verify-phase9.ts` 全过
- [ ] `npx tsx tests/verify/verify-flows.ts` 全过
- [ ] pt-dev Context 含 `## 会话知识` + `## 参考手册`（不再 `## 对话记忆`）
- [ ] pt-dev Context 会话知识段含 Trigger 索引（`### pt-quality-trigger` 等）
- [ ] pt-dev Context 会话知识段含 me Domain（user-profile/pt-goal/collab-mode）
- [ ] pt-dev Context 参考手册段含 pt-quality 规范条目
- [ ] pt-quality 不污染 pt-dev 会话知识段（只贡献 Trigger + 参考手册 Manual）
- [ ] `renderSystemPrompt` 不含硬编码 `"Scene"`（grep 确认）
- [ ] `compile/context.ts` 不含 `domainSceneRenderers`（grep 确认 modName 注册表替代）
- [ ] `compile/context.ts` 不含 `if (target === "system_prompt")` 硬编码（modName 驱动）
- [ ] `Blueprint.agent` 字段存在
- [ ] `Profile.blueprint` + `Profile.domains` 字段存在
- [ ] `InjectionPointInstance` 无 `trigger`/`boundaries` 字段
- [ ] `.pt/assets/channels/` 目录不存在
- [ ] `.pt/assets/profiles/` 目录存在
- [ ] `/manual:pt-quality` 触发能返回内容（`renderContextMessage` 不返 null）
- [ ] PiAdapter 封装 `pi.on` 调用（index.ts 不直接调 `pi.on("before_agent_start")`）
- [ ] pt-writing 跨项目编译 writing Profile 成功
- [ ] grep `.openxenon` 零残留
- [ ] grep `对话记忆` 零残留（§0.10 变更说明除外）
- [ ] `/pt-context` getArgumentCompletions 用 `lastCwd || process.cwd()`（Q1 修复）

---

## 附录：v9 目录结构（实现后）

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
    └── registry.ts        # agentAdapters 注册表
```

```
.pt/assets/
├── domains/               # Domain（加 ## Trigger 段 + me Domain）
│   ├── pt-concepts.md
│   ├── pt-architecture.md
│   ├── pt-transpile.md
│   ├── pt-stack.md
│   ├── pt-dev-flow.md
│   ├── pt-collab.md
│   ├── pt-quality.md
│   ├── glossary-test.md
│   └── me.md              # 新增
├── blueprints/            # Blueprint（v8 channel + agent + Compilation）
│   └── dev-knowledge.blueprint.md   # 合并 v8 dev-knowledge + pt-dev channel
└── profiles/              # Profile（v8 blueprint 的 Domains 选择）— 新增
    ├── pt.profile.md
    ├── pt-dev.profile.md
    └── glossary-test.profile.md
```
