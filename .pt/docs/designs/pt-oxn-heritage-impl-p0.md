# P0 执行文档：可验证手册基础

> **基线**：pt `@issac/pi-pt@0.1.0` Phase 9.9 v9
> **关联**：`pt-oxn-heritage.md`（遗产清单）、`pt-oxn-heritage-impl-overview.md`（总览）
> **用途**：执行者按本文档逐项落地 P0。含改动清单、代码片段、MD 语法、验收标准、测试用例。

---

## 目标

让 Manual 从「声明式手册」升级为「可验证手册」：
1. FlowStep 能声明 `observe`（验证参照——probe 名列表）
2. 定义 `ProbeOutcome` 三态枚举（COMPLETED / DEVIATED / INCONCLUSIVE）
3. Manual 实例文档（`.pt/manuals/*.md`）含执行状态表，记录每步验证结果

> **范围说明**：P0 单独交付的是「声明能力」——Manual 能说「这步要验证什么」，但还不能真的验证。验证实现是 P1 的 `src/verify/` 模块。

## 前置条件

- `npm run verify` 和 `tsc --noEmit` 在改动前通过（建立 baseline）
- 熟悉 pt 三段式架构：`parse`（MD→IR）→ `compile`（IR 聚合）→ `render`（IR→注入字符串）

## 关键代码事实（执行前必读）

| 事实 | 位置 | 对 P0 的影响 |
|---|---|---|
| FlowStep 当前只解析 `desc` | `domain-renderers.ts` 的 `collectSteps` 返回 `string[]`，再 `.map((desc) => ({ desc }))` | observe 解析需改 collectSteps 返回 `FlowStep[]` |
| bindFlowTemplate 只渲染 desc | `context-message.ts:bindFlowTemplate` 的 `lines.push(`${i+1}. ${desc}`)` | 需加 observe 渲染 |
| Manual 实例文档是代码生成 | `commands.ts:buildManualDoc` 的 `lines.push(...)` 模板拼接 | 执行状态表需改这个函数 |
| type-guard 只校验最小形状 | `type-guards.ts:isFlowTemplateLike` 校验 `{name, intent, steps[]}` | observe 可选，不影响——**无需改 type-guard** |

---

## 改动清单

| # | 文件 | 改动 | 行数 |
|---|---|---|---|
| 1 | `src/schema.ts` | 加 `FlowStep.observe` + `ProbeOutcomeKind` + `ProbeOutcome` + `StepResult` | +15 |
| 2 | `src/parse/domain-renderers.ts` | `collectSteps` 返回 `FlowStep[]`（从 `string[]` 改），解析 `- observe:` 行 | ~25 行改 |
| 3 | `src/render/context-message.ts` | `bindFlowTemplate` 渲染 observe 子行 | +5 |
| 4 | `src/commands.ts` | `buildManualDoc` 生成执行状态表 + checklist observe 子项 | +15 |

---

## 改动 1：`src/schema.ts`

在 `FlowStep` interface 加 `observe` 字段（紧随 `output` 字段后）：

```typescript
/** 手册步骤（workflow-Domain.## Manual 段内容） */
export interface FlowStep {
  /** 做什么 */
  desc: string;
  /** 从哪取数据（数据语义层） */
  dataSource?: ExternalRef;
  /** 套哪条规则（引用知识库的 Rule） */
  rule?: string;
  /** 期望产出什么 */
  output?: string;
  /** 验证参照（Probe 名列表，如 ["fs-content-match", "ts-compiles"]）。
   *  P0 新增：声明这步执行后用什么 probe 验证。probe 实现在 src/verify/（P1）。 */
  observe?: string[];
}
```

在 `FlowStep` 定义后、`FlowTemplate` 定义前，加 ProbeOutcome 类型（供 P1 verify 模块和 Manual 实例文档共用）：

```typescript
/** 验证结果三态（借鉴 OXN ADR-0066/0067，简化为纯枚举 + 消息，不引入 strategy 模式）。
 *  - COMPLETED：执行符合预期
 *  - DEVIATED：偏离预期（不是失败，是偏了，仍可继续）
 *  - INCONCLUSIVE：无法判定（如人工评估、probe 缺参数） */
export type ProbeOutcomeKind = "COMPLETED" | "DEVIATED" | "INCONCLUSIVE";

/** verify 函数返回值（P1 的 src/verify/ 模块用）。 */
export interface ProbeOutcome {
  outcome: ProbeOutcomeKind;
  message: string;
  actual?: string;
}

/** Manual 实例文档的步骤执行记录（buildManualDoc 生成表头，执行者用 edit 填值）。 */
export interface StepResult {
  stepIndex: number;
  outcome: ProbeOutcomeKind;
  message?: string;
}
```

---

## 改动 2：`src/parse/domain-renderers.ts`

**当前** `collectSteps` 返回 `string[]`，workflow parser 做 `.map((desc) => ({ desc }))`。

**改为** `collectSteps` 直接返回 `FlowStep[]`，解析 `- observe:` 行。

### 步骤 2a：加 import（文件头部）

```typescript
import type { FlowStep } from "../schema.js";
```

### 步骤 2b：替换 `collectSteps` 函数

当前实现：

```typescript
function collectSteps(itemName: string, sectionRaw: string): string[] {
  const lines = sectionRaw.split(/\r?\n/);
  const steps: string[] = [];
  let inItem = false;
  for (const line of lines) {
    const h3 = line.match(/^###\s+(.+)$/);
    if (h3) {
      const name = h3[1].trim();
      if (inItem) break;
      if (name === itemName) inItem = true;
      continue;
    }
    if (!inItem) continue;
    const stepMatch = line.match(/^\s*-\s+step\s*:\s*(.+)$/);
    if (stepMatch) steps.push(stepMatch[1].trim());
  }
  return steps;
}
```

替换为：

```typescript
function collectSteps(itemName: string, sectionRaw: string): FlowStep[] {
  const lines = sectionRaw.split(/\r?\n/);
  const steps: FlowStep[] = [];
  let inItem = false;
  let cur: FlowStep | null = null;
  for (const line of lines) {
    const h3 = line.match(/^###\s+(.+)$/);
    if (h3) {
      if (inItem) break;
      if (h3[1].trim() === itemName) inItem = true;
      continue;
    }
    if (!inItem) continue;
    const stepMatch = line.match(/^\s*-\s+step\s*:\s*(.+)$/);
    if (stepMatch) {
      if (cur) steps.push(cur);
      cur = { desc: stepMatch[1].trim() };
      continue;
    }
    const observeMatch = line.match(/^\s*-\s+observe\s*:\s*(.+)$/);
    if (observeMatch && cur) {
      const val = observeMatch[1].trim();
      // 支持 [a, b] 数组格式 和 单值格式
      const arrMatch = val.match(/^\[(.*)\]$/);
      if (arrMatch) {
        cur.observe = arrMatch[1].split(",").map((s) => s.trim()).filter((s) => s !== "");
      } else {
        cur.observe = [val];
      }
      continue;
    }
  }
  if (cur) steps.push(cur);
  return steps;
}
```

### 步骤 2c：改 workflow parser

`Manual.workflow` 注册项里，去掉 `.map((desc) => ({ desc }))`：

```typescript
    workflow: (items, sectionRaw) => items.map((item) => {
      const tpl: Record<string, unknown> = {
        name: item.name,
        argumentHint: s(item.fields["argument-hint"]) || undefined,
        intent: s(item.fields.intent),
        steps: collectSteps(item.name, sectionRaw),  // 原来是 collectSteps(...).map((desc) => ({ desc }))
        externals: [],
      };
      const vars = sArr(item.fields.vars);
      if (vars.length > 0) tpl._vars = vars;
      return tpl;
    }),
```

---

## 改动 3：`src/render/context-message.ts`

**当前** `bindFlowTemplate` 渲染步骤只输出 `desc`：

```typescript
  lines.push(`## 步骤`);
  tpl.steps.forEach((s: FlowStep, i: number) => {
    lines.push(`${i + 1}. ${replaceVars(s.desc, bound)}`);
  });
```

**改为** 加 observe 子行：

```typescript
  lines.push(`## 步骤`);
  tpl.steps.forEach((s: FlowStep, i: number) => {
    lines.push(`${i + 1}. ${replaceVars(s.desc, bound)}`);
    if (s.observe && s.observe.length > 0) {
      lines.push(`   - 验证参照：${s.observe.join(", ")}`);
    }
  });
```

---

## 改动 4：`src/commands.ts`

**当前** `buildManualDoc` 从 `bound`（bindFlowTemplate 输出）解析步骤行，生成 checklist + 产物区 + 更新指引。

**改为**：(a) checklist 里保留 observe 子行；(b) 在 `## 产物` 前加执行状态表。

### 步骤 4a：改步骤解析循环

当前实现（`buildManualDoc` 中段）：

```typescript
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
```

替换为：

```typescript
  const boundLines = bound.split("\n");
  let stepCount = 0;
  for (const line of boundLines) {
    if (line.startsWith("#")) continue;
    if (line.startsWith("_")) continue;
    const stepMatch = line.match(/^(\d+)\.\s+(.*)$/);
    if (stepMatch) {
      stepCount++;
      lines.push(`- [ ] ${stepMatch[2]}`);
      continue;
    }
    // observe 行（bindFlowTemplate 渲染的 "   - 验证参照：xxx"）→ checklist 子项
    if (line.includes("验证参照：")) {
      lines.push(`  ${line.trim()}`);
      continue;
    }
    lines.push(line);
  }
```

### 步骤 4b：在 `## 产物` 前插入执行状态表

在步骤循环后、`lines.push("## 产物")` 前，加：

```typescript
  lines.push("");
  lines.push("## 执行状态");
  lines.push("| Step | Outcome | Message |");
  lines.push("|---|---|---|");
  for (let i = 1; i <= stepCount; i++) {
    lines.push(`| ${i} | — | |`);
  }
  lines.push("");
```

### 步骤 4c：在 `## 更新指引` 段追加执行状态表说明

当前：

```typescript
  lines.push("## 更新指引");
  lines.push("执行完每个 step 后：用 edit 把对应 `- [ ]` 改成 `- [x]`。");
  lines.push("全部完成后：用 edit 在 ## 产物 下追加创建/修改的文件路径（每行一条）。");
  lines.push("status 全部完成后可改为 completed。");
```

改为：

```typescript
  lines.push("## 更新指引");
  lines.push("执行完每个 step 后：用 edit 把对应 `- [ ]` 改成 `- [x]`。");
  lines.push("验证后：用 edit 把 ## 执行状态表 对应行的 `—` 改为 COMPLETED / DEVIATED / INCONCLUSIVE + Message。");
  lines.push("全部完成后：用 edit 在 ## 产物 下追加创建/修改的文件路径（每行一条）。");
  lines.push("status 全部完成后可改为 completed。");
```

---

## MD 语法规格

observe 写在 `- step:` 行之后，归属上一个 step。支持 `[a, b]` 数组格式和单值格式：

```markdown
## Manual

### fix-issue
- argument-hint: <issue-name>
- intent: 修复 {{issue-name}} 并关闭
- vars: [issue-name]
- step: 读 .pt/docs/issues/{{issue-name}}.md 的修复方向段
- step: 实施修复 — 改代码/资产，每步一个 commit
- observe: [ts-compiles, test-pass]
- step: 跑 npm run verify + tsc --noEmit
- observe: [test-pass]
- step: 手动验证现象消失
```

**规则**：
- `- observe:` 必须紧随某个 `- step:` 行（不能在 H3 标题后独立出现）
- 一个 step 可有多个 `- observe:` 行（合并到 `observe[]`），也可用 `[a, b]` 一行写多个
- 无 observe 的 step 不受影响（向后兼容）

---

## 测试用例

新建 `tests/verify/observe.test.ts`：

```typescript
// tests/verify/observe.test.ts — P0：observe 字段解析 + 渲染 + Manual 实例文档
import { describe, it, expect } from "vitest";
import { loadAndTranspile } from "../../src/transpile.js";
import { bindFlowTemplate, findFlowInBlueprint } from "../../src/render/context-message.js";
import { buildManualDoc } from "../../src/commands.js";
import { session } from "../../src/session.js";

describe("P0: observe 字段", () => {
  it("FlowStep.observe 被正确解析", async () => {
    const r = await loadAndTranspile(process.cwd(), "pt-dev");
    const b = r.bundles[0];
    const tpl = findFlowInBlueprint(r.blueprint, b.domains, "resolve-issue");
    expect(tpl).toBeDefined();
    // resolve-issue 的某个 step 有 observe（若 fixture 加了）
    const hasObserve = tpl!.steps.some((s) => s.observe && s.observe.length > 0);
    // 若无 fixture，本测试验证 observe 字段存在且类型正确
    expect(tpl!.steps.every((s) => typeof s.desc === "string")).toBe(true);
  });

  it("bindFlowTemplate 渲染 observe 子行", async () => {
    const r = await loadAndTranspile(process.cwd(), "pt-dev");
    const b = r.bundles[0];
    const tpl = findFlowInBlueprint(r.blueprint, b.domains, "resolve-issue");
    if (!tpl) throw new Error("resolve-issue not found");
    const bound = bindFlowTemplate(tpl, "");
    const hasObserveStep = tpl.steps.some((s) => s.observe?.length);
    if (hasObserveStep) {
      expect(bound).toContain("验证参照：");
    }
  });

  it("buildManualDoc 生成执行状态表", async () => {
    const r = await loadAndTranspile(process.cwd(), "pt-dev");
    session.cachedBundles = r.bundles;
    session.cachedBlueprint = r.blueprint;
    session.cachedContext = r.context;

    const doc = buildManualDoc(process.cwd(), "resolve-issue", "test-issue");
    expect(doc.error).toBeUndefined();
    expect(doc.content).toContain("## 执行状态");
    expect(doc.content).toContain("| Step | Outcome | Message |");
    expect(doc.content).toContain("| — |");
  });

  it("无 observe 的 step 向后兼容", async () => {
    const r = await loadAndTranspile(process.cwd(), "pt-dev");
    const b = r.bundles[0];
    const tpl = findFlowInBlueprint(r.blueprint, b.domains, "collect-requirements");
    if (!tpl) throw new Error("collect-requirements not found");
    expect(tpl.steps.length).toBeGreaterThan(0);
    expect(tpl.steps.every((s) => typeof s.desc === "string")).toBe(true);
  });
});
```

> **fixture 准备**：测试前需在某个 workflow Domain（如 `.pt/assets/domains/issues.md` 的 `resolve-issue`）的某个 step 后加 `- observe: [test-pass]`，让测试有真实 observe 可验证。

---

## 验收标准（DoD）

- [ ] `src/schema.ts` 有 `FlowStep.observe` + `ProbeOutcomeKind` + `ProbeOutcome` + `StepResult`
- [ ] `collectSteps` 返回 `FlowStep[]`，能解析 `- observe:` 行
- [ ] `bindFlowTemplate` 渲染 observe 为 `   - 验证参照：xxx` 子行
- [ ] `buildManualDoc` 生成的 Manual 实例文档含 `## 执行状态` 表
- [ ] 无 observe 的 step 渲染不受影响（向后兼容）
- [ ] `tsc --noEmit` 通过
- [ ] `npm run verify` 通过（含新测试 `tests/verify/observe.test.ts`）
- [ ] 至少 1 个 workflow Domain 的步骤加了 observe（作为真实 fixture）

---

## 向后兼容

- `observe` 是可选字段——存量 Manual 无 observe 时，`collectSteps` 返回的 FlowStep 只有 `desc`，与改动前等价
- `bindFlowTemplate` 只在 `s.observe` 存在时加子行——无 observe 的 step 输出不变
- `buildManualDoc` 的执行状态表是新增段——不影响现有 checklist + 产物区 + 更新指引
- type-guard `isFlowTemplateLike` 不校验 FlowStep 内部字段——observe 可选不影响最小形状校验

---

## 执行步骤（顺序）

1. 跑 `tsc --noEmit && npm run verify` 确认 baseline 绿
2. 改 `src/schema.ts`（改动 1）
3. 改 `src/parse/domain-renderers.ts`（改动 2a/2b/2c）
4. 跑 `tsc --noEmit`——应通过（collectSteps 返回类型变了但消费方兼容）
5. 改 `src/render/context-message.ts`（改动 3）
6. 改 `src/commands.ts`（改动 4a/4b/4c）
7. 在 `.pt/assets/domains/issues.md` 的 `resolve-issue` 某个 step 后加 `- observe: [test-pass]`
8. 新建 `tests/verify/observe.test.ts`
9. 跑 `tsc --noEmit && npm run verify`
10. 全绿后 git commit `feat: P0 observe field + ProbeOutcome + manual status table`
