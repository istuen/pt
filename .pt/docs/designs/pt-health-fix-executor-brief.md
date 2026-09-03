# 体检修复执行者简报：lint 流程洞 + 死代码 + manual-session 抽离 + 契约收紧

> **基线 commit**：`d8e1221`（feat: P4 build config...）— HEAD 起点，工作区干净
> **任务来源**：2026-09-03 深入体检报告（对话产出，本简报是其可执行化）
> **目标**：关闭 lint 流程洞 → 清 src 死代码 → 抽 manual-session 降 index.ts 体量 → 收紧 ref-check/commands 运行时契约
> **约束**：v9 四层语义不动；162 tests 不退步；每 commit 必过三件套；不改资产行为
> **产出**：3 必做 commit + 2 可选/决策 commit

---

## ⚠️ 现状校准（HEAD d8e1221）

### 总评：🟢 可发版，3 处可收紧

| 维度 | 状态 | 数据 |
|---|---|---|
| 类型安全 | 🟢 | `tsc --noEmit` 0 错，strict |
| 回归测试 | 🟢 | 162/162 通过（17 文件）|
| 引用完整性 | 🟢 | 无悬空（6 警告，语义过严，见 H3）|
| 架构落地 | 🟢 | v9 四层 + 三段式 + Adapter 注册制完整 |
| **Lint 卫生** | 🟡 | **82 diagnostics**，且 lint **未进任何 npm hook** |
| **代码组织** | 🟡 | index.ts 780 行 / 10 函数，manual 相关 6 函数可再抽 |
| 技术债 | 🟢 | 4/5 issues 已关闭，T1–T13 已清理，仅 T12 预留 |
| 发布就绪 | 🟢 | dist 已构建（比 src 新），.gitignore 正确 |

### H1 现状：lint 形同虚设

`package.json` 有 `lint` / `lint:fix` / `format` 三个脚本，但**无任何 hook 调用**：
- `prebuild` = `tsc --noEmit`（只类型）
- `verify` = `vitest run tests/verify/`（只测试）
- `prepublishOnly` = `build && verify`（不含 lint）
- 无 `.husky`、无 git hook

结果：**82 个 diagnostics 长期无人拦截**。按规则分布：

| 规则 | 数量 | 性质 |
|---|---|---|
| `lint/style/noNonNullAssertion` | 45 | 测试侧为主（fixable），src 侧 2 处（非 fixable，见 H4）|
| `lint/complexity/useLiteralKeys` | 17 | 全 fixable，测试侧为主 |
| `lint/style/useTemplate` | 11 | 全 fixable，src+测试 |
| `lint/correctness/noUnused*` | 9 | **src 侧真实死代码**（见下表）|

**src 侧 9 个 correctness 问题（真实死代码/未用导入）**：

| 文件 | 行 | 问题 |
|---|---|---|
| `src/compile/context.ts` | 27 | 未用 import `Context as ContextIR` |
| `src/compile/context.ts` | 35 | 未用 import（`Domain` / `Rule` / `StructureLayout` 等残留）|
| `src/compile/context.ts` | 202 | 未用函数参数 |
| `src/index.ts` | 27 | 未用 import |
| `src/index.ts` | 50 | 未用 import |
| `src/parse/profile.ts` | 29 | 未用 `Section` type import |
| `src/verify/ref-check.ts` | 26 | 未用参数 `domains` |

> 注：上表 7 行对应 9 个 diagnostics（部分行多个 import）。这 9 个是 `biome check --write` **不能**自动清的（correctness 类需人工判断），其余 73 个 fixable 可一键清。

### H2 现状：index.ts 780 行职责偏胖

P1/P2 已抽出 `profile-persist / api-bridge / session / transpile`，但 index.ts 仍聚着 manual + footer 全套：

| 函数 | 行数 | 职责 | 可抽？ |
|---|---|---|---|
| `transpileActive` | 42 | 转译主流程 | 否（入口核心）|
| `switchProfile` | 27 | 切换 | 否（入口核心）|
| `readManualFromSession` | 26 | session JSONL 读 manual | ✅ |
| `tryRestoreManual` | 23 | session_start 恢复 | ✅ |
| `refreshManualWidget` | 18 | widget 刷新 | ✅ |
| `persistManualToSession` | 11 | session JSONL 写 manual | ✅ |
| `renderActiveManualSuffix` | 8 | footer 后缀 | ✅ |
| `refreshInjectionFooter` | 8 | footer | ✅ |
| `registerInjectionIfReady` | 8 | 注入注册 | 否（入口接线）|
| `slog` | 7 | 日志快捷 | 否（共享工具）|

**可抽 6 函数 ~94 行** → `src/manual-session.ts`。与已抽的 `manual-track.ts`（纯函数渲染）分工：manual-track = 渲染纯函数，manual-session = session/JSONL/widget 交互层。抽完后 index.ts 降到 ~600 行，回归"事件接线 + 命令分发"纯入口职责。

### H3 现状：ref-check 6 警告语义过严

`pt_check_refs` 报 6 个"Blueprint 注入点在 Profile 里未实例化"警告：
```
Blueprint "dev-knowledge" 的注入点 "会话知识" 在 Profile "pt-chat" 里未实例化
Blueprint "dev-knowledge" 的注入点 "参考手册" 在 Profile "pt-chat" 里未实例化
... (pt-dev / pt 各 2 条)
```

**根因**：3 个 Profile 全只用 YAML `domains: [...]` 全局分发，没写 `## 会话知识` / `## 参考手册` H2 实例化段。`pt_status` 显示 pt-chat 正常编译出 9184 chars prompt —— 证明"全局 domains 自动分发到所有注入点"这条简化路径有效且是主用例。

`ref-check` 把"Blueprint 声明的注入点在 Profile 里未 H2 实例化"判为 warning，与实际用法冲突。

### H4 现状：commands.ts:67-68 非空断言

```typescript
session.activeAdapter.listManuals?.(
  session.cachedContext!,     // ← 67
  session.cachedBlueprint!,  // ← 68
  filterDomainsByProfile(...)
)
```
上游已检查 `session.activeAdapter` 非空，但隐式假设"context/blueprint 也必在"。这是"adapter 在则 bundle 已编译"的运行时契约，类型上未表达。`lint/style/noNonNullAssertion` 非 fixable，需人工改。

### H5 现状：T12 预留 by-injection-point

`schema.ts` 的 `CacheSplitStrategy` 含 `"by-injection-point"`，但 `render/cache.ts` 只实现 single-file（已标 `v10+ TODO`）。Blueprint 配置成 by-injection-point 会**静默 fallback**。当前唯一 Blueprint 用 `split: single-file`，无实际影响。

---

## 任务清单

按 ROI 排序。H1/H2 必做，H3 需决策，H4/H5 可选。

### H1（高 ROI / 低风险）：lint hook + 清死代码

- **动作 1**：`biome check --write` 一键清 73 个 fixable（useTemplate / useLiteralKeys / 测试侧 noNonNullAssertion）
- **动作 2**：手动清 9 个 src 侧 correctness 死代码：
  - `src/compile/context.ts:27,35` — 删未用 import
  - `src/compile/context.ts:202` — 删未用函数参数（或加 `_` 前缀）
  - `src/index.ts:27,50` — 删未用 import
  - `src/parse/profile.ts:29` — 删未用 `Section` type import
  - `src/verify/ref-check.ts:26` — 删未用 `domains` 参数（或加 `_` 前缀，确认调用方不需传）
- **动作 3**：把 `lint` 并进 npm hook：
  - `package.json` 改 `"verify": "biome check && vitest run tests/verify/"`
  - `package.json` 改 `"prebuild": "tsc --noEmit && biome check"`
  - `prepublishOnly` 已含 `build && verify`，自动继承
- **完成判定**：
  - `npx biome check` 退出 0（0 diagnostics）
  - `npm run verify` 同时跑 lint + 测试
  - 162 tests 全过（不退步）
  - `grep -n "Context as ContextIR" src/compile/context.ts` = 0

### H2（中 ROI）：抽 src/manual-session.ts

- **新建**：`src/manual-session.ts`
- **迁入 6 函数**：`readManualFromSession` / `persistManualToSession` / `tryRestoreManual` / `refreshManualWidget` / `renderActiveManualSuffix` / `refreshInjectionFooter`
- **index.ts**：改 import 引用，删函数定义
- **依赖梳理**：这 6 函数用到 `ExtensionAPI / ExtensionContext / AgentUIContext / ExtensionUIContext`（Pi 类型）+ `ActiveManual`（session.ts）+ `isManualActive / parseManualProgress / renderManualFooterSuffix / renderManualWidgetLines`（manual-track.ts）+ `slog`（index.ts 本地）。`slog` 需一并迁出或提到独立工具——**建议把 slog 提到 `src/log.ts` 或新建 `src/slog.ts`**（它是 session.logger 的快捷包装，属日志层不属入口）
- **完成判定**：
  - `src/manual-session.ts` 存在，含 6 函数
  - `src/index.ts` 行数 ≤ 650（当前 780）
  - `grep -cE "^(async )?function " src/index.ts` ≤ 7（当前 10）
  - 162 tests 全过
  - `manual-track-integration.test.ts` 仍过（验证迁移未破坏 manual 行为）

### H3（决策性）：ref-check 警告降级 —— ⚠️ 需用户决策

**决策点**：

| 选项 | 动作 | 建议 |
|---|---|---|
| **(a) 改 check** | `src/verify/ref-check.ts`：Profile 只用全局 domains 是合法用法，"未 H2 实例化"降级为 info 或加"全局 domains 已覆盖"判断后静默 | ✅ **推荐**——当前 3 Profile 全走简化路径，这才是主用例 |
| **(b) 改文档/资产** | 在 Blueprint JSDoc 或 `pt-asset-layering.md` 明确"全局 domains 是默认路径；H2 实例化是按注入点精细追加的进阶路径，留空=全分发" | 不改代码，仅文档 |
| **(c) 不动** | 接受 6 警告为常态 | 最省事但 noise 持续 |

若选 (a)：改 `src/verify/ref-check.ts` 的注入点实例化检查逻辑——Profile 有 `domains` 全局列表非空时，对 Blueprint 注入点未在 Profile H2 实例化的情况不报 warning（或降级为 info）。同时改 `tests/verify/ref-check.test.ts` 加用例：全局 domains 覆盖时不报 warning。

### H4（可选）：commands.ts:67-68 非空断言改早返

- **位置**：`src/commands.ts:67-68`
- **动作**：在 `flowsText()` 调 `listManuals` 前加显式早返：
  ```typescript
  if (!session.cachedContext || !session.cachedBlueprint) {
    return "无激活 Profile，先用 /pt-context <name> 激活";
  }
  ```
  然后去掉 `!` 断言。
- **完成判定**：
  - `grep "cachedContext!" src/commands.ts` = 0
  - `grep "cachedBlueprint!" src/commands.ts` = 0
  - 162 tests 全过

### H5（可选）：T12 CacheSplitStrategy 收紧

**决策点**：

| 选项 | 动作 | 建议 |
|---|---|---|
| **(a) 移除字面量** | `schema.ts` 的 `CacheSplitStrategy` 删 `"by-injection-point"`；`render/cache.ts` 删占位 if 块 + TODO 注释 | ✅ YAGNI——未实现就别声明 |
| **(b) 加 warn** | `compile` 阶段对未知 split 显式 `console.warn` | 中量 |
| **(c) 不动** | 保留预留 | 当前状态，静默 fallback |

若选 (a)：改 `src/schema.ts` 类型 + `src/render/cache.ts` 删 fallback 块 + 删 `src/parse/blueprint.ts` 对该字面量的解析（若有）+ 更新 `tests/verify/phase9.test.ts` 若有断言引用。

---

## Commit 拆分建议（3 必做 + 2 可选/决策）

### Commit 1: H1（lint hook + 清死代码）

- `biome check --write` 清 73 fixable（涉及 src + tests 多文件）
- 手动清 9 个 src correctness 死代码
- `package.json` 改 verify / prebuild 脚本
- message: `chore: close lint gap (hook + dead code cleanup)`
- **理由**：lint 卫生是一件事，hook 接线 + 死代码清理同源

### Commit 2: H2（抽 manual-session）

- 新建 `src/manual-session.ts`
- 改 `src/index.ts`（删 6 函数 + import）
- slog 提到 `src/log.ts` 或 `src/slog.ts`
- message: `refactor: extract manual-session (index.ts 780→≤650)`

### Commit 3（若 H3 选 a）: ref-check 降级

- 改 `src/verify/ref-check.ts`
- 改 `tests/verify/ref-check.test.ts`
- message: `fix: ref-check silence uninstance warning when global domains cover`

### Commit 4（可选 H4）: commands 早返

- 改 `src/commands.ts:67-68`
- message: `refactor: commands flowsText early-return over non-null assertion`

### Commit 5（可选 H5 选 a）: CacheSplitStrategy 移除

- 改 `src/schema.ts` + `src/render/cache.ts`
- message: `refactor: drop unimplemented by-injection-point cache split (YAGNI)`

---

## 边界纪律

- **不动**：v9 四层语义（Domain/Blueprint/Profile/Context IR 契约）
- **不动**：parse/compile/render 三段式架构
- **不动**：P0–P4 已抽出物（diagnostics / api-bridge / profile-persist / session / transpile / format-manual-body / read-stderr）
- **不动**：资产行为（.pt/assets/ 下 md 不改；只改代码与 ref-check 判定逻辑）
- **不**改测试 fixtures
- **不**删除现有测试（H1 的 `biome check --write` 可能改测试写法，但不删用例）
- **不**主动改 phase9 / switch-injection / manual-track-integration 等行为测试的断言（除非 H5 改了 CacheSplitStrategy 字面量被断言引用）
- **H2 迁函数严格遵守**：函数行为不变，只搬位置 + 改 import；slog 迁出后 index.ts 通过 import 引用
- **H1 死代码清理严格遵守**：删 import 前确认无引用（tsc 会兜底）；删未用参数前确认调用方不需传（grep 调用点）
- **H3/H5 需用户拍板**，不做默认推进

---

## 验证循环（每 commit 后必跑）

```bash
npm run typecheck   # 0 output
npm run verify      # ≥ 162 passed（H1 后含 lint）
npm run lint        # 0 error（H1 后此命令与 verify 内 lint 重复，但保留独立入口）
```

H2 后额外：
```bash
wc -l src/index.ts           # ≤ 650
grep -cE "^(async )?function " src/index.ts  # ≤ 7
```

---

## 完成判定（全部满足）

### H1
- [ ] `npx biome check` 退出 0（0 diagnostics）
- [ ] `npm run verify` 同时跑 lint + 测试
- [ ] `npm run prebuild` 含 lint
- [ ] `grep -n "Context as ContextIR" src/compile/context.ts` = 0
- [ ] `grep -n "Section" src/parse/profile.ts` 的 import 行无未用 type
- [ ] 162 tests passed（不退步）

### H2
- [ ] `src/manual-session.ts` 存在，含 6 函数
- [ ] `src/index.ts` 行数 ≤ 650
- [ ] `grep -cE "^(async )?function " src/index.ts` ≤ 7
- [ ] `manual-track-integration.test.ts` 7 tests 全过
- [ ] 162 tests passed（不退步）

### H3（若选 a）
- [ ] `pt_check_refs` 对 pt-chat/pt-dev/pt 不报"未实例化"warning
- [ ] `tests/verify/ref-check.test.ts` 含"全局 domains 覆盖时不报 warning"用例

### H4（可选）
- [ ] `grep "cachedContext!" src/commands.ts` = 0
- [ ] `grep "cachedBlueprint!" src/commands.ts` = 0

### H5（若选 a）
- [ ] `grep "by-injection-point" src/schema.ts` = 0
- [ ] `grep "by-injection-point" src/render/cache.ts` = 0
- [ ] phase9.test.ts 若引用该字面量已更新

---

## ⚠️ 决策点汇总（需用户拍板）

| 任务 | 选项 | 建议 |
|---|---|---|
| **H3** | (a) 改 check 降级 (b) 改文档 (c) 不动 | **(a)**——主用例不该报 warning |
| **H4** | 做 / 不做 | 做——小工作量收紧契约 |
| **H5** | (a) 移除字面量 (b) 加 warn (c) 不动 | **(a)**——YAGNI |

若 H3 选 (a) + H4 做 + H5 选 (a)：3 必做 + 3 可选 = 5 commit + 本 brief = 6 commit。
若 H3/H5 不动、H4 不做：2 commit（H1 + H2）+ 本 brief = 3 commit。

---

## 开工

1. `git checkout d8e1221` 确认基线干净
2. 从 H1 开始——`npx biome check --write` 看改了哪些文件，再手动清 9 个 correctness
3. 按 commit 拆分逐个落地，每 commit 跑验证循环
4. H3/H5 决策点等用户拍板后再做（可先做 H1/H2/H4 不阻塞）
