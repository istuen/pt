# Pt 部署与发布流程设计（GitHub + npm）

> **目标**：把 `@issac/pi-pt` 从本地仓库变成可被外部用户 `npm install` 安装、Pi 直接加载的扩展包；建立 GitHub → npm 的自动化发布流水线；明确"PT Assets"如何随包分发。
>
> **CI-CD 知识已沉淀为可转译的 Pt 项目领域知识资产**：`.pt/assets/domains/ci-cd.md`（workflow Domain，8 Scene + 6 Manual）。它是 Pt 项目自身部署流程的知识（与 `deployment`/`development`/`asset-workflow` 同类——项目自用，不随包分发）；`pt-dev` profile 已引用，发版时 LLM 可见 Scene/Trigger/Manual。本文档是人类阅读的设计说明，`ci-cd.md` 是 LLM 消费的资产形态——两者描述同一套 CI-CD 知识，冲突时以 `ci-cd.md` 为准（资产是单一事实源）。
>
> 关联文档：`docs/pt-asset-layering.md`（资产分层模型）、`.pt/assets/domains/deployment.md`（发版/回滚策略，手动 fallback）、`.pt/assets/domains/asset-workflow.md`（`sync-builtin` manual）、`src/builtin/assets/domains/ci-cd.md`（CI-CD 自动化实现，资产形态）。
>
> 本文回答三个问题：
> 1. PT Assets 指什么？怎么随 npm 包分发？（§1–§2）
> 2. GitHub + npm 的流水线怎么搭？（§3–§5）
> 3. 一次完整发版长什么样？（§6）

---

## 一、概念厘清：三种"资产"，三种去向

项目里存在三种 `.md` 资产，发布时去向不同，必须先分清，否则会把作者私有内容误发给外部用户。

| 资产 | 位置 | 性质 | 入 npm 包？ | 入 git？ |
|---|---|---|---|---|
| **A. 项目开发资产** | `.pt/assets/` | Pt 项目自用——含 `me`（作者身份）、`pt-dev`/`pt-chat` profile、`glossary-test` 测试夹具 | ❌ 不发 | ✅ 入（开发可复现） |
| **B. 内建资产（Builtin Assets）** | `src/builtin/assets/` | 对外可复用的稳定资产——`authoring`/`usage`/`project-analysis`/`ci-cd` 等 domain、`dev-knowledge` blueprint、不含 `me` 的 `pt` profile | ✅ 随包发 | ✅ 入 |
| **C. 用户项目资产** | 用户的 `.pt/assets/` | 外部用户自己写的资产，Pt 运行时读取 | — | 用户自决 |

**"PT Assets"在本文指 B 类——内建资产**，即随 `@issac/pi-pt` 包分发给所有用户的那批 `.md`。它由 A 类同步而来（剔除作者私有部分），是 Pt 的"出厂知识库"。

> ⚠️ **关键纪律**：`.pt/assets/`（A 类）**绝不**入 npm 包。它含 `me` domain（"Pt 项目作者"），对外发会失真（`sync-builtin` manual 已点明："内建 Profile 不含 me domain"）。靠 `package.json` 的 `files` 字段白名单控制，而非靠人记得排除。

---

## 二、分发模型：单包 + 内建 fallback

### 2.1 为什么不拆成"代码包 + 资产包"两个 npm 包

| 方案 | 优点 | 缺点 |
|---|---|---|
| **方案 1：单包 `@issac/pi-pt`**（代码 + 内建资产同包） | 用户一次安装即得全部；版本联动；pi extension 入口直接引用内建资产 | 包体积稍大（多几 KB `.md`） |
| 方案 2：`@issac/pi-pt`（代码）+ `@issac/pi-pt-assets`（资产） | 资产可独立迭代 | 两个包版本要对齐；用户要装两个；pi extension 入口要跨包解析路径，复杂度上升 |

**决策：方案 1（单包）。** 内建资产是几 KB 的 `.md`，拆包的治理成本远大于体积收益。当内建资产膨胀到上百个 domain 时再考虑拆分（届时走"资产 registry + 按需加载"）。

### 2.2 内建 fallback 机制（代码改动）

当前 `src/` 无 builtin 概念——`loadAndTranspile` 只读项目 `.pt/assets/`。要让外部用户"装包即用"，加一层 fallback：

```
resolveAsset(name, kind)
  ├─ 1. 项目 .pt/assets/{kind}s/<name>.{suffix}.md   ← 用户项目资产优先
  └─ 2. 包内 src/builtin/assets/{kind}s/<name>.{suffix}.md  ← 内建 fallback
```

**语义**：用户项目没有的资产，回退到包内内建。用户可以用同名文件**覆盖**内建（自定义行为），但不能删除内建。这和 pi 的"项目级覆盖包级"一致。

**改动点**（parse 层，不动 compile/render）：
- `src/parse/shared.ts`（或新增 `src/parse/builtin.ts`）：加 `resolveBuiltinPath(cwd, kind, name)`，用 `import.meta.url` 定位包内 `src/builtin/assets/`
- `src/parse/{domain,blueprint,profile}.ts`：读文件失败时调 `resolveBuiltinPath` 重试
- `src/constants.ts`：加 `BUILTIN_ASSETS_DIR` 常量

> 守住 `inv-renderer-only-extension` 纪律：fallback 只动 parse 层（前端），不渗透 compile/render。

### 2.3 `sync-builtin` 流程（A → B 同步）

把 `asset-workflow.md` 里的 `sync-builtin` manual 落地成脚本 `scripts/sync-builtin.mjs`：

```
.pt/assets/                    src/builtin/assets/
├── domains/                   ├── domains/
│   ├── me.md          ──✗──   │   （排除：作者身份）
│   ├── glossary-test.md ─✗──  │   （排除：测试夹具）
│   ├── asset-workflow.md ─→   │   ├── asset-workflow.md
│   ├── deployment.md    ─→    │   ├── deployment.md
│   ├── development.md   ─→    │   ├── development.md
│   ├── product-design.md ─→   │   ├── product-design.md
│   ├── pt-collab.md     ─→    │   ├── pt-collab.md
│   ├── pt-quality.md    ─→    │   ├── pt-quality.md
│   └── requirements.md  ─→    │   └── requirements.md
├── blueprints/                ├── blueprints/
│   └── dev-knowledge.blueprint.md ─→  └── dev-knowledge.blueprint.md
└── profiles/                  └── profiles/
    ├── pt-dev.profile.md      ──✗──   （排除：引用 me）
    ├── pt-chat.profile.md     ─→  （若引用 me 则改写或排除）
    └── glossary-test.profile.md ─✗──  （排除：测试夹具）
```

**排除规则**（脚本内硬编码清单，显式优于隐式）：
- `domains/me.md` — 作者身份
- `profiles/pt-dev.profile.md` — 引用 `me`
- `glossary-test.*` — 测试夹具

脚本干三件事：复制（按白名单）→ `npm run verify`（验内建 fallback + 覆盖语义）→ 报告 diff。发版前跑一次。

---

## 三、npm 包字段补全

当前 `package.json` 缺发布必要字段。补齐：

```jsonc
{
  "name": "@issac/pi-pt",
  "version": "0.1.0",
  "description": "...",
  "type": "module",
  "license": "MIT",                          // 新增
  "author": "issac",                          // 新增
  "repository": {                             // 新增
    "type": "git",
    "url": "https://github.com/issac/pi-pt.git"
  },
  "homepage": "https://github.com/issac/pi-pt",  // 新增
  "bugs": { "url": "https://github.com/issac/pi-pt/issues" },  // 新增
  "keywords": ["pi-package", "pi-extension", "transpiler", "prompt-engineering"],
  "files": [                                  // 新增——白名单控制发布内容
    "src",
    "README.md",
    "docs/pt-asset-layering.md"
  ],
  "main": "./src/index.ts",                   // 新增——虽 pi 走 extensions 字段，但留 main 便于工具识别
  "scripts": {
    "typecheck": "tsc --noEmit",
    "verify": "vitest run tests/verify/",
    "sync-builtin": "node scripts/sync-builtin.mjs",
    "prepublishOnly": "npm run verify && tsc --noEmit"   // 新增——发布前强制校验
  },
  "pi": {
    "extensions": ["./src/index.ts"]
  },
  "peerDependencies": { ... },
  "devDependencies": { ... }
}
```

**关键点**：
- `files: ["src", ...]` —— 白名单。只发 `src/`（含 `src/builtin/assets/`）+ README + 一份分层文档。`.pt/`、`data/`、`tests/`、`docs/`（除指定）、`.zread/` 全部不发。
- **无 build step**：pi 通过 tsx 直接加载 `./src/index.ts`，不发 `.js`/`.d.ts`（`.gitignore` 已忽略它们，`files` 白名单也不含）。peerDependencies 保证消费者装了 pi（含 tsx）。
- `prepublishOnly` —— 双保险，即使本地手抖 `npm publish` 也会先跑验证。

### 3.1 发布内容预览（`npm pack --dry-run` 预期）

```
npm notice === Tarball Contents ===
npm notice src/index.ts
npm notice src/schema.ts
npm notice ... (所有 src/*.ts)
npm notice src/builtin/assets/domains/asset-workflow.md
npm notice ... (内建资产 .md)
npm notice README.md
npm notice docs/pt-asset-layering.md
```

**不应出现**：`.pt/`、`data/*.xlsx`、`tests/`、`package-lock.json`、`node_modules/`、`.zread/`、`*.js`。

---

## 四、GitHub 仓库设置

### 4.1 一次性初始化

```bash
# 1. GitHub 建仓（手动或 gh CLI）
gh repo create issac/pi-pt --public --source=. --remote=origin --description "Pt — Polyglot Transpiler for Pi"

# 2. 推送
git push -u origin main
```

### 4.2 仓库配置（一次性，在 GitHub Web）

| 项 | 设置 |
|---|---|
| Default branch | `main` |
| Branch protection | `main`：要求 PR review ✅、CI 必过 ✅、禁止 force push |
| Secrets | `NPM_TOKEN`（npm access token，automation 类型） |
| Tags | `v*.*.*` 格式，作为发版锚点 |

### 4.3 `.gitignore` 复核

当前 `.gitignore` 已合理，**无需改动**。确认：
- `.pt/contexts/cache/`、`.pt/raws/`、`.pt/fulls/`、`*.context.md` 不入 git（运行产物）✅
- `.pt/assets/` 入 git（开发资产）✅（未在 ignore 列表）
- `*.js`/`*.d.ts` 不入 git（无构建）✅
- `node_modules/`、`dist/` 不入 git ✅

唯一新增：`src/builtin/assets/` **入 git**（内建资产是源码的一部分，要随提交走）。它不在 ignore 列表，默认即入，无需改 `.gitignore`。

---

## 五、CI/CD 流水线（GitHub Actions）

### 5.1 CI：每次 push / PR 跑验证

`.github/workflows/ci.yml`：

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm run verify
```

**作用**：PR 必过 `tsc --noEmit` + `vitest`，否则不能 merge（靠分支保护强制）。

### 5.2 Release：tag 触发 npm 发布

`.github/workflows/release.yml`：

```yaml
name: Release
on:
  push:
    tags: ['v*.*.*']

jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      contents: write   # 创建 GitHub Release
      id-token: write   # npm provenance（可选）
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
          registry-url: https://registry.npmjs.org
      - run: npm ci
      - run: npm run typecheck
      - run: npm run verify
      - run: npm publish --access public --provenance
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
      - name: Create GitHub Release
        uses: softprops/action-gh-release@v2
        with:
          generate_release_notes: true   # 从 commits 自动生成 release notes
          body_path: docs/CHANGELOG.md
```

**触发链**：`git push --tags` → CI 跑验证 → `npm publish` → 创建 GitHub Release。

### 5.3 为什么用 tag 触发而非"push main 就发"

- tag = 显式发版意图，不会每次 merge 误发版
- tag 即 baseline 锚点（`deployment.md` 的 rollback 策略依赖 tag 回退）
- 与 `deployment.md` 的 `release` manual 一致（`git tag {{version}}` 步骤）

---

## 六、完整发版流程（一次发版长这样）

把 `.pt/assets/domains/deployment.md` 的 `release` manual 落地成可执行步骤：

```bash
# 0. 前置：资产有改动则先同步内建（走 asset-workflow#sync-builtin 手册）
#    .pt/assets → src/builtin/assets（剔除 me/测试夹具）
git add src/builtin/assets/
git commit -m "sync builtin assets: <说明>"   # 可选，无改动跳过

# 1. 验证全过
npm run verify && npm run typecheck

# 2. 改版本号
#    patch: 0.1.0 → 0.1.1   （bug 修复）
#    minor: 0.1.0 → 0.2.0   （新功能，向后兼容）
#    major: 0.1.0 → 1.0.0   （破坏性变更）
npm version patch   # 自动改 package.json + commit + 打本地 tag

# 3. 写 CHANGELOG
#    docs/CHANGELOG.md 追加：版本 / 日期 / 新功能 / 修复 / 破坏性变更
git add docs/CHANGELOG.md
git commit --amend --no-edit   # 并入版本号 commit
git tag -f v0.1.1              # 重打 tag 到 amended commit

# 4. 推送——触发 Release workflow
git push origin main --follow-tags
#    或显式：git push origin main && git push origin v0.1.1

# 5. 自动发生（GitHub Actions）：
#    CI verify → npm publish --access public → GitHub Release 创建

# 6. 人工验证
npm view @issac/pi-pt versions   # 含新版本？
# 在干净目录测试：
mkdir /tmp/pt-test && cd /tmp/pt-test
npm init -y && npm i @issac/pi-pt
# pi 加载扩展，确认内建 fallback 生效
```

### 6.1 回滚流程（沿用 `deployment.md` 的 `rollback` manual）

```bash
# 出问题的版本 24h 内
npm unpublish @issac/pi-pt@<broken-version>   # 仅 24h 内可 unpublish
git revert <release-commit>                   # 回退代码
git tag -d v<broken> && git push origin :refs/tags/v<broken>   # 删 tag

# 超 24h：deprecated 标记 + 发修复版
npm deprecate @issac/pi-pt@<broken-version> "broken, use vX.Y.Z+1"
# 走正常 release 流程发修复版
```

---

## 七、实施清单（按依赖顺序）

按顺序执行，每步可独立验证：

| # | 任务 | 产出 | 依赖 |
|---|---|---|---|
| 1 | 补 `package.json` 发布字段 | `license`/`repository`/`files`/`prepublishOnly` 等 | — |
| 2 | 写 `README.md` | 安装/用法/内建资产说明 | 1 |
| 3 | 建 `src/builtin/assets/` + sync 脚本 | `scripts/sync-builtin.mjs` + 内建资产目录 | — |
| 4 | 加内建 fallback 代码 | `src/parse/builtin.ts` + parse 层改动 + `BUILTIN_ASSETS_DIR` 常量 | 3 |
| 5 | 首次走 asset-workflow#sync-builtin 手册 + verify | 内建资产落地 + 测试过 | 3,4 |
| 6 | 建 `docs/CHANGELOG.md` | 首个版本条目 | — |
| 7 | 建 GitHub repo + 推送 | `origin` remote | 1–6 |
| 8 | 加 `.github/workflows/ci.yml` | CI 跑通 | 7 |
| 9 | 配 `NPM_TOKEN` secret | 发布凭证 | 7 |
| 10 | 加 `.github/workflows/release.yml` | tag 触发发布 | 9 |
| 11 | 首次发版 `v0.1.0` | npm 上有包 + GitHub Release | 全部 |

> 步骤 3–5 是"PT Assets"的核心——它把项目自用资产转成对外分发的内建资产，并让代码能在用户项目缺资产时回退到包内。步骤 7–10 是 GitHub + npm 流水线。步骤 11 是首次发版验收。

---

## 八、开放问题（待决策）

1. **`pt-chat` profile 是否随内建发？** 它引用 `me` domain。若发，需改写为不含 `me` 的通用 chat profile，或新建 `default-chat.profile.md`。倾向新建通用 profile。
2. **内建资产要不要支持版本化覆盖？** 当前 fallback 是"包内只读 + 项目覆盖"。若未来要让用户锁版本，再考虑把内建资产版本号写进 frontmatter。
3. **npm provenance（来源证明）**：`release.yml` 用了 `--provenance`，需 npm 账号开 2FA + package 默认 provenance。若嫌麻烦可去掉。
4. **是否要 `dist/` 编译产物**？当前设计不发 `.js`。若有非 pi 的程序化消费者要 `import`，再加 `tsup`/`tsc -emit` 出 `dist/`。MVP 不做。
