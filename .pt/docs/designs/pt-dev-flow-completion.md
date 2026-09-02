# pt-dev 流程闭环——需求→开发→测试→部署→发版全流程补全

> **状态**：设计完成，待执行
> **执行者**：LLM coding agent（具备 read/bash/edit/write 工具）
> **前提**：已读 Pt 项目基线（`src/` 全量 + `.pt/assets/` 全部 domain + `docs/pt-asset-layering.md`）
> **验收**：`tsc --noEmit` + `npm run verify`（43→44+ tests）全过 + `/pt-context pt-dev` 编译产物含 testing + asset-workflow 的 Trigger 索引和 Manual 手册 + `docs/CHANGELOG.md` 存在 + ci-cd#release-flow 手册无 `npm run sync-builtin` 引用

---

## 1. 背景与动机

### 1.1 目标

让 `pt-dev` profile 能支撑 LLM 从「用户一句话需求」走到「npm 发版」的完整流程，每步都有手册可查、Trigger 索引可见、验收标准可复验。这是 Pt「markdown 资产 → 自动上下文」价值链的最强 dogfooding——Pt 自己的开发流程就用 Pt 自己编译的知识来驱动。

### 1.2 现状盘点（5 环节覆盖矩阵）

pt-dev profile 当前引用 8 个 domain：`me, product-design, requirements, development, deployment, ci-cd, pt-quality, pt-collab`。

| 环节 | Scene 知识 | 可执行手册 (Manual) | Trigger 索引 | 闭环? |
|---|---|---|---|---|
| **需求** | requirement-sources / requirement-doc / feasibility-axis | collect-requirements / analyze-feasibility / output-requirement-doc | ✅ requirements-trigger | ✅ 完整 |
| **开发** | source-tree / assets-tree / cache-tree / builtin-assets | modify-schema / modify-asset / add-domain-type / transpile / list-available-profiles / add-builtin-asset | ✅ development-trigger | ⚠️ 缺端到端调度 |
| **资产更新** | update-loop / asset-types / verify-loop / cache-invalidation | update-domain / update-profile / sync-builtin | ✅ asset-update-trigger | ❌ **domain 存在但未被 pt-dev 引用** |
| **测试** | ❌ 无独立 domain | ❌ 无独立手册（测试知识散落在 pt-quality 规范 + development 手册里嵌的 `npm run verify` 步骤） | ❌ 无 testing-trigger | ❌ **完全空白** |
| **部署** | version-strategy / release-channels / rollback-strategy | release / rollback | ✅ deployment-trigger | ✅ 完整 |
| **发版** | ci-pipeline / release-pipeline / trigger-model / repo-config / npm-package-fields / publish-content / secrets-management | setup-ci / setup-release / setup-npm-fields / verify-publish-content / release-flow / rollback-flow | ✅ ci-cd-trigger | ⚠️ 引用不存在的文件/脚本 |

**结论**：5 个主环节里，需求/部署完整，开发/发版有手册但引用了不存在的东西，资产更新未被 profile 引用，**测试环节完全空白**。

### 1.3 缺口诊断

#### 缺口 A：测试环节无独立 domain（最大缺口）

LLM 拿到「发版前要测试」这个意图时，没有 `/manual:testing` 可查，只能翻 pt-quality 的 9 条 invariant（只是约束，不是流程）或凭记忆跑 `npm run verify`。缺：测试策略分层、用例设计流程、回归验证清单、发版就绪检查。

#### 缺口 B：asset-workflow domain 存在但未被 pt-dev 引用

`.pt/assets/domains/asset-workflow.md` 存在，含 `update-domain` / `update-profile` / `sync-builtin` 三个手册，但 `pt-dev.profile.md` 的 domains 列表没引用它。后果：LLM 在 pt-dev 会话里看不到这些手册（listManuals 只列 Profile 引用的 domain 的手册），改资产时只能走 development 的通用 `modify-asset`，不能用按资产类型细分的 `update-domain` / `update-profile`，更关键的是看不到 `sync-builtin`（发版流程的关键步骤）。

#### 缺口 C：ci-cd#release-flow 引用不存在的文件/脚本

- `npm run sync-builtin` —— `package.json` 无此 script，执行者跑 release-flow 时第一步就失败
- `docs/CHANGELOG.md` —— release-flow 第四步引用但文件不存在
- 无 `update-changelog` 手册 —— release-flow 只说「追加 CHANGELOG」但无标准流程

**为什么 `npm run sync-builtin` 不能建脚本**：内建资产（`src/builtin/assets/`）与项目资产（`.pt/assets/`）是**部分不同的集合**——`authoring` / `usage` / `project-analysis` 只存在于内建（对外专用，项目自己不用），`me` / `requirements` / `development` 等只存在于项目（项目专用，不对外发）。同步是「选择哪些资产对外发」的**业务判断**，不是机械复制。脚本化会误导。正确解法：改手册，让 release-flow 引用 asset-workflow#sync-builtin 手册（LLM 执行判断 + 复制）。

#### 缺口 D：开发环节缺端到端调度手册

development 的 6 个手册全是「改已有结构」（modify-schema / modify-asset / add-domain-type / transpile / list-available-profiles / add-builtin-asset）。LLM 拿到 `output-requirement-doc` 产物后，要自己决定走哪个手册、按什么顺序、每步要不要补测试。缺一个调度层把需求→开发→测试→发版串起来。

---

## 2. 设计

### 2.1 方案总览

| 优先级 | 缺口 | 解法 | 改动文件 |
|---|---|---|---|
| P0 | A 测试空白 | 新建 `testing` domain | `.pt/assets/domains/testing.md`（新建） |
| P0 | C CHANGELOG 缺失 | 建 `docs/CHANGELOG.md` + ci-cd 加 `update-changelog` 手册 | `docs/CHANGELOG.md`（新建）+ `.pt/assets/domains/ci-cd.md`（edit） |
| P0 | C sync-builtin script 不存在 | 改 release-flow 手册，引用 asset-workflow#sync-builtin 手册替代 `npm run sync-builtin` | `.pt/assets/domains/ci-cd.md`（edit） |
| P0 | B asset-workflow 未引用 + testing 新建 | pt-dev profile 引用 asset-workflow + testing | `.pt/assets/profiles/pt-dev.profile.md`（edit） |
| P1 | D 缺端到端调度 | development 加 `plan-implementation` + `deliver-feature` 手册 | `.pt/assets/domains/development.md`（edit） |

### 2.2 依赖关系

```
P0-1 (新建 testing domain) ──┐
                              ├──→ P0-4 (pt-dev profile 引用 testing + asset-workflow)
P0-3 (改 release-flow) ───────┤    （依赖 testing/asset-workflow 存在才能引用）
P0-2 (CHANGELOG + update-changelog) ─┤
                                     ├──→ P1 (deliver-feature 引用 testing#regression-verify 等)
                                     │
```

P0-1/P0-2/P0-3 可并行（改不同文件）。P0-4 依赖 P0-1（testing 存在才能引用）。P1 依赖 P0-1（deliver-feature 引用 testing 手册）。建议按 Phase 1→5 顺序执行。

### 2.3 各 domain 间手册引用关系（补全后）

```
用户提需求
  ↓ /manual:requirements → collect-requirements → output-requirement-doc
  ↓ /deliver-feature <req> → plan-implementation（选 modify-* / update-* / add-* 手册）
开发
  ↓ /manual:development → modify-schema / modify-asset / add-domain-type
  ↓ /manual:asset-workflow → update-domain / update-profile / sync-builtin
测试
  ↓ /manual:testing → write-test / add-test-for-change / regression-verify
发版就绪
  ↓ /manual:testing → release-readiness-check <version>
发版
  ↓ /manual:ci-cd → update-changelog → release-flow <version>
  ↓ /manual:ci-cd → rollback-flow（如出问题）
完成
```

`deliver-feature` 是顶层调度手册，内部引用 `plan-implementation` / `testing#add-test-for-change` / `testing#regression-verify` / `testing#release-readiness-check` / `ci-cd#release-flow`，一条命令走完全程。

---

## 3. 执行步骤

### Phase 1: 新建 testing domain（P0-1，填补缺口 A）

**目标**：创建 `.pt/assets/domains/testing.md`，建立测试环节的 Scene 知识 + 4 个 Manual 手册 + Trigger 索引。

**操作**：用 write 工具创建 `.pt/assets/domains/testing.md`，完整内容：

```markdown
---
type: workflow
name: testing
---

# testing

## Trigger
### testing-trigger
- desc: 写测试/跑回归/发版前验证时参考；含测试策略 / 用例设计 / 回归验证 / 发版就绪检查
- hint: /manual:testing 查看完整测试手册

## Scene

### test-strategy
- desc: 测试三层：单元（type-guards/parse 纯函数逻辑）+ 集成（loadAndTranspile 端到端）+ 回归（phase9/flows 基线）。改动类型决定测试层：改 schema→全层；改 compile renderer→集成；改 asset→产物 diff；改 parse→单元+集成。

### test-coverage
- desc: 覆盖率策略：每个 Manual 手册至少 1 个 vitest 断言；新增 FlowTemplate 必加 bindFlowTemplate 触发测试；新增 type guard 必加 isXxxArray 正反例测试；新增 renderer 必加产物结构断言。

### test-fixtures
- desc: 测试夹具：tests/fixtures/ 存测试专用资产（不污染 .pt/assets/）；SourceAdapterContext.assetDir 指向夹具；夹具资产遵循 v9 格式（frontmatter + H2 段）。当前测试用项目 .pt/assets/ 的 glossary-test profile 做扩展性验证。

### regression-baseline
- desc: 回归基线：tests/verify/phase9.test.ts（v9 四层结构断言，40 tests）+ tests/verify/flows.test.ts（手册触发断言，3 tests）。基线变更必须更新断言 + commit。发版前全量回归不只跑 verify，还要查残留（as 断言/console.error/路径字面量散落）。

## Manual

### write-test
- argument-hint: <test-target>
- intent: 给 {{test-target}} 写新测试的标准流程
- vars: [test-target]
- step: 定位测试目标类型 — type guard / parse 函数 / compile 逻辑 / render 产物 / 端到端
- step: 选测试层 — 单元（纯函数，tests/verify/ 下新建 .test.ts）vs 集成（loadAndTranspile 端到端）vs 回归（phase9/flows 基线加断言）
- step: 写 vitest describe/it/expect — 断言可独立复验，不接受 console.log 看输出（pt-quality#test-framework）
- step: 跑 vitest run <新测试文件> — 确认通过
- step: git commit "test: 给 {{test-target}} 加测试"

### add-test-for-change
- argument-hint: <changed-file>
- intent: 给 {{changed-file}} 的改动补回归测试
- vars: [changed-file]
- step: git diff {{changed-file}} — 看新增函数/改逻辑/改资产
- step: 判断测试层 — 改 schema→全层；改 compile renderer→集成；改 asset→产物 diff；改 parse→单元+集成
- step: 在 tests/verify/ 对应文件加断言 — 或新建 .test.ts
- step: 跑 npm run verify — 新断言通过 + 老断言不破
- step: git commit "test: 回归 {{changed-file}} 改动"

### regression-verify
- argument-hint: (无)
- intent: 发版前全量回归验证
- vars: []
- step: npm run typecheck — tsc 全过
- step: npm run verify — vitest 全过（当前 43 tests）
- step: 残留检查 — grep " as " src/（type guard 外的断言）/ console.error / 路径字面量散落（按 docs/pt-tech-debt-audit.md 验收清单）
- step: 产物 diff — 对比 .pt/contexts/cache/ 下 baseline context.md，确认结构对（字数允许变但段要在）
- step: 跨项目验证 — 干净目录 npm pack + npm install + pi --pt-context pt 能启动

### release-readiness-check
- argument-hint: <version>
- intent: 发版 {{version}} 前的就绪检查清单
- vars: [version]
- step: 跑 regression-verify — 全过才能继续
- step: 确认内建资产已更新 — 走 asset-workflow#sync-builtin 手册（复制稳定资产到 src/builtin/assets/，剔除 me/glossary-test/引用 me 的 profile）
- step: npm pack --dry-run — 验证只含 src/**/*.ts + src/builtin/assets/**/*.md + README.md
- step: 检查 docs/CHANGELOG.md 已更新 — 走 ci-cd#update-changelog 手册
- step: 检查 git working tree clean — git status 无未提交改动
- step: 检查 baseline tag — 上一个版本 tag 存在，可回退
```

**验收**：
- `cat .pt/assets/domains/testing.md` 存在且 frontmatter 含 `type: workflow` + `name: testing`
- `grep "^### " .pt/assets/domains/testing.md` 输出含 testing-trigger + test-strategy + test-coverage + test-fixtures + regression-baseline + write-test + add-test-for-change + regression-verify + release-readiness-check
- `tsc --noEmit` 过（无代码改动，应无影响）
- `npm run verify` 过（无测试改动，43 tests 不变）

---

### Phase 2: 建 CHANGELOG + update-changelog 手册（P0-2，填补缺口 C 左半）

**目标**：创建 `docs/CHANGELOG.md`（release-flow 引用但不存在）+ 在 ci-cd domain 加 `update-changelog` 手册（标准化 CHANGELOG 更新流程）。

**操作 2a**：用 write 工具创建 `docs/CHANGELOG.md`，完整内容：

```markdown
# Changelog

本文件记录 `@issac/pi-pt` 每个版本的新功能 / 修复 / 破坏性变更。
更新流程见 ci-cd domain 的 `update-changelog` 手册（`/manual:ci-cd`）。

## 0.1.0 (未发布)

### 新功能
- v9 四层资产模型（Domain / Blueprint / Profile / Context）落地
- 三段式编译管线（parse → compile → render）
- PiAdapter：`before_agent_start` 注入 system_prompt + `input` 事件注入 context_message
- `/pt` 命令族（status / flows / raw / full / manual / logs / logs:clear / sessions）
- `/pt-context` 命令即时切换 Profile
- `/manual:<domain>` + `/<flow-name> <args>` 双触发手册注入
- `/pt manual <procedure>` 手册实例化（生成 checklist 文档，带产物登记区）
- Context 物理缓存（FNV-1a sourceHash，Profile/Blueprint/Domains 任一变化即失效）
- 内建资产 fallback（项目 `.pt/assets/` 覆盖 `src/builtin/assets/`，随 npm 包分发）
- PtLogger per-session 持久化日志（NDJSON，5 维度 trace）

### 技术债清理
- T1–T13：type guards / 常量集中 / registry 模式 / session 状态合并 / 持久化日志
```

**操作 2b**：用 edit 工具改 `.pt/assets/domains/ci-cd.md`，在 `### release-flow` 段之前插入 `### update-changelog` 段，并同时修正 release-flow 的 intent 行（为 Phase 3 铺垫）。

edit 参数（一次调用，两个 edits）：

edits[0].oldText:
```
### release-flow
- argument-hint: <version>
- intent: 完整发版流程（sync-builtin → verify → version → changelog → tag → push → CI 自动发布）
```

edits[0].newText:
```
### update-changelog
- argument-hint: <version>
- intent: 更新 docs/CHANGELOG.md 追加 {{version}} 条目
- vars: [version]
- step: 读 git log <last-tag>..HEAD --oneline —— 提取本版本 commit
- step: 分类 commit —— 新功能（feat / Phase）/ 修复（fix / T）/ 破坏性变更 / 文档（docs）
- step: 追加 docs/CHANGELOG.md 顶部 `## {{version}} ({{date}})` —— 列出分类条目
- step: git commit "docs: CHANGELOG for {{version}}"

### release-flow
- argument-hint: <version>
- intent: 完整发版流程（确认内建资产 → verify → version → changelog → tag → push → CI 自动发布）
```

**验收**：
- `ls docs/CHANGELOG.md` 存在
- `grep "### update-changelog" .pt/assets/domains/ci-cd.md` 输出 1 行
- `grep "确认内建资产" .pt/assets/domains/ci-cd.md` 输出 1 行（intent 行已改）
- `tsc --noEmit` + `npm run verify` 过

---

### Phase 3: 修正 release-flow 的 sync-builtin 步骤（P0-3，填补缺口 C 右半）

**目标**：release-flow 手册第一步 `npm run sync-builtin` 引用不存在的 script，改成引用 asset-workflow#sync-builtin 手册（LLM 执行）。第四步「追加 CHANGELOG」改成引用 P0-2 新增的 update-changelog 手册。

**操作**：用 edit 工具改 `.pt/assets/domains/ci-cd.md`，两个 edits：

edits[0].oldText:
```
- step: npm run sync-builtin —— .pt/assets 同步到 src/builtin/assets（剔除 me/测试夹具）；有改动则 git commit
```

edits[0].newText:
```
- step: 确认内建资产已更新 —— 走 asset-workflow#sync-builtin 手册：把本版本要对外发的稳定资产复制到 src/builtin/assets/（剔除 me domain / glossary-test 测试夹具 / 引用 me 的 profile）；有改动则 git commit "Sync builtin assets"
```

edits[1].oldText:
```
- step: 追加 docs/CHANGELOG.md —— 版本/日期/新功能/修复/破坏性变更
```

edits[1].newText:
```
- step: 走 ci-cd#update-changelog 手册 —— 追加 docs/CHANGELOG.md 版本/日期/新功能/修复/破坏性变更
```

**验收**：
- `grep "npm run sync-builtin" .pt/assets/domains/ci-cd.md` 无输出（已移除）
- `grep "asset-workflow#sync-builtin" .pt/assets/domains/ci-cd.md` 输出 1 行（release-flow 第一步）
- `grep "ci-cd#update-changelog" .pt/assets/domains/ci-cd.md` 输出 1 行（release-flow 第四步 + release-readiness-check 引用）
- `tsc --noEmit` + `npm run verify` 过

---

### Phase 4: 更新 pt-dev profile（P0-4，填补缺口 B + 引用 testing）

**目标**：pt-dev profile 的 domains 列表加 `asset-workflow`（已存在但未引用）+ `testing`（P0-1 新建）。顺序遵循「身份类 → 概念 → 流程环节按交付顺序 → 约束」。

**操作**：用 edit 工具改 `.pt/assets/profiles/pt-dev.profile.md`：

edits[0].oldText:
```
domains: [me, product-design, requirements, development, deployment, ci-cd, pt-quality, pt-collab]
```

edits[0].newText:
```
domains: [me, product-design, requirements, development, asset-workflow, testing, deployment, ci-cd, pt-quality, pt-collab]
```

**验收**：
- `grep "^domains:" .pt/assets/profiles/pt-dev.profile.md` 输出含 `asset-workflow` + `testing`
- 删缓存强制重编译：`rm -f .pt/contexts/cache/pt-dev.context.md`
- 跑 `npm run verify`，`flows.test.ts` 的「pt-dev Profile 可触发手册」测试应过（flows 数 > 之前，因为多了 asset-workflow + testing 的手册）
- 手动验证编译产物含新 domain：`grep "testing-trigger\|asset-update-trigger" .pt/contexts/cache/pt-dev.context.md` 输出含两者

---

### Phase 5: 加端到端调度手册（P1，填补缺口 D）

**目标**：在 development domain 加 `plan-implementation`（从需求文档规划实现路径）+ `deliver-feature`（从需求到发版的端到端流程）两个手册，串联 4 个环节。

**操作**：用 edit 工具改 `.pt/assets/domains/development.md`，在 `### add-builtin-asset` 段末尾（`package.json files: ["src"] 确保 .md 随 npm publish 发布` 那行之后）追加两个手册。

edits[0].oldText:
```
- step: 跑 npm run verify 验证 fallback + 覆盖语义
```

edits[0].newText:
```
- step: 跑 npm run verify 验证 fallback + 覆盖语义

### plan-implementation
- argument-hint: <requirement-id>
- intent: 从需求文档 {{requirement-id}} 规划实现路径
- vars: [requirement-id]
- step: 读需求文档 — 目标 / 约束 / 验收标准 / 边界纪律
- step: 判断改动类型 — 改 IR（走 modify-schema）/ 改资产（走 modify-asset 或 asset-workflow#update-domain/update-profile）/ 加新 type（走 add-domain-type）/ 加新内建资产（走 add-builtin-asset）
- step: 任务分解 — 列出要改的文件 + 每步对应的 Manual 手册名 + 每步要加的测试（走 testing#add-test-for-change）
- step: 选 baseline — git log 找最近稳定 commit 作回退锚点
- step: 输出实现计划 — 步骤列表 + 每步手册名 + 验收方式

### deliver-feature
- argument-hint: <requirement-id>
- intent: 从需求到发版的端到端交付流程
- vars: [requirement-id]
- step: plan-implementation {{requirement-id}} — 规划路径
- step: 按计划走 modify-* / add-* / update-* 手册 — 每步一个 commit
- step: 每个改动文件走 testing#add-test-for-change — 补回归测试
- step: testing#regression-verify — 全量回归
- step: testing#release-readiness-check <version> — 发版就绪检查
- step: ci-cd#release-flow <version> — 发版
```

**验收**：
- `grep "^### plan-implementation$\|^### deliver-feature$" .pt/assets/domains/development.md` 输出 2 行
- 删缓存：`rm -f .pt/contexts/cache/pt-dev.context.md`
- `npm run verify` 过
- `grep "deliver-feature\|plan-implementation" .pt/contexts/cache/pt-dev.context.md` 输出含两者（编译产物含新手册）

---

## 4. 验收清单

全部 Phase 完成后，独立跑以下硬指标（不只信报告，按 pt-collab#accept-checklist）：

| # | 指标 | 验证命令 | 期望 |
|---|---|---|---|
| 1 | tsc 无类型错误 | `npm run typecheck` | exit 0 |
| 2 | vitest 全过 | `npm run verify` | 43 tests pass（flows.test.ts 的 pt-dev 手册数应增加） |
| 3 | testing domain 存在 | `test -f .pt/assets/domains/testing.md && grep "^type: workflow" .pt/assets/domains/testing.md` | type=workflow |
| 4 | CHANGELOG 存在 | `test -f docs/CHANGELOG.md` | exit 0 |
| 5 | update-changelog 手册已加 | `grep "### update-changelog" .pt/assets/domains/ci-cd.md` | 1 行 |
| 6 | release-flow 无 sync-builtin script 引用 | `grep "npm run sync-builtin" .pt/assets/domains/ci-cd.md` | 无输出 |
| 7 | release-flow 引用 sync-builtin 手册 | `grep "asset-workflow#sync-builtin" .pt/assets/domains/ci-cd.md` | ≥1 行 |
| 8 | pt-dev profile 引用 asset-workflow + testing | `grep "asset-workflow.*testing\|testing.*asset-workflow" .pt/assets/profiles/pt-dev.profile.md` | 1 行 |
| 9 | development 含 plan-implementation + deliver-feature | `grep -c "### plan-implementation\|### deliver-feature" .pt/assets/domains/development.md` | 2 |
| 10 | pt-dev 编译产物含 testing + asset-workflow Trigger | `rm -f .pt/contexts/cache/pt-dev.context.md && npx tsx -e "import {loadAndTranspile} from './src/transpile.js'; loadAndTranspile(process.cwd(),'pt-dev').then(r=>console.log(r.bundles[0].domains.map(d=>d.name).join(',')))"` | 输出含 testing + asset-workflow |
| 11 | pt-dev 编译产物含新手册 | `grep "release-readiness-check\|deliver-feature" .pt/contexts/cache/pt-dev.context.md` | 含两者 |
| 12 | 无残留 `npm run sync-builtin` | `grep -rn "npm run sync-builtin" .pt/assets/ docs/` | 无输出 |

### Git 提交纪律

每个 Phase 一个 commit（按 pt-collab#dispatch-task-checklist）：

- Phase 1: `git commit -am "Add testing domain: 测试环节手册 + Trigger 索引"`
- Phase 2: `git commit -am "Add CHANGELOG.md + ci-cd update-changelog manual"`
- Phase 3: `git commit -am "Fix ci-cd release-flow: sync-builtin 改引用 asset-workflow 手册"`
- Phase 4: `git commit -am "Update pt-dev profile: 引用 asset-workflow + testing"`
- Phase 5: `git commit -am "Add development plan-implementation + deliver-feature manuals"`

### 完成后效果

pt-dev profile 的 8 个 Trigger 索引全覆盖 5 个交付环节：

```
requirements-trigger → development-trigger → asset-update-trigger → testing-trigger → deployment-trigger → ci-cd-trigger
       需求                  开发                  资产更新              测试              部署              发版
```

LLM 拿到用户一句话需求后，`/deliver-feature <req>` 一条命令走完需求→开发→测试→发版，每步都有手册可查、有验收可复验。这是 Pt 价值链的最强 dogfooding——Pt 自己的开发流程就用 Pt 自己编译的知识驱动。
