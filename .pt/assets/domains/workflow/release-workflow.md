---
name: workflow/release-workflow
---

# release-workflow

## Trigger
### release-workflow-trigger
- desc: 发版时参考；含 CI workflow / Release workflow / npm 包字段 / 发布内容验证 / 发版与回滚自动化
- hint: /manual:release-workflow 查看完整流水线配置

## Scene

### ci-pipeline
- desc: CI workflow（.github/workflows/ci.yml）—— on push main / pull_request main；jobs.verify：checkout + setup-node 22 + npm ci + typecheck + verify；分支保护强制 PR 必过才能 merge。

### release-pipeline
- desc: Release workflow（.github/workflows/release.yml）—— on push tags v*.*.*；jobs.publish：verify → npm publish --access public → 建 GitHub Release；用 NPM_TOKEN secret；--provenance 来源证明（可选，需 npm 2FA + package provenance 开关）。

### trigger-model
- desc: tag 触发发版（非 push main 误发）—— tag = 显式发版意图 + baseline 回退锚点（与 deployment.md#rollback-strategy 一致）；push main 只跑 CI 验证不发版。

### repo-config
- desc: 仓库配置：默认分支 main；分支保护（要求 PR review + CI 必过 + 禁 force push）；Secrets 加 NPM_TOKEN；tag 格式 v*.*.*（semver）。

### npm-package-fields
- desc: package.json 发布字段：files 白名单（["src"] 只发源码 + 内建资产 + README，不靠 .npmignore 排除）；license/repository/homepage/bugs；prepublishOnly 跑 verify + typecheck 双保险；无 build step（pi 走 tsx 直跑 .ts，不发 .js/.d.ts）。

### publish-content
- desc: 发布内容：应含 src/**/*.ts + src/builtin/assets/**/*.md + README.md；不应含 .pt/（开发资产含 me 作者身份）/ data/ / tests/ / node_modules/ / package-lock.json / .zread/；npm pack --dry-run 预览验证。

### secrets-management
- desc: NPM_TOKEN 用 npm automation token（非 publish token——automation 不被 2FA 流程阻塞）；GitHub 仓库 Settings → Secrets and variables → Actions → New repository secret；release.yml 用 ${{ secrets.NPM_TOKEN }} 注入 NODE_AUTH_TOKEN。

### deployment-relationship
- desc: 与 deployment.md 互补——deployment 是发版策略层（版本策略/发布渠道/回滚策略，手动 release manual 作 CI 不可用时的 fallback）；release-workflow 是自动化实现层（workflow 文件/字段/secrets/触发模型）。主路径走 release-workflow#release 自动化。

## Flows

### release
- argument-hint: <version>
- intent: 完整发版流程（确认内建资产 → verify → version → changelog → tag → push → CI 自动发布）
- vars: [version]
- step: 确认内建资产已更新 —— 把本版本要对外发的稳定资产复制到 src/builtin/assets/（剔除 user-info domain / 引用 user-info 的 profile）；有改动则 git commit "Sync builtin assets"
- step: npm run verify && tsc --noEmit —— 全过才能发版
- step: npm version <patch|minor|major> —— 自动改 package.json + commit + 打本地 tag
- step: 追加 .pt/.pt/.pt/docs/CHANGELOG.md —— 版本/日期/新功能/修复/破坏性变更
- step: git commit --amend --no-edit —— 并入版本号 commit；git tag -f v{{version}} 重打 tag 到 amended commit
- step: git push origin main --follow-tags —— 触发 Release workflow
- step: 等 GitHub Actions 跑完 —— CI verify → npm publish → GitHub Release
- step: npm view @issac/pi-pt versions 验证含 {{version}}；干净目录装包测试内建 fallback