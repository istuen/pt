---
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
- desc: 资产改动后删 .pt/cache/agent-contexts/*.agent-context.md 强制重编译；sourceHash = hash(Profile + Blueprint + Domains)，资产变了 hash 自然不同，cache miss 自动重编译
