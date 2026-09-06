---
name: product-design
---

# product-design

## Scene

### Pt 是什么
- desc: Pi 扩展，把业务知识资产（MD 资产）转译成 Agent Context（Session Context 固定注入面 + Turn Context 按需触发面）；按 v9 四层模型（Pt Domain→Blueprint→Pt Profile→Agent Context）驱动。

### v9 四层模型
- desc: Pt Domain（内容层，H2 段名开放：Scene/Trigger/Rules/Flows/Checklists/Participant/扩展）+ Blueprint（结构层，YAML groups 项，Agent 端，定义聚合组 inject + Modules + mode）+ Pt Profile（配置层，业务端实例，引用 Blueprint + YAML 全局 domains + 聚合组追加 domains）+ Agent Context（产物层，Phase term-P1 前名 Context，Profile 编译输出，按聚合组聚合多 Domain 内容，物理文件 + hash 缓存）。两面对外：Session Context（每轮固定注入面）+ Turn Context（按需触发面）。

### H2=聚合组（v9 核心）
- desc: Blueprint 的 groups 项 = Agent 聚合组（聚合组名人类自定义语义名），由 group.inject 映射到 Agent 注入位置（session / turn，Agent-agnostic 语义值）；Pt Profile 同名 H2 实例化聚合组（追加 Domain 列表）；AgentContext 同名 modules 项是编译产物。render 按 inject 分发，不硬编码模块名。AgentAdapter 内部把 session/turn 映射到 Pi 的 system_prompt/context_message API。

### 模块级 Domain 引用（v9 核心）
- desc: Pt Profile 按聚合组分别列 Domain（`### Domains`），一个 Domain 的不同 H2 段可贡献不同聚合组。term-Domain 的 Manual Rule[] v9 不再是死代码。

### Domain 即 Module
- desc: v9 唯一模块类型是 Pt Domain，H2 段名即 schema 选择器（Scene/Trigger/Rules/Flows/Checklists/Participant/扩展）；Blueprint.groups[].modules 决定各聚合组参与哪些 H2 段；Pt Profile.domains 全局分发到所有聚合组；AgentContext.modules 按聚合组名聚合各 Domain 的 H2 段内容。

### 三段式编译架构
- desc: parse/（前端，Pt md→IR）+ compile/（中端，IR→IR 变换，按聚合组编译）+ render/（后端，IR→产物字符串+缓存）。各层只依赖 IR，不跨层互相调用。

### Schema / IR 契约
- desc: src/schema.ts 定义 v9 IR（Domain/Blueprint/Profile/AgentContext + BlueprintGroup/ProfileGroup + AgentAdapter），是 Pt 核心契约。parse/compile/render/agent 四层都依赖 IR，不跨层调用。

### Renderer 注册制
- desc: compile/agent-context.ts 维护 moduleRenderers: Record<modName, fn> 注册表，按 modName 分发渲染（v9 替代 v8 domainSceneRenderers 按 type 分发）。加新 modName = 调 registerModuleRenderer("xxx", fn) 加一行注册，不动 compile/ 主循环。

### 依赖反转
- desc: Pt 定义 SourceAdapter 接口（src/schema.ts），来源（MD/YAML/...）实现 adapter。Pt 核心不感知来源格式，加新来源 = 加 adapter，不改核心。

### AgentContext 缓存
- desc: compile 产出 AgentContext IR（modules: Record<聚合组名, 聚合后 markdown>），render 写入 `<cacheDir>/<name>.agent-context.md` 物理文件（cacheDir 用 CACHE_DIR 常量）。失效策略：sourceHash = hash(Profile + Blueprint + Domains) 组合——三者任一变化即失效重编译。

### 聚合组→ 注入位置映射（v9）
- desc: Blueprint.groups[].inject 字段是聚合组到注入位置（session/turn）的映射。render 按 inject 分发，不硬编码聚合组名。inject=session 的聚合组内容 → Session Inject（before_agent_start，会话级）；inject=turn 的聚合组内容 → Turn Inject（input 事件 transform，轮次级）。AgentAdapter 内部映射到 Pi API（system_prompt/context_message）。

### typescript
- role: Pt 全部源码用 TypeScript（src/*.ts）；tsconfig.json include: ["src"]，target ES2022，module ESNext bundler。

### pi-extension-api
- role: Pi 提供的 ExtensionAPI（src/index.ts 入口）；用到的接口：registerFlag / registerCommand / on(session_start|before_agent_start|input|session_shutdown)。

### tsx
- role: 验证脚本运行器（verify-*.ts 用 `npx tsx` 直接执行，tsconfig.json allowImportingTsExtensions: true）。

### md-asset-format
- role: Domain / Profile 是 markdown + YAML frontmatter；Blueprint 是纯 YAML（无 frontmatter）。按 frontmatter 字段分发解析（blueprint → Profile IR；Pt Domain 无 type 字段，H2 段名即 schema 选择器）。v9 资产：Blueprint groups（inject + modules），Profile 同名 H2 实例化聚合组（追加 ### Domains），Profile YAML 全局 domains 自动分发到所有聚合组。

### git
- role: 版本控制；每 Phase 一个 commit（Phase X.Y: ... 格式），baseline 可回退。

### inv-layer-boundary
- desc: parse / compile / render 三层职责互不渗透；跨层调用必须经过 IR 序列化边界。

### inv-renderer-only-extension
- desc: 加新 modName/聚合标题只加 renderer（registerModuleRenderer 一行注册 + renderer 函数），不动 parse/compile 主循环；未注册的 modName 走 generic fallback 自动聚合。如被迫改主循环，说明抽象泄漏。