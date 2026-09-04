---
type: workflow
name: requirements
---

# requirements

## Trigger
### requirements-trigger
- desc: 收集/分析/表达需求时参考；含需求来源 / 需求文档结构 / 收集流程 / 可行性分析 / 文档输出
- hint: /manual:requirements 查看完整流程

## Scene

### requirement-sources
- desc: 需求来源三类：（1）用户对话（Pi session 中实时对话）；（2）Phase 文档（.pt/docs/designs/pt-dev-phases*.md 的任务描述段）；（3）issue（外部 issue tracker，引用到 commit）。

### requirement-doc
- desc: 需求文档结构：目标（Why + What）→ 约束（Must-have / Must-not）→ 验收标准（可独立复验的硬指标）→ 边界纪律（不自行发挥的约束）→ 开工（执行入口）。结构对齐 pt-collab.md 的 task-description 段。

### feasibility-axis
- desc: 可行性分析三轴：技术（架构 / 依赖 / 兼容性）/ 资源（人力 / 时间 / 工具）/ 风险（数据丢失 / 回滚难度 / 用户影响）。任一轴红 → 改方案；不强行推进。

## Manual

### collect-requirements
- argument-hint: (无)
- intent: 从用户/文档/issue 收集需求的标准流程
- vars: []
- step: 听用户原始诉求 — 不预先分类，逐字记录（避免 LLM 提前框架化）
- step: 追问模糊点 — 用户省略的"边界"和"为什么"主动问（如"这个改动影响老用户吗？"）
- step: 搜已有资产 — 查 .pt/assets/ + .pt/docs/designs/ 看相关 Domain / Phase 文档是否已表达
- step: 整理到 task-description 结构（见 pt-collab.md#task-description）— 必读 / 设计原则 / 步骤 / 验收 / 边界 / baseline
