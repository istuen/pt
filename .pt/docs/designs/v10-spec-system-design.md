# V10 Spec 系统设计：type-as-spec（按用户洞察）

> **基线 commit**：`fd3ac05`（docs: add P3+P4 executor brief...）— HEAD 起点
> **触发洞察**：用户指出"加 type 实际是加 MD 解析规范，不是加 type 字符串"
> **目标**：v9 type-as-string 升级为 v10 type-as-spec——用户可在自己项目内定义 MD 解析规范
> **状态**：v10 设计文档（**不立即实现**，等 P3+P4 完成后另起实现 brief）

---

## 1. 背景与动机

### 1.1 v9 现状（type-as-string）

v9 当前 type 是 frontmatter 里的字符串标识符：

```yaml
---
type: workflow         # 字符串
---
```

type 字符串隐含的"规范"散落在 pt 源码 6+ 个文件：

| 规范层 | 位置 | 数量 |
|---|---|---|
| Scene 段 parse 规则 | `src/parse/domain-renderers.ts` | 3 type × 1 段 |
| Manual 段 parse 规则 | `src/parse/domain-renderers.ts` | 3 type × 1 段 |
| Scene 段 render 规则 | `src/compile/context.ts:166` `renderSceneModule` | 3 type switch case |
| Manual 段 render 规则 | `src/compile/context.ts:220` `renderManualModule` | 3 type switch case |
| Manual 段 render 规则 | `src/render/context-message.ts:76` `renderDomainManual` | 3 type switch case |
| type guard | `src/compile/type-guards.ts` | 3 type × 2 段 = 6 guard |

**v9 的"扩展性"是为 pt 开发者预留的，不是为终用户**——加新 type 必须改 pt 源码 + 重新构建。

### 1.2 用户痛点

终用户用构建后的 pt（dist/index.js 或 src/index.ts），想加新 type（如 "schema"）时：
- ❌ **必须**提 issue，等新版构建
- ❌ **不能**在自己项目内定义新 type
- ❌ **不能** fork pt 后只在自己 fork 内加

这是 v9 模型的**根本限制**——不是 P3.1（注册表化）能解决的。

### 1.3 设计洞察

> "type 本身代表一种文档的解析规范。如果要自定义扩展，实际增加的不是 type 值，而是 type 对应的解析规范。"

**type 字符串只是规范的名字**——真正的"规范本体"（MD 怎么解析 + 怎么渲染）应该被外部定义。

---

## 2. 设计目标

**v10 把 type 从"字符串标识符"升级为"自描述规范包"**：

| 维度 | v9 | v10 |
|---|---|---|
| type 字符串 | pt 内置白名单（term/workflow/stack）| 任意字符串（用户自定义） |
| 规范定义位置 | pt 源码 6+ 文件 | 用户 `.pt/specs/*.ts` 1 文件 |
| 加新 type 改 pt 源码 | 必须（3-6 文件）| **0 改** |
| 加载时机 | 编译期 | 运行时（pt 启动时） |
| 规范可见性 | pt 内部隐藏 | 公开 API（`@issac/pi-pt/spec`） |

---

## 3. Spec 形态定义

### 3.1 用户视角：写一份 spec

`.pt/specs/schema.ts`（用户文件）：

```typescript
import type { Spec, SectionSpec } from "@issac/pi-pt/spec";

const Scene: SectionSpec = {
  // 怎么从 MD H3 项解析成 IR
  parse: (items) => items.map(it => ({
    name: it.name,
    type: s(it.fields.type) || "string",
    desc: s(it.fields.desc),
    required: s(it.fields.required) === "true",
  })),

  // 怎么从 IR 渲染成 markdown
  render: (content) => content.map(f =>
    `- ${f.name}${f.required ? " (required)" : ""}: ${f.type} — ${f.desc}`
  ).join("\n"),

  // runtime type guard（可选，缺省时不强校验）
  guard: (x): x is Field[] => Array.isArray(x) && x.every(isFieldLike),
};

const Manual: SectionSpec = {
  parse: () => [],
  render: () => "",
  guard: () => true,
};

export default {
  name: "schema",           // 资产 frontmatter.type: schema
  sections: {
    Scene,                  // 哪些 H2 段参与
    Manual,
    // 未来：Trigger, ...（按 spec 声明）
  },
} satisfies Spec;
```

### 3.2 API 暴露（pt 公开包）

```typescript
// @issac/pi-pt/spec 命名空间

export interface SectionSpec<T = unknown> {
  /** MD H3 items → IR */
  parse: (items: Item[]) => T;
  /** IR → markdown string */
  render: (content: T) => string;
  /** runtime type guard（可选） */
  guard?: (x: unknown) => x is T;
}

export interface Spec {
  /** 规范名（资产 frontmatter.type 用） */
  name: string;
  /** 该规范处理的 H2 段名 → SectionSpec */
  sections: Record<string, SectionSpec>;
}

export function registerSpec(spec: Spec): void;
export function getSpec(name: string): Spec | undefined;
export function listSpecs(): string[];

// Item 类型（从 .pt/specs 内部用）
export interface Item {
  name: string;
  fields: Record<string, unknown>;
}
```

### 3.3 用户资产

```yaml
---
type: schema              # ← 对应 .pt/specs/schema.ts
name: user-domain
---

## Scene
- [field-one](field-one.md) 第一个字段
  - type: string
  - required: true
- [field-two](field-two.md) 第二个字段
  - type: int
```

---

## 4. pt 核心改动（v10）

### 4.1 spec loader

`src/spec/loader.ts`（新建）：

```typescript
import { registerSpec, type Spec } from "@issac/pi-pt/spec";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

/** 扫描 .pt/specs/*.ts 并注册。
 *  加载时机：transpile 之前（session_start）。 */
export async function loadUserSpecs(cwd: string): Promise<void> {
  const dir = join(cwd, ".pt/specs");
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return;  // 无 .pt/specs 目录，跳过
  }
  for (const f of files.filter(f => f.endsWith(".ts"))) {
    const mod = await import(join(dir, f));
    const spec = mod.default as Spec;
    if (spec?.name) registerSpec(spec);
  }
}
```

### 4.2 调度（compile + render 改写）

`src/compile/context.ts`（v10 改写）：

```typescript
import { getSpec } from "@issac/pi-pt/spec";

// 替代 v9 的 moduleRenderers: Record<modName, ModuleRenderer>
function dispatchSection(
  d: Domain,
  modName: string,
  content: unknown,
  mode?: StructureLayout["mode"]
): string | null {
  const spec = getSpec(d.type);              // 查用户定义的 spec
  if (!spec) return genericFallback(d, modName, content);
  const sectionSpec = spec.sections[modName];
  if (!sectionSpec) return null;
  if (sectionSpec.guard && !sectionSpec.guard(content)) return null;
  return sectionSpec.render(content);
}
```

main 循环（v10 简化）：

```typescript
for (const modName of ipConfig.modules) {
  const content = d.modules[modName];
  if (content === undefined) continue;
  const rendered = dispatchSection(d, modName, content, ipConfig.mode);
  if (rendered) modParts.push(rendered);
}
```

### 4.3 解析（parse 改写）

`src/parse/domain.ts`（v10 改写）：

```typescript
import { getSpec } from "@issac/pi-pt/spec";

function parseDomainSection(h2Name, items, sectionRaw, type): unknown {
  const spec = getSpec(type);
  if (spec?.sections[h2Name]) {
    return spec.sections[h2Name].parse(items);
  }
  // v9 兼容：内置 (h2Name × type) 组合仍走 domainSectionRenderers
  const v9parser = getDomainSectionParser(h2Name, type);
  if (v9parser) return v9parser(items, sectionRaw);
  // v9 兼容：fallback Term[]
  return fallbackTerms(items);
}
```

### 4.4 v9 内置 spec 改造

`src/builtin/specs/term.ts`（v10 新建，把 v9 term 的 6 段规范打包）：

```typescript
import type { Spec } from "@issac/pi-pt/spec";

export default {
  name: "term",
  sections: {
    Scene: { parse, render, guard: isTermArray },
    Manual: { parse, render, guard: isRuleArray },
    Trigger: { parse, render, guard: isTriggerItemArray },
  },
} satisfies Spec;
```

类似 `workflow.ts` / `stack.ts` —— v9 的 3 个内置 type 转成 v10 spec 形式，pt 启动时自动注册。

---

## 5. 兼容性策略

### 5.1 v9 → v10 资产兼容

v9 资产（`type: term/workflow/stack`）在 v10 下**继续工作**——pt 启动时自动注册内置 spec（`term` / `workflow` / `stack`）。

### 5.2 v9 → v10 资产 type guard 兼容

`type-guards.ts`（v10 保留，但 export 形式变 spec.sectionSpec.guard）：

```typescript
// v9
export function isTermArray(x): x is Term[] { ... }

// v10（保留 v9 export，spec 内部也用同一函数）
export const isTermArray = (x): x is Term[] => ...;
```

`isTermArray` 仍 export 给用户用，但同时作为内置 term spec 的 `Scene.guard`。

### 5.3 v9 → v10 渲染兼容

`renderSceneModule` / `renderManualModule` / `renderDomainManual` 的 switch-case 在 v10 下**保留**——但降级为内置 spec 的 render 实现（v9 行为 = v10 内置 spec 行为）。

v9 资产在 v10 下走内置 spec，输出**与 v9 一致**——P3+P4 的测试套全过。

### 5.4 用户 spec 优先级

- 用户 `.pt/specs/<name>.ts` 覆盖 pt 内置同名 spec（如用户写 `term.ts` 覆盖 v10 内置）
- 加载顺序：先内置 spec（启动时），后用户 spec（覆盖同名）
- 命名冲突提示：slog warn 提示

---

## 6. 公开 API 设计

### 6.1 package.json exports

```jsonc
{
  "exports": {
    ".": "./dist/index.js",
    "./spec": "./dist/spec/index.js",      // ← 新增
    "./runtime": "./dist/runtime/index.js"  // ← 新增
  }
}
```

### 6.2 spec 子包导出

```typescript
// @issac/pi-pt/spec
export type { Spec, SectionSpec, Item };
export { registerSpec, getSpec, listSpecs };
```

### 6.3 runtime 子包导出

```typescript
// @issac/pi-pt/runtime
export { loadUserSpecs, transpile, loadAndTranspile };
export { AgentAdapter, SourceAdapter };  // 已有
```

### 6.4 用户导入方式

```typescript
// 用户 spec 文件
import type { Spec, SectionSpec } from "@issac/pi-pt/spec";
import { registerSpec } from "@issac/pi-pt/spec";
import { s } from "@issac/pi-pt/runtime";
```

---

## 7. 验收标准

### 7.1 用户视角

- [ ] 用户写 `.pt/specs/schema.ts` 定义新 type "schema"
- [ ] 用户写资产 `type: schema`，pt 编译成功
- [ ] 用户 `Scene` / `Manual` 段按用户 spec 解析 + 渲染
- [ ] pt 核心源码 0 改动（除新增 spec 加载器）

### 7.2 兼容性

- [ ] v9 资产（`type: term/workflow/stack`）在 v10 下行为不变
- [ ] v9 全部 162 tests 在 v10 下通过
- [ ] v9 type-guards.ts 仍 export（用户已 import 的 API 不破）

### 7.3 工程指标

- [ ] pt 核心 `src/compile/context.ts` `switch (d.type)` = 0
- [ ] pt 核心 `src/render/context-message.ts` `switch (d.type)` = 0
- [ ] `src/parse/domain-renderers.ts` 内置表清空（由内置 spec 取代）
- [ ] 新增 `src/spec/` 目录（loader + index + types）

### 7.4 文档

- [ ] `.pt/docs/designs/v10-spec-system-design.md`（本文件）
- [ ] `.pt/docs/designs/v10-spec-user-guide.md`（用户怎么写 spec）
- [ ] `.pt/assets/builtin/specs/*.md`（v10 内置 spec 资产示例）
- [ ] `.pt/docs/issues/v9-type-extension-limit.md`（issue 关闭）

---

## 8. 边界纪律

### 8.1 不做

- ❌ **不做** in-spec 沙箱（WASM / VM 隔离）——v10 假设 spec 是可信代码（用户自己项目内）
- ❌ **不做** spec 热重载——v10 启动时加载一次，session 期间不变
- ❌ **不做** spec 版本管理——spec 兼容性由用户保证
- ❌ **不做** spec marketplace / 远程加载——v10 只从本地 `.pt/specs/` 加载

### 8.2 风险

| 风险 | 缓解 |
|---|---|
| spec 抛异常破坏 transpile | spec render 包 try/catch，失败返 null + slog warn |
| spec 内 import 大量模块 | 不限（用户自己项目，承担 import cost）|
| spec 互相覆盖同名 | 同名 spec 加载时 slog warn 提示 |
| v9 switch-case 全删后行为漂移 | 162 tests 必须全过 |

### 8.3 与 P3 / P4 关系

| 阶段 | 范围 | v10 关系 |
|---|---|---|
| **P3** | 代码卫生（P3.5/3.6/3.7）| 不涉及 type 扩展，照做 |
| **P4** | 发布形态改造 | 不涉及 spec 系统 |
| **P5+** | v10 spec 系统实现 | 本设计文档落地 |

P3 的 P3.1（注册表化）**不做**——你的洞察证明 v10 spec 系统是正确方向，注册表化是中间过渡形态。

---

## 9. 实施路径（v10 spec brief 启动后）

### Phase 1: 基础设施
- 新建 `src/spec/` 目录（types.ts + index.ts + loader.ts）
- 新建 `src/builtin/specs/`（term/workflow/stack 内置 spec）
- `package.json` 加 `./spec` + `./runtime` exports

### Phase 2: 调度改写
- `src/compile/context.ts`：renderSceneModule / renderManualModule switch 改为查 spec
- `src/render/context-message.ts`：renderDomainManual switch 改为查 spec
- `src/parse/domain.ts`：parseDomainSection 优先查 spec

### Phase 3: 用户文档 + 示例
- `.pt/docs/designs/v10-spec-user-guide.md`
- `.pt/assets/builtin/specs/schema-example/`（示例 spec + 资产）

### Phase 4: 验证
- 加 spec 系统单测（loader + dispatcher + 兼容性）
- 跑 162 tests 全过
- 加端到端测试：用户写自定义 spec → 资产 type 引用 → transpile 成功

### Phase 5: 文档 + issue 关闭
- 写 CHANGELOG
- 关闭 `.pt/docs/issues/v9-type-extension-limit.md`

---

## 10. 完成判定

- [ ] 本设计文档 commit
- [ ] `.pt/docs/issues/v9-type-extension-limit.md` 创建（open）
- [ ] P3 + P4 完成（按 P3+P4 brief）
- [ ] v10 spec 实现 brief 启动（v10-spec-impl-brief.md）
- [ ] v10 实施按 Phase 1-5 推进

---

## 附录 A：v9 vs v10 对比

| 维度 | v9 | v10 |
|---|---|---|
| type 字符串 | pt 内置白名单 | 任意字符串 |
| 规范位置 | pt 源码 | 用户 `.pt/specs/*.ts` |
| 加载时机 | 编译期（hardcode）| 运行时（启动时扫描）|
| 加 type 改 pt 源码 | 必须 | 0 改 |
| 公开 API | `registerModuleRenderer`（hidden）| `@issac/pi-pt/spec`（公开）|
| 用户扩展 | ❌ | ✅ |
| v9 兼容 | — | ✅（内置 spec 桥接）|

## 附录 B：参考实现对比

| 系统 | 类似机制 | 差异 |
|---|---|---|
| webpack | loader | 同步 transform，v10 spec 包含 parse + render + guard |
| rollup | plugin | 全量 hook，v10 spec 是 type-scoped |
| vite | plugin | transform-based，v10 spec 是 type-scoped |
| dbt | macros + sources | SQL-based，v10 spec 是 MD-based |
| terraform | provider | 远程加载，v10 spec 是本地 |
