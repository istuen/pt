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
- desc: 技术规范在 Manual 段；执行开发手册（modify-schema/modify-asset/add-domain-type）时自动带出对话记忆注入点。

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
- check: parse 扩展用注册表，不用 switch-case（与 compile 的 domainSceneRenderers 一致）

### path-constant
- slot: global
- type: invariant
- check: 资产/缓存路径必须用常量集中管理（如 CACHE_DIR），不散落硬编码

### module-name-constant
- slot: global
- type: invariant
- check: 模块名 会话知识/对话记忆 必须用常量，不散落字符串字面量

### naming-consistency
- slot: global
- type: invariant
- check: 代码命名与架构语义一致（adapter 不叫 oxnAdapter，应叫 mdAdapter）

### npm-scripts
- slot: global
- type: invariant
- check: package.json 必须有 typecheck/verify 脚本入口

### test-framework
- slot: global
- type: invariant
- check: 验证脚本用断言框架（vitest），不用 console.log + 人工看 ✅

### error-via-notify
- slot: global
- type: invariant
- check: 生产错误用 ctx.ui.notify，不用 console.error
