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
- desc: 回滚策略：每个 Phase 前 git baseline 可回退（详见 collaboration.md#baseline-reversibility）；发版后出问题 → git revert 到上一个 baseline tag + npm unpublish（24h 内）+ 通知用户。

### publish-form
- desc: 发布形态分两阶段——dev（P0–P3）发 src/.ts（pi 用 jiti 运行时加载，files:["src"]，pi.extensions:["./src/index.ts"]，noEmit:true，改完即跑反馈环最短）；发布（P4+）发 dist/.js（tsc 编译产出，files:["dist"]，pi.extensions:["./dist/index.js"]，main/types 指向 dist，build 脚本复制 builtin 资产到 dist/builtin/assets/）。双轨理由：pi 自身即 dev=src/发布=dist；AgentAdapter 目标是多 agent，非 pi agent 不用 jiti，需标准 ESM .js。详见 .pt/docs/designs/pt-code-quality-plan.md §7.2 §10。

## Manual

### release
- argument-hint: <version>
- intent: 发版流程（{{version}} = 待发布版本号）
- vars: [version]
- step: 跑 `npm run verify` — 所有测试通过才能发版
- step: 更新 package.json version 字段到 {{version}}
- step: 更新 .pt/.pt/docs/CHANGELOG.md — 列出本 Phase 的新功能 / 修复 / 破坏性变更
- step: git commit "release: {{version}}" — 版本号 + changelog 单独成提交
- step: git tag {{version}} — 锚点 tag，baseline 回退用
- step: npm publish --access public — 发版到 npm
- step: 验证发版成功 — npm view @issac/pi-pt versions 应含 {{version}} + Pi 端能加载新版本

### rollback
- argument-hint: <target-version>
- intent: 回滚流程（{{target-version}} = 要回退到的目标版本）
- vars: [target-version]
- step: 评估影响范围 — npm 下载量 / 用户报告 / 关键 bug 严重度
- step: git revert HEAD — 回退当前 commit（如多 commit 用 `git revert <commit-range>`）
- step: npm unpublish @issac/pi-pt@<broken-version> — 仅 24h 内发布的版本可 unpublish，超时用 deprecated 标记
- step: 发版修复版 — 走 release 流程发版到下一个 patch 版本
- step: 通知用户 — 在 Pi 扩展 store / issue tracker 公告回滚原因 + 修复版本
- step: 写复盘 — .pt/docs/designs/post-mortem-<date>.md，含 root cause / 修复方案 / 防范措施