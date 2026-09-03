---
type: term
name: pt-quality
---

# pt-quality

## Trigger
### pt-quality-trigger
- desc: 改 Pt 代码时参考；含 9 条技术规范（modules-type-safety 等）
- hint: /manual:pt-quality 查看完整规范

## Scene

### quality-index
- desc: 技术规范在 Manual 段；执行开发手册（modify-schema/modify-asset/add-domain-type）时自动带出参考手册注入点。

## Manual

### modules-type-safety
- slot: global
- type: invariant
- check: Domain.modules 读取必须用 type guard，不用 as 断言

### no-duplicate-type
- slot: global
- type: invariant
- check: 禁止重复定义相似类型，用 Pick/Partial 从 schema 派生

### parse-extension-registry
- slot: global
- type: invariant
- check: parse 扩展用注册表，不用 switch-case（与 compile 的 moduleRenderers 一致）

### path-constant
- slot: global
- type: invariant
- check: 资产/缓存路径必须用常量集中管理（如 CACHE_DIR），不散落硬编码

### module-name-constant
- slot: global
- type: invariant
- check: Domain H2 段名（Scene/Trigger/Manual/Term）必须用常量，不散落字符串字面量；注入点名（Blueprint H2 人类自定义语义名）不该常量化

### naming-consistency
- slot: global
- type: invariant
- check: 代码命名与架构语义一致（adapter 命名应匹配实际适配的格式，如 mdAdapter 适配 MD 格式；历史 oxnAdapter→mdAdapter 已于 Phase 9 完成）

### npm-scripts
- slot: global
- type: invariant
- check: package.json 必须有 typecheck/verify/lint 脚本入口（lint = biome check）

### test-framework
- slot: global
- type: invariant
- check: 验证脚本用断言框架（vitest），不用 console.log + 人工看 ✅

### error-via-notify
- slot: global
- type: invariant
- check: 生产错误用 ctx.ui.notify，不用 console.error

### biome-guarded
- slot: global
- type: invariant
- check: src/ + tests/ 受 Biome 守护（biome.json：双引号/分号/2 空格/行宽 100，linter preset recommended，organizeImports off 保留人工 import 分组）。改完 src 代码必跑 `npm run lint`；CI gate 要求 0 error（warning/info 不阻塞，作为 P2 类型安全清理清单输入）。`npm run lint:fix` 自动修 safe fixes（format/useTemplate/useLiteralKeys 等），不修 unsafe（noNonNullAssertion/noUnusedVariables 需人工判断）。
