---
name: dev-workflow
---

# dev-workflow

## Trigger
### dev-workflow-trigger
- desc: 从需求到发版的端到端开发流程参考；含 source-tree / assets-tree / cache-tree / builtin-assets 目录约定 + 需求来源 / 需求文档结构 / 可行性分析 + feature-lifecycle 完整交付链
- hint: /manual:dev-workflow 查看完整开发手册

## Scene

### source-tree
- path: src/
- desc: 源码目录（parse/ + compile/ + render/ + schema.ts + transpile.ts + index.ts + config.ts）

### assets-tree
- path: .pt/assets/
- desc: 资产目录，含三个子目录：domains/（Domain md，按 frontmatter.type 分发）+ blueprints/（Blueprint md，结构层——H2=注入点人类自定义名 + agent + injectionPoints + Compilation，跨项目复用）+ profiles/（Profile md，配置层——引用 Blueprint + YAML 全局 domains + 各注入点 ### Domains 追加，项目级）。

### cache-tree
- path: .pt/cache/agent-contexts/
- desc: AgentContext 物理缓存目录（*.agent-context.md，含 source-hash 头；cacheDir 从 Blueprint.compilation.cacheDir 读，默认 .pt/cache/agent-contexts/）

### builtin-assets
- path: src/builtin/assets/
- desc: 内建资产目录（随 npm 包发布，跨项目复用）；用 import.meta.url 定位（不能用 cwd 相对路径——外部用户 cwd ≠ 包路径）；fallback 顺序：项目 .pt/assets/ 优先，内建 src/builtin/assets/ 补充；package.json files: ["src"] 确保 .md 随包发布

### requirement-sources
- desc: 需求来源三类：（1）用户对话（Pi session 中实时对话）；（2）Phase 文档（.pt/docs/designs/pt-dev-phases*.md 的任务描述段）；（3）issue（外部 issue tracker，引用到 commit）。

### requirement-doc
- desc: 需求文档结构：目标（Why + What）→ 约束（Must-have / Must-not）→ 验收标准（可独立复验的硬指标）→ 边界纪律（不自行发挥的约束）→ 开工（执行入口）。结构对齐 pt-collab.md 的 task-description 段。

### feasibility-axis
- desc: 可行性分析三轴：技术（架构 / 依赖 / 兼容性）/ 资源（人力 / 时间 / 工具）/ 风险（数据丢失 / 回滚难度 / 用户影响）。任一轴红 → 改方案；不强行推进。

## Flows

### feature-lifecycle
- argument-hint: <requirement-id>
- intent: 从需求到发版的端到端交付链（collect → plan →实施 → 测 → 回归 → 发版）
- vars: [requirement-id]
- step: collect —— 收集需求（听用户原始诉求 / 追问模糊点 / 搜已有资产 / 整理 task-description 结构）
- step: plan —— 规划路径（读需求文档 / 判断改动类型 / 任务分解 / 选 baseline / 输出实施计划）
- step: 实施 —— 按计划改代码/资产，每步一个 commit
- step: 每个改动文件走 testing-workflow#add-test-for-change — 补回归测试
- step: testing-workflow#regression-verify — 全量回归（含发版就绪检查）
- step: release-workflow#release <version> — 发版