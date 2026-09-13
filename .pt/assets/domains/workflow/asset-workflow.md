---
name: workflow/asset-workflow
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
- desc: Pt Domain（.pt/assets/domains/*.md，H2 段名即 schema 选择器）+ Blueprint（.pt/assets/blueprints/*.blueprint.yaml，结构层——groups 聚合组：name + inject: session/turn + modules）+ Pt Profile（.pt/assets/profiles/*.md，配置层——blueprint 引用 + YAML 全局 domains + 聚合组 H2 实例化追加）

### directory-layout
- desc: .pt/ 布局声明式 spec——两类入口：assets/（入 git，转译资产 domains/blueprints/profiles）+ docs/（入 git，文档 designs 设计与执行 / issues 问题跟踪 / CHANGELOG）；运行时产物默认不入 git：manuals/（pt_manual 工作文档）+ cache/（contexts 编译产物 / fulls 完整 prompt dump / raws segment dump）+ logs/（NDJSON trace）。改布局就改本场景——当前代码路径常量在 src/constants.ts 需手动同步，未来计划让转译层直接读本场景配置目录与 git 归属

### verify-loop
- desc: 改完资产后必跑 `npm run verify`（全测试通过）+ `tsc --noEmit`；失败则修到过，不跳过不绕过

### cache-invalidation
- desc: 资产改动后删 .pt/cache/agent-contexts/*.agent-context.md 强制重编译；sourceHash = hash(Profile + Blueprint + Domains)，资产变了 hash 自然不同，cache miss 自动重编译

### code-feedback-loop
- desc: 改 src/ 代码后的验证反馈环——v13.x（issue pt-dist-src-desync 修复）：`package.json` 的 `pi.extensions` 走 `./src/index.ts`（jiti 运行时加载），改 src 即生效，无需 `npm run build` + 重启 pi-web。改 src/ 后跑 `npm run verify`（vitest + biome）和 `npm run typecheck`（tsc --noEmit）确认基线干净。`dist/` 仍由 `npm run build`（tsup）生成，发布时双形态都发（`files: ["src", "dist"]`）。历史：P4 之前 `pi.extensions` 指向 dist/index.js，src/ 改后必须 rebuild + 重启 pi-server 才会反映（issue pt-dist-src-desync 根因）。

### pack-layout
- desc: v15.x Pack 是资产来源的抽象——一个 Pack = 一个目录（domains/ + blueprints/ + profiles/ 子目录 + 可选 pt-asset-pack.yaml manifest）。4 类 Pack 按优先级加载：project（@prj，<cwd>/.pt/assets/ 或 pt.project-pack-dir 配置）> settings（@<manifest-name>，.pi/settings.json 的 pt.asset-packs[] 声明，后者赢）> global（@gbl，~/.pt/assets/）> builtin（@pt，src/builtin/assets/ 随 npm 包）。project 永远最高，settings 内部后者赢（npm 风格）

### pack-manifest
- desc: Pack manifest（pt-asset-pack.yaml）是 Pack 身份的单一事实源——含 name / version / description 字段。settings pack 只在 .pi/settings.json 声明 path，name 从 manifest 读（不在 settings 赋名）。manifest.name 不能是 reserved 名（prj/gbl/pt）。无 manifest 的目录用 basename 兜底 name（隐式 pack）

### use-inheritance
- desc: v15.x Profile use 单继承——use: @pack/name 引用另一 Profile 作为基础，递归展开。合并规则：name 强制（不继承）/ blueprint 覆盖 / tagline 覆盖 / domains 追加去重（self 优先）/ groups 同名替换（self 整个 group 覆盖 use 的，含 modules）。循环检测（A use B use A）报错含完整链；菱形（A use B, A use C, B use D, C use D）D 展开两次不误报。不写 use = 完全独立 Profile（back-compat 干净）
