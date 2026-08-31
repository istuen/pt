---
type: stack
name: pt-capabilities
---

# pt-capabilities

## Scene

### schema-ts
- role: IR 契约定义（Domain/Struct/Render 三层接口 + SourceAdapter 反转）

### frontend
- role: OXN MD → SchemaBundle（parser.ts 字符串解析 + adapter.ts 分发到 Domain/Struct 装/拆）

### midend
- role: layout 编排策略（byDomain / byType / hybrid 三 mode；v6 中保留以备 Phase 7+ 复用）

### backend-prompt
- role: SchemaBundle → System Prompt（generateV6Prompt，按 type 调 scene renderer）

### backend-message
- role: SchemaBundle + Manual struct + args → Manual 实例（generateManual，按 type 找 FlowTemplate 后 binder 展开）

### transpile
- role: Source Adapter 注册表 + 调度（loadAndTranspile：adapter.load → generateV6Prompt → 剥注释）

## Manual