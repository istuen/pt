# Phase 8：v8 模型实现执行描述

> **依据**：`docs/pt-asset-layering.md` §0（v8 模型，2026-08-31 定稿）
> **目标**：把 v7 代码（隐式 Modules + render 硬编码 + 粗粒度 Domain 引用）升级为 v8（H2=注入点显式化 + 模块级 Domain 引用 + Context 缓存策略可配置）
> **基线**：commit `8251378`（v8 §0 文档定稿）
> **验证**：`tsc --noEmit` 通过 + `tests/verify/verify-phase77.ts` 全过 + `tests/verify/verify-flows.ts` 全过

---

## 执行者须知

本任务由执行者按子步顺序完成，每步一个 commit。执行者必须：

1. **按顺序执行**：8.1→8.2→8.3→8.4→8.5→8.6→8.7→8.8，不可跳步。Schema（8.2）会破坏全链路，后续 8.3-8.6 是连续修复链。
2. **每步 commit**：commit message 用 `Phase 8.X: ...` 前缀，附本步改动摘要。
3. **每步验证**：改完跑 `tsc --noEmit`，能跑通才 commit。Schema 步（8.2）允许 tsc 暂时不过（预期破坏），但 8.6 结束时必须全过。
4. **不改动 docs/§1-§11**：历史章节保留，只改 §0 已完成（本次不动）。
5. **资产迁移用 sed 批量 + 手动校验**：路径替换后 grep 确认零残留。
6. **遇到歧义按 §0 文档为准**：本文档是执行描述，语义基准在 `pt-asset-layering.md` §0。

---

## 8.1 资产样板先行（不改代码）

**目的**：先把 pt-dev 的 Channel + Blueprint 改成 v8 格式，作为后续代码改动的参照样板。代码改完后这个样板就是验证夹具。

**改动**：

### 8.1.1 `.pt/assets/channels/pt-dev.channel.md` → v8 格式

当前 v7：
```markdown
---
name: pt-dev
---
# pt-dev (channel)
## Modules
- Scene
- Manual
## Layout
- mode: hybrid
```

改为 v8（H2=注入点）：
```markdown
---
name: pt-dev
---
# pt-dev (channel)

## 会话知识
target: system_prompt
mode: hybrid
### Modules
- Scene

## 对话记忆
target: context_message
### Modules
- Manual
```

### 8.1.2 `.pt/assets/blueprints/pt-dev.blueprint.md` → v8 格式

当前 v7：`## Channel` + `## Domains`（粗粒度全量）+ `## Trigger`（顶级）+ `## Boundaries`（顶级）。

改为 v8（按注入点选 Domain + Trigger/Boundaries 在注入点下 + Compilation）：
```markdown
---
name: pt-dev
---
# pt-dev (blueprint)

## Channel

pt-dev

## 会话知识

### Domains
- pt-architecture
- pt-stack
- pt-concepts

### Trigger
当用户要开发/修改 Pt 自身（改 IR、改资产、扩展 Domain Type、加 Channel/Blueprint）时按以下流程回答；其余对话正常响应，勿套用本流程。

### Boundaries
### identify-task
- deps: []
- desc: 识别开发任务类型（改 schema / 改 asset / 扩 type / 加 channel / 加 blueprint）

### cite-stack
- deps: [identify-task]
- desc: 按任务类型从 pt-stack 引用相关技术栈（typescript / pi-extension-api / tsx / md-asset-format）

### cite-flow
- deps: [cite-stack]
- desc: 从 pt-dev-flow 引用对应流程（modify-schema / modify-asset / add-domain-type）

### execute
- deps: [cite-flow]
- desc: 按 cite-flow 步骤执行（tsc --noEmit → verify-phase77.ts → git commit）

## 对话记忆

### Domains
- pt-dev-flow
- pt-collab

## Compilation

cache-dir: .pt/contexts/cache/
split: single-file
```

### 8.1.3 同步改 pt + glossary-test 两个 Blueprint + dev-knowledge Channel

- `.pt/assets/channels/dev-knowledge.channel.md` → v8 格式（注入点：会话知识 + 对话记忆）
- `.pt/assets/blueprints/pt.blueprint.md` → v8 格式（会话知识下放 pt-concepts/pt-architecture/pt-transpile/pt-stack；对话记忆下放 pt-transpile；加 Compilation）
- `.pt/assets/blueprints/glossary-test.blueprint.md` → v8 格式（会话知识下放 glossary-test；加 Compilation）

### 8.1.4 同步改 pt-writing 项目

- `/Users/issac/pro/pt-writing/.pt/assets/channels/writing.channel.md` → v8
- `/Users/issac/pro/pt-writing/.pt/assets/blueprints/writing.blueprint.md` → v8

**验证**：此步不改代码，tsc 仍过。资产改完后手动读一遍确认格式正确（v8 注入点 H2 + target + ### Modules + Blueprint 按注入点列 Domain + Compilation）。

**commit**：`Phase 8.1: 资产样板先行 — pt-dev/pt/glossary-test/pt-writing 全部迁 v8 格式`

---

## 8.2 Schema 重写（破坏性，预期 tsc 暂时不过）

**目的**：定义 v8 IR 类型，跟 v7 不兼容。这是破坏点，后续 8.3-8.6 修复全链路。

**改动 `src/schema.ts`**：

### 8.2.1 新增 InjectionPoint 类型

```typescript
/** Pi 注入位置（代码层技术名，由 Channel.target 映射）。 */
export type InjectionTarget = "system_prompt" | "context_message" | string;
```

### 8.2.2 新增 InjectionPointConfig（Channel 的 H2 注入点）

```typescript
/** Channel 的注入点定义（对应 Channel md 的 H2）。 */
export interface InjectionPointConfig {
  /** 注入点名（语义名，如 "会话知识"/"对话记忆"，来自 Channel H2 标题）。 */
  name: string;
  /** Pi 注入位置（system_prompt / context_message / 扩展）。 */
  target: InjectionTarget;
  /** 聚合点：参与的 Domain H2 段名列表（来自 ### Modules 无符号项）。 */
  modules: string[];
  /** 聚合方式（仅 system_prompt 类注入点有意义）。 */
  mode?: StructureLayout["mode"];
}
```

### 8.2.3 改 Channel IR

```typescript
export interface Channel {
  name: string;
  /** v8：注入点列表（H2=注入点），替代 v7 的 modules + layout。 */
  injectionPoints: InjectionPointConfig[];
}
```

删掉 `modules: string[]` 和 `layout: StructureLayout`（已移入 InjectionPointConfig）。

### 8.2.4 新增 InjectionPointInstance（Blueprint 的注入点实例化）

```typescript
/** Blueprint 的注入点实例化（对应 Blueprint md 的 H2，跟 Channel 的 InjectionPointConfig 同名）。 */
export interface InjectionPointInstance {
  /** 注入点名（跟 Channel 的 InjectionPointConfig.name 对应）。 */
  name: string;
  /** 参与本注入点的 Domain 名列表（模块级引用——只贡献该注入点聚合的 H2 段）。 */
  domains: string[];
  /** 本注入点的触发条件（实例级）。 */
  trigger?: string;
  /** 本注入点的流程节点 DAG（实例级）。 */
  boundaries?: BoundaryNode[];
}
```

### 8.2.5 新增 CompilationConfig

```typescript
/** Context 缓存拆分策略。 */
export type CacheSplitStrategy = "single-file" | "by-injection-point";

/** Blueprint 的编译方式配置（## Compilation 段）。 */
export interface CompilationConfig {
  /** 缓存目录（默认 .pt/contexts/cache/）。 */
  cacheDir: string;
  /** 拆分策略（默认 single-file）。 */
  split: CacheSplitStrategy;
}
```

### 8.2.6 改 Blueprint IR

```typescript
export interface Blueprint {
  name: string;
  /** 引用的 Channel 名。 */
  channel: string;
  /** v8：按注入点选 Domain（模块级引用），替代 v7 的 domains: string[]。 */
  injectionPoints: InjectionPointInstance[];
  /** v8：编译方式（缓存目录 + 拆分策略）。 */
  compilation: CompilationConfig;
}
```

删掉 `domains: string[]`、`trigger?: string`、`boundaries?: BoundaryNode[]`（已移入 InjectionPointInstance）。

### 8.2.7 改 Context IR

```typescript
export interface Context {
  name: string;
  sourceHash: string;
  /** v8：注入点名 → 聚合后的 markdown 字符串（按注入点组织，替代 v7 按模块名）。 */
  modules: Record<string, string>;
}
```

Context.modules 的 key 从 v7 的"模块名（Scene/Manual）"变成 v8 的"注入点名（会话知识/对话记忆）"——但 Record 结构不变，只是 key 语义变了。

### 8.2.8 保留不变的类型

Domain、Domain Type、FlowTemplate、FlowStep、ExternalRef、Term、Rule、BoundaryNode、StructureLayout、ToolRef、SchemaBundle、SourceAdapter——这些都不变。

**验证**：tsc 此时会报大量错误（parse/compile/render/index 全引用旧字段），**这是预期的**。不要在此步修代码，直接 commit，下一步开始修。

**commit**：`Phase 8.2: Schema 重写为 v8 IR — InjectionPoint/InjectionPointInstance/CompilationConfig`

---

## 8.3 parse/ 前端适配 v8 IR

**目的**：parse/channel.ts + parse/blueprint.ts 解析 v8 格式资产，产出 v8 IR。

**改动 `src/parse/channel.ts`**：

当前解析 `## Modules`（列表）+ `## Layout`（mode）。改为解析 H2=注入点：

```typescript
export async function parseChannel(cwd: string, fileName: string): Promise<Channel> {
  const asset = await readAsset(...);
  // v8：每个 H2 = 一个注入点
  const injectionPoints: InjectionPointConfig[] = [];
  for (const [h2Name, section] of Object.entries(asset.sections)) {
    if (h2Name === "Modules" || h2Name === "Layout") continue;  // v7 残留，跳过
    // H2 名 = 注入点名（语义名）
    // H2 段下找 target / mode 字段（裸值或列表项）
    // H2 段下找 ### Modules H3，其无符号项 = Domain H2 段名列表
    const target = extractFieldValue(section, "target") ?? "system_prompt";
    const mode = extractFieldValue(section, "mode") as StructureLayout["mode"] | undefined;
    const modules = extractModulesList(section);  // ### Modules 下的列表项
    injectionPoints.push({ name: h2Name, target, modules, mode: mode ?? "hybrid" });
  }
  return { name, injectionPoints };
}
```

需要新增辅助函数 `extractFieldValue`（从 H2 段的裸值或列表项取字段值）和 `extractModulesList`（从 H2 段下的 ### Modules H3 取列表项）。

**改动 `src/parse/blueprint.ts`**：

当前解析 `## Channel` + `## Domains`（全量列表）+ `## Trigger`（顶级）+ `## Boundaries`（顶级）。改为解析按注入点组织：

```typescript
export async function parseBlueprint(cwd: string, fileName: string): Promise<Blueprint> {
  const asset = await readAsset(...);
  const channel = /* ## Channel 段，跟 v7 一样 */;
  
  // v8：按注入点解析（H2 = 注入点名，其下 ### Domains / ### Trigger / ### Boundaries）
  const injectionPoints: InjectionPointInstance[] = [];
  for (const [h2Name, section] of Object.entries(asset.sections)) {
    if (h2Name === "Channel" || h2Name === "Compilation") continue;
    // H2 名 = 注入点名
    // ### Domains → domains: string[]
    // ### Trigger → trigger: string
    // ### Boundaries → boundaries: BoundaryNode[]
    const domains = extractDomainsFromSection(section);
    const trigger = extractTriggerFromSection(section);
    const boundaries = extractBoundariesFromSection(section);
    injectionPoints.push({ name: h2Name, domains, trigger, boundaries });
  }
  
  // v8：## Compilation 段
  const compilation = parseCompilationSection(asset.sections["Compilation"]);
  
  return { name, channel, injectionPoints, compilation };
}

function parseCompilationSection(section): CompilationConfig {
  const cacheDir = extractFieldValue(section, "cache-dir") ?? ".pt/contexts/cache/";
  const split = extractFieldValue(section, "split") ?? "single-file";
  return { cacheDir, split: split as CacheSplitStrategy };
}
```

**注意**：Blueprint 的 H2 注入点名要跟 Channel 的 H2 注入点名**同名**（如都是"会话知识"）——这是实例化关系。parse 阶段不校验同名，compile 阶段校验（8.4）。

**改动 `src/parse/domain.ts`**：不变（Domain IR 没变）。

**改动 `src/parse/index.ts`**：`oxnAdapter.load` 返回 SchemaBundle，类型不变，但 Channel/Blueprint 字段变了——适配即可。

**验证**：parse 模块独立可测——写临时脚本验证 parseChannel/parseBlueprint 能正确解析 8.1 的样板资产。tsc 此时 compile/render/index 还报错，预期。

**commit**：`Phase 8.3: parse/ 适配 v8 IR — Channel H2=注入点解析 + Blueprint 按注入点解析`

---

## 8.4 compile/ 中端重写（核心改动）

**目的**：compileContext 按 v8 IR 编译——遍历注入点，每个注入点聚合对应 Domain 的对应 H2 段。

**改动 `src/compile/context.ts`**：

### 8.4.1 compileContext 主函数重写

当前 v7：遍历 `channel.modules`，按 moduleName 分发（Scene/Manual/generic）。

v8：遍历 `channel.injectionPoints`，每个注入点找 Blueprint 对应的 InjectionPointInstance，按 target 分发：

```typescript
export function compileContext(
  blueprint: Blueprint,
  channel: Channel,
  domains: Domain[],
): Context {
  const domainByName = new Map(domains.map(d => [d.name, d]));
  const modules: Record<string, string> = {};
  
  for (const ipConfig of channel.injectionPoints) {
    // 找 Blueprint 对应的注入点实例化（同名）
    const ipInstance = blueprint.injectionPoints.find(i => i.name === ipConfig.name);
    if (!ipInstance) continue;
    
    // 取本注入点参与的 Domain
    const refDomains = ipInstance.domains
      .map(n => domainByName.get(n))
      .filter((d): d is Domain => !!d);
    
    // 按 target 分发编译
    if (ipConfig.target === "system_prompt") {
      modules[ipConfig.name] = compileSystemPromptModule(
        ipInstance, ipConfig, refDomains
      );
    } else if (ipConfig.target === "context_message") {
      modules[ipConfig.name] = compileContextMessageModule(
        ipInstance, ipConfig, refDomains
      );
    } else {
      // 扩展注入点：generic 聚合
      modules[ipConfig.name] = compileGenericInjectionPoint(
        ipInstance, ipConfig, refDomains
      );
    }
  }
  
  const sourceHash = computeSourceHash(blueprint, channel, domains);
  return { name: blueprint.name, sourceHash, modules };
}
```

### 8.4.2 compileSystemPromptModule（原 compileSceneModule 改名+重构）

原 `compileSceneModule(blueprint, channel, refDomains)` 读 `blueprint.trigger` + `blueprint.boundaries`。v8 改为读 `ipInstance.trigger` + `ipInstance.boundaries`，mode 从 `ipConfig.mode` 取（不再从 `channel.layout` 取）。

```typescript
function compileSystemPromptModule(
  ipInstance: InjectionPointInstance,
  ipConfig: InjectionPointConfig,
  refDomains: Domain[],
): string {
  const mode = ipConfig.mode ?? "hybrid";
  const parts: string[] = [];
  
  // 1. Trigger（从 ipInstance 取，不再从 blueprint 顶级取）
  const trigger = ipInstance.trigger?.trim() || "当用户请求相关任务时...";
  parts.push(`> ${trigger}`);
  
  // 2. 全局约束（hybrid only，原逻辑保留）
  if (mode === "hybrid") {
    const globals = refDomains.flatMap(extractRules).filter(r => r.slot === "global");
    if (globals.length > 0) parts.push(renderGlobalRules(globals));
  }
  
  // 3. 流程段（Boundaries 从 ipInstance 取）
  const flowText = compileFlow(ipInstance, refDomains);
  if (flowText) parts.push(flowText);
  
  // 4. 按 mode 拼装 Domain sections（原逻辑保留，但 ipConfig.modules 决定聚合哪些 H2 段）
  //    v7 是全量 refDomains，v8 只聚合 ipConfig.modules 列出的 H2 段
  const domainsToRender = refDomains.filter(d => 
    ipConfig.modules.some(m => d.modules[m] !== undefined)
  );
  if (mode === "byType") {
    // byType 聚合（原 renderAggregatedTerms/Rules）
  } else {
    for (const d of domainsToRender) {
      const sec = formatDomainSceneSection(d, mode, ipConfig.modules);
      if (sec) parts.push(sec);
    }
  }
  
  // 5. 工具段 + 6. 可用手册（原逻辑保留，但只在 ipConfig.modules 含对应 H2 时输出）
  return parts.join("\n\n");
}
```

### 8.4.3 compileContextMessageModule（原 compileManualModule 重写）

原 `compileManualModule` 只处理 workflow-Domain 的 FlowTemplate。v8 要服务多种内容（FlowTemplate + term-Domain 的 Rule + 新增 pt-quality 的规范条目）。

```typescript
function compileContextMessageModule(
  ipInstance: InjectionPointInstance,
  ipConfig: InjectionPointConfig,
  refDomains: Domain[],
): string {
  // 聚合 ipConfig.modules 列出的 H2 段内容
  // 通用逻辑：遍历 refDomains，每个 Domain 取 ipConfig.modules 里的 H2 段
  //   - workflow-Domain 的 Manual → FlowTemplate 列表（原逻辑）
  //   - term-Domain 的 Manual → Rule 列表（v7 死代码，v8 修复）
  //   - 其他 H2 段按 generic 聚合
  // 输出：### 模块「domain-name」+ 该 Domain 在本注入点贡献的内容
}
```

**关键修复**：v7 的 term-Manual 死代码（compileManualModule 只处理 workflow）在 v8 必须修——term-Domain 的 Manual Rule[] 要正常聚合。这解了"pt-quality 的规范条目能进对话记忆"的需求。

### 8.4.4 compileFlow 改签名

原 `compileFlow(blueprint, refDomains)` 读 `blueprint.boundaries`。改为 `compileFlow(ipInstance, refDomains)` 读 `ipInstance.boundaries`。内部逻辑不变。

### 8.4.5 formatDomainSceneSection 加 modules 过滤

原函数按 type 分发 renderer，渲染 Domain 的 Scene 段。v8 加 `modules` 参数——只渲染 `ipConfig.modules` 列出的 H2 段（可能不只是 Scene）。

### 8.4.6 domainSceneRenderers 注册表保留

扩展机制不变——按 type 注册 renderer。但 renderer 函数签名加 `modules: string[]` 参数，控制渲染哪些 H2 段。

### 8.4.7 computeSourceHash 保留

hash 算法不变，但输入对象的形状变了（blueprint/channel 字段变了）——`stableStringify` 自动适应。

**验证**：compile 模块独立可测——写临时脚本验证 compileContext 能产出 v8 Context（modules key 是注入点名）。tsc 此时 render/index 还报错，预期。

**commit**：`Phase 8.4: compile/ 重写 — 按注入点编译 + 模块级 Domain 引用 + term-Manual 死代码修复`

---

## 8.5 render/ 后端通用化

**目的**：render 不再硬编码 `ctx.modules["Scene"]`，改为按 Channel 的 target 字段分发。

**改动 `src/render/system-prompt.ts`**：

当前：`return ctx.modules["Scene"] ?? ""`（硬编码模块名）。

v8：按注入点聚合——遍历 Channel.injectionPoints，找 target=system_prompt 的，取对应 modules 项。

```typescript
import type { Context, Channel } from "../schema.js";

/** 渲染 System Prompt：聚合所有 target=system_prompt 的注入点内容。 */
export function renderSystemPrompt(ctx: Context, channel: Channel): string {
  const parts: string[] = [];
  for (const ip of channel.injectionPoints) {
    if (ip.target === "system_prompt") {
      const content = ctx.modules[ip.name];
      if (content) parts.push(content);
    }
  }
  return parts.join("\n\n");
}
```

**注意**：签名加了 `channel` 参数——调用方要传。transpile.ts 里 `renderSystemPrompt(cached)` 改成 `renderSystemPrompt(cached, channel)`。

**改动 `src/render/context-message.ts`**：

当前 `renderContextMessage` 遍历 `ctx.modules["Manual"]`。v8 改为遍历所有 target=context_message 的注入点：

```typescript
export function renderContextMessage(
  ctx: Context,
  channel: Channel,
  blueprint: Blueprint,
  args: string,
): string | null {
  // 遍历 channel.injectionPoints，找 target=context_message 的
  // 在对应 modules 内容里找 FlowTemplate（原 findFlowInBundle 逻辑）
}
```

`findFlowInBundle` 也要改——原从 `blueprint.domains` 找，改为从 `blueprint.injectionPoints` 里 target=context_message 的注入点的 domains 找。

**改动 `src/render/cache.ts`**：

当前 `CACHE_DIR = ".pt/contexts/cache"` 硬编码。v8 改为从 Blueprint.compilation 取：

```typescript
export async function saveContext(
  cwd: string,
  ctx: Context,
  compilation: CompilationConfig,
): Promise<string> {
  const dir = join(cwd, compilation.cacheDir);
  // ...
}

export async function loadContext(
  cwd: string,
  name: string,
  expectedHash: string,
  compilation: CompilationConfig,
): Promise<Context | null> {
  // 按 compilation.split 决定文件名
  // single-file: <name>.context.md
  // by-injection-point: 多文件（暂可先实现 single-file，by-injection-point 留 TODO）
}
```

**by-injection-point 拆分策略**：本步可先只实现 single-file（保持现状），by-injection-point 留 TODO 注释 + 抛 not implemented。完整实现留 8.6 或后续。

**改动 `src/render/index.ts`**：导出新签名函数。

**改动 `src/transpile.ts`**：

`loadAndTranspile` 调 renderSystemPrompt/renderContextMessage 要传 channel + compilation。链路调整：

```typescript
// 原：segments.push(renderSystemPrompt(cached));
// v8：segments.push(renderSystemPrompt(cached, channel));
```

**验证**：render 模块可独立测——临时脚本验证 renderSystemPrompt(ctx, channel) 能产出正确字符串。tsc 此时 index.ts 可能还报错（cachedBundles 用法变了），预期。

**commit**：`Phase 8.5: render/ 通用化 — 按 target 分发 + cache 读 CompilationConfig + transpile 链路调整`

---

## 8.6 index.ts 注入逻辑适配 + 全链路打通

**目的**：index.ts 的 before_agent_start / input 事件用 v8 IR，全链路 tsc 通过。

**改动 `src/index.ts`**：

### 8.6.1 cachedBundles 类型适配

`SchemaBundle` 里 Channel/Blueprint 字段变了，cachedBundles 用法要适配。`findFlow` 改为遍历 `blueprint.injectionPoints` 里 target=context_message 的注入点的 domains。

### 8.6.2 before_agent_start

```typescript
pi.on("before_agent_start", async (event) => {
  if (!cachedSegment) return undefined;
  // cachedSegment 现在是 renderSystemPrompt(cached, channel) 的结果
  // 直接拼到 event.systemPrompt
  const finalPrompt = event.systemPrompt + "\n\n## 当前任务上下文\n\n" + cachedSegment;
  return { systemPrompt: finalPrompt };
});
```

逻辑不变，但 cachedSegment 的来源（transpileActive → loadAndTranspile → renderSystemPrompt）链路要确认传了 channel。

### 8.6.3 input 事件

```typescript
pi.on("input", async (event) => {
  const match = event.text.match(/^\/(\S+)\s*(.*)$/);
  if (!match) return { action: "continue" };
  const [, tplName, args] = match;
  // findFlow 改为遍历 blueprint.injectionPoints[target=context_message].domains
  const tpl = findFlow(tplName);
  if (!tpl) return { action: "continue" };
  const expanded = bindFlowTemplate(tpl, args);
  return { action: "transform", text: expanded };
});
```

### 8.6.4 /pt flows 子命令

原逻辑遍历 `bp.domains` 找 workflow-Domain。改为遍历 `bp.injectionPoints` 里 target=context_message 的注入点的 domains：

```typescript
if (sub === "flows") {
  // 遍历 cachedBundles
  // 对每个 bundle，找 blueprint.injectionPoints[target=context_message].domains
  // 在这些 domains 里找 workflow-Domain 的 Manual FlowTemplate
}
```

### 8.6.5 提示文案

所有提到 `## Scene`/`## Manual` 的提示文案改为注入点语义名（"会话知识"/"对话记忆"）。

**验证**：全链路 tsc 必须通过。跑 verify-phase77 + verify-flows。

**预期产物变化**：
- Context 文件的 H2 从 `## Scene`/`## Manual` 变成 `## 会话知识`/`## 对话记忆`
- System Prompt 内容不变（会话知识注入点聚合的内容跟 v7 Scene 一样）
- Context Message 触发逻辑不变（对话记忆注入点的 FlowTemplate 跟 v7 Manual 一样）

**commit**：`Phase 8.6: index.ts 适配 v8 + 全链路打通 — tsc 全过 + 回归通过`

---

## 8.7 资产迁移 + pt-quality Domain 落地

**目的**：8.1 只改了样板，此步把所有资产迁 v8 + 新增 pt-quality Domain（技术规范）。

**改动**：

### 8.7.1 新增 `.pt/assets/domains/pt-quality.md`

type: term，`## Manual` 段含 9 条技术规范（Rule[] 格式）。参考技术债清单 P1-P3 项提炼为持久规范：

```markdown
---
type: term
name: pt-quality
---
# pt-quality

## Scene

### quality-index
- desc: 技术规范在 Manual 段；执行开发手册（modify-schema/modify-asset/add-domain-type）时自动带出对话记忆注入点。

## Manual

### modules-type-safety
- slot: global
- type: invariant
- check: Domain.modules 读取必须用 type guard，不用 as 断言

### no-duplicate-type
- slot: global
- type: invariant
- check: 禁止重复定义相似类型，用 Pick/Partial 从 schema 派生

### parse-extension-registry
- slot: global
- type: invariant
- check: parse 扩展用注册表，不用 switch-case（与 compile 的 domainSceneRenderers 一致）

### path-constant
- slot: global
- type: invariant
- check: 资产/缓存路径必须用常量集中管理（如 CACHE_DIR），不散落硬编码

### module-name-constant
- slot: global
- type: invariant
- check: 模块名 Scene/Manual 必须用常量，不散落字符串字面量

### naming-consistency
- slot: global
- type: invariant
- check: 代码命名与架构语义一致（adapter 不叫 oxnAdapter，应叫 mdAdapter）

### npm-scripts
- slot: global
- type: invariant
- check: package.json 必须有 typecheck/verify 脚本入口

### test-framework
- slot: global
- type: invariant
- check: 验证脚本用断言框架（vitest），不用 console.log + 人工看 ✅

### error-via-notify
- slot: global
- type: invariant
- check: 生产错误用 ctx.ui.notify，不用 console.error
```

### 8.7.2 pt-quality 加入 pt-dev Blueprint 的对话记忆注入点

8.1 的样板里已经写了 `- pt-collab` 在对话记忆下。此步加 `- pt-quality`：

```markdown
## 对话记忆
### Domains
- pt-dev-flow
- pt-collab
- pt-quality
```

### 8.7.3 验证 pt-quality 进 Context

清缓存重编译 pt-dev，确认对话记忆注入点含 pt-quality 的规范条目。

**验证**：verify-phase77 通过 + pt-dev Context 含 pt-quality 规范。

**commit**：`Phase 8.7: pt-quality Domain 落地 — 9 条技术规范进 pt-dev 对话记忆`

---

## 8.8 回归 + 文档同步

**目的**：全量回归 + 更新文档（dev-phases.md + pt-concepts 等资产措辞同步 v8）。

**改动**：

### 8.8.1 跑全量回归

- `tsc --noEmit` 通过
- `npx tsx tests/verify/verify-phase77.ts` 全过（更新脚本里的断言：H2 从 Scene/Manual 改为会话知识/对话记忆）
- `npx tsx tests/verify/verify-flows.ts` 全过

### 8.8.2 更新 tests/verify/verify-phase77.ts

脚本里硬编码的 `## Scene`/`## Manual` 检查改为 `## 会话知识`/`## 对话记忆`。路径 `.pt/cache` 已改 `.pt/contexts/cache`（上轮已改，确认无残留）。

### 8.8.3 更新 docs/pt-dev-phases.md

加 Phase 8 章节（8.1-8.8 记录）。更新"接手坐标"为 v8。

### 8.8.4 更新 pt-concepts / pt-architecture / pt-transpile 资产

这些 Domain 的内容里提到的 "v7 四层模型" 措辞改为 "v8 模型"。H2=注入点等 v8 概念同步。

### 8.8.5 6 项硬指标验收

| 指标 | v8 验收标准 |
|---|---|
| 三段式叙事 | src/{parse,compile,render}/ 都有 v8 实现 |
| 无命名碰撞 | schema.ts 无 v7 modules/layout 顶级字段（移入 InjectionPointConfig） |
| 产物无回归 | pt=约 1900 字 / pt-dev 含 pt-quality 规范 / 字数允许变但结构对 |
| Channel 复用 | dev-knowledge 仍被 pt + glossary-test 引用 |
| Context 缓存 | cacheHit=true，segment 一致 |
| 扩展性 | glossary renderer 仍注册，glossary-test Blueprint 仍工作 |

**commit**：`Phase 8.8: 回归 + 文档同步 — 6 项硬指标全过`

---

## 风险与回退

### 风险

1. **Schema 破坏期长**：8.2-8.6 之间 tsc 不过，约 4 个 commit。执行者要一口气做完，不要中途停。
2. **parse 辅助函数复杂**：extractFieldValue/extractModulesList 要处理多种格式（裸值/列表/H3）。参考现有 parse/shared.ts 的 s/sArr 辅助。
3. **compileContextMessageModule 重写**：v7 死代码修复，要正确处理 term-Domain 的 Rule[]。参考 renderTermSceneSection 的 extractRules 逻辑。
4. **by-injection-point 缓存拆分**：8.5 可先只实现 single-file，by-injection-point 留 TODO。

### 回退

- 基线 `8251378`（v8 §0 文档定稿，代码还是 v7）
- 任一步失败可 `git reset --hard 8251378` 回到 v7 代码 + v8 文档状态
- 资产已迁 v8（8.1）但代码回退 v7 时，v7 代码读不了 v8 资产——回退要连资产一起回退

---

## 验收清单

执行者完成后，验收者（assistant）独立检查：

- [ ] `tsc --noEmit` 通过
- [ ] `npx tsx tests/verify/verify-phase77.ts` 6 项全过
- [ ] `npx tsx tests/verify/verify-flows.ts` 全过
- [ ] pt-dev Context 含 `## 会话知识` + `## 对话记忆`（不再是 Scene/Manual）
- [ ] pt-dev Context 对话记忆段含 pt-quality 规范条目
- [ ] renderSystemPrompt 不含硬编码 `"Scene"`（grep 确认）
- [ ] compileManualModule 无 `if (d.type !== "workflow") continue` 死代码
- [ ] Channel.injectionPoints 字段存在，Channel.modules/layout 不存在
- [ ] Blueprint.injectionPoints 字段存在，Blueprint.domains/trigger/boundaries 不存在
- [ ] Blueprint.compilation 字段存在
- [ ] pt-writing 跨项目编译 writing Blueprint 成功
- [ ] grep `.openxenon` 零残留（上轮已清，此步确认不回退）
