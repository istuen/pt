---
name: pack-management
---

# pack-management

Pack 全生命周期管理 domain——创建 / 调整 / 迭代 / 迁移 / 修复。builtin profile
`guide` 引用本 domain，用户 `/pt_turn_inject pack-management` 触发任意 FlowTemplate，
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
- desc: v15.x Pack 有 3 类来源——project（`<cwd>/.pt/assets/`）/ settings（`.pi/settings.json` 的 `pt.asset-packs[]`，PR4 启用）/ builtin（`src/builtin/assets/`，随 npm 包发布）。每类走相同 MdFilePack 管线，差别只在入口函数和 name fallback 表。v15.x PR7（issue pt-remove-global-pack 移除）后从 4 类收敛为 3 类——global pack（`~/.pt/assets/`）删除，跨项目共享走 settings pack 显式声明路径。

### pack-manifest
- desc: `pt-asset-pack.yaml` 是 pack 自描述 manifest——三个字段：`name`（kebab-case 身份 alias，跨项目寻址用）/ `version`（semver，缓存失效标识）/ `description`（人类可读说明，UI 展示用）。字段全部可选——但**强烈建议始终提供**（back-compat fallback 是过渡方案）。

### validation-codes
- desc: validatePack 返回的错误码——`dir-not-found`（路径不存在）/ `no-asset-subdir`（无 asset 子目录）/ `load-failed`（加载抛异常）/ `manifest-warnings`（manifest 缺失/解析失败/字段校验失败，**不阻断**但会走 notify + manual hint）

### pack-naming
- desc: 寻址双层语义——位置 alias（`@prj`/`@pt`，固定 2 slot 物理位置指针，reserved pack 用）+ 身份 alias（`@<manifest-name>`，跨项目寻址用，settings pack 用）。manifest.name 走身份 alias，无 manifest 时 reserved pack 退到位置 alias，settings pack 退到 basename（**易碎**，建议始终提供 manifest）。

### pack-reserved-vs-external
- desc: Pt Pack 体系按"是否有固定位置约定"分两类——

  **① 固定位置 slot（reserved，2 个 slot，本质是位置约定）**：
  - `@prj` → 项目 cwd 下的 `.pt/assets/`（项目 pack）
  - `@pt`  → npm 包内嵌 `src/builtin/assets/`（工具内嵌 pack）

  两者都是"外部 pack"——它们不在 pt 工具代码本身里，是用户在文件系统 / npm 包里的资产。reserved 不是因为"内置"，而是因为**有固定的物理位置约定**——pt 工具预先知道去哪里找它们，不用用户声明路径。

  **② 用户/外部 Pt Packs（settings，通过 manifest.name 走身份 alias）**：
  - 用户主动声明在 `.pi/settings.json` 的 `pt.asset-packs[]` 中
  - 身份由 manifest.name 决定（自由命名，避开保留名）
  - 没有固定位置约定——可以是任意路径、任意名字
  - 包含第三方 pack（团队 / 公司 / 社区发布的）

  **关键区别**：① 有固定位置（物理约定）→ 工具自己找；② 有固定身份（manifest.name）→ 用户声明路径找。

### pack-builtin-special
- desc: `@pt` 是最特殊的 reserved pack——位置 alias + 身份 alias 合一。

  - builtin pack 的"身份"就是"内置"，**不需要跨项目身份寻址**（位置固定 = `pt`）
  - 位置 slot `@pt` 已经是其完整身份表达
  - manifest.name="pt" 合法（保留名作为身份 alias）——位置 alias = 身份 alias 合一
  - working set 双索引 key 重合：`@pt/foo` 的 location 和 identity entry 指向同一份 asset
  - 其他 reserved pack（prj）不享受合一——项目 pack 仍用跨项目身份名（`pt-internal` 等）

  设计动机：v10.x 时期 builtin pack.name="pt"（位置别名退化）是 back-compat 默认行为；本轮修复把这个行为**显式声明**为设计意图，而不是引入 `pt-builtin` 之类冗余名字。保留名规则对 builtin 特例放行（`parseManifest(rootDir, "builtin")`），project/settings pack 仍禁用保留名。

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
- step: 校验：name 满足 `[a-z0-9-]{1,64}` 且非保留字（prj/pt/project/builtin；v15.x PR7 后删除 gbl/global）
- step: 校验：version 满足 `^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$`
- step: 若作为 settings pack 暴露：在 `.pi/settings.json` 加 `pt.asset-packs: [{ "path": "<pack-root>" }]`
- step: 验证：`/pt status` → 新 pack 显示在 Pack 健康行

### pack-repair
- argument-hint: (无)
- intent: Manifest 缺失/错误时自描述修复——按错误码分类处置后重启 session 验证
- vars: []
- step: `/pt status` 查看 pack 健康状态 + manifest warnings（如果有 `[repair-required]` 前缀，说明需要修复）
- step: **cwd 边界判断**（issue pt-pack-repair-cwd-home-edge-case）：若 cwd=`$HOME` 且 pack-root 落在 `~/.pt/assets/`（曾 v15.x PR7 前 global pack 路径），先确认用户意图——prj pack 在 home 通常无项目上下文，盲目创建无意义。三选一：
- step:   - (a) 用户想进入正常项目开发 → 建议切换到项目目录后再跑 pi（project pack 自然落到 `<cwd>/.pt/assets/`，激活项目级 pack），pack-repair 在项目目录才有意义
- step:   - (b) 用户想临时调试 home → `mkdir -p ~/.pt/assets/{domains,blueprints,profiles}` 创建空骨架（无 manifest 走 back-compat fallback，name 退到位置别名 `prj`）
- step:   - (c) 用户仅调研规范 → 啥都不做，builtin guide 已可用，无需落地 pack
- step: 按错误码分类处置：
- step:   - manifest 缺失：走 `pack-create` flow 创建 `pt-asset-pack.yaml`（保留现有 assets 子目录）
- step:   - manifest 解析失败：检查 YAML 语法（top-level 必须是 mapping）
- step:   - name 非 kebab-case：改名满足 `[a-z0-9-]{1,64}`
- step:   - name 是保留字：改用其他身份 alias（不能是 prj/pt/project/builtin；v15.x PR7 后删除 gbl/global）
- step:   - version 非 semver：改成 `^\d+\.\d+\.\d+` 格式
- step:   - dir-not-found（路径在 `~/.pt/` 下）：先做上面 cwd 边界判断；确认用户意图后处置——(a) 切到项目目录，(b) `mkdir -p ~/.pt/assets/{domains,blueprints,profiles}` 创建临时骨架
- step:   - dir-not-found（其他路径）：`mkdir -p <pack-root>/{domains,blueprints,profiles}`
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
- step: 读迁移指南（`.pt/docs/migrations/<from>-to-<to>-*.md` 或 `/pt_turn_inject pt-asset-migration`）
- step: 按指南转换每个 asset 文件（如 v9.0 → v9.1 modules-to-profile-complete：Blueprint `modules` 字段删除，迁到 Profile `### Modules`）
- step: 跑 `pt_check` LLM 工具检查 pack 健康（missing-modules / dangling-blueprint-ref / empty-segment / orphan-h2 等）
- step: 修完所有报错后 bump version（breaking change 升 major）
- step: 验证：`/pt status` 健康 + `npm run verify` 通过

## Rules

### manifest-required-as-identity
- check: Pack 必须有 `pt-asset-pack.yaml` manifest——没有 manifest 的目录只是 back-compat 兜底状态（reserved pack 退到 prj/pt，settings pack 退到 basename）。Manifest 是 pack 的身份证 + 说明书，缺它 pack 不是真正的 pt pack

### manifest-name-kebab-case
- check: `manifest.name` 必须满足 `[a-z0-9-]{1,64}`——kebab-case 格式，1-64 字符。校验失败 → warning + fallback 到 basename（settings pack）或位置 alias（reserved pack）

### manifest-name-not-reserved
- check: `manifest.name` 不能等于保留字——`prj`/`pt`/`project`/`builtin` 全部禁用（reserved pack 位置 alias 专用）。冲突 → warning + fallback

### manifest-version-semver
- check: `manifest.version` 必须满足 `^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$`——semver 格式。校验失败 → warning + 默认 "0.0.0"

### manifest-fallback-is-transitional
- check: Manifest 缺失时的 fallback 是**过渡方案**，不是设计意图——reserved pack 退到位置 alias、settings pack 退到 basename 都是 back-compat 妥协。Pack 作者应始终提供 manifest，让 pack 成为自描述实体

### reserved-pack-position-agreement
- check: Reserved pack（`@prj` / `@pt`）的"reserved"**不是"内置"**——两者都是"外部 pack"（项目 / npm 包里的资产），reserved 是因为有**固定的物理位置约定**（pt 工具预先知道去哪里找）。用户资产 / 第三方 pack 走 settings，通过 manifest.name 走身份 alias（见 `pack-reserved-vs-external`）

### builtin-pack-name-merges-position-and-identity
- check: builtin pack 是 2 个 reserved slot 里最特殊的——位置 alias `@pt` = 身份 alias `@pt` 合一。`src/builtin/assets/pt-asset-pack.yaml` 的 `name: pt` 合法（保留名作为身份 alias），working set 双索引 key 重合。其他 reserved pack（prj）仍用跨项目身份名（`pt-internal` 等），不合一（见 `pack-builtin-special`）

### validate-pack-never-throws
- check: validatePack 失败时返 `ValidationResult` 对象（`ok=false` + `errors[]`），不抛异常——保证加载链不阻断（§6.7.7）。Manifest parse 失败同样不阻断（parseManifest 已容错，warning 进 notify）

### project-pack-degradation
- check: Project pack 失效时强制激活 builtin `guide` profile（`projectPackDegraded=true`），覆盖用户配置的 `pt.default-profile`——保证 pi 可用让用户走 `pack-repair` flow 修复（§6.7.3）

### restart-after-repair
- check: 修复 pack 后必须重启 pi session——`projectPackDegraded` 标记在 session_start 重新校验时清零，不重启则继续降级

### global-pack-removed
- check: 全局 Pack 已删除（v15.x PR7，issue pt-remove-global-pack）——跨项目共享走 settings pack 显式声明路径（如 `~/.pt/packs/foo`），无"首次创建"隐式引导。原来的 §7.5 / §7.5.1 全局 Pack 初始化引导整节删除。

### cwd-boundary-for-project-pack
- check: Project pack 在 cwd=`$HOME` 时无意义——`~/.pt/assets/` 曾是 global pack 路径（v15.x PR7 删除），现被 project pack 自动接管，但 home 通常无项目上下文。`pack-repair` flow 在走 `dir-not-found` 处置前必须先做 cwd 边界判断（issue pt-pack-repair-cwd-home-edge-case）：(a) 切到项目目录 / (b) 临时 mkdir 骨架 / (c) 啥都不做——三选一由用户决定，flow 主动询问，不要无脑推荐 `mkdir`。会话层（session_start notify + `/pt status`）已实现 cwd=home 检测并附加决策引导

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