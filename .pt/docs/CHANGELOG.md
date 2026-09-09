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

### 修复（v10.x）
- pt-context 选择跨进程持久化（方案 D：`pi.appendEntry` 写 session JSONL，session_start 加第四源 fallback）— resolves `pt-context-persist-lost`
- `au.` 前缀清理为 `pt:` 命名空间（`au-prefix-tech-debt` 关闭，新代码不再用 `au.`）

### 修复（v11.x）
- `/pt-context` 手动切换后 segment 不注入 system prompt（提取 `registerInjectionIfReady` helper + PiAdapter 幂等保护）— resolves `manual-switch-no-injection`
- auto 探测排除内建 `pt` profile（`detectSingleProfile` 只统计项目级 Profile）
- `/pt full` 输出 segment 重复 2 次（改用 `lastBuiltPrompt` 作 canonical source）— resolves `pt-full-duplicate-segment`
- pt_manual 工具 + `/pt manual` 命令实例化（checklist 文档 + 产物登记区 + 步骤执行跟踪）
- PtLogger per-session 持久化日志（NDJSON trace，5 维度）
- ref-check 引用完整性校验 + `pt_check_refs` 工具
- `pt_check_refs` 静默"未实例化"警告：Profile 有全局 domains 时不报（v11.x 设计：全局分发是合法用法）— 背景：ref-check refactor

### 修复（v14.x）
- **资产迁移可见性（Layer 2-5）** — resolves `pt-asset-migration-visibility`
  - `scanProjectHealth()` 批量体检 5 类反模式（missing-modules / dangling-blueprint-ref / orphan-h2 / empty-segment / unknown-modname）
  - session_start 末尾调 scan + notify 存量项目 schema 错误
  - `/pt check [--profile X] [--fix]` 命令（biome 风格输出）+ `pt_check` LLM tool
  - footer ANSI 颜色（状态染色）+ health suffix `⚠ N issues`（TUI / Web 兼容）
  - `.pt/docs/migrations/v9.0-to-v9.1-modules.md` 迁移文档
- `statusText` 暴露 `pt health:` 行（issue `pt-status-no-injection-state` 后续改进）
- 4 态自报 + 空 segment 告警 + `injectionState` 暴露 — resolves `pt-status-no-injection-state`
- turn inject 按 Profile scope 过滤 — resolves `pt-turn-inject-not-profile-scoped`
