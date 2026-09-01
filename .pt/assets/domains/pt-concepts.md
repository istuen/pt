---
type: term
name: pt-concepts
---

# pt-concepts

## Scene

### Pt 是什么
- desc: Pi 扩展，把业务知识资产（OXN MD 文件）转译成 Pi Agent 用的 System Prompt 和 Context Message；按 v8 四层模型（Domain→Channel→Blueprint→Context）驱动。

### v8 四层模型
- desc: Domain（内容层，H2 段名开放：Scene/Manual/Term/扩展）+ Channel（结构层，H2=注入点，跨项目复用，定义注入点 target + modules + mode）+ Blueprint（配置层，每场景一份：Channel + 按注入点选 Domain + Trigger/Boundaries + Compilation）+ Context（产物层，Blueprint 编译输出，按注入点聚合多 Domain 内容，物理文件 + hash 缓存）。

### H2=注入点（v8 核心）
- desc: Channel 的 H2 = Pi 注入点（system_prompt / context_message / 扩展），由 Channel.target 映射；Blueprint 同名 H2 实例化注入点（选 Domain + Trigger/Boundaries）；Context 同名 H2 是编译产物。render 按 target 分发，不硬编码模块名。

### 模块级 Domain 引用（v8 核心）
- desc: Blueprint 按注入点分别列 Domain（`### Domains`），一个 Domain 的不同 H2 段可贡献不同注入点。term-Domain 的 Manual Rule[] v8 不再是死代码。

### 三段式编译架构
- desc: parse/（前端，Pt md→IR）+ compile/（中端，IR→IR 变换，按注入点编译）+ render/（后端，IR→产物字符串+缓存）。各层只依赖 IR，不跨层互相调用。

### Schema 反转
- desc: Pt 定义 IR 接口（src/schema.ts），来源（OXN/YAML/...）实现 SourceAdapter；Pt 核心不感知来源格式，加新来源 = 加 adapter，不改核心。

### Domain 即 Module
- desc: v8 唯一模块类型是 Domain，用 frontmatter.type 区分承载内容性质（term/workflow/stack/扩展）；Channel.injectionPoints[].modules 决定各注入点参与哪些 H2 段；Context.modules 按注入点名聚合各 Domain 的 H2 段内容。

### 注入点→ Pi 位置映射
- desc: Channel.injectionPoints[].target 字段是语义名（会话知识/对话记忆）到 Pi 技术名（system_prompt/context_message）的桥梁。render 通用化按 target 分发：会话知识注入点 → System Prompt（before_agent_start 注入，session 级）；对话记忆注入点 → Context Message（input 事件 transform 注入，轮次级）。

### Context 缓存
- desc: 物理文件 `<cacheDir>/<name>.context.md`（cacheDir 从 Blueprint.compilation.cacheDir 读，默认 .pt/contexts/cache/），sourceHash = hash(Domains + Channel + Blueprint) 组合。Pt 读取时比 sourceHash：一致用缓存，不一致重编译覆盖。拆分策略 single-file / by-injection-point 由 Blueprint.compilation.split 配置。

## Manual

### inv-layer-boundary
- desc: parse / compile / render 三层职责互不渗透；跨层调用必须经过 IR 序列化边界。

### inv-renderer-only-extension
- desc: 加新 Domain type 只加 renderer（compile/context.ts 的 registerDomainSceneRenderer 一行注册 + renderer 函数），不动 parse/ 主循环。如被迫改主循环，说明抽象泄漏。