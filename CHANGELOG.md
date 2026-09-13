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
- **Profile tagline** — v14.x 增量
  - `Profile.tagline?: string` 选填字段（frontmatter `tagline: <value>`）
  - 展示路径：`/pt-profile` 选择器 `name — tagline` / `pt status` 显式展开 / footer `: <tagline>`（≤35 字符）
  - back-compat：无 tagline 的 profile 行为不变
  - 4 个 pt-* profile 资产补 tagline：pt-dev / pt-arch / pt-design / pt-devops
- `statusText` 暴露 `pt health:` 行（issue `pt-status-no-injection-state` 后续改进）
- 4 态自报 + 空 segment 告警 + `injectionState` 暴露 — resolves `pt-status-no-injection-state`
- turn inject 按 Profile scope 过滤 — resolves `pt-turn-inject-not-profile-scoped`

### v15.x：资产包化（Pack 抽象 + 跨项目共享）

**新功能**：
- **Pack 抽象**：资产来源统一为 `AssetPack` 接口，4 类 Pack 按优先级加载（project > settings > global > builtin）
- **全局 Pack**：`~/.pt/assets/` 用户跨项目共用资产，首次启动引导创建
- **settings 声明 Pack**：`.pi/settings.json` 的 `pt.asset-packs[]` 加载第三方 / 团队 Pack（只 path 字段，name 从 manifest 读）；`pt.project-pack-dir` 可配 project pack 路径
- **Pack manifest**：`pt-asset-pack.yaml` 定义 Pack 身份（name / version / description），name 是单一事实源
- **`@pack/name` 限定语法**：Profile / Domain / Blueprint 引用可限定 Pack（`@prj` / `@gbl` / `@pt` reserved + `@<pack-name>/<asset>` 第三方）
- **`use` Profile 单继承**：Profile 可 `use` 另一 Profile 作为基础，增量覆盖（blueprint 覆盖 / domains 追加 / groups 替换）+ 循环检测 + 菱形处理
- **跨 Pack mixin 合并**：同 name asset 跨 Pack 合并（mergeSectionContent）——Scenario D/E 同名 asset 内容 union
- **Pack 校验与降级**：`validatePack` 两层校验（结构 + 解析）+ project pack 失效降级到 builtin guide + settings pack 失效预警跳过
- **builtin `pack-repair` domain**：project pack 校验失败时 `/manual:pack-repair` 触发修复引导

**改进**：
- cache 文件名加 pack 前缀（`<pack>__<profile>.agent-context.md`）+ sourceHash 含 pack 身份
- `/pt status` 展示 pack 健康（4 类 Pack 校验结果）
- `/pt-profile` 选择器展示 `[@pack]` 前缀 + tagline

**back-compat**：
- 不写 `pt.asset-packs` / `pt.project-pack-dir` / `use` 行为等价 v14.x
- 不限定引用（`foo`）自动解析为 `@prj/foo`（与今天前者赢补充一致）
- phase9 44 集成测试全过

**设计源**：`.pt/docs/designs/pt-asset-pack.md`（v15.x 完整设计）
