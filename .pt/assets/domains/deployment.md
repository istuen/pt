---
type: workflow
name: deployment
---

# deployment

## Trigger
### deployment-trigger
- desc: 发版/回滚时参考；含版本策略 / 发布渠道 / 发版流程 / 回滚流程
- hint: /manual:deployment 查看完整流程

## Scene

### version-strategy
- desc: 版本策略：每 Phase 一个 commit（Phase X.Y: ... 格式），baseline 可回退。版本号遵循 semver（major.minor.patch），对应 Phase 主版本号递增（详见 product-design.md#git）。

### release-channels
- desc: 发布渠道两类：（1） npm @issac/pi-pt — Pi 扩展主包，package.json peerDependencies 声明 Pi API 版本；（2） git tag — 每个 Phase 稳定点打 tag，baseline 回退锚点。

### rollback-strategy
- desc: 回滚策略：每个 Phase 前 git baseline 可回退（详见 pt-collab.md#baseline-reversibility）；发版后出问题 → git revert 到上一个 baseline tag + npm unpublish（24h 内）+ 通知用户。

### publish-form
- desc: 发布形态分两阶段——dev（P0–P3）发 src/.ts（pi 用 jiti 运行时加载，files:["src"]，pi.extensions:["./src/index.ts"]，noEmit:true，改完即跑反馈环最短）；发布（P4+）发 dist/.js（tsc 编译产出，files:["dist"]，pi.extensions:["./dist/index.js"]，main/types 指向 dist，build 脚本复制 builtin 资产到 dist/builtin/assets/）。双轨理由：pi 自身即 dev=src/发布=dist；AgentAdapter 目标是多 agent，非 pi agent 不用 jiti，需标准 ESM .js。详见 .pt/docs/designs/pt-code-quality-plan.md §7.2 §10。
