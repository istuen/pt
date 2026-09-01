---
type: term
name: pt-architecture
---

# pt-architecture

## Scene

### 三段式编译架构
- desc: parse/（前端，Pt md→IR）+ compile/（中端，IR→IR 变换，按注入点编译）+ render/（后端，IR→产物字符串+缓存）。各层只依赖 IR，不跨层互相调用。

### Schema / IR 契约
- desc: src/schema.ts 定义 v8 IR（Domain/Channel/Blueprint/Context + InjectionPoint/InjectionPointInstance/CompilationConfig），是 Pt 核心契约。parse/compile/render 三层都依赖 IR，不跨层调用。

### Renderer 注册制
- desc: compile/context.ts 维护 domainSceneRenderers: Record<type, fn> 注册表，按 Domain type 分发渲染。加新 type = 调 registerDomainSceneRenderer("xxx", fn) 加一行注册，不动 compile/ 主循环。

### 依赖反转
- desc: Pt 定义 SourceAdapter 接口（src/schema.ts），来源（OXN/YAML/...）实现 adapter。Pt 核心不感知来源格式，加新来源 = 加 adapter，不改核心。

### Context 缓存
- desc: compile 产出 Context IR（modules: Record<注入点名, 聚合后 markdown>），render 写入 `<Blueprint.compilation.cacheDir>/<name>.context.md` 物理文件。失效策略：sourceHash = hash(Domains + Channel + Blueprint) 组合——三者任一变化即失效重编译。

### 注入点→ Pi 位置映射（v8）
- desc: Channel.injectionPoints[].target 字段是语义名（会话知识/对话记忆）到 Pi 技术名（system_prompt/context_message）的桥梁。render 按 target 分发，不硬编码模块名。target=system_prompt 的注入点聚合内容 → System Prompt（before_agent_start，session 级）；target=context_message 的注入点聚合内容 → Context Message（input 事件 transform，轮次级）。

## Manual

### inv-layer-boundary
- desc: parse / compile / render 三层职责互不渗透；跨层调用必须经过 IR 序列化边界。

### inv-renderer-only-extension
- desc: 加新 Domain type 只加 renderer（registerDomainSceneRenderer 一行注册 + renderer 函数），不动 parse/compile 主循环。如被迫改主循环，说明抽象泄漏。