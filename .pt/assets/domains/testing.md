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
- desc: 测试夹具：tests/fixtures/ 存测试专用资产（不污染 .pt/assets/）；SourceAdapterContext.assetDir 指向夹具；夹具资产遵循 v9 格式（frontmatter + H2 段）。扩展性验证走 tests/fixtures/ 夹具（加新 type 时在此建测试专用 Profile + Domain）。

### regression-baseline
- desc: 回归基线：tests/verify/phase9.test.ts（v9 四层结构断言）+ tests/verify/flows.test.ts（手册触发断言）。基线变更必须更新断言 + commit。发版前全量回归不只跑 verify，还要查残留（as 断言/console.error/路径字面量散落）。

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
- step: 残留检查 — grep " as " src/（type guard 外的断言）/ console.error / 路径字面量散落（按 .pt/docs/designs/pt-tech-debt-audit.md 验收清单）
- step: 产物 diff — 对比 .pt/cache/contexts/ 下 baseline context.md，确认结构对（字数允许变但段要在）
- step: 跨项目验证 — 干净目录 npm pack + npm install + pi --pt-context pt 能启动

### release-readiness-check
- argument-hint: <version>
- intent: 发版 {{version}} 前的就绪检查清单
- vars: [version]
- step: 跑 regression-verify — 全过才能继续
- step: 确认内建资产已更新 — 走 asset-workflow#sync-builtin 手册（复制稳定资产到 src/builtin/assets/，剔除 me/引用 me 的 profile）
- step: npm pack --dry-run — 验证只含 src/**/*.ts + src/builtin/assets/**/*.md + README.md
- step: 检查 .pt/.pt/docs/CHANGELOG.md 已更新 — 走 ci-cd#update-changelog 手册
- step: 检查 git working tree clean — git status 无未提交改动
- step: 检查 baseline tag — 上一个版本 tag 存在，可回退
