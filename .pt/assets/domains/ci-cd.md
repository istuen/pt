---
type: workflow
name: ci-cd
---

# ci-cd

## Trigger
### ci-cd-trigger
- desc: 搭建/改 CI-CD 流水线时参考；含 CI workflow / Release workflow / npm 包字段 / 发布内容验证 / 发版与回滚自动化
- hint: /manual:ci-cd 查看完整流水线配置

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
- desc: 与 deployment.md 互补——deployment 是发版策略层（版本策略/发布渠道/回滚策略，手动 release manual 作 CI 不可用时的 fallback）；ci-cd 是自动化实现层（workflow 文件/字段/secrets/触发模型）。主路径走 ci-cd#release-flow 自动化。

## Manual

### setup-ci
- argument-hint: (无)
- intent: 搭建 CI workflow（push/PR 跑验证）
- vars: []
- step: 建 .github/workflows/ci.yml —— on push main / pull_request main
- step: jobs.verify：actions/checkout@v4 + actions/setup-node@v4（node-version 22 + cache npm）+ npm ci + npm run typecheck + npm run verify
- step: GitHub 仓库 Settings → Branches → main 加分支保护：要求 PR review + CI 必过 + 禁 force push
- step: 推送到 main 触发首次 CI —— 确认 workflow 跑通
- step: git commit "Add CI workflow"

### setup-release
- argument-hint: (无)
- intent: 搭建 Release workflow（tag 触发 npm 发布）
- vars: []
- step: npm 账号生成 automation access token（非 publish token——automation 不被 2FA 阻塞）
- step: GitHub 仓库 Settings → Secrets → Actions → 加 NPM_TOKEN
- step: 建 .github/workflows/release.yml —— on push tags v*.*.*
- step: jobs.publish：actions/checkout@v4 + actions/setup-node@v4（node-version 22 + registry-url https://registry.npmjs.org + cache npm）+ npm ci + typecheck + verify + npm publish --access public --provenance（env NODE_AUTH_TOKEN = secrets.NPM_TOKEN）
- step: 加 softprops/action-gh-release@v2 创建 GitHub Release（generate_release_notes: true + body_path docs/CHANGELOG.md）
- step: permissions: contents write（建 Release）+ id-token write（provenance 用）
- step: git commit "Add Release workflow"

### setup-npm-fields
- argument-hint: (无)
- intent: 补全 package.json 发布字段
- vars: []
- step: 加 license（MIT）/ author / repository（type: git + url: <repo>.git）/ homepage / bugs（url）
- step: 加 files: ["src", "README.md", "docs/pt-asset-layering.md"] —— 白名单，只发 src + README + 一份分层文档
- step: 加 main: "./src/index.ts" —— 便于工具识别（pi 走 extensions 字段，main 是辅助）
- step: 加 scripts.prepublishOnly: "npm run verify && tsc --noEmit" —— 双保险，手抖 npm publish 也会先验证
- step: npm pack --dry-run 验证发布内容 —— 确认无 .pt/ / data/ / tests/ / node_modules/
- step: git commit "Add npm publish fields"

### verify-publish-content
- argument-hint: (无)
- intent: 验证 npm 包发布内容（发版前必跑）
- vars: []
- step: npm pack --dry-run —— 列出 tarball 内容
- step: 检查应含：src/**/*.ts + src/builtin/assets/**/*.md + README.md
- step: 检查不应含：.pt/（开发资产含 me 作者身份）/ data/（xlsx）/ tests/ / package-lock.json / node_modules/ / .zread/ / *.js
- step: 若含不该发的文件 —— 检查 package.json files 白名单
- step: 修复后重新 npm pack --dry-run 确认

### update-changelog
- argument-hint: <version>
- intent: 更新 docs/CHANGELOG.md 追加 {{version}} 条目
- vars: [version]
- step: 读 git log <last-tag>..HEAD --oneline —— 提取本版本 commit
- step: 分类 commit —— 新功能（feat / Phase）/ 修复（fix / T）/ 破坏性变更 / 文档（docs）
- step: 追加 docs/CHANGELOG.md 顶部 `## {{version}} ({{date}})` —— 列出分类条目
- step: git commit "docs: CHANGELOG for {{version}}"

### release-flow
- argument-hint: <version>
- intent: 完整发版流程（确认内建资产 → verify → version → changelog → tag → push → CI 自动发布）
- vars: [version]
- step: 确认内建资产已更新 —— 走 asset-workflow#sync-builtin 手册：把本版本要对外发的稳定资产复制到 src/builtin/assets/（剔除 me domain / glossary-test 测试夹具 / 引用 me 的 profile）；有改动则 git commit "Sync builtin assets"
- step: npm run verify && tsc --noEmit —— 全过才能发版
- step: npm version <patch|minor|major> —— 自动改 package.json + commit + 打本地 tag
- step: 走 ci-cd#update-changelog 手册 —— 追加 docs/CHANGELOG.md 版本/日期/新功能/修复/破坏性变更
- step: git commit --amend --no-edit —— 并入版本号 commit；git tag -f v{{version}} 重打 tag 到 amended commit
- step: git push origin main --follow-tags —— 触发 Release workflow
- step: 等 GitHub Actions 跑完 —— CI verify → npm publish → GitHub Release
- step: npm view @issac/pi-pt versions 验证含 {{version}}；干净目录装包测试内建 fallback

### rollback-flow
- argument-hint: <broken-version>
- intent: 回滚已发布版本（24h 内 unpublish / 超时 deprecate）
- vars: [broken-version]
- step: 评估影响范围 —— npm 下载量 / 用户报告 / 关键 bug 严重度
- step: 24h 内：npm unpublish @issac/pi-pt@{{broken-version}}；git revert <release-commit>；git tag -d v{{broken-version}} && git push origin :refs/tags/v{{broken-version}}
- step: 超 24h：npm deprecate @issac/pi-pt@{{broken-version}} "broken, use vX.Y.Z+1"；走 release-flow 发修复版
- step: 通知用户 —— GitHub Release 说明 / issue tracker 公告回滚原因 + 修复版本
- step: 写复盘 —— docs/post-mortem-<date>.md，含 root cause / 修复方案 / 防范措施
