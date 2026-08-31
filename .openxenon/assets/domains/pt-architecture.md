---
type: term
name: pt-architecture
---

# pt-architecture

## Scene

### 三段式编译架构
- desc: parse/（前端，Pt md→IR）+ compile/（中端，IR→IR 变换，含 layout 编排）+ render/（后端，IR→产物字符串+缓存）。各层只依赖 IR，不跨层互相调用。

### Schema / IR 契约
- desc: src/schema.ts 定义 v7 四层 IR（Domain/Channel/Blueprint/Context），是 Pt 核心契约。parse/compile/render 三层都依赖 IR，不跨层调用。

### Renderer 注册制
- desc: compile/context.ts 维护 domainSceneRenderers: Record<type, fn> 注册表，按 Domain type 分发渲染。加新 type = 调 registerDomainSceneRenderer("xxx", fn) 加一行注册，不动 compile/ 主循环。

### 依赖反转
- desc: Pt 定义 SourceAdapter 接口（src/schema.ts），来源（OXN/YAML/...）实现 adapter。Pt 核心不感知来源格式，加新来源 = 加 adapter，不改核心。

### Context 缓存
- desc: compile 产出 Context IR（modules: Record<H2段名, 聚合后 markdown>），render 写入 .pt/cache/*.context.md 物理文件。失效策略：sourceHash = hash(Domains + Channel + Blueprint) 组合——三者任一变化即失效重编译。

### 模块→注入固定约定
- desc: Context.## Scene 模块 → 注入 System Prompt（before_agent_start，session 级）；Context.## Manual 模块 → 注入 Context Message（input 事件 transform，轮次级）。两者都是 Pt 产物层，对齐 Pi 注入机制。

## Manual

### inv-layer-boundary
- desc: parse / compile / render 三层职责互不渗透；跨层调用必须经过 IR 序列化边界。

### inv-renderer-only-extension
- desc: 加新 Domain type 只加 renderer（registerDomainSceneRenderer 一行注册 + renderer 函数），不动 parse/compile 主循环。如被迫改主循环，说明抽象泄漏。