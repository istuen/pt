# 执行报告：pt-dev 流程闭环 + command/tool 双注册架构

> **执行者**：MiniMax-M3 (LLM coding agent)
> **执行日期**：2026-09-02
> **基线 commit**：`cc0e63c` (Add pt-dev flow completion design doc)
> **终态 commit**：`cf9935f` (Update usage domain: document pt LLM tools)
> **执行范围**：2 份设计文档 → 10 个 commits → 测试 + 类型 + 资产一致性全过

---

## 0. 一句话总结

两份设计文档的 5 个缺口（测试空白 / CHANGELOG 缺失 / release-flow 引用不存在 script / asset-workflow 未被 pt-dev 引用 / 缺端到端调度手册；command/tool 不能共享内核）全部填补，43 → 45 tests，零逻辑重复，零破坏性变更。

---

## 1. 范围

| 文档 | 解决的问题 | Phase 数 |
|---|---|---|
| `docs/pt-dev-flow-completion.md` | pt-dev profile 5 环节里测试环节空白 + ci-cd 引用不存在 script + asset-workflow 未被引用 + 缺端到端调度 | 5 |
| `docs/pt-command-tool-dual-registration.md` | 3 种触发机制全要人类 input，LLM 不能自主创建手册实例 | 5 |

---

## 2. 提交清单（10 commits）

### Doc 1：`pt-dev-flow-completion.md`

| # | Commit | Phase | 标题 |
|---|---|---|---|
| 1 | `8c68469` | 1 | Add testing domain: 测试环节手册 + Trigger 索引 |
| 2 | `c30a6fa` | 2 | Add CHANGELOG.md + ci-cd update-changelog manual |
| 3 | `75fc7c7` | 3 | Fix ci-cd release-flow: sync-builtin 改引用 asset-workflow 手册 |
| 4 | `09423f2` | 4 | Update pt-dev profile: 引用 asset-workflow + testing |
| 5 | `ec05654` | 5 | Add development plan-implementation + deliver-feature manuals |

### Doc 2：`pt-command-tool-dual-registration.md`

| # | Commit | Phase | 标题 |
|---|---|---|---|
| 6 | `d1e76ac` | 1 | Refactor: extract pt command kernels to src/commands.ts |
| 7 | `2e3b90f` | 2 | Refactor: /pt command handlers call pure kernels |
| 8 | `7238826` | 3 | Add pt_status/pt_flows/pt_manual tools (LLM-callable) |
| 9 | `253e0a4` | 4 | test: cover command+tool dual registration kernels |
| 10 | `cf9935f` | 5 | Update usage domain: document pt LLM tools |

---

## 3. 验收证据

### 3.1 类型 + 测试

```bash
$ npm run typecheck
> tsc --noEmit
(exit 0)

$ npm run verify
 ✓ tests/verify/flows.test.ts (2 tests) 12ms
 ✓ tests/verify/phase9.test.ts (43 tests) 167ms
 Test Files  2 passed (2)
      Tests  45 passed (45)
```

**测试数演进**：

| 时点 | phase9 | flows | 总 | 来源 |
|---|---|---|---|---|
| 基线（commit cc0e63c） | 40 | 3 | 43 | 设计文档基线 |
| glossary-test 清理（WIP，未在我范围） | 38 | 2 | 40 | 见 §6 |
| + Doc 2 Phase 4 | 43 | 2 | **45** | 本次终态 |

Doc 2 期望 `43 → 48`，实际 `40 → 45`（+5）。差额 3 = glossary-test 清理掉的 3 个测试，不是我漏做。

### 3.2 Doc 1 五项硬指标

```bash
# 1. tsc 无错 →  exit 0 ✓
# 2. vitest 全过 → 45 tests pass ✓
$ test -f .pt/assets/domains/testing.md && grep "^type: workflow" .pt/assets/domains/testing.md
type: workflow
✓

# 4. CHANGELOG 存在
$ test -f docs/CHANGELOG.md
✓

# 5-7. release-flow 已修正
$ grep "### update-changelog" .pt/assets/domains/ci-cd.md   # 1 行
$ grep "npm run sync-builtin" .pt/assets/domains/ci-cd.md    # 0 行
$ grep "asset-workflow#sync-builtin" .pt/assets/domains/ci-cd.md  # 1 行
✓✓✓

# 8. pt-dev 引用 asset-workflow + testing
$ grep "^domains:" .pt/assets/profiles/pt-dev.profile.md
domains: [me, product-design, requirements, development, asset-workflow, testing, deployment, ci-cd, pt-quality, pt-collab]
✓ (10 个 domain，6 个交付环节全覆盖)

# 9. development 含 plan-implementation + deliver-feature
$ grep -c "^### plan-implementation$\|^### deliver-feature$" .pt/assets/domains/development.md
2
✓

# 10. pt-dev 编译产物含 testing + asset-workflow
$ npx tsx -e "import {loadAndTranspile} from './src/transpile.ts'; loadAndTranspile(process.cwd(),'pt-dev').then(r=>console.log(r.domains.map(d=>d.name).join(',')))"
asset-workflow,ci-cd,deployment,development,glossary-test,me,product-design,pt-collab,pt-quality,requirements,testing,authoring,project-analysis,usage
✓

# 11. pt-dev.context.md 含新手册
$ grep "deliver-feature\|plan-implementation" .pt/contexts/cache/pt-dev.context.md
- plan-implementation <requirement-id>: 从需求文档 {{requirement-id}} 规划实现路径
- deliver-feature <requirement-id>: 从需求到发版的端到端交付流程
✓

# 12. 全局无残留 npm run sync-builtin
$ grep -rn "npm run sync-builtin" .pt/assets/ docs/ | grep -v "pt-dev-flow-completion.md"
(无输出)
✓（仅历史设计文档提及，不是可执行残留）
```

### 3.3 Doc 2 五项硬指标

```bash
# 1-2. typecheck + verify → exit 0 + 45 tests ✓

# 3. 纯函数内核存在
$ grep "^export function" src/commands.ts
export function filterDomainsByProfile<T extends { name: string }>(domains: T[], profile: Profile | null): T[]
export function statusText(): string
export function flowsText(): string
export function buildManualDoc(cwd: string, procedure: string, args: string): ManualDocResult
✓ (4 个 export function，filterDomainsByProfile 从 index.ts 迁入)

# 4. command 壳调内核
$ grep "statusText()\|flowsText()\|buildManualDoc(" src/index.ts
        ctx.ui.notify(statusText(), "info");
        ctx.ui.notify(flowsText(), "info");
        const r = buildManualDoc(ctx.cwd, procedureName, procedureArgs);
      return { content: [{ type: "text", text: statusText() }], details: {} };
      return { content: [{ type: "text", text: flowsText() }], details: {} };
✓ (3 处 command + 2 处 tool = 5 处)

# 5. 3 个 tool 已注册
$ grep 'name: "pt_status"\|name: "pt_flows"\|name: "pt_manual"' src/index.ts
    name: "pt_status",
    name: "pt_flows",
    name: "pt_manual",
✓

# 6. pt_manual 用 withFileMutationQueue
$ grep "withFileMutationQueue" src/index.ts
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
      return withFileMutationQueue(r.filePath, async () => {
✓

# 7. pt-context 未注册 tool
$ grep "pt_context\|pt-context.*registerTool" src/index.ts
(无输出)
✓（§2.4 纪律遵守）

# 8. usage domain 记录 tool
$ grep "pt-tools-llm" src/builtin/assets/domains/usage.md
### pt-tools-llm
✓

# 9. typebox import 在
$ grep 'from "typebox"' src/index.ts
import { Type } from "typebox";
✓

# 10. 重构后 /pt status 行为不变（手动验证 statusText 输出）
$ npx tsx /tmp/test-status.mjs
=== statusText ===
pt profile: pt-dev | pt agent: pi | pt domains: 15, blueprints: 1, profiles: 4, flows: 38 | pt segment length: 9232 chars | pt cache hit: no | pt last built prompt: (未跑过 turn) | pt cwd:
✓（7 字段顺序与格式与重构前一致）
```

---

## 4. 架构终态

### 4.1 pt-dev 触发链（Doc 1 完成后）

```
requirements → development → asset-workflow → testing → deployment → ci-cd
   需求          开发          资产更新        测试       部署        发版
（10 个 domain 引用，6 个 Trigger 索引，4 个 Manual 手册端到端调度）
```

`/deliver-feature <req>` 是顶层调度手册，内部串联：

```
plan-implementation (development)
  ↓
modify-schema / modify-asset / add-domain-type / add-builtin-asset (development)
  ∥
update-domain / update-profile / sync-builtin (asset-workflow)
  ↓
add-test-for-change / write-test (testing)
  ↓
regression-verify (testing)
  ↓
release-readiness-check (testing)
  ↓
update-changelog (ci-cd)
  ↓
release-flow (ci-cd)
```

### 4.2 command + tool 双壳（Doc 2 完成后）

```
              ┌─ command 壳（人类 /pt status）── ctx.ui.notify(text)
src/commands.ts ─┤
（纯函数内核）  └─ tool 壳（LLM tool_call）── return { content: [{ text }] }
```

| 角色 | 查 Pt 状态 | 列手册 | 创建手册实例 | 切 Profile |
|---|---|---|---|---|
| 人类 | `/pt status` | `/pt flows` | `/pt manual deliver-feature req-001` | `/pt-context pt-dev` |
| LLM | `pt_status` tool | `pt_flows` tool | `pt_manual` tool | ❌ 不允许 |

---

## 5. 对原设计的偏差（透明记录）

| # | 原设计 | 实际实现 | 原因 |
|---|---|---|---|
| 1 | `filterDomainsByProfile` 在 `src/agent/pi-adapter.ts` export | 实际原本在 `src/index.ts` line 436；迁到 `src/commands.ts` 并 export | 原设计假设与代码现状不符，但效果一致——纯函数、双壳共享 |
| 2 | flows 行格式 `/${f.name}` | 实际 `${f.name}`（无 `/` 前缀） | 项目现行政策（commit `4afae24` Render manual list as bare name）：手册名作为标识符列出，`/` 前缀属于触发命令语法由 PiAdapter 处理 |
| 3 | Phase 4 测试期望直接调用 `buildManualDoc("nonexistent-proc")` 返 "未找到手册" | 实际用 `beforeAll` 预热 session + `afterAll` 清理 | session 是模块级单例，裸调 "nonexistent-proc" 会因 cachedBundles 为 null 返 "无激活 Profile" 错误先 |
| 4 | Phase 2 测试期望 `npm run verify` 从 43 涨到 48 | 实际 40 → 45（+5） | glossary-test 清理 WIP 已减掉 3 测试（phase9 -2, flows -1），原 43 实际是 40 |
| 5 | doc text `// pt-architecture.md, pt-concepts.md, ...` 提及 | 不在执行范围 | 是 commit `c335210` 历史的注释，不是当前文件 |

以上偏差均**未改变用户可观察行为**，仅内部实现细节调整。

---

## 6. 不在本次执行范围的预存 WIP

执行开始时工作树已有未提交变更，与本次 2 份文档无关：

```
 D .pt/assets/domains/glossary-test.md          # 删除 obsolete glossary-test
 D .pt/assets/profiles/glossary-test.profile.md # domain
 M tests/verify/flows.test.ts                   # 移除 glossary-test 测试
 M tests/verify/phase9.test.ts                  # 移除 glossary-test 引用
```

| 文件 | 改动 | 备注 |
|---|---|---|
| `package.json` | 加 `files: ["src"]` | 与 ci-cd#setup-npm-fields 手册一致，发布白名单 |
| `src/compile/context.ts` | `- /${t.name}` → `- ${t.name}` | 手册行去 `/` 前缀（commit `4afae24`） |
| `src/render/context-message.ts` | 同上 | 同上 |
| `src/parse/{blueprint,domain,profile}.ts` | `parseX(cwd, assetDir, fn)` → `parseX(absDir, fn)` | 重构 absDir 参数，类型更清晰 |
| 内建资产 | `src/builtin/assets/{blueprints,profiles,domains}/` 全部到位 | dev-knowledge blueprint + pt profile + authoring/usage/project-analysis domains |
| `docs/pt-dev-flow-completion.md` | 本次执行的设计文档本身 | 已 commit `cc0e63c` |
| `docs/pt-deployment.md` | 同类发版设计文档 | 已 commit `75fc7c7`（含 sync-builtin 修复） |

这些 WIP 与本次执行兼容（typecheck + verify 均过），是否单独 commit 由你决定。

---

## 7. 已知边界 / 不做的事

按 Doc 2 §6.2「不处理的」清单，**全部遵守**：

- ❌ 不监听 output 事件——LLM 输出 `/<flow-name>` 仍不触发 FlowTemplate（保持人类 input 触发）
- ❌ 不给 `pt-context` 加 confirm 闸门（§2.4 纪律：直接只 command，不退化成人类触发）
- ❌ 不做 Externals→registerTool 批量 tool 化所有 FlowTemplate（本设计是手动 3 个，范围更可控）

按 Doc 1 §1.3「缺口诊断」全部处理：

- ✅ 缺口 A（测试空白）→ testing domain
- ✅ 缺口 B（asset-workflow 未引用）→ pt-dev profile 加 asset-workflow
- ✅ 缺口 C（ci-cd 引用不存在 script）→ release-flow 改引用 asset-workflow#sync-builtin 手册
- ✅ 缺口 D（缺端到端调度）→ development 加 plan-implementation + deliver-feature

---

## 8. 验收清单（设计者复验用）

```bash
# 一次性跑全部硬指标
npm run typecheck                                    # exit 0
npm run verify                                       # 45 tests pass
test -f .pt/assets/domains/testing.md                # exists
test -f docs/CHANGELOG.md                            # exists
grep "### update-changelog" .pt/assets/domains/ci-cd.md | wc -l   # 1
grep "npm run sync-builtin" .pt/assets/domains/ci-cd.md && echo FAIL || echo OK  # OK
grep "^domains:" .pt/assets/profiles/pt-dev.profile.md  # 含 asset-workflow + testing
grep -c "^### plan-implementation$\|^### deliver-feature$" .pt/assets/domains/development.md  # 2
grep 'name: "pt_status"\|name: "pt_flows"\|name: "pt_manual"' src/index.ts | wc -l  # 3
grep "withFileMutationQueue" src/index.ts | wc -l     # ≥2
grep "pt-tools-llm" src/builtin/assets/domains/usage.md | wc -l  # 1
```

---

## 9. Sign-off

| 项 | 状态 |
|---|---|
| 10 commits 落地 | ✅ |
| `tsc --noEmit` exit 0 | ✅ |
| `npm run verify` 45/45 | ✅ |
| Doc 1 五项硬指标 | 5/5 ✅ |
| Doc 2 五项硬指标 | 5/5 ✅ |
| 架构纪律（command/tool 共享内核 + pt-context 不做 tool）| ✅ |
| 设计偏差已透明记录（§5）| ✅ |
| 不在范围的工作已说明（§6）| ✅ |

执行完成。如有设计意图未实现或实现有偏差，请基于 §3 验收证据 + §5 偏差记录 复核。
