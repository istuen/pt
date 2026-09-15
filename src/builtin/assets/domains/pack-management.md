---
name: pack-management
---

# pack-management

Pack 全生命周期管理 domain——创建 / 调整 / 迭代 / 迁移 / 修复。builtin profile
`guide` 引用本 domain，用户 `/manual:pack-management` 触发任意 FlowTemplate，
LLM 跟着 Scene + Rules + Flow + Checklist 走即可。

**核心立场**：manifest 是 pack 的**身份证 + 说明书**——没有 manifest 的目录只是
back-compat 兜底状态（参见 `pt-pack-location-vs-identity-alias`），不是真正的
pt pack。缺 manifest / 写错时，跟着 `pack-repair` flow 走即可自描述修复。

## Scene

### pack-lifecycle
- desc: Pack 五态——创建（init）→ 迭代（add/change asset）→ 迁移（schema 升级）→ 废弃（deprecate）→ 修复（manifest 缺失/错误回退到创建态）。每态对应一个 FlowTemplate。

### pack-structure
- desc: Pt pack 标准目录结构——必须含 `domains/` + `blueprints/` + `profiles/` 三个子目录之**一**（至少一个）；可选 `pt-asset-pack.yaml` manifest（**强烈建议始终提供**——manifest 是身份证，不是装饰）

### pack-sources
- desc: v15.x Pack 有 4 类来源——project（`<cwd>/.pt/assets/`）/ settings（`.pi/settings.json` 的 `pt.asset-packs[]`，PR4 启用）/ global（`~/.pt/assets/`）/ builtin（`src/builtin/assets/`，随 npm 包发布）。每类走相同 MdFilePack 管线，差别只在入口函数和 name fallback 表。

### pack-manifest
- desc: `pt-asset-pack.yaml` 是 pack 自描述 manifest——三个字段：`name`（kebab-case 身份 alias，跨项目寻址用）/ `version`（semver，缓存失效标识）/ `description`（人类可读说明，UI 展示用）。字段全部可选——但**强烈建议始终提供**（back-compat fallback 是过渡方案）。

### validation-codes
- desc: validatePack 返回的错误码——`dir-not-found`（路径不存在）/ `no-asset-subdir`（无 asset 子目录）/ `load-failed`（加载抛异常）/ `manifest-warnings`（manifest 缺失/解析失败/字段校验失败，**不阻断**但会走 notify + manual hint）

### pack-naming
- desc: 寻址双层语义——位置 alias（`@prj`/`@gbl`/`@pt`，固定 3 slot 物理位置指针，reserved pack 用）+ 身份 alias（`@<manifest-name>`，跨项目寻址用，settings pack 用）。manifest.name 走身份 alias，无 manifest 时 reserved pack 退到位置 alias，settings pack 退到 basename（**易碎**，建议始终提供 manifest）。

## Flows

### pack-create
- argument-hint: <pack-root>
- intent: 从零创建新 pack——创建目录结构 + 写 `pt-asset-pack.yaml` 模板（name 走 kebab-case 提示用户输入，version 默认 `0.1.0`）
- vars: [pack-root]
- step: 确认 pack-root 不存在或为空（避免覆盖现有 pack）
- step: `mkdir -p <pack-root>/{domains,blueprints,profiles}`
- step: 写 `<pack-root>/pt-asset-pack.yaml` 模板：
- step:   ```yaml
  name: <kebab-case-name>   # 跨项目身份 alias
  version: 0.1.0            # semver
  description: <一句话说明>
  ```
- step: 校验：name 满足 `[a-z0-9-]{1,64}` 且非保留字（prj/gbl/pt/project/global/builtin）
- step: 校验：version 满足 `^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$`
- step: 若作为 settings pack 暴露：在 `.pi/settings.json` 加 `pt.asset-packs: [{ "path": "<pack-root>" }]`
- step: 验证：`/pt status` → 新 pack 显示在 Pack 健康行

### pack-repair
- argument-hint: (无)
- intent: Manifest 缺失/错误时自描述修复——按错误码分类处置后重启 session 验证
- vars: []
- step: `/pt status` 查看 pack 健康状态 + manifest warnings（如果有 `[repair-required]` 前缀，说明需要修复）
- step: 按错误码分类处置：
- step:   - manifest 缺失：走 `pack-create` flow 创建 `pt-asset-pack.yaml`（保留现有 assets 子目录）
- step:   - manifest 解析失败：检查 YAML 语法（top-level 必须是 mapping）
- step:   - name 非 kebab-case：改名满足 `[a-z0-9-]{1,64}`
- step:   - name 是保留字：改用其他身份 alias（不能是 prj/gbl/pt/project/global/builtin）
- step:   - version 非 semver：改成 `^\d+\.\d+\.\d+` 格式
- step:   - dir-not-found：`mkdir -p <pack-root>/{domains,blueprints,profiles}`
- step:   - no-asset-subdir：至少创建一个 asset 子目录
- step:   - load-failed：检查资产文件格式（`.md` frontmatter 合法 / `.blueprint.yaml` 语法正确）
- step: 修复后重启 pi session（`projectPackDegraded` 在 session_start 重新校验时清零）
- step: `/pt status` 确认 pack 健康（✅，无 `[repair-required]` warnings）

### pack-iterate
- argument-hint: <pack-root>
- intent: Pack 内容迭代——添加 / 修改 / 删除 asset，并按需 bump version
- vars: [pack-root]
- step: 修改 asset 文件（`domains/*.md` / `blueprints/*.blueprint.yaml` / `profiles/*.profile.md`）
- step: 资产改动后删 `.pt/cache/agent-contexts/*.agent-context.md`（强制重编译，sourceHash 自动失效）
- step: 修改 manifest.version——breaking change 升 major，向后兼容加 feature 升 minor，bug fix 升 patch
- step: 同步 description（如果 pack 用途变化）
- step: 验证：`/pt status` → pack version 已更新 → 跑 `npm run verify` 全测试通过

### pack-migrate
- argument-hint: <pack-root>
- intent: Pt schema 升级时 pack 内容迁移——按迁移指南更新 asset 格式
- vars: [pack-root]
- step: 读迁移指南（`.pt/docs/migrations/<from>-to-<to>-*.md` 或 `/manual:pt-asset-migration`）
- step: 按指南转换每个 asset 文件（如 v9.0 → v9.1 modules-to-profile-complete：Blueprint `modules` 字段删除，迁到 Profile `### Modules`）
- step: 跑 `pt_check` LLM 工具检查 pack 健康（missing-modules / dangling-blueprint-ref / empty-segment / orphan-h2 等）
- step: 修完所有报错后 bump version（breaking change 升 major）
- step: 验证：`/pt status` 健康 + `npm run verify` 通过

## Rules

### manifest-required-as-identity
- check: Pack 必须有 `pt-asset-pack.yaml` manifest——没有 manifest 的目录只是 back-compat 兜底状态（reserved pack 退到 prj/gbl/pt，settings pack 退到 basename）。Manifest 是 pack 的身份证 + 说明书，缺它 pack 不是真正的 pt pack

### manifest-name-kebab-case
- check: `manifest.name` 必须满足 `[a-z0-9-]{1,64}`——kebab-case 格式，1-64 字符。校验失败 → warning + fallback 到 basename（settings pack）或位置 alias（reserved pack）

### manifest-name-not-reserved
- check: `manifest.name` 不能等于保留字——`prj`/`gbl`/`pt`/`project`/`global`/`builtin` 全部禁用（reserved pack 位置 alias 专用）。冲突 → warning + fallback

### manifest-version-semver
- check: `manifest.version` 必须满足 `^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$`——semver 格式。校验失败 → warning + 默认 "0.0.0"

### manifest-fallback-is-transitional
- check: Manifest 缺失时的 fallback 是**过渡方案**，不是设计意图——reserved pack 退到位置 alias、settings pack 退到 basename 都是 back-compat 妥协。Pack 作者应始终提供 manifest，让 pack 成为自描述实体

### validate-pack-never-throws
- check: validatePack 失败时返 `ValidationResult` 对象（`ok=false` + `errors[]`），不抛异常——保证加载链不阻断（§6.7.7）。Manifest parse 失败同样不阻断（parseManifest 已容错，warning 进 notify）

### project-pack-degradation
- check: Project pack 失效时强制激活 builtin `guide` profile（`projectPackDegraded=true`），覆盖用户配置的 `pt.default-profile`——保证 pi 可用让用户走 `pack-repair` flow 修复（§6.7.3）

### restart-after-repair
- check: 修复 pack 后必须重启 pi session——`projectPackDegraded` 标记在 session_start 重新校验时清零，不重启则继续降级

### global-pack-guide-non-interactive
- check: 全局 Pack 初始化引导仅在 TTY + 非 CI + 无 `PT_NO_GUIDE` 环境触发（§7.5.1）——避免阻塞 CI / 后台进程

## Checklists

### pack-create-checklist
- step: pack-root 路径合法（绝对路径或相对 cwd）
- step: pack-root 不存在或为空（避免覆盖）
- step: 至少一个 asset 子目录存在（domains/blueprints/profiles）
- step: `pt-asset-pack.yaml` 存在且字段合法（kebab-case name / semver version / description 可选）
- step: 若作为 settings pack 暴露，`.pi/settings.json` 的 `pt.asset-packs[]` 已声明
- step: `/pt status` 显示新 pack 健康（✅）

### pack-repair-checklist
- step: `/pt status` 列出所有 `[repair-required]` warnings
- step: 每个 warning 对应 pack-repair flow 的一个 step（manifest 缺失 / 解析失败 / name 校验 / version 校验 / dir-not-found / no-asset-subdir / load-failed）
- step: 修复后 `/pt status` 无 `[repair-required]` warnings
- step: 重启 pi session 后 `projectPackDegraded` 标记清零
- step: `npm run verify` 通过（除 phase9 fixture 错位独立 bug）