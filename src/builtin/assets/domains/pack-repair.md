---
name: pack-repair
---

# pack-repair

v15.x PR1（§6.7.4）：project pack 校验失败时的修复引导手册。builtin profile `guide`
会引用本 domain——用户 `/manual:pack-repair` 触发 FlowTemplate，按步骤修复。

## Scene

### pack-structure
- desc: Pt pack 标准目录结构——必须含 domains/ + blueprints/ + profiles/ 三个子目录之一；可选 pt-asset-pack.yaml manifest（PR2 启用）

### pack-sources
- desc: v15.x Pack 有 4 类来源——project（`<cwd>/.pt/assets/`）/ settings（`.pi/settings.json` 的 `pt.asset-packs[]`，PR4 启用）/ global（`~/.pt/assets/`）/ builtin（`src/builtin/assets/`，随 npm 包发布）

### validation-codes
- desc: validatePack 返回的错误码——`dir-not-found`（路径不存在）/ `no-asset-subdir`（无 asset 子目录）/ `load-failed`（加载抛异常）

## Flows

### pack-repair
- argument-hint: (无)
- intent: project pack 校验失败时引导修复——按错误码分类处置后重启 session 验证
- vars: []
- step: /pt status 查看 pack 健康状态（§6.7.6），定位失效 pack + 错误码
- step: 按 errors[].code 分类处置：
  - dir-not-found：创建 pack 目录（project: mkdir -p .pt/assets/{domains,blueprints,profiles}；global: mkdir -p ~/.pt/assets/{domains,blueprints,profiles}）
  - no-asset-subdir：至少创建一个 asset 子目录（domains/blueprints/profiles 任选其一）
  - load-failed：检查资产文件格式（.md frontmatter 合法 / .blueprint.yaml 语法正确）
- step: 修复后重启 pi session（projectPackDegraded 在 session_start 重新校验时清零）
- step: /pt status 确认 pack 健康（✅，无 DEGRADED 行）

## Rules

### validate-pack-never-throws
- check: validatePack 失败时返 ValidationResult 对象（ok=false + errors[]），不抛异常——保证加载链不阻断（§6.7.7）

### project-pack-degradation
- check: project pack 失效时强制激活 builtin guide profile（projectPackDegraded=true），覆盖用户配置的 pt.default-profile——保证 pi 可用让用户修复（§6.7.3）

### restart-after-repair
- check: 修复 project pack 后必须重启 pi session——projectPackDegraded 标记在 session_start 重新校验时清零，不重启则继续降级

### global-pack-guide-non-interactive
- check: 全局 Pack 初始化引导仅在 TTY + 非 CI + 无 PT_NO_GUIDE 环境触发（§7.5.1）——避免阻塞 CI / 后台进程