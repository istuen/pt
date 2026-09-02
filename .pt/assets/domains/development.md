---
type: workflow
name: development
---

# development

## Trigger
### development-trigger
- desc: Pt 开发/操作时参考；含 modify-schema / modify-asset / add-domain-type 开发流程 + transpile / list-available-profiles 转译流程
- hint: /manual:development 查看完整手册

## Scene

### source-tree
- path: src/
- desc: 源码目录（parse/ + compile/ + render/ + schema.ts + transpile.ts + index.ts + config.ts）

### assets-tree
- path: .pt/assets/
- desc: 资产目录，含三个子目录：domains/（Domain md，按 frontmatter.type 分发）+ blueprints/（Blueprint md，结构层——H2=注入点人类自定义名 + agent + injectionPoints + Compilation，跨项目复用）+ profiles/（Profile md，配置层——引用 Blueprint + YAML 全局 domains + 各注入点 ### Domains 追加，项目级）。

### cache-tree
- path: .pt/contexts/cache/
- desc: Context 物理缓存目录（*.context.md，含 source-hash 头；cacheDir 从 Blueprint.compilation.cacheDir 读，默认 .pt/contexts/cache/）

### builtin-assets
- path: src/builtin/assets/
- desc: 内建资产目录（随 npm 包发布，跨项目复用）；用 import.meta.url 定位（不能用 cwd 相对路径——外部用户 cwd ≠ 包路径）；fallback 顺序：项目 .pt/assets/ 优先，内建 src/builtin/assets/ 补充；package.json files: ["src"] 确保 .md 随包发布

## Manual

### modify-schema
- argument-hint: (无)
- intent: 改 IR 契约（src/schema.ts）的标准流程
- vars: []
- step: 改 src/schema.ts — 加新字段、改类型签名、或增新 IR 类型
- step: 跑 `tsc --noEmit` — 看类型错误指向（parse/compile/render 三层都可能受影响）
- step: 逐层修复：parse/（adapter/parser）→ compile/（context.ts）→ render/（system-prompt/context-message/cache）
- step: 跑 `npm run verify` — 验证产物语义等价 + 缓存命中 + 扩展性（glossary 假 type 仍能渲染）
- step: git commit "Phase X.Y: ..." — 一个 commit 一笔改动，附语义说明

### modify-asset
- argument-hint: (无)
- intent: 改资产（md 文件）的标准流程
- vars: []
- step: 改目标 .md — frontmatter（type/name/agent/blueprint）+ H2 段（Scene/Trigger/Manual/扩展）；v9 资产 H2 = 注入点在 Blueprint，Profile 同名 H2 实例化
- step: 删 `<cacheDir>/*.context.md` 对应 Profile 的缓存（强制重编译）
- step: 跑 `npm run verify` — 验证产物语义等价（字数允许变但结构要对）
- step: 若结构差异大（>30% 字数变化），diff 对比 baseline context.md 溯源
- step: git commit — 一个 commit 一类资产改动（Domain 一组 / Blueprint / Profile）

### add-domain-type
- argument-hint: (无)
- intent: 扩展新 Domain Type（除 term/workflow/stack 之外）的标准流程
- vars: []
- step: 写新 type 的 Domain md（frontmatter.type=新 type，H2 段按约定格式）
- step: src/compile/context.ts 加 renderer 函数 + registerModuleRenderer(modName, fn) 一行注册
- step: 不动 parse/ 主循环 — 前端按 frontmatter.type 分发是通用 path，未识别 type 走 term 形态 fallback
- step: 加测试 Profile（如 glossary-test）— 引用新 type 的 Domain，验证产物含新 type 段
- step: 跑 `npm run verify` — 扩展性验证：新 Profile 含新 type 段；其他 Profile 不污染
- step: git commit — 一个 commit = 一个新 type 落地（renderer + 测试夹具）

### transpile
- argument-hint: <profile-name>
- intent: 把 Profile {{profile-name}} 转译成 System Prompt + Context Message
- vars: [profile-name]
- step: 读 .pt/assets/domains/ 下所有 .md → parse/domain.ts 每个解析为 Domain IR（{ name, type, modules: Record<H2段名, 内容> }）
- step: 读 .pt/assets/blueprints/ 下所有 .md → parse/blueprint.ts 每个解析为 Blueprint IR（{ name, agent, injectionPoints: InjectionPointConfig[], compilation: CompilationConfig }），H2=注入点
- step: 读 .pt/assets/profiles/ 下所有 .md → parse/profile.ts 每个解析为 Profile IR（{ name, blueprint, domains: string[], injectionPoints: InjectionPointInstance[] }）
- step: 在 Profile 列表里找 name={{profile-name}} 作为 activeProfile → 找到 Profile.blueprint 引用的 Blueprint
- step: 调 compile/context.ts 的 compileContext(profile, blueprint, domains) → Context IR（{ name, sourceHash, modules: Record<注入点名, 聚合 markdown> }），按 Blueprint.injectionPoints 遍历，按 modName 驱动聚合
- step: render/cache.ts loadContext(cwd, name, hash, compilation) 命中 → 用缓存；未命中 → saveContext(Context, compilation) 落盘 `<cacheDir>/<name>.context.md`
- step: render/system-prompt.ts 遍历 Blueprint.injectionPoints，聚合所有 target=system_prompt 的注入点内容 → System Prompt 字符串，PiAdapter 封装 before_agent_start 注入
- step: 用户输入 /<template-name> 时 PiAdapter 触发 render/context-message.ts 的 bindFlowTemplate(FlowTemplate, args) 展开为 Context Message；/manual:<domain-name> 触发注入该 Domain 的 Manual 段内容

### list-available-profiles
- argument-hint: (无)
- intent: 列出当前项目所有可用 Profile 名
- vars: []
- step: 读 .pt/assets/profiles/ 下所有 .profile.md 的 frontmatter.name
- step: 去重排序后输出

### add-builtin-asset
- argument-hint: (无)
- intent: 加内建资产（随包发布的默认 Blueprint/Profile/Domain）到 src/builtin/assets/
- vars: []
- step: 在 src/builtin/assets/{blueprints,profiles,domains}/ 下创建 .md（格式同项目资产）
- step: mdAdapter 加 fallback：项目 .pt/assets/ 找不到 → src/builtin/assets/（用 import.meta.url 定位，不用 cwd）
- step: 同名时项目资产覆盖内建（用户可定制）
- step: package.json files: ["src"] 确保 .md 随 npm publish 发布
- step: 跑 npm run verify 验证 fallback + 覆盖语义

### plan-implementation
- argument-hint: <requirement-id>
- intent: 从需求文档 {{requirement-id}} 规划实现路径
- vars: [requirement-id]
- step: 读需求文档 — 目标 / 约束 / 验收标准 / 边界纪律
- step: 判断改动类型 — 改 IR（走 modify-schema）/ 改资产（走 modify-asset 或 asset-workflow#update-domain/update-profile）/ 加新 type（走 add-domain-type）/ 加新内建资产（走 add-builtin-asset）
- step: 任务分解 — 列出要改的文件 + 每步对应的 Manual 手册名 + 每步要加的测试（走 testing#add-test-for-change）
- step: 选 baseline — git log 找最近稳定 commit 作回退锚点
- step: 输出实现计划 — 步骤列表 + 每步手册名 + 验收方式

### deliver-feature
- argument-hint: <requirement-id>
- intent: 从需求到发版的端到端交付流程
- vars: [requirement-id]
- step: plan-implementation {{requirement-id}} — 规划路径
- step: 按计划走 modify-* / add-* / update-* 手册 — 每步一个 commit
- step: 每个改动文件走 testing#add-test-for-change — 补回归测试
- step: testing#regression-verify — 全量回归
- step: testing#release-readiness-check <version> — 发版就绪检查
- step: ci-cd#release-flow <version> — 发版