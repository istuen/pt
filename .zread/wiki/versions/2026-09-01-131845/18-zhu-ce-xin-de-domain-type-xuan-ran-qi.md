在 v8 四层模型里，Domain 通过 frontmatter 中的 `type` 标签区分承载内容性质（term/workflow/stack/扩展），`type` 决定**同一 H2 段名下的内部内容格式**——而不是 H2 段名本身。本页专门回答：**当现有 type不足以表达你的领域内容时，如何在不动 schema、不改主循环的前提下，把新 type 注入到 Pt 编译流水线里？**

答案依赖于 v8 在 `src/compile/context.ts` 显式暴露的扩展接口 `registerDomainSceneRenderer()`，以及 `src/parse/domain.ts` 中按 `(h2Name, type)` 二维分发的 `parseDomainSection()`。两者共同构成 Domain Type 的扩展面——前者控制**渲染**（输出形态），后者控制**解析**（输入形态）。

Sources: [pt-asset-layering.md](docs/pt-asset-layering.md#L59-L77)

## Domain Type 在编译流水线里的位置

要把"注册新 Domain Type 渲染器"这件事讲清楚，必须先看 Domain Type 在三段式架构（parse → compile → render）中**实际影响哪些环节**：

```mermaid
flowchart LR A[domains/*.md<br/>frontmatter.type] --> B[parse/domain.ts<br/>parseDomainSection]
    B --> C[Domain IR<br/>type + modules]
    C --> D[compile/context.ts<br/>formatDomainSceneSection]
    D --> E[Context IR<br/>modules 聚合后 markdown]
    E --> F[render/system-prompt.ts<br/>renderSystemPrompt]
    F --> G[System Prompt 字符串]
```

**关键边界**：`type` 只在 `Scene` 段聚合时决定渲染形态——**不会**影响 `Manual` 段、不影响 `compileContextMessageModule`（context_message 注入点）的通用聚合逻辑、不影响 `compileFlow`（流程段）。把"加新 type"误解为"加新渲染器函数"是常见错误，实际上**整套 compile 主循环都用 `domainSceneRenderers[type]` 查表分发**，新 type 不必改 `compileContext` 主循环。

Sources: [pt-asset-layering.md](docs/pt-asset-layering.md#L59-L77), [compile/context.ts](src/compile/context.ts#L88-L101), [compile/context.ts](src/compile/context.ts#L313-L338)

## 渲染器注册表：唯一的扩展接口

`src/compile/context.ts` 第 313-338 行是整个扩展面的心脏。它由三部分组成：**类型定义**、**注册表**、**注册函数**。

```typescript
// src/compile/context.ts:313-332type DomainSceneRenderer = (
  d: Domain,
  mode: "byDomain" | "byType" | "hybrid",
  modules: string[],
) => string;

/** Domain type → Scene renderer。已注册：term / workflow / stack / glossary。
 *  扩展 type：调 registerDomainSceneRenderer("xxx", fn) 即可，不动主循环。 */
const domainSceneRenderers: Record<string, DomainSceneRenderer> = {
  term: renderTermSceneSection,
  workflow: renderWorkflowSceneSection,
  stack: renderStackSceneSection,
  glossary: renderGlossarySceneSection,
};

/** 扩展接口：加新 Domain type 只加一行注册 + 一个 renderer 函数。 */
export function registerDomainSceneRenderer(type: string, fn: DomainSceneRenderer): void {
  domainSceneRenderers[type] = fn;
}
```

注意三个要点：

1. **导出但未在 `src/compile/index.ts` 转发**——当前 `compile/index.ts` 只导出 `compileContext` 与 `computeSourceHash`，并未 re-export `registerDomainSceneRenderer`。这意味着：**新 type 的注册**必须在使用方一侧（你的 Pi 扩展、`src/index.ts` 或新增的初始化文件）显式 import 并调用，否则运行时找不到注册函数。这是 v8 当前架构的**已知扩展摩擦点**——见后文"边界与陷阱"。

2. **类型签名三个参数**：`(d, mode, modules)`。`d` 是当前 Domain 的完整 IR；`mode` 是 Channel注入点的聚合方式（byDomain/byType/hybrid），由 Channel 在 H2 下声明；`modules` 是 Channel 注入点声明的 H2 段名列表（如 `["Scene"]` 或 `["Scene", "Manual"]`），告诉 renderer 本注入点聚合哪些 H2 段。

3. **返回空字符串表示不输出**——`formatDomainSceneSection` 在 `domainSceneRenderers[d.type]` 找不到时也返回 `""`，所以"不注册 = 不输出"，与"注册并返空"语义等价。

Sources: [compile/context.ts](src/compile/context.ts#L313-L338), [compile/index.ts](src/compile/index.ts#L1-L4)

## 渲染器分发表：调度入口

`compileSystemPromptModule` 内部对每个 Domain 调用 `formatDomainSceneSection()`，由它去查表分发：

```typescript
// src/compile/context.ts:334-338

function formatDomainSceneSection(d: Domain, mode: "byDomain" | "byType" | "hybrid", modules: string[]): string {
  const fn = domainSceneRenderers[d.type];
  if (!fn) return "";  // 未注册 type：不输出
  return fn(d, mode, modules);
}
```

调用链路径：

| 层级 | 文件:行 | 职责 |
|---|---|---|
| compile入口 | [compile/context.ts:54-86](src/compile/context.ts#L54-L86) | 遍历 Channel.injectionPoints，按 Blueprint 同名匹配 |
| 注入点分发 | [compile/context.ts:88-101](src/compile/context.ts#L88-L101) | 按 `target` 分发到 system_prompt / context_message / generic |
| System Prompt 模块编译 | [compile/context.ts:105-155](src/compile/context.ts#L105-L155) | 按 mode 拼接 Trigger / 全局约束 / 流程 / Domain sections |
| Domain section 渲染调度 | [compile/context.ts:334-338](src/compile/context.ts#L334-L338) | **type → renderer 查表** |

**扩展性结论**：新 type 的渲染只影响第四层。前三层不动一行代码。

Sources: [compile/context.ts](src/compile/context.ts#L88-L155), [compile/context.ts](src/compile/context.ts#L334-L338)

## 已注册 type 的对比下面四个 built-in renderer 是 Pt v8 现有扩展面已承载的全部 type。从对比中可以看出 renderer 函数的设计契约：

| Type | 典型 H2 | 段内格式 | Renderer 函数 | 输出形态 |
|---|---|---|---|---|
| **term** | Scene | `Term[]`（公理） | [renderTermSceneSection](src/compile/context.ts#L342-L375) | `### 模块「xxx」` + 术语/规则列表 |
| **workflow** | Scene | `ExternalRef[]`（手册清单 + 数据源） | [renderWorkflowSceneSection](src/compile/context.ts#L377-L398) | `### 模块「xxx」` + 外部数据列表 |
| **stack** | Scene | `ToolRef[]`（工具引用） | [renderStackSceneSection](src/compile/context.ts#L400-L403) | 返回 `""`（stack 工具由聚合段统一输出） |
| **glossary** | Scene | `{name, desc}[]` | [renderGlossarySceneSection](src/compile/context.ts#L405-L420) | `### 术语表「xxx」` + 通用条目 |

观察 **glossary** 这一行——它就是 Phase 5.5 的扩展性验证 type，证明"加新 type 不改主循环"是可工作的。`tests/verify/verify-phase77.ts` 第 4 节专门测试 `glossary-test` scene出现且 `pt` scene 不污染。

Sources: [compile/context.ts](src/compile/context.ts#L313-L420), [verify-phase77.ts](tests/verify/verify-phase77.ts#L77-L84)

## 渲染器函数的最小实现模板

把以上 contract 翻译成代码——一个最小可工作的 renderer 长这样：

```typescript
// src/compile/my-type-renderer.ts （新建文件）

import type { Domain } from "../schema.js";
import type { DomainSceneRenderer } from "./context.js";

/**
 * mytype类型的 Domain Scene 渲染器 * - 与 term 不同：term 输出"术语"小节；mytype 输出"特性"小节
 * - 与 workflow 不同：workflow 只列数据源；mytype 列出每个特性的描述
 */
export const renderMytypeSceneSection: DomainSceneRenderer = (d, mode, modules) => {
  const lines: string[] = [`###特性表「${d.name}」`];
  let any = false;

  for (const modName of modules) {
    const content = d.modules[modName];
    if (content === undefined) continue;

    // 复用 glossary 风格的通用聚合：要求 content 是 {name, desc}[] 形态
    if (Array.isArray(content)) {
      for (const t of content as Array<{ name: string; desc: string }>) {
        if (t.desc) lines.push(`- **${t.name}**：${t.desc}`);
        else lines.push(`- **${t.name}**`);
        any = true;
      }
    }
  }

  return any ? lines.join("\n").trimEnd() : "";
};
```

三条设计约束（来自 v8 已注册的四个 renderer 的归纳）：

- **`any` 哨兵**：没产出任何内容时返 `""`，避免输出孤立标题。这与 `renderWorkflowSceneSection` 第 397 行 `return any ? lines.join("\n").trimEnd() : "";` 一致。
- **`mode`决定渲染粒度**：byDomain（当前 domain 内独立小节）/ byType（按 type 跨域聚合，但当前 renderer仍按域输出，最终聚合由 `renderAggregatedTerms` / `renderAggregatedRules` 处理——见 [compile/context.ts:437-451](src/compile/context.ts#L437-L451)）/ hybrid（混合，byDomain 逻辑 + 全局约束）。
- **`modules` 是过滤白名单**：renderer **不应**渲染 `modules` 之外的 H2 段名——Channel 的 `### Modules` 列表才是权威。

Sources: [compile/context.ts](src/compile/context.ts#L342-L420), [compile/context.ts](src/compile/context.ts#L437-L468)

## 完整注册步骤（端到端）

加一个新 Domain Type 不止是写 renderer——还要在**解析侧**同步扩展，否则 `parseDomainSection` 会把新 H2 段解析成 term形态，与 renderer 期望的结构不一致。

```mermaid
flowchart TD S1[1. 在 parse/domain.ts<br/>parseDomainSection 加 case]
    S2[2. 写新 md资产<br/>frontmatter.type: mytype]
    S3[3. 在 compile/context.ts<br/>添加 renderer + 注册到表]
    S4[4. 在 src/index.ts 或初始化处<br/>调用 registerDomainSceneRenderer]
    S5[5. 加 verify 用例]
    S1 --> S2 --> S3 --> S4 --> S5
```

### 步骤 1：扩展 parse侧分发表

`parseDomainSection` 在 `src/parse/domain.ts` 第 43-76 行是 `(h2Name, type)` 二维 switch。**新 type 必须在此显式加入**，否则解析走 `default` 分支（term fallback），与 renderer 期望解构冲突。

```typescript
// src/parse/domain.ts:43-76 — 在 parseDomainSection 的 switch (h2Name) 内switch (h2Name) {
  case "Scene":
    switch (type) {
      case "term": return toTerms(items);
      case "workflow": return { externals: toExternals(items) };
      case "stack": return toTools(items);
      case "glossary": return toMyTypeItems(items);  // ← 新增分支
      default: return toTerms(items);
    }
  // ...
}
```

**何时可以跳过这一步**？如果新 type 的 `## Scene` 段内格式与 `term` 完全一致（都是 `{name, desc}[]`）——可以借用现有 fallback。但 renderer 必须能容忍 fallback 形态的 content 结构。

Sources: [parse/domain.ts](src/parse/domain.ts#L43-L76), [parse/domain.ts](src/parse/domain.ts#L80-L82)

### 步骤 2：编写新 Domain 资产

```markdown
<!-- .pt/assets/domains/feature-foo.md -->
---
type: mytype
name: feature-foo
---

# feature-foo

## Scene
### 并发安全
- desc: 同一 Blueprint 内不支持并发转译；切换 Blueprint 时串行执行。

### 可观测性
- desc: 通过 /pt status 查看 cache hit、segment length、active blueprint。
```

**frontmatter.type 必须严格匹配**——`parseDomain` 第 27 行 `const type = typeof asset.frontmatter.type === "string" ? asset.frontmatter.type : "term";`，未指定 type 时 fallback 到 `"term"`，这会让你的新 Domain 在 compile 阶段按 term 渲染。

Sources: [parse/domain.ts](src/parse/domain.ts#L25-L40), [.pt/assets/domains/glossary-test.md](.pt/assets/domains/glossary-test.md#L1-L16)

### 步骤 3：写 renderer 函数并注册

按上一节给出的模板实现 `renderMytypeSceneSection`。然后在 `compile/context.ts` 第 322-327 行的注册表里加一行：

```typescript
const domainSceneRenderers: Record<string, DomainSceneRenderer> = {
  term: renderTermSceneSection,
  workflow: renderWorkflowSceneSection,
  stack: renderStackSceneSection,
  glossary: renderGlossarySceneSection,
  mytype: renderMytypeSceneSection,  // ← 新增
};
```

**注意**：这一步是**编译期静态注册**。如果你的 renderer 函数需要运行时动态注入（不同 Blueprint 用不同 renderer），必须在下一步用 `registerDomainSceneRenderer` 替换。

Sources: [compile/context.ts](src/compile/context.ts#L320-L332)

### 步骤 4：保证运行时可达

当前 `src/compile/index.ts` 只导出 `compileContext` 与 `computeSourceHash`，**没有 re-export `registerDomainSceneRenderer`**。这意味着三种补救路径：

| 路径 | 适用场景 | 实现位置 |
|---|---|---|
| **A. 编译期注册** | 新 type 是项目内置 | 直接修改 `domainSceneRenderers` 表（步骤 3 已覆盖） |
| **B. 运行时注册（模块 import）** | Pt 是被外部项目依赖 | 在 `src/index.ts` 入口顶部 `import { registerDomainSceneRenderer } from "./compile/context.js";` 后立即调用 |
| **C. 运行时注册（从 `compile/index.ts` 透传）** | 推荐——消除摩擦 | 在 `compile/index.ts` 添加 `export { registerDomainSceneRenderer } from "./context.js";` |

**推荐先做 C**——这是 v8 现有扩展接口的完整化，零行为变化。同时为将来 plugin 化（Pt 被外部业务包引用）铺路。

Sources: [compile/index.ts](src/compile/index.ts#L1-L4), [src/index.ts](src/index.ts#L1-L14)

### 步骤 5：写 verify 用例

参考 `tests/verify/verify-phase77.ts` 第 4 节"扩展性验证：glossary 假 type"的模式：

```typescript
// tests/verify/verify-mytype.ts

import { loadAndTranspile } from "../../src/transpile.js";
const cwd = process.cwd();

const r = await loadAndTranspile(cwd, "mytype-test-blueprint");
console.assert(
  r.segment.includes("特性表「feature-foo」"),
  "新 type 应被 renderer 渲染"
);
console.assert(
  !r.segment.includes("术语表"),  // 不污染其他 type
  "新 type 不应影响其他 type 输出"
);
```

并把新 Blueprint 上下文（`.pt/assets/blueprints/mytype-test.blueprint.md`）的 `injectionPoints` 至少包含一个 `target: system_prompt` 的注入点，让 `compileSystemPromptModule` 真正进入 `formatDomainSceneSection` 调度。

Sources: [verify-phase77.ts](tests/verify/verify-phase77.ts#L77-L84)

## 注册失败的常见原因（陷阱清单）

| 症状 | 根因 | 检查路径 |
|---|---|---|
| Domain 没出现在 System Prompt | `type` 拼写错或未声明 | 读 Domain frontmatter 第 2 行 |
| 渲染了但格式不对 | `parseDomainSection` 没加 case，走了 term fallback | 检查 `src/parse/domain.ts` switch (h2Name) 内是否有 `case "mytype"` |
| Renderer 函数找不到 | `registerDomainSceneRenderer` 未在运行时调用 | 检查 `src/index.ts` 或 `compile/index.ts` 是否 export 并调用 |
| `formatDomainSceneSection` 返 `""` | renderer内部 `any` 哨兵未触发（content 解析为空） | 检查 `d.modules` 内 `modName` 对应的内容；通常 frontmatter 解析或 H2 段名拼写问题 |
| 新 type 污染其他 Blueprint | renderer 没读 `modules` 白名单，渲染了未声明的 H2 | renderer 内 `for (const modName of modules)` 必须作为外层过滤 |

Sources: [compile/context.ts](src/compile/context.ts#L334-L338), [compile/context.ts](src/compile/context.ts#L437-L468)

## 与上下文相关的扩展路径

注册新 Domain Type 渲染器只是 v8 扩展面的一部分。下表帮你判断下一步该跳到哪一页：

| 你想做的事 | 跳转到 |
|---|---|
| 加新 Domain Type 的**解析**逻辑（content 形态） | 本页步骤 1 |
| 加新 Domain Type 的**渲染**逻辑（markdown 输出） | 本页步骤 3-4 |
| 加新 Channel 注入点（target=system_prompt 之外） | [中端编译：按注入点聚合与 mode 渲染](14-zhong-duan-bian-yi-an-zhu-ru-dian-ju-he-yu-mode-xuan-ran) |
| 加新 Source Adapter（OXN 之外的资产来源） | [接入新的 Source Adapter（多来源转译）](19-jie-ru-xin-de-source-adapter-duo-lai-yuan-zhuan-yi) |
| 理解 schema 设计哲学（为什么 type 不带格式痕迹） | [Schema 与 IR 契约（src/schema.ts）](12-schema-yu-ir-qi-yue-src-schema-ts) |
| 完整跑一次端到端验证 | [端到端验证流程与回归用例](20-duan-dao-duan-yan-zheng-liu-cheng-yu-hui-gui-yong-li) |

## 一句话总结

**新 Domain Type = `parse/domain.ts` 加 case + `compile/context.ts` 加 renderer（静态）或 `registerDomainSceneRenderer()`（运行时） + 新 md 资产 + verify 用例**。整个过程中 `compileContext`、`renderSystemPrompt`、`compileContextMessageModule` 一行都不动——这正是 v8 在 `compile/context.ts:329` 注释里说的"加新 Domain type 只加一行注册 + 一个 renderer 函数"的本意。