---
type: workflow
name: issue-workflow
---

# issue-workflow

## Trigger
### issue-workflow-trigger
- desc: 问题生命周期管理参考；含 issue 文档结构 / status 流转 / 排查流程 / 修复闭环
- hint: /manual:issue-workflow 查看完整问题追踪手册

## Scene

### issue-tracking
- desc: 项目问题追踪机制：.pt/docs/issues/ 下每个 .md 是一个 issue（frontmatter: type=issue + name + status + severity + created + domain + body）。status: open/in-progress/resolved/wontfix。severity: high/medium/low。与 git issue tracker 互补——issue 文档是 LLM 可消费的资产形态（随 pt-dev profile 编译进 system prompt），git issue 是人类协作界面。

### issue-doc-structure
- desc: issue 文档结构：现象（用户视角看到什么）→ 根因（代码层面为何发生，附文件:行号）→ 影响范围（用户体验/LLM 上下文/自动化受阻）→ 排查方法（可独立复验的步骤）→ 修复方向（方案 + 风险 + 备选）→ 关联（相关 issue / 设计文档 / 代码位置）。每个 issue 一个 .md，frontmatter name = issue 标识。

### issue-lifecycle
- desc: issue 生命周期：open（记录）→ in-progress（有人认领排查）→ resolved（已修复 + 验证）→ closed。resolved 时 body 补"修复 commit + 验证方式"段，不删文件（保留历史可追溯）。wontfix 时 body 补"不修理由"。

## Manual

### issue-lifecycle
- argument-hint: <issue-name>
- intent: 问题端到端处理流程（记录 → 排查 → 修复 → 关闭）
- vars: [issue-name]
- step: 确认问题可复现 — 写下复现步骤（不接受"偶尔出现"无复现路径）
- step: 查 .pt/docs/issues/ 已有 issue — 避免重复记录（grep name/现象关键词）
- step: 查 pt-logs（.pt/logs/）— session_start/input/tool 事件 trace 定位代码层面根因
- step: 用 write 创建 .pt/docs/issues/{{issue-name}}.md — frontmatter: type=issue + name + status=open + severity + created + domain；body 按 issue-doc-structure 六段写
- step: 根因段附文件:行号 — 用 read/bash 确认行号准确（不接受"大概在某文件"）
- step: 若 issue 与其他 issue 关联 — 在关联段互相引用 name
- step: 跑 npm run verify + tsc --noEmit
- step: git commit "Add issue: {{issue-name}}"
- step: 读 .pt/docs/issues/{{issue-name}}.md — 确认现状/根因段是否已定位
- step: 用 read 读根因段标注的代码文件:行号 — 验证行号仍准确（代码可能已变）
- step: 用 bash 跑排查方法段的步骤 — 确认可复现
- step: 若根因未定位 — 加 pt-logs trace（在相关代码加 slog 或 console.error 跑一次复现）+ 读 pi 文档确认 API 语义
- step: 更新 issue 文档 — 根因段补精确行号 + 代码引用；status 改 in-progress
- step: 若发现新关联 issue — 记录 + 本 issue 关联段引用
- step: git commit "Investigate {{issue-name}}: 根因定位"
- step: 读 .pt/docs/issues/{{issue-name}}.md 的修复方向段 — 按方案实施（或评估后改方案）
- step: 实施修复 — 改代码/资产，每步一个 commit
- observe: [test-pass]
- step: 跑 npm run verify + tsc --noEmit — 全过才能 resolve
- observe: [ts-compiles, test-pass]
- step: 手动验证现象消失 — 按排查方法段复现，确认不再触发
- step: 更新 issue 文档 — status 改 resolved；body 末尾加"## 修复"段：commit hash + 验证方式 + 修复日期
- step: 检查关联 issue — 若本 issue 阻塞其他 issue，更新它们的关联段
- step: 删 .pt/cache/agent-contexts/pt-dev.agent-context.md（让 resolved 状态重编译）
- step: git commit "Resolve {{issue-name}}: 修复说明"