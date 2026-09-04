# 资产一致性与契约缺口修复方案

> **基线**：HEAD `24d73f9`（`npm run verify` 168/168 通过，`tsc --noEmit` 0 错，`pt_check_refs` 无悬空——src 已静默全局 domains 警告）
> **日期**：2026-09-03（第二轮修订：删 C1 已完成项 + 重写 A2）
> **审计范围**：`.pt/assets/`（11 domains + 1 blueprint + 2 项目 profiles + 1 内建 profile）+ `.pt/docs/issues/`（6 个）+ `.pt/cache/` + `src/schema.ts` / `src/parse/domain-renderers.ts` / `src/compile/context.ts` / `src/verify/ref-check.ts`
> **用途**：执行者按 B1→A1→E1 三步推进，每步独立可验收、互不阻塞。A1/E1 的方向已决策（A1-a 扩 schema / E1 仍标未发布），执行者照做不重开决策
> **约束**：v9 四层语义不动；168 tests 不退步；每 commit 必过 typecheck + verify + lint；不改资产行为（A1 是补丢字段，非改语义）
>
> **第二轮修订说明**：初版 5 步方案里 **C1 已在 commit `2a943d6` 完成**（issue 转 resolved，测试已隔离 cwd），本版删除。**A2 初版判断错误**（误判特性未演练 + 误判 6 警告语义正确），实测后重写为"dist 构建滞后"问题，方案改为重建 dist。详见 §1.3

---

## 0. 现状快照（问题清单）

| 编号 | 问题 | 严重度 | 根因层 | 方案 |
|---|---|---|---|---|
| B1 | `collaboration.md` 悬空引用 ×3 | 🔴 高 | 资产 | 3 处字面量替换 |
| A1 | Term schema 字段被静默丢弃 | 🔴 高 | schema+parse+compile | A1-a 扩 Term 接口 |
| A2 | `pt_check_refs` 报 6 警告（dist 构建滞后于 src） | 🟡 低 | 构建部署 | `npm run build` 重建 dist |
| E1 | CHANGELOG 停在 0.1.0 v9，v10.x/v11.x 修复未补 | 🟠 中 | 文档治理 | 补两节记录 |

**已完成（不再列入方案）**：
- ~~C1 `pt-manual-test-residual`~~ — commit `2a943d6` 已落地（测试 mkdtemp 隔离 cwd + testing.md 兜底 step 提交 + issue 转 resolved）
- ~~issue `module-state-pi-web-multisession`~~ — commit `24d73f9` 已落地 per-session state 改造

**结论**：v9 四层模型贯通、168 tests 全过、无悬空引用。当前问题集中在 **资产-Schema 契约缺口**（A1：作者写的字段在 parse 阶段静默丢失）和 **资产内部一致性**（B1：文件改名后引用没跟）。A2 是构建部署卫生（dist 没重建），E1 是文档治理欠账。三步全做完，`.pt/` 进入"资产即契约、文档即现状"状态。

---

## 1. 问题逐项分析与方案

### 1.1 B1：`collaboration.md` 悬空引用 ×3（最快见效）

**现象**：`requirements.md` 与 `deployment.md` 引用 `collaboration.md` / `collaboration.md#task-description` / `collaboration.md#baseline-reversibility`，但该文件已改名 `pt-collab.md`。LLM 按 System Prompt 指示去 read 会找不到文件。

**根因**：文件改名时引用未同步。锚点核对过——`#task-description` / `#baseline-reversibility` 在 `pt-collab.md` 里的 H3 对得上。

**改动**：

| 文件 | 行号 | 现状 | 改为 |
|---|---|---|---|
| `.pt/assets/domains/requirements.md` | 19 | `结构对齐 collaboration.md 的 task-description 段` | `结构对齐 pt-collab.md 的 task-description 段` |
| `.pt/assets/domains/requirements.md` | 33 | `（见 collaboration.md#task-description）` | `（见 pt-collab.md#task-description）` |
| `.pt/assets/domains/deployment.md` | 22 | `详见 collaboration.md#baseline-reversibility` | `详见 pt-collab.md#baseline-reversibility` |

**验证**：`grep -rn "collaboration.md" .pt/assets/` 应无输出。

**commit**：`fix(assets): rename collaboration.md refs to pt-collab.md`

---

### 1.2 A1：Term schema 字段被静默丢失（影响最深）

**现象**：`pt-collab.md`（type: term）的 Scene 项用了 `fields:` / `purpose:` / `rule:` 等字段，但编译产物 `pt-dev.context.md` 里只剩 `- task-description: <desc>`，`fields`/`purpose`/`rule` 全部丢失。

**根因链（代码证据）**：

1. **schema 层无字段收纳** — `src/schema.ts` `Term` 接口只有 `{ name, desc, level? }`：
   ```typescript
   export interface Term {
     name: string;
     desc: string;
     level?: "axiom" | "theorem";
   }
   ```
   `fields` / `purpose` / `rule` 无处可去。

2. **parse 层主动丢弃** — `src/parse/domain-renderers.ts` Scene/term renderer 只取 name + desc(+description/role 兜底)：
   ```typescript
   Scene: {
     term: (items) =>
       items.map((it) => ({
         name: it.name,
         desc: s(it.fields.desc) || s(it.fields.description) || s(it.fields.role) || "",
         // ← fields/purpose/rule 在此被丢弃
       })),
   ```
   `it.fields` 里的 `fields` / `purpose` / `rule` 根本没读。

3. **compile 层无输出路径** — `src/compile/context.ts` `renderSceneModule` term 分支只输出 `- ${name}: ${desc}`，即便 IR 有额外字段也没渲染。

→ 资产作者写的结构化信息（task-description 的 6 字段检查清单、acceptance 的验收准则）在 parse 阶段就没了，作者却以为已注入 LLM。

**方案 A1-a：扩 Term schema 收纳**

Term 加两个可选字段，向后兼容（me / product-design 无这些字段照常工作）：

```typescript
// src/schema.ts
export interface Term {
  name: string;
  desc: string;
  level?: "axiom" | "theorem";
  /** 结构化字段清单（如 task-description 的 [必读, 设计原则, 步骤, ...]）。
   *  来自资产 `- fields: [a, b, c]` 行；renderer 输出 `（字段：a/b/c）`。 */
  fields?: string[];
  /** 补充说明（purpose / rule 等非 desc 的语义信息统一收纳）。
   *  renderer 在 desc 后追加 ` — note`。 */
  note?: string;
}
```

**改动清单**：

| 文件 | 改动 |
|---|---|
| `src/schema.ts` | `Term` +`fields?: string[]` +`note?: string` |
| `src/parse/domain-renderers.ts` | Scene/term renderer 多取 `it.fields.fields`（sArr）+ `it.fields.purpose ?? it.fields.rule`（s）→ 填入 term.fields / term.note |
| `src/compile/type-guards.ts` | `isTermArray` 放行 fields/note 可选字段（不强制，仅校验类型） |
| `src/compile/context.ts` | `renderSceneModule` term 分支：有 fields 追加 `（字段：a/b/c）`；有 note 追加 ` — note` |
| `tests/verify/parse-domain.test.ts` | +用例：parse pt-collab 的 task-description 项，断言 `term.fields = [必读, 设计原则, 步骤, 验收标准, 边界纪律, baseline]` 且 `term.note` 含 purpose 内容 |
| `tests/verify/compile-context.test.ts` | +用例：compile 含 fields/note 的 term，断言产物含 `（字段：...）` 和 ` — ...` |

**renderer 输出格式**（向后兼容）：
- 无 fields/note：`- task-description: <desc>`（现状不变）
- 有 fields：`- task-description: <desc>（字段：必读/设计原则/步骤/验收标准/边界纪律/baseline）`
- 有 note：`- acceptance: <desc> — 每个硬指标都要有独立验证方式`
- 两者都有：`- task-description: <desc>（字段：...） — <note>`

**边界纪律**：
- ✅ 只加可选字段，me / product-design 资产不改、测试不破
- ✅ 不动 workflow/stack 的 Scene renderer（只动 term 分支）
- ✅ 不改资产格式（pt-collab.md 不用动，只是 parse 开始读它已有的字段）
- ✅ pt-quality #2 `no-duplicate-type` 不违反（Term 派生新字段，非新类型）

**验证**：
- `npm run typecheck` 0 错
- `npm run verify` 全过（163 + 2 新用例 = 165）
- 删 `.pt/cache/contexts/*.context.md` 重编译 → `pt-dev.context.md` 的 pt-collab 段应含 fields/note 内容
- `grep "字段：" .pt/cache/contexts/pt-dev.context.md` 应有命中

**commit**：`feat(schema): extend Term with fields/note to stop silent field loss`

---

### 1.3 A2：`pt_check_refs` 报 6 警告（dist 构建滞后于 src）

**现象**：`pt_check_refs` tool 报 6 警告——Blueprint `dev-knowledge` 的两个注入点（会话知识/参考手册）在 pt-chat / pt-dev / pt 三个 Profile 里都未实例化。

**⚠️ 根因：不是特性问题，是 dist 没重建**

这是两轮调研后的实测结论，不是初判：

1. **src 已静默该警告** — commit `5b31dd7 fix: ref-check silence uninstance warning when global domains cover` 在 `src/verify/ref-check.ts:65` 加了条件：
   ```typescript
   // v11.x：Profile 有全局 domains 时，注入点未 H2 实例化是合法用法（全局分发到所有注入点），
   // 静默不报。只有 Profile 全空（无全局 domains + 无 H2 实例化）时才报"未实例化" warning。
   if (bp && profile.domains.length === 0) {   // ← 加了全局 domains 为空的条件
   ```
   pt-dev 有 11 个全局 domains，`domains.length === 0` 为 false，不进警告分支。直接调 src 的 `checkProfileRefs(pt-dev, [blueprint], [])` 实测 `warnings.length = 0`。

2. **dist 跑的是旧逻辑** — `pt_check_refs` tool 链路：Pi extension 加载 `dist/index.js`（package.json `pi.extensions` 指向 dist）→ `dist/index.js` dynamic import `./verify/ref-check.js`。dist 构建于 Sep 3 16:07（当时 src 还是旧逻辑 `if (bp)` 无条件检查），commit `5b31dd7` 在 Sep 3 18:14 修了 src，但**没跑 `npm run build`** → dist 滞后 2 小时 → tool 还在用旧逻辑报警告。

3. **注入点级追加特性本身实现完整可用** — 实测构造用 H2 追加的测试 Profile 跑 `compileContext`，产出正确：
   - 全局 domains=[me] + `## 参考手册 ### Domains - product-design`
   - 产物：会话知识段含 me（全局），不含 product-design；参考手册段含 product-design（H2 追加），不含 me
   - 关键断言通过：追加的 domain 精确只进指定注入点，不泄漏
   → 特性 parse/compile 链路完整工作，不是"未实现"或"有问题"。

**方案：`npm run build` 重建 dist**

让 dist 与 src 同步，tool 行为自然正确。**本文档撰写时已执行 `npm run build` 验证**：
- 重建后 `dist/verify/ref-check.js` 含 `if (bp && profile.domains.length === 0)` 条件，与 src 逻辑一致（仅缩进差异，tsup 格式化）
- tool 重启 pi runtime 后 `pt_check_refs` 应报 0 警告

**改动**：无源码改动、无资产改动。仅 `npm run build`（dist 在 `.gitignore`，不入 git）。

**验证**：重启 pi runtime 后跑 `pt_check_refs`，应输出 `✓ 引用完整性检查通过，无悬空引用`（0 警告）。

**边界纪律**：
- ✅ 不改 src（src 已正确）
- ✅ 不改资产（product-design.md 不用标注"待启用"——特性本就可用）
- ✅ 不改 ref-check 逻辑（静默条件正确）
- ✅ 不补演示 Profile（当前全局 domains 模式满足业务，无真实需求触发进阶用法）

**备注**：本步可在发版前常规 build 流程里顺手完成，不作为独立 commit。若想留痕，可记一条 docs commit 说明"重建 dist 同步 ref-check 静默逻辑"。

---

### 1.4 E1：CHANGELOG 过期（补记录）

**现状**：`.pt/docs/CHANGELOG.md` 停在 `0.1.0 (未发布)` 的 v9 功能列表。v10.x（persist-profile 方案 D）、v11.x（switch-injection 修复、duplicate-segment 修复、manual-track）这些在 issues 里有详细记录的修复，CHANGELOG 一条都没补。

**方案**：仍标 `0.1.0 (未发布)`（package.json version 仍 0.1.0，未正式发版），在 0.1.0 下补 `### 修复` 子节。不推进版本号。

**改动**：`.pt/docs/CHANGELOG.md` 0.1.0 节末尾追加：

```markdown
### 修复（v10.x）
- pt-context 选择跨进程持久化（方案 D：`pi.appendEntry` 写 session JSONL，session_start 加第四源 fallback）— resolves `pt-context-persist-lost`
- `au.` 前缀清理为 `pt:` 命名空间（`au-prefix-tech-debt` 关闭，新代码不再用 `au.`）

### 修复（v11.x）
- `/pt-context` 手动切换后 segment 不注入 system prompt（提取 `registerInjectionIfReady` helper + PiAdapter 幂等保护）— resolves `manual-switch-no-injection`
- auto 探测排除内建 `pt` profile（`detectSingleProfile` 只统计项目级 Profile）
- `/pt full` 输出 segment 重复 2 次（改用 `lastBuiltPrompt` 作 canonical source）— resolves `pt-full-duplicate-segment`
- pt_manual 工具 + `/pt manual` 命令实例化（checklist 文档 + 产物登记区 + 步骤执行跟踪）
- PtLogger per-session 持久化日志（NDJSON trace，5 维度）
- ref-check 引用完整性校验 + `pt_check_refs` 工具
```

**验证**：CHANGELOG 与 issues 的"修复记录"段对齐；无新悬空引用。

**commit**：`docs: backfill CHANGELOG with v10.x/v11.x fixes`

---

## 2. 执行步骤（按依赖排序）

> 每步独立 commit，互不阻塞。B1 纯资产可先做；A1 改 schema 需 typecheck + 新测试；A2 是 build 步骤无 commit；E1 纯文档收尾。
>
> **第二轮修订**：原 5 步缩为 3 步 + 1 个 build。C1 已在 commit `2a943d6` 完成，删除。A2 从"改 product-design.md"改为"重建 dist"。

### Step 1 — B1：rename collaboration.md refs（零风险，最快）

```bash
# 改 3 处引用（见 §1.1 表）
# 验证
grep -rn "collaboration.md" .pt/assets/   # 应无输出
rm -f .pt/cache/contexts/*.context.md      # 强制重编译
npm run verify                             # 168 通过（不增不减）
git add .pt/assets/domains/requirements.md .pt/assets/domains/deployment.md
git commit -m "fix(assets): rename collaboration.md refs to pt-collab.md"
```

### Step 2 — A1：扩 Term schema（影响最深，需 typecheck + 新测试）

```bash
# 1. src/schema.ts Term 加 fields?/note?（见 §1.2）
# 2. src/parse/domain-renderers.ts Scene/term renderer 多取字段
# 3. src/compile/type-guards.ts isTermArray 放行
# 4. src/compile/context.ts renderSceneModule term 分支追加输出
# 5. tests/verify/parse-domain.test.ts +compile-context.test.ts 加用例

npm run typecheck                          # 0 错
npm run verify                             # 168 + 2 新 = 170 通过
rm -f .pt/cache/contexts/*.context.md      # 重编译
grep "字段：" .pt/cache/contexts/pt-dev.context.md   # 应命中 pt-collab 段

git add src/schema.ts src/parse/domain-renderers.ts \
        src/compile/type-guards.ts src/compile/context.ts \
        tests/verify/parse-domain.test.ts tests/verify/compile-context.test.ts
git commit -m "feat(schema): extend Term with fields/note to stop silent field loss"
```

### Step 3 — A2：重建 dist（让 pt_check_refs 警告消失）

```bash
# 无源码改动，仅重建 dist 同步 ref-check 静默逻辑
npm run build
# 验证：dist 含静默条件
grep "domains.length" dist/verify/ref-check.js   # 应输出 if (bp && profile.domains.length === 0)
# 重启 pi runtime 后跑 pt_check_refs 应报 0 警告
```

**注**：dist 在 `.gitignore`，本步无 commit。可在发版前常规 build 流程里顺手完成。若需留痕可记 docs commit。

### Step 4 — E1：补 CHANGELOG（纯文档）

```bash
# CHANGELOG.md 0.1.0 节追加 v10.x/v11.x 修复子节（见 §1.4）
git add .pt/docs/CHANGELOG.md
git commit -m "docs: backfill CHANGELOG with v10.x/v11.x fixes"
```

---

## 3. 验收标准（全部完成后）

| 维度 | 标准 | 校验命令 |
|---|---|---|
| 类型安全 | `tsc --noEmit` 0 错 | `npm run typecheck` |
| 回归测试 | 全过（≥170，A1 新增 2） | `npm run verify` |
| Lint | 0 error | `npm run lint` |
| B1 悬空引用 | 无 | `grep -rn "collaboration.md" .pt/assets/` 无输出 |
| A1 字段保留 | context 含 fields/note | `grep "字段：" .pt/cache/contexts/pt-dev.context.md` 命中 |
| A2 dist 同步 | dist 含静默条件 + tool 报 0 警告 | `grep "domains.length" dist/verify/ref-check.js` 命中；重启 pi 后 `pt_check_refs` 无警告 |
| CHANGELOG | 含 v10.x/v11.x 修复子节 | 读 `.pt/docs/CHANGELOG.md` |
| 工作区 | 干净 | `git status` 无 untracked / modified |

---

## 4. 风险与回滚

| 步骤 | 风险 | 回滚 |
|---|---|---|
| B1 | 无（纯字面量替换） | `git revert` |
| A1 | isTermArray 放行新字段可能漏校验导致类型不安全 | 删 fields/note 字段 + renderer 改动，回到只输出 desc |
| A2 | 无（仅重建 dist，无源码/资产改动） | 无需回滚（dist 是构建产物） |
| E1 | 无（纯文档） | `git revert` |

A1 是唯一有实质代码改动的步骤，回滚成本最低（新增字段全是可选，删掉即恢复）。

---

## 5. 关联

- **issue: pt-manual-test-residual**（resolved, commit `2a943d6`）— 原方案 C1 已完成，不再列入
- **issue: module-state-pi-web-multisession**（commit `24d73f9`）— per-session state 改造已完成，不在本方案范围
- **issue: pt-context-persist-lost**（resolved）— E1 CHANGELOG 补记
- **issue: manual-switch-no-injection**（resolved）— E1 CHANGELOG 补记
- **issue: pt-full-duplicate-segment**（resolved）— E1 CHANGELOG 补记
- **issue: au-prefix-tech-debt**（closed）— E1 CHANGELOG 补记
- **commit `5b31dd7`** `fix: ref-check silence uninstance warning when global domains cover` — A2 根因（src 已修，dist 未重建）
- **src/schema.ts** `Term` — A1 改动点
- **src/parse/domain-renderers.ts** Scene/term renderer — A1 改动点
- **src/compile/context.ts** `resolveDomains` / `renderSceneModule` — A1 改动点
- **src/verify/ref-check.ts:65** `domains.length === 0` 静默条件 — A2 根因确认点
- **.pt/assets/domains/pt-collab.md** — A1 字段来源（资产不用改，parse 开始读它已有的 fields/purpose/rule）
- **.pt/docs/designs/pt-asset-layering.md §0.6** — 注入点级追加特性的设计文档（两层 Domain 引用机制）
