# P0 执行者简报：去噪与去重

> **基线 commit**：`ff102aa`（docs(assets): add publish-form scene...）
> **目标**：消除死代码与重复辅助函数，零行为变更。为 P1 结构重构扫清障碍。
> **约束**：v9 四层语义不动；每步必过 `typecheck` + `verify`(76 tests) + `lint`(0 error)。
> **产出**：单个 commit `refactor: P0 去噪去重（死代码 + 重复辅助函数 + au 前缀）`

---

## 执行顺序与任务清单

按 P0.1 → P0.7 顺序执行。每项完成后跑验证（见 §3），全部完成后单个 commit。

### P0.1 删 `findFlow`（死代码 + 逻辑错误）

- **位置**：`src/index.ts:183-193`
- **现状**：`function findFlow(name: string)` 无任何调用方；且逻辑错误——`bp = b.blueprints.find((x) => x.name === b.blueprints[0]?.name)` 总匹配第一个 blueprint
- **动作**：
  1. 删除 `src/index.ts:183-193` 整个 `findFlow` 函数
  2. **删孤儿 import**：`src/index.ts:30` 的 `import { findFlowInBlueprint } from "./render/context-message.js"` 整行删除（`findFlowInBlueprint` 在 `index.ts` 内仅被 `findFlow` 调用；`commands.ts` 有自己的独立 import，不受影响）
- **完成判定**：`grep -rn "findFlow\b" src/` = 0（注意 `findFlowInBlueprint` 会在 commands.ts/render 里出现，那是正常的，不算）

### P0.2 删 `_debugActive`（死代码）

- **位置**：`src/index.ts:637-655`（`export function _debugActive(): { ... }`）
- **现状**：纯调试导出，零调用方（`grep _debugActive src/ tests/` 只有定义处）
- **动作**：删除整个 `_debugActive` 函数
- **完成判定**：`grep -rn "_debugActive" src/ tests/` = 0

### P0.3 删 `renderGlobalRules`（死代码）

- **位置**：`src/compile/context.ts:269` 起（`function renderGlobalRules(rules: Rule[]): string`）
- **现状**：Biome `noUnusedVariables` 确认未使用；注释写"v9 保留但不在主路径调用"——属死代码
- **动作**：删除整个 `renderGlobalRules` 函数（含上方注释块）
- **完成判定**：`grep -rn "renderGlobalRules" src/` = 0

### P0.4 抽 `errMsg`/`reportWarn`/`reportError` 到 `src/diagnostics.ts`

- **三处重复定义**：
  | 文件 | 行号 | 函数 |
  |---|---|---|
  | `src/parse/index.ts` | 160 | `reportWarn(adapterCtx, msg, details)` |
  | `src/parse/index.ts` | 169 | `reportError(adapterCtx, msg, details)` |
  | `src/parse/index.ts` | 178 | `errMsg(e)` |
  | `src/transpile.ts` | 185 | `reportWarn` |
  | `src/transpile.ts` | 195 | `reportError` |
  | `src/transpile.ts` | 205 | `errMsg` |
  | `src/index.ts` | 48 | `errMsg`（只有 errMsg，无 reportWarn/reportError） |
- **动作**：
  1. 新建 `src/diagnostics.ts`，导出 `errMsg`/`reportWarn`/`reportError`（从 `parse/index.ts` 的实现复制，它是三处里最完整的）
  2. `diagnostics.ts` 的依赖：`import type { SourceAdapterContext } from "./schema.js"`（reportWarn/reportError 签名需要它）
  3. `parse/index.ts`、`transpile.ts`、`index.ts` 三处删本地定义，改 `import { errMsg, reportWarn, reportError } from "./diagnostics.js"`（各文件按实际用到的导入）
- **完成判定**：`grep -rnE "function (errMsg|reportWarn|reportError)" src/` 只在 `diagnostics.ts` 出现一次

### P0.5 抽 `s`/`sArr` 唯一来源（import shared）

- **三处定义**：
  | 文件 | 行号 | 函数 | 是否 export |
  |---|---|---|---|
  | `src/parse/shared.ts` | 240 | `s(v)` | ✅ export（**唯一来源**） |
  | `src/parse/shared.ts` | 247 | `sArr(v)` | ✅ export |
  | `src/parse/domain-renderers.ts` | 94 | `s(v)` | 本地 |
  | `src/parse/domain-renderers.ts` | 100 | `sArr(v)` | 本地 |
  | `src/parse/domain.ts` | 74 | `s(v)` | 本地（只有 s，无 sArr） |
- **动作**：
  1. `domain-renderers.ts`：删 `:94` 的 `s` + `:100` 的 `sArr` 本地定义，加 `import { s, sArr } from "./shared.js"`（若已有 shared import 则合并）
  2. `domain.ts`：删 `:74` 的 `s` 本地定义，加 `import { s } from "./shared.js"`（若已有 shared import 则合并）
- **注意**：实现一致性已预验证——`shared.ts` 的 `s`/`sArr` 与 `domain-renderers.ts`/`domain.ts` 的本地实现逐字节一致（同样的 typeof/Array.isArray/filter 逻辑），可直接安全替换
- **完成判定**：`grep -rnE "function (s|sArr)\b" src/` 只在 `shared.ts` 出现

### P0.6 抽 `isRecord` 到 `src/compile/type-guards.ts`

- **两处定义**：
  | 文件 | 行号 |
  |---|---|
  | `src/compile/context.ts` | 306 |
  | `src/config.ts` | 33 |
- **决策**：放 `src/compile/type-guards.ts`。理由：`isRecord` 是 `x is Record<string, unknown>` 类型守卫，与 type-guards.ts 现有 `isArray`/`isNonEmptyArray` 同类；type-guards 已被多层共用（compile/render/agent），config.ts import 它不引入循环（两者都只依赖 schema 层 0）
- **注意**：实现一致性已预验证——两处 `isRecord` 逐字节一致（`return !!x && typeof x === "object" && !Array.isArray(x);`），可直接合并
- **动作**：
  1. `type-guards.ts`：加 `export function isRecord(x: unknown): x is Record<string, unknown> { return !!x && typeof x === "object" && !Array.isArray(x); }`
  2. `compile/context.ts`：删 `:306` 本地定义，加 `import { isRecord } from "./type-guards.js"`（若已有 type-guards import 则合并）
  3. `config.ts`：删 `:33` 本地定义，加 `import { isRecord } from "./compile/type-guards.js"`
- **完成判定**：`grep -rn "function isRecord" src/` 只在 `type-guards.ts` 出现

### P0.7 修 `au.pt-context` → `pt.pt-context`（向后兼容读旧键）

- **位置**：
  - `src/index.ts:218`：`readProjectSetting<string>(ctx.cwd, "au.pt-context")`
  - `src/index.ts:245`：notify 文案 `"...设 au.pt-context。"`
- **动作**：
  1. `:218` 改为双读（新键优先，旧键 fallback）：
     ```typescript
     const fromSettings =
       (await readProjectSetting<string>(ctx.cwd, "pt.pt-context")) ??
       (await readProjectSetting<string>(ctx.cwd, "au.pt-context"));
     ```
  2. `:245` notify 文案改 `pt.pt-context`
- **注意**：新键名是 `pt.pt-context`（pt 命名空间 + pt-context 键名），不是 `pt.context`（计划文档 §3 表格里写 `pt.context` 是笔误，以此简报为准）。`readProjectSetting` 对不存在的键返回 `undefined`（已验证实现：try/catch + reduce fallback），`??` 短路双读安全
- **完成判定**：`grep "au.pt-context" src/` 只出现在 `:219` 的 fallback 行；主路径用 `pt.pt-context`
- **issue 关闭**：完成后把 `.pt/docs/issues/au-prefix-tech-debt.md` 的 `status: open` 改为 `status: closed`，加 `closed: 2026-09-03`（或执行日期）

---

## 验证循环（每项完成后必跑）

```bash
npm run typecheck   # tsc --noEmit，必须零输出
npm run verify      # vitest，必须 76 tests passed
npm run lint        # biome check，必须 0 error（warning/info 不阻塞）
```

**任一失败则修到过，不跳过不绕过。** `switch-injection.test`（4 用例）和 `persist-profile.test`（13 用例）是行为回归门——P0.7 改 settings 键读取后重点关注这两个。

全部 7 项完成后，额外验证 Biome 指标下降：
```bash
npm run lint 2>&1 | grep "Found"   # 对比基线：29 warnings + 12 infos 应下降
```
预期：`noUnusedVariables` 3→0（P0.1/0.2/0.3 删 3 个死代码）、`noUnusedImports` 4→3（P0.1 删孤儿 import）。

---

## commit 规范

全部 7 项作为一个 commit：

```
refactor: P0 去噪去重（死代码 + 重复辅助函数 + au 前缀）

- 删 findFlow（index.ts 死代码 + 逻辑错误）+ 孤儿 import
- 删 _debugActive（index.ts 纯调试导出，零调用）
- 删 renderGlobalRules（compile/context.ts 死代码）
- 抽 errMsg/reportWarn/reportError → src/diagnostics.ts（3处→1处）
- 抽 s/sArr 统一 import shared（domain-renderers/domain 本地定义→import）
- 抽 isRecord → compile/type-guards.ts（2处→1处）
- au.pt-context → pt.pt-context（双读兼容旧键）+ 关闭 au-prefix-tech-debt issue

Verified: typecheck clean, 76 tests pass, lint 0 error.
```

---

## 陷阱与注意事项

1. **P0.1 删 findFlow 后必删 import**：`index.ts:30` 的 `findFlowInBlueprint` import 成孤儿（`findFlowInBlueprint` 在 index.ts 内只被 findFlow 调用）。不删会被 Biome `noUnusedImports` 报。
2. **P0.5 先比对实现一致性**：`shared.ts` 的 `s`/`sArr` 与 `domain-renderers.ts`/`domain.ts` 的本地实现必须逐字节一致才能合并。若有差异（如空格处理、fallback 值不同），**停止该项，报告差异**，不强行合并。
3. **P0.6 config.ts 跨层 import**：`config.ts`（层 6）import `compile/type-guards.ts`（层 2）——这在 P1 会随 type-guards 迁到 `contract/` 层自然解决，P0 阶段可接受跨层 import（config 已依赖 schema 层 0，type-guards 也只依赖 schema，无循环）。
4. **P0.7 双读顺序**：`pt.pt-context` 在前（优先），`au.pt-context` 在后（fallback）。用 `??` 短路——`readProjectSetting` 返回 `undefined` 时才读旧键。确认 `readProjectSetting` 对不存在的键返回 `undefined`（而非抛错），若抛错要用 try/catch。
5. **不动 type-guards 归属**：P0.6 只是把 isRecord 放进 type-guards.ts，不迁移 type-guards.ts 到 contract/ 层（那是 P1 的事）。
6. **不删 sourceAdapters 数组 / 不简化 transpile**：那是 P1.1，不在 P0 范围。

---

## 完成判定（全部满足）

- [ ] `grep -rn "findFlow\b" src/` = 0
- [ ] `grep -rn "_debugActive" src/ tests/` = 0
- [ ] `grep -rn "renderGlobalRules" src/` = 0
- [ ] `grep -rnE "function (errMsg|reportWarn|reportError)" src/` 只在 `diagnostics.ts`
- [ ] `grep -rnE "function (s|sArr)\b" src/` 只在 `shared.ts`
- [ ] `grep -rn "function isRecord" src/` 只在 `type-guards.ts`
- [ ] `grep "au.pt-context" src/index.ts` 只在 fallback 行
- [ ] `npm run typecheck` 零输出
- [ ] `npm run verify` 76 passed
- [ ] `npm run lint` 0 error
- [ ] `.pt/docs/issues/au-prefix-tech-debt.md` status: closed
