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
