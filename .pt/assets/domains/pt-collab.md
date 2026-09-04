---
name: pt-collab
---

# pt-collab

## Trigger
### pt-collab-trigger
- desc: 派任务/验收时参考；含任务描述/进度报告/验收/baseline 规范
- hint: /manual:pt-collab 查看完整规范

## Scene

### task-description
- desc: 设计者派给执行者的任务描述，固定结构：必读 → 设计原则 → 步骤（含验收）→ 边界纪律 → 开工
- fields: [必读, 设计原则, 步骤, 验收标准, 边界纪律, baseline]
- purpose: 执行者不猜设计意图，按步骤执行即可

### progress-report
- desc: 执行者完成后给验收者的汇报，固定结构：进度表 → 硬指标 → 文件结构 → 风险处置
- fields: [步骤进度, 硬指标结果, 关键文件, 风险与处置]
- purpose: 验收者能独立复验，不只听报告

### acceptance
- desc: 验收者独立复验，不只信报告——查 git/tsc/产物/缓存
- rule: 每个硬指标都要有独立验证方式，不只看执行者给的结果

### baseline-reversibility
- desc: 每个 Phase 前 git baseline 可回退；搞砸了 git revert，不修不凑

## Checklists

### dispatch-task-checklist
- items: [必读段已指明文档位置, 设计原则含"必须守住"的约束, 步骤含验收标准, 边界纪律含"不自行发挥", baseline 可回退]

### report-progress-checklist
- items: [每步骤 commit hash, 硬指标有实测数据, 文件结构列关键文件, 风险有处置记录]

### accept-checklist
- items: [独立跑验证脚本, 独立 grep 残留, 独立读产物内容, 不只信报告]
