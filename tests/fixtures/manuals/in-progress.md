---
procedure: feature-lifecycle
domain: dev-workflow
created: 2026-09-02T09:36:46.251Z
status: in-progress
args: p1-verify
---

# feature-lifecycle 实例

从需求到发版的端到端交付链

- [x] feature-lifecycle p1-verify — 规划路径
- [x] 按计划走 modify-* / add-* / add-* / update-* 手册 — 每步一个 commit
- [ ] 每个改动文件走 testing-workflow#add-test-for-change — 补回归测试
- [ ] testing-workflow#regression-verify — 全量回归
- [ ] testing-workflow#regression-verify — 全量回归（含发版就绪检查）
- [ ] release-workflow#release <version> — 发版

## 执行状态
| Step | Outcome | Message |
|---|---|---|
| 1 | COMPLETED | plan 完成 |
| 2 | COMPLETED | 已 commit |
