---
type: term
name: pt-concepts
---

# pt-concepts

## Scene

### Pt 是什么
- desc: Pi 扩展，把业务知识资产（OXN MD 文件）转译成 Pi Agent 用的 System Prompt 和 Manual；按 v6 语义驱动。

### 三段式编译架构
- desc: frontend（异构来源 → SchemaBundle IR）→ midend（IR 编排）→ backend（IR → System Prompt / Manual）。各层只依赖 IR，不跨层互相调用。

### Schema 反转
- desc: Pt 定义 IR 接口（schema.ts），OXN 实现 SourceAdapter；Pt 核心不感知来源格式，加新来源 = 加 adapter，不改核心。

### Domain 即 Module
- desc: v6 唯一模块类型是 Domain，用 frontmatter.type 区分承载内容性质（term/workflow/stack/扩展）；Scene 读 Domain.## Scene 段，Blueprint 读 Domain.## Blueprint 段。

### 两个产物通道
- desc: System Prompt（session 级，由 Scene 编译产出，before_agent_start 注入）+ Manual（轮次级，由 Blueprint 实例化产出，input 事件 transform）。前者可缓存，后者不可缓存。

## Blueprint

### inv-three-tier-boundary
- desc: frontend / midend / backend 三层职责互不渗透；跨层调用必须经过 IR（SchemaBundle）序列化边界。

### inv-midend-zero-change
- desc: 中端 layout.ts 在模型重构（v3 → v6）期间应保持零改动；如被迫修改，说明抽象泄漏，需回看 §0 语义。

### inv-renderer-registration
- desc: backend 不硬编码 Domain Type；renderer 按 Record<type, fn> 注册表分发；加新 type = 加一行注册。