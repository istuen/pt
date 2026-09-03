---
type: workflow
name: development
---

# development

## Trigger
### development-trigger
- desc: Pt 开发/操作时参考；含 modify-schema / modify-asset / add-domain-type 开发流程 + transpile / list-available-profiles 转译流程
- hint: /manual:development 查看完整手册

## Scene

### source-tree
- path: src/
- desc: 源码目录（parse/ + compile/ + render/ + schema.ts + transpile.ts + index.ts + config.ts）

### assets-tree
- path: .pt/assets/
- desc: 资产目录，含三个子目录：domains/（Domain md，按 frontmatter.type 分发）+ blueprints/（Blueprint md，结构层——H2=注入点人类自定义名 + agent + injectionPoints + Compilation，跨项目复用）+ profiles/（Profile md，配置层——引用 Blueprint + YAML 全局 domains + 各注入点 ### Domains 追加，项目级）。

### cache-tree
- path: .pt/cache/contexts/
- desc: Context 物理缓存目录（*.context.md，含 source-hash 头；cacheDir 从 Blueprint.compilation.cacheDir 读，默认 .pt/cache/contexts/）

### builtin-assets
- path: src/builtin/assets/
- desc: 内建资产目录（随 npm 包发布，跨项目复用）；用 import.meta.url 定位（不能用 cwd 相对路径——外部用户 cwd ≠ 包路径）；fallback 顺序：项目 .pt/assets/ 优先，内建 src/builtin/assets/ 补充；package.json files: ["src"] 确保 .md 随包发布

## Manual

### plan-implementation
- argument-hint: <requirement-id>
- intent: 从需求文档 {{requirement-id}} 规划实现路径
- vars: [requirement-id]
- step: 读需求文档 — 目标 / 约束 / 验收标准 / 边界纪律
- step: 判断改动类型 — 改 IR / 改资产 / 加新 type / 加新内建资产（按需查 /manual:development 段）
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
- step: testing#regression-verify — 全量回归（含发版就绪检查）
- step: ci-cd#release <version> — 发版