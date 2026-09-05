---
type: issue
name: pt-dist-src-desync
status: resolved
severity: medium
created: 2026-09-04
updated: 2026-09-05
resolved: 2026-09-05
domain: pt-dev
---

# dist/ 与 src/ 不同步——开发期 MCP 工具走 stale 编译产物

> **背景**：在排查 `pt-no-agent-context-multi-root-causes` 父 issue 时新发现。
> **不在父 issue 范围**——这是开发基础设施问题，独立跟踪。
> **优先级**：**P1.5 中**——影响所有 MCP 工具（pt_status / pt_flows / pt_manual）输出准确性

## 现象

`src/` 已 P1 改名（commit `0455a47`，Sep 4 13:28 之前），但 `dist/` 未同步 rebuild：

```bash
$ stat -f "%Sm" src/commands.ts dist/commands.js
Sep  4 20:20:39 2026 src/commands.ts   ← 新代码
Sep  4 13:28:04 2026 dist/commands.js  ← 旧编译产物（6+ 小时滞后）
```

**实证**（2026-09-04 16:00）：

```
$ grep "context_message 注入点\|turn 注入点" src/commands.ts
src/commands.ts:79:        return "当前 Profile 无可触发手册（turn 注入点无 workflow-type Domain）";  ✅ 新版

$ grep "context_message 注入点\|turn 注入点" dist/commands.js
dist/commands.js:65:        return "当前 Profile 无可触发手册（context_message 注入点无 workflow-type Domain）";  ❌ 旧版
```

**MCP 工具实际表现**：

| 工具 | 输出 | 是否 stale |
|---|---|---|
| `pt_status` | `flows: 7` | ⚠️ stale（dist 数据） |
| `pt_flows` | `"context_message 注入点无 workflow-type Domain"` | ❌ stale 字符串 |
| `pt_manual` | `"未找到手册: issue-lifecycle"` | ❌ stale（找不到新 FlowTemplate） |

手工 `npm run build` rebuild dist 后，dist 字符串已更新（`turn 注入点`），但 MCP 工具仍返回 stale —— **pi-web server 缓存了旧 dist，需重启 pi-web 才能生效**。

## 根因

`package.json:27` 的 `pi.extensions: ["./dist/index.js"]` 让 Pi extension 加载 `dist/` 而非 `src/`。

**这不是单纯 bug**——是设计选择：发布形态走 dist/（生产用），开发形态走 src/（jiti 运行时加载，反馈环最短）。但当前：
1. dev 模式没启用（`package.json` 没有 `jiti` + `src/index.ts` 配置）
2. 没有 `prebuild` hook 监听 src 变更自动 rebuild dist
3. 没有文档说"改 src 后必须 rebuild dist + 重启 pi-web"

`.pt/assets/domains/deployment.md` 的 `publish-form` 段提到：
> "dev（P0–P3）发 src/.ts（pi 用 jiti 运行时加载，files:["src"]，pi.extensions:["./src/index.ts"]，noEmit:true，改完即跑反馈环最短）"

但实际 `package.json` 已配置 `pi.extensions: ["./dist/index.js"]`，**没有走 dev 形态**——可能是 P3→P4 切换时没回退。

## 影响范围

| 维度 | 影响 |
|---|---|
| LLM 实际对话 | 不直接影响（transpile 走的是 src/，不是 dist/）|
| MCP 工具准确性 | ⚠️ **所有 MCP 工具输出 stale**——调试时误导 |
| 反馈环 | ⚠️ 改 src 后必须 rebuild + 重启 pi-web，反馈环延长到几分钟 |
| 其他 issue 排查 | ⚠️ `pt-no-agent-context-*` 系列 issue 修复时，MCP 工具输出不可信 |
| 发布形态 | ✅ 不影响（发布前必须 rebuild 是正确流程）|

## 排查方法（可独立复验）

```bash
# 1. 看 src vs dist 时间差
stat -f "%Sm %N" /Users/issac/pro/pt/dist/commands.js /Users/issac/pro/pt/src/commands.ts
# 预期：src 比 dist 新（已 P1 改名，未 rebuild）

# 2. 看 MCP 工具是否返回 stale 字符串
# 在 pi session 内调用：
/ pt_status
# 预期：flows 数与实际 pt-dev profile 的 FlowTemplate 数一致（≈12）
/ pt_flows
# 预期：返回"turn 注入点无 workflow-type Domain"（修复后）而非 "context_message 注入点无 workflow-type Domain"（stale）

# 3. rebuild dist
npm run build
# 预期：dist 时间刷新

# 4. 重启 pi-web 后再调 MCP 工具
# macOS: pkill -f pi-web && /opt/homebrew/bin/pi-web --hostname 0.0.0.0 &
# 预期：MCP 工具输出与 src/ 一致
```

## 修复方向

### 方案 A：dev 形态走 src/ + jiti（最推荐）

改 `package.json`：

```diff
-    "extensions": [
-      "./dist/index.js"
-    ]
+    "extensions": [
+      "./src/index.ts"
+    ]
+    "loader": "jiti",
```

jiti 是 pi 内置的 TypeScript 运行时加载器（已确认在 `@earendil-works/pi-coding-agent` 里），改 src 即生效，**反馈环秒级**。

代价：
- 启动稍慢（jiti 解析 TS）
- 一些 ESM-only 语法可能需 tsx 配置
- 但符合 `.pt/assets/domains/deployment.md` 的"dev 阶段应走 src/"原则

### 方案 B：prebuild hook 监听 src 变更

`tsup` 配置加 watch 模式：

```ts
// tsup.config.ts
export default defineConfig({
  watch: ['src/**/*.ts', 'src/**/*.md'],
  onSuccess: async () => {
    // ... existing onSuccess
  },
});
```

开发时跑 `tsup --watch`，改 src 自动 rebuild dist。

但仍需重启 pi-web 才能让内存里的 dist 刷新。

### 方案 C：CI/CD 加 rebuild dist 检查

`.github/workflows/ci.yml` 加 step：

```yaml
- name: Check dist sync
  run: |
    npm run build
    if [[ -n "$(git status --porcelain dist/)" ]]; then
      echo "::error::dist/ 与 src/ 不同步"
      exit 1
    fi
```

只防止 stale dist 入库，**不解决开发期反馈环问题**。

### 推荐 A

最彻底——dev 阶段走 src/（jiti），发布前 `npm run build` 走 dist/。双形态明确分离，反馈环秒级。

## 验收标准

- [ ] 选定方案后实施
- [ ] `npm run typecheck` 通过
- [ ] `npm run verify` 全测试通过
- [ ] 改 src 后 MCP 工具立即反映新代码（方案 A）或自动 rebuild（方案 B）
- [ ] 文档更新（`.pt/assets/domains/deployment.md` + `.pt/assets/domains/asset-workflow.md`），明确 dev/release 形态切换流程

## 关联

- **`.pt/docs/issues/pt-no-agent-context-multi-root-causes.md`** —— 父 issue，触发本次发现
- **`package.json:27`** —— `pi.extensions` 当前指向 dist/index.js
- **`tsup.config.ts`** —— build 配置（待改）
- **`.pt/assets/domains/deployment.md`** `publish-form` 段 —— 已规定 dev 应走 src/
- **`.pt/assets/domains/asset-workflow.md`** —— 资产工作流（待同步更新）

## 修复日志

### commit

- `Phase v13.x: pi.extensions 走 src/index.ts (jiti 运行时加载) (issue pt-dist-src-desync)`

### 修复要点

1. **`package.json` 改 dev 形态**
   - `pi.extensions: ["./dist/index.js"]` → `["./src/index.ts"]`
   - `files: ["dist"]` → `["src", "dist"]`（双形态发布，npm 装的环境也能 jiti 加载 src/）
   - `main` / `types` 仍指向 `./dist/index.{js,d.ts}`（非 pi agent 仍可走 dist/）
   - 不加 `loader: "jiti"` 字段——pi ExtensionAPI 内置 jiti（extensions.md:179 "loaded via jiti"）

2. **文档同步**
   - `.pt/assets/domains/deployment.md` `publish-form` 段：加 v13.x 注释说明当前走 src/
   - `.pt/assets/domains/asset-workflow.md` 新增 `code-feedback-loop` 场景：说明改 src/ 即生效，反馈环秒级

### 验证方式

- **`npm run typecheck`** → 通过
- **`npm run verify`** → 191/191 全过（vitest 通过 tsx 加载 src/，不受 pi.extensions 改动影响）
- **`npx tsx -e "import('./src/index.js')"`** → load ok，exports 含 default export ✅
- **手动验证**：下次 pi-web 进程重启时自动加载 `./src/index.ts`，改 src/ 立即反映在 LLM 工具输出（无需 `npm run build` + 重启）

### 边界纪律

- ✅ 未动源码（仅改 package.json + 文档）
- ✅ 未动 dist 编译流程（`npm run build` 仍可用，发布形态保留）
- ✅ 未动 pi ExtensionAPI（用 jiti 内置）
- ✅ 未改 `main` / `types` 字段（非 pi agent 走 dist 仍可用）

### 修复日期

2026-09-05