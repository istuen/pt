---
type: term
name: pt-concepts
---

# pt-concepts

## Scene

### Pt 是什么
- desc: Pi 扩展，把业务知识资产（OXN MD 文件）转译成 Pi Agent 用的 System Prompt 和 Context Message；按 v7 四层模型（Domain→Channel→Blueprint→Context）驱动。

### v7 四层模型
- desc: Domain（内容层，H2 段名开放：Scene/Manual/Term/扩展）+ Channel（结构层，跨项目复用，定义含哪些模块+编排）+ Blueprint（配置层，每场景一份：Channel + 具体 Domains + trigger + boundaries）+ Context（产物层，Blueprint 编译输出，按模块聚合多 Domain 内容，物理文件 + hash 缓存）。

### 三段式编译架构
- desc: parse/（前端，Pt md→IR）+ compile/（中端，IR→IR 变换，含 layout 编排）+ render/（后端，IR→产物字符串+缓存）。各层只依赖 IR，不跨层互相调用。

### Schema 反转
- desc: Pt 定义 IR 接口（src/schema.ts），来源（OXN/YAML/...）实现 SourceAdapter；Pt 核心不感知来源格式，加新来源 = 加 adapter，不改核心。

### Domain 即 Module
- desc: v7 唯一模块类型是 Domain，用 frontmatter.type 区分承载内容性质（term/workflow/stack/扩展）；Channel.modules 决定 Context 含哪些 ## 段；Context.modules 按 H2 段名聚合各 Domain 的 ## 段内容。

### 模块→注入固定约定
- desc: Context.## Scene 模块 → System Prompt（before_agent_start 注入，session 级）；Context.## Manual 模块 → Context Message（input 事件 transform 注入，轮次级）。两者都是 Pt 产物层名，对齐 Pi 注入机制。

### Context 缓存
- desc: 物理文件 .pt/cache/*.context.md，sourceHash = hash(Domains + Channel + Blueprint) 组合。Pt 读取时比 sourceHash：一致用缓存，不一致重编译覆盖。三者任一变化即失效。

## Manual

### inv-layer-boundary
- desc: parse / compile / render 三层职责互不渗透；跨层调用必须经过 IR 序列化边界。

### inv-renderer-only-extension
- desc: 加新 Domain type 只加 renderer（compile/context.ts 的 registerDomainSceneRenderer 一行注册 + renderer 函数），不动 parse/ 主循环。如被迫改主循环，说明抽象泄漏。