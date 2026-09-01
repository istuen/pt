---
type: workflow
name: pt-dev-flow
---

# pt-dev-flow

## Scene

### pt-source-tree
- path: src/
- desc: 源码目录（parse/ + compile/ + render/ + schema.ts + transpile.ts + index.ts + config.ts）

### pt-assets-tree
- path: .pt/assets/
- desc: 资产目录（domains/ + channels/ + blueprints/）

### pt-cache-tree
- path: .pt/contexts/cache/
- desc: Context 物理缓存目录（*.context.md，含 source-hash 头；cacheDir 从 Blueprint.compilation.cacheDir 读）

## Manual

### modify-schema
- argument-hint: (无)
- intent: 改 IR 契约（src/schema.ts）的标准流程
- vars: []
- step: 改 src/schema.ts — 加新字段、改类型签名、或增新 IR 类型
- step: 跑 `tsc --noEmit` — 看类型错误指向（parse/compile/render 三层都可能受影响）
- step: 逐层修复：parse/（adapter/parser）→ compile/（context.ts）→ render/（system-prompt/context-message/cache）
- step: 跑 .pt/verify-phase77.ts — 验证四 Blueprint 产物语义等价 + 缓存命中 + Channel 复用 + glossary 扩展性
- step: git commit "Phase X.Y: ..." — 一个 commit 一笔改动，附语义说明

### modify-asset
- argument-hint: (无)
- intent: 改资产（md 文件）的标准流程
- vars: []
- step: 改目标 .md — frontmatter（type/name）+ H2 段（Scene/Manual/Term/扩展）；v8 资产 H2 = 注入点，Channel/Blueprint 同步改
- step: 删 `<cacheDir>/*.context.md` 对应 Blueprint 的缓存（强制重编译）
- step: 跑 .pt/verify-phase77.ts — 验证产物语义等价（字数允许变但结构要对）
- step: 若结构差异大（>30% 字数变化），diff 对比 v6 baseline（.pt/baseline-phase2-*.md 系列）溯源
- step: git commit — 一个 commit 一类资产改动（Domain 一组 / Channel / Blueprint）

### add-domain-type
- argument-hint: (无)
- intent: 扩展新 Domain Type（除 term/workflow/stack 之外）的标准流程
- vars: []
- step: 写新 type 的 Domain md（frontmatter.type=新 type，H2 段按约定格式）
- step: src/compile/context.ts 加 renderer 函数 + registerDomainSceneRenderer("新 type", fn) 一行注册
- step: 不动 parse/ 主循环 — 前端按 type 分发是通用 path，识别新 type 走通用 fallback
- step: 加测试 Blueprint（如 glossary-test 模板）— 引用新 type 的 Domain，验证产物含新 type 段
- step: 跑 .pt/verify-phase77.ts — 扩展性验证：新 Blueprint 含新 type 段；其他 Blueprint 不污染
- step: git commit — 一个 commit = 一个新 type 落地（renderer + 测试夹具）