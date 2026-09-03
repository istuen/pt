---
type: workflow
name: asset-workflow
---

# asset-workflow

## Trigger
### asset-update-trigger
- desc: 讨论达成决策后，把结论持久化到 .pt/assets/ 时参考；含资产类型 / 更新流程 / 验证循环
- hint: /manual:asset-workflow 查看完整流程

## Scene

### update-loop
- desc: 讨论决策 → 定位目标资产（Domain/Blueprint/Profile）→ 改 .md → 删 cache → verify + typecheck → commit

### asset-types
- desc: Domain（.pt/assets/domains/*.md，frontmatter.type 区分 term/workflow/stack，H2 段 Scene/Trigger/Manual）+ Blueprint（.pt/assets/blueprints/*.md，结构层——H2=注入点 + target + Modules + Compilation）+ Profile（.pt/assets/profiles/*.md，配置层——blueprint 引用 + domains 列表 + 注入点追加）

### directory-layout
- desc: .pt/ 布局声明式 spec——两类入口：assets/（入 git，转译资产 domains/blueprints/profiles）+ docs/（入 git，文档 designs 设计与执行 / issues 问题跟踪 / CHANGELOG）；运行时产物默认不入 git：manuals/（pt_manual 工作文档）+ cache/（contexts 编译产物 / fulls 完整 prompt dump / raws segment dump）+ logs/（NDJSON trace）。改布局就改本场景——当前代码路径常量在 src/constants.ts 需手动同步，未来计划让转译层直接读本场景配置目录与 git 归属

### verify-loop
- desc: 改完资产后必跑 `npm run verify`（全测试通过）+ `tsc --noEmit`；失败则修到过，不跳过不绕过

### cache-invalidation
- desc: 资产改动后删 .pt/cache/contexts/*.context.md 强制重编译；sourceHash = hash(Profile + Blueprint + Domains)，资产变了 hash 自然不同，cache miss 自动重编译

## Manual

### update-domain
- argument-hint: <domain-name>
- intent: 更新 Domain 资产（新增/修改 Scene 项、Manual 规则、Trigger 等）
- vars: [domain-name]
- step: 定位 .pt/assets/domains/{{domain-name}}.md
- step: 改 frontmatter（type/name）或 H2 段（Scene 加 ### 项 + desc；Manual 加 ### 规则 + desc/check；Trigger 加 ### 项 + desc/hint）
- step: 删 .pt/cache/contexts/*.context.md（强制重编译）
- step: 跑 `npm run verify` + `tsc --noEmit`
- step: git commit "Update {{domain-name}} domain: 改动说明"

### update-profile
- argument-hint: <profile-name>
- intent: 更新 Profile 资产（调整 domains 顺序、增删 domain 引用、改 blueprint 引用）
- vars: [profile-name]
- step: 定位 .pt/assets/profiles/{{profile-name}}.profile.md
- step: 改 frontmatter（blueprint）或 domains 列表（顺序影响 LLM attention——身份类 domain 放前，约束类放后）
- step: 删 .pt/cache/contexts/{{profile-name}}.context.md
- step: 跑 `npm run verify`
- step: git commit "Update {{profile-name}} profile: 改动说明"

### sync-builtin
- argument-hint: (无)
- intent: 把项目资产同步到内建（src/builtin/assets/）供外部用户使用
- vars: []
- step: 确认资产已稳定（通过 pt-dev 验证 + 多轮讨论）
- step: 复制到 src/builtin/assets/ 对应子目录（blueprints/profiles/domains）
- step: 内建 Profile 不含 me domain（"Pt 作者"身份对外失真）
- step: 跑 `npm run verify` 验证内建 fallback + 覆盖语义
- step: git commit "Sync builtin assets: 资产名"
