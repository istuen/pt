---
name: product-design
---

# product-design

## Scene

### Pt 是什么
- desc: Pi 扩展，把业务知识资产（MD 资产）转译成 Pi Agent 用的 System Prompt 和 Context Message；按 v9 四层模型（Domain→Blueprint→Profile→Context）驱动。

### v9 四层模型
- desc: Domain（内容层，H2 段名开放：Scene/Trigger/Manual/扩展）+ Blueprint（结构层，H2=注入点人类自定义名，Agent 端，定义注入点 target + Modules + mode + agent 字段）+ Profile（配置层，业务端实例，引用 Blueprint + YAML 全局 domains + 注入点追加 domains）+ AgentContext（产物层，Phase term-P1 前名 Context，Profile 编译输出，按注入点聚合多 Domain 内容，物理文件 + hash 缓存）。

### H2=注入点（v9 核心）
- desc: Blueprint 的 H2 = Agent 注入点（注入点名人类自定义语义名），由 ip.target 映射到 Agent 技术注入点（system_prompt / context_message）；Profile 同名 H2 实例化注入点（追加 Domain 列表）；AgentContext 同名 H2 是编译产物。render 按 target 分发，不硬编码模块名。

### 模块级 Domain 引用（v9 核心）
- desc: Profile 按注入点分别列 Domain（`### Domains`），一个 Domain 的不同 H2 段可贡献不同注入点。term-Domain 的 Manual Rule[] v9 不再是死代码。

### Domain 即 Module
- desc: v9 唯一模块类型是 Domain，用 frontmatter.type 区分承载内容性质（term/workflow/stack/扩展）；Blueprint.injectionPoints[].modules 决定各注入点参与哪些 H2 段；Profile.domains 全局分发到所有注入点；AgentContext.modules 按注入点名聚合各 Domain 的 H2 段内容。

### 三段式编译架构
- desc: parse/（前端，Pt md→IR）+ compile/（中端，IR→IR 变换，按注入点编译）+ render/（后端，IR→产物字符串+缓存）。各层只依赖 IR，不跨层互相调用。

### Schema / IR 契约
- desc: src/schema.ts 定义 v9 IR（Domain/Blueprint/Profile/AgentContext + InjectionPointConfig/InjectionPointInstance/CompilationConfig + AgentAdapter），是 Pt 核心契约。parse/compile/render/agent 四层都依赖 IR，不跨层调用。

### Renderer 注册制
- desc: compile/context.ts 维护 moduleRenderers: Record<modName, fn> 注册表，按 modName 分发渲染（v9 替代 v8 domainSceneRenderers 按 type 分发）。加新 modName = 调 registerModuleRenderer("xxx", fn) 加一行注册，不动 compile/ 主循环。

### 依赖反转
- desc: Pt 定义 SourceAdapter 接口（src/schema.ts），来源（MD/YAML/...）实现 adapter。Pt 核心不感知来源格式，加新来源 = 加 adapter，不改核心。

### AgentContext 缓存
- desc: compile 产出 AgentContext IR（modules: Record<注入点名, 聚合后 markdown>），render 写入 `<Blueprint.compilation.cacheDir>/<name>.agent-context.md` 物理文件。失效策略：sourceHash = hash(Profile + Blueprint + Domains) 组合——三者任一变化即失效重编译。

### 注入点→ Pi 位置映射（v9）
- desc: Blueprint.injectionPoints[].target 字段是语义名（会话知识/参考手册）到 Pi 技术名（system_prompt/context_message）的桥梁。render 按 target 分发，不硬编码模块名。target=system_prompt 的注入点聚合内容 → System Prompt（before_agent_start，session 级）；target=context_message 的注入点聚合内容 → Context Message（input 事件 transform，轮次级）。

### typescript
- role: Pt 全部源码用 TypeScript（src/*.ts）；tsconfig.json include: ["src"]，target ES2022，module ESNext bundler。

### pi-extension-api
- role: Pi 提供的 ExtensionAPI（src/index.ts 入口）；用到的接口：registerFlag / registerCommand / on(session_start|before_agent_start|input|session_shutdown)。

### tsx
- role: 验证脚本运行器（verify-*.ts 用 `npx tsx` 直接执行，tsconfig.json allowImportingTsExtensions: true）。

### md-asset-format
- role: Domain / Blueprint / Profile 都是 markdown + YAML frontmatter；按 frontmatter 字段分发解析（type → Domain IR，agent → Blueprint IR，blueprint → Profile IR）。v9 资产：Blueprint H2=注入点（target + ### Modules），Profile 同名 H2 实例化注入点（追加 ### Domains），Profile YAML 全局 domains 自动分发到所有注入点。

### git
- role: 版本控制；每 Phase 一个 commit（Phase X.Y: ... 格式），baseline 可回退。

## Manual

### inv-layer-boundary
- desc: parse / compile / render 三层职责互不渗透；跨层调用必须经过 IR 序列化边界。

### inv-renderer-only-extension
- desc: 加新 modName/聚合标题只加 renderer（registerModuleRenderer 一行注册 + renderer 函数），不动 parse/compile 主循环；未注册的 modName 走 generic fallback 自动聚合。如被迫改主循环，说明抽象泄漏。