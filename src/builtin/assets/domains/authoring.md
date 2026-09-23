---
name: authoring
---

# authoring

## Trigger
### authoring-trigger
- desc: 创作/修改 Pt 资产 md 时参考；含 Pt Domain/Blueprint/Pt Profile 格式（v9.1+） + 创建流程 + 角色隔离配置
- hint: /pt_turn_inject authoring 查看完整创作手册

## Scene

### domain-format
- desc: frontmatter（name: 域路径名——根目录写裸名 `user-info`，多级目录写 path 形式 `workflow/dev-workflow`，与加载路径一致；无 type 字段——Module/H2 段名即 schema 选择器）+ Module（## Scene / ## Trigger / ## Rules / ## Flows / ## Checklists / ## Participant / ## User / ## Agent / ...，按需写）+ H3 项（### 项名 + - desc: 描述 / - path: 路径 / - check: 规则 / - fields: 字段清单 / - note: 补充说明）。文件放 .pt/assets/domains/<name>.md 或 .pt/assets/domains/<subdir>/<name>.md。

### blueprint-format
- desc: YAML 格式（.blueprint.yaml）。字段：name + groups（聚合组列表，每个含 name + inject: session/turn + mode）。**v9.1+：Blueprint 不带 modules 字段**——Blueprint 退化为插槽契约（声明有哪些插槽 + inject + mode），modules 由 Profile H2 下的 ### Modules 列表填。无 agent 字段（Blueprint Agent-agnostic，运行时硬编码 "pi"）。无 Compilation 段（cacheDir 用 CACHE_DIR 常量）。文件放 .pt/assets/blueprints/<name>.blueprint.yaml（v9.1+ 可省略——`src/parse/index.ts` 的 `dedupByName` 机制保证项目优先 + 内建补充，profile 引 `blueprint: pt-default` 自动 fallback 到 builtin）。

### profile-format
- desc: frontmatter（name + blueprint: 引用名 + domains: [全局 Domain 列表，**多级目录用 path 形式**如 `workflow/dev-workflow`，自动分发到所有聚合组]）+ H2 聚合组实例化（## 聚合组名 与 Blueprint.groups[].name 同名）+ H3 段下两类追加列表：(a) `### Domains` 追加到本聚合组的 Domain 名列表；(b) `### Modules` 本插槽填的 modName 列表（v9.1+）。**v9.1+ 的 modules 形态 2 种**：段名（`Scene` / `User`）和 段.项（`Agent.senior-developer`），无形态 3。domains 顺序影响 LLM attention——身份类放前，约束类放后。文件放 .pt/assets/profiles/<name>.profile.md。

### profile-modules-section
- desc: v9.1+ Profile H2 段下 ### Modules 段填法——按 modName 2 形态逐行列出本插槽的 modules。**形态 1：段名**（整段聚合，跨所有引用域）——例 `- Scene`（所有引用域的 Scene 段都进）。**形态 2：段.项**（精确选 H3 项）——例 `- Agent.agent-role-senior-developer`（agent-info 段下 senior-developer 项进）。modName 解析失败（段名不在 `KNOWN_SECTION_NAMES` 集合）→ log warn 跳过。**解析规则**：`Scene` / `User.user-profile` / `Trigger.authoring-trigger` 都合法；`my-domain:Scene.foo` 这种形态 3 形式不合法——限定到单 domain 用专用段名（`User` / `Agent`）。

### profile-section-namespace
- desc: 段名 = 命名空间（v9.1+）——通用段（`Scene` / `Trigger` / `Rules` / `Flows` / `Checklists`）跨 domain 通用；专用段（`User` / `Agent`）限定到单 domain（`user-info` 用 `User`、`agent-info` 用 `Agent`）。**Profile 角色隔离的核心机制**——专用段名让 profile 可以"只选自己需要的身份角色"而不影响其他 profile。例：pt-arch 与 pt-dev 共享同一 agent-info Domain（6 个 H3 项：architect / senior-developer / qa-engineer / code-reviewer / devops-engineer / active-role-rule），但 pt-arch `### Modules: [Agent.agent-role-architect, Agent.active-role-rule]` 只看到 architect + active-role-rule；pt-dev `### Modules: [Agent.agent-role-senior-developer, Agent.agent-role-qa-engineer, Agent.agent-role-code-reviewer, Agent.active-role-rule]` 只看到 dev 3 角色 + active-role-rule。

### profile-role-isolation
- desc: v9.1+ Profile 角色隔离配置示例（共享 agent-info Domain，各 profile 只看自己角色 + active-role-rule）：
- sample-pt-arch: |
    ## session-context
    ### Modules
    - Scene
    - User
    - Agent.agent-role-architect
    - Agent.active-role-rule
- sample-pt-design: |
    ## session-context
    ### Modules
    - Scene
    - User
    - Agent.agent-role-architect
    - Agent.active-role-rule
- sample-pt-dev: |
    ## session-context
    ### Modules
    - Scene
    - User
    - Agent.agent-role-senior-developer
    - Agent.agent-role-qa-engineer
    - Agent.agent-role-code-reviewer
    - Agent.active-role-rule
- sample-pt-devops: |
    ## session-context
    ### Modules
    - Scene
    - User
    - Agent.agent-role-devops-engineer
    - Agent.active-role-rule
- step: 复制 sample 改 name + domains + ### Modules 即可

### profile-multi-level-dir
- desc: 多级目录引用（v9.1+）——Profile frontmatter `domains:` 列表用 path 形式引用多级目录的 Domain。例：`.pt/assets/domains/workflow/dev-workflow.md` → `domains: [user-info, agent-info, workflow/dev-workflow, workflow/issue-workflow, workflow/testing-workflow, ...]`。**同目录不重名**（硬约束，文件系统约束）；不同子目录可同名（path 天然区分——`meta/login` 和 `auth/login` 不冲突）。Domain frontmatter.name 也用 path 形式（与加载路径一致）。

### profile-h2-sections
- desc: Profile 范本必加 H2 聚合组段——即使无追加也保留段让配置入口可见。具体格式：YAML 后用 H2 标题写出 Blueprint.groups[].name 同名的段；段下用 `### Domains` 追加（如有）+ `### Modules` 列本插槽的 modules 列表（v9.1+）。例如 pt-dev 范本保留 ## session-context + ## trigger-index + ## reference-manual 三段（与 pt-default 的 groups 对齐）。配置可观测性：parseProfile groups 数 > 0，用户能看出本 Profile 覆盖哪些聚合组 + 每个聚合组的 modules 选择。

### term-domain-pattern
- desc: 概念/术语/规则类 Domain 写法：## Scene 下 ### 概念名 + - desc: 定义；## Rules 下 ### 规则名 + - check: 不变量描述。适合概念/术语/架构知识。（注：v9 已删 type 字段，不再有 term/workflow/stack 分类——H2 段名决定 schema。）

### workflow-domain-pattern
- desc: 流程/手册类 Domain 写法：## Scene 下 ### 引用名 + - path: 路径 + - desc: 说明；## Flows 下 ### 流程名 + - intent: 目的 + - step: 步骤。适合操作流程/开发手册。（注：v9 已删 type 字段。）

### participant-domain-pattern
- desc: 身份类 Domain 写法（v9.1+ 重命名）——user-info Domain 用 `## User` 段下 H3 角色项（user-profile / pt-goal / collab-mode / ...）；agent-info Domain 用 `## Agent` 段下 H3 角色项（agent-role-architect / agent-role-senior-developer / ...）。**段名 = 命名空间**：`User` 限定 user-info、`Agent` 限定 agent-info。Profile 通过 `### Modules: [User]` 聚合 user-info 整段；通过 `### Modules: [Agent.agent-role-architect]` 精确选单角色——角色隔离的"开关"。

### build-roadmap
- desc: 从零构建 Pt 资产的顺序：（1）分析项目知识结构（参考 project-analysis 的 analyze-steps + section-as-namespace + role-isolation）→ 识别概念/流程/工具栈；（2）创建 Pt Domain 资产（每个知识单元一个 .md，H2 段名决定 schema）→ create-domain-procedure；（3）选 Blueprint（优先复用内建 pt-default，聚合组需求不同才 create-blueprint-procedure——v9.1+ 通常省略，dedupByName 自动 fallback 到 builtin）→（4）创建 Pt Profile 组装 Domain 列表 + ### Modules 填 H3 粒度 → create-profile-procedure；（5）/pt-profile 验证产物 + 检查角色隔离。执行 procedure 时用 /pt make-manual <procedure-name> <args> 创建实例文档跟踪。

### minimal-example
- desc: 从零上手的最小样本——两个 Domain（user-info + agent-info）+ 一个 Profile，照抄改即可跑通
- sample-domain-user: |
    ---
    name: user-info
    ---
    # user-info
    ## User
    ### who-am-i
    - desc: 我是这个项目的开发者

    ### preferences
    - desc: 偏好类型安全、模块化设计
- sample-domain-agent: |
    ---
    name: agent-info
    ---
    # agent-info
    ## Agent
    ### role
    - desc: 你是编码助手，帮用户创作 Pt 资产
- sample-profile: |
    ---
    name: my-guide
    blueprint: pt-default
    domains: [user-info, agent-info, project-analysis, authoring, usage]
    ---
    # my-guide (profile)
    ## session-context
    ### Modules
    - Scene
    - User
    - Agent
    ## trigger-index
    ### Modules
    - Trigger
    ## reference-manual
    ### Modules
    - Rules
    - Flows
    - Checklists
- steps: 放 user-info.md / agent-info.md 到 .pt/assets/domains/，放 my-guide.profile.md 到 .pt/assets/profiles/，/pt-profile my-guide 激活
- why: 展示最小闭环——两个 Domain 各只写 User/Agent 段（用户身份 + Agent 身份，v9.1+ 重命名），Profile 引内建 blueprint + 选域 + 填 ### Modules 段含 `User` / `Agent` 整段（onboarding 完整模式）；激活后 Session Context 即有成对身份

### renderer-registration
- desc: 加新专用段名（如 `## Audit` / `## Glossary`）的扩展流程——(1) Domain 内用新 H2 段名；(2) `src/parse/profile.ts` 的 `KNOWN_SECTION_NAMES` 集合加新段名一行；(3) `src/compile/agent-context.ts` 的 `moduleRenderers` 注册一行（已有 renderer 复用，如复用 `renderSceneModule` 处理 Term[] 同构）；(4) `src/constants.ts` 加 `MOD_XXX = "XXX"` 常量一行（可选，但建议加——模块名常量集中管理便于跨文件引用）。**不需要改主循环**——加新 modName 走 renderer 注册表分发，generic fallback 兜底。

### doc-schema-format
- desc: 文档 frontmatter schema 协议——JSON Schema draft 2020-12 格式，放 `.pt/schemas/<type>.frontmatter.schema.json`。Pt 内置 3 个 schema（issue/manual/design）在 builtin (`src/builtin/schemas/`，随 npm 包发布)，probe 校验时两级查找：先查项目级 `.pt/schemas/`（用户覆盖），miss 则 fallback builtin。项目要自定义 = 放同名文件到 `.pt/schemas/` 即覆盖，**粒度是单文件名**（不改某个字段 = 覆盖整个 schema）。schema 定义 required（必填字段）+ properties（字段 type/enum/description）+ allOf（条件约束，如 status=resolved → requires resolved 日期）。

### doc-schema-fields
- desc: 内置 3 schema 的字段清单——**issue**（required: type/name/status/severity/created；optional: updated/resolved/domain/profile/parent/sub-issues/related/resolved-by/discovered-by/resolution/source/wontfix；status=resolved → requires resolved 日期；status=wontfix → requires wontfix 日期）；**manual**（required: procedure/domain/created/status；optional: type/updated/args/profile/issue/source/approach/branch/verified；status=completed → requires verified 布尔）；**design**（required: type/name/created/domain；optional: updated/profile/status/issue/parent/related/superseded-by/phase；status=superseded → requires superseded-by）。完整字段定义 + 描述见 builtin schemas/*.json 的 properties.description 字段。

### doc-schema-custom
- desc: 自定义新文档类型 schema——(1) 写 `.pt/schemas/<type>.frontmatter.schema.json`（JSON Schema draft 2020-12 格式，含 required + properties + allOf if/then）；(2) 调用 `validateDoc(cwd, docPath, schemaName)` 时传 schema 文件名；(3) `/pt check-docs --kind <type>` 要在 `src/commands.ts` 的 `KIND_SCHEMA` 注册一行。**无需改 Pt 核心代码**——schema 是数据，不是代码。三种场景：(a) 全用默认 = 不建 `.pt/schemas/`，3 个 schema 都走 builtin；(b) 改 1 个 = 只放同名 schema 到 `.pt/schemas/`（issue 走项目版，manual/design 仍走 builtin）；(c) 加新类型 = 放 `.pt/schemas/custom.frontmatter.schema.json` + 在 KIND_SCHEMA 注册 + 命令行调用。

## Flows

### create-domain-procedure
- argument-hint: <name>
- intent: 创建新 Pt Domain 资产的步骤指引（LLM 读完后用 write 工具执行，非 Pi 注册命令）
- vars: [name]
- step: 用 write 工具创建 .pt/assets/domains/{{name}}.md（多级目录可放 .pt/assets/domains/<subdir>/{{name}}.md）
- step: 写 frontmatter（name: {{name}}——多级目录用 path 形式如 `workflow/dev-workflow`，无 type 字段）
- step: 按知识性质选 Module（概念→Scene+Rules，流程→Scene+Flows，规则→Rules，验收→Checklists；身份类→User 或 Agent 专用段）
- step: 在目标 Profile 的 domains 列表追加 {{name}}（多级目录用 path 形式）
- step: 删 .pt/cache/agent-contexts/*.agent-context.md + /pt-profile <profile> 验证

### create-profile-procedure
- argument-hint: <name>
- intent: 创建新 Pt Profile 的步骤指引（LLM 读完后用 write 工具执行，非 Pi 注册命令）
- vars: [name]
- step: 用 write 工具创建 .pt/assets/profiles/{{name}}.profile.md
- step: 写 frontmatter（name: {{name}} + blueprint: pt-default 优先复用内建 + domains: [按需列，多级目录用 path 形式]）
- step: 为每个 Blueprint 插槽加 H2 段（## session-context / ## trigger-index / ## reference-manual 等），段下加 `### Modules` 列表（v9.1+）填本插槽的 modName（段名 / 段.项两种形态）
- step: 角色隔离配置——身份域用专用段名 + 段.项精确选单角色（详见 profile-role-isolation 的 sample-pt-arch / pt-dev / pt-devops）
- step: 删 .pt/cache/agent-contexts/*.agent-context.md + /pt-profile {{name}} 验证产物 + 检查角色隔离

### create-blueprint-procedure
- argument-hint: <name>
- intent: 创建新 Blueprint 的步骤指引（v9.1+ 通常省略——优先复用内建；仅当聚合组需求与内建 pt-default 不同时新建；LLM 读完后用 write 工具执行）
- vars: [name]
- step: 确认需要新聚合组——pt-default 有session-context/trigger-index/reference-manual三个聚合组（session×2 + turn×1），不够才新建
- step: 用 write 工具创建 .pt/assets/blueprints/{{name}}.blueprint.yaml
- step: 写 YAML（name: {{name}}，无 agent 字段，**无 modules 字段**——v9.1+ Blueprint 是插槽契约）
- step: 写 groups（每个聚合组：name + inject: session/turn + mode 可选）——**modules 字段不再存在**
- step: Profile frontmatter 的 blueprint 字段改为 {{name}} 引用
- step: Profile H2 段下 ### Modules 列表按需填 modName（段名 / 段.项形态）
- step: 删 .pt/cache/agent-contexts/*.agent-context.md + /pt-profile <profile> 验证

### modify-asset-procedure
- argument-hint: (无)
- intent: 修改已有资产的步骤指引（LLM 读完后用 edit/write 工具执行）
- vars: []
- step: 用 read 工具读目标 .md（Pt Domain/Blueprint/Pt Profile）
- step: 用 edit 工具改内容（或 write 整体重写）—— Profile 改 ### Modules 时保持 modName 2 形态
- step: 删 .pt/cache/agent-contexts/*.agent-context.md（强制重编译）
- step: /pt-profile <profile> 重载验证
- step: 检查产物：/pt raw 看 segment，确认角色隔离生效（pt-dev 不含 architect / devops-engineer，pt-arch 不含 senior+qa+cr+devops 等）

## Rules

### when-new-domain
- check: 主题聚焦才建新 Domain——一个 Domain 承载一个知识单元；同主题扩内容加 Module，不新建 Domain

### when-new-blueprint
- check: 聚合组需求不同才建 Blueprint——优先复用内建 pt-default（session-context/trigger-index/reference-manual三组）；加新聚合组才新建。**v9.1+：Blueprint 不带 modules，创建后无需同步 modules 字段到 Profile——Profile 填 ### Modules 独立维护**

### when-add-module
- check: 同主题扩内容加 Module（Domain 内加 ## 新 Module 名）；不同主题才新建 Domain

### section-name-namespace
- check: 段名是命名空间（v9.1+）——通用段（Scene/Trigger/Rules/Flows/Checklists）跨 domain 通用；专用段（User/Agent/...）限定到单 domain。加新专用段 = 同时改 Domain + KNOWN_SECTION_NAMES + moduleRenderers（详见 renderer-registration）

### multi-level-dir-no-collision
- check: 同目录不重名（v9.1+ 多级目录硬约束）——`domains/meta/login.md` 与 `domains/meta/login-other.md` OK（不同名），但 `domains/meta/login.md` 与 `domains/auth/login.md` 也 OK（path 不同），仅 `domains/meta/login.md` 与 `domains/meta/login.md` 冲突（重复）。不同子目录同名用 path 形式引用时不会冲突。

### role-isolation-via-section-name
- check: 角色隔离通过专用段名实现（v9.1+）——user-info 用 ## User、agent-info 用 ## Agent，Profile 引用 `[User]` 整段或 `[Agent.<role>]` 精确选。**不要在 modName 里加形态 3（domain:段.项）**——会破坏命名空间设计且 profile 配置冗余。

## Checklists

### domain-quality-checklist
- items: [frontmatter name 对齐加载路径（多级目录用 path 形式）, H2 段名是标准段（Scene/Trigger/Rules/Flows/Checklists）或已注册专用段（User/Agent/...）, H3 项有 desc 字段, 同段内 H3 项名唯一（跨段可重名靠专用段名避免）, 无 type 字段]

### profile-quality-checklist
- items: [blueprint 引用名存在（优先内建 pt-default）, domains 顺序合理（身份类前约束类后）, 聚合组段对齐 Blueprint groups（每个 group 一个 H2）, ### Modules 段存在且填了 modName（v9.1+ 必填）, modName 是合法 2 形态（段名 / 段.项），不含形态 3, 角色隔离正确：专用段（User/Agent）按设计填充，段.项精确选单角色, 无追加时保留 H2 段让配置入口可见, 多级目录引用用 path 形式（如 `workflow/dev-workflow`）]

### role-isolation-checklist
- items: [4 profile（pt-arch / pt-design / pt-dev / pt-devops）共用同一 agent-info Domain 但各自 ### Modules 列出不同 Agent 角色, pt-dev `### Modules` 含 `Agent.agent-role-senior-developer` + `Agent.agent-role-qa-engineer` + `Agent.agent-role-code-reviewer` + `Agent.active-role-rule`（不含 architect / devops-engineer）, pt-arch / pt-design 含 `Agent.agent-role-architect` + `Agent.active-role-rule`（不含 dev / devops 角色）, pt-devops 含 `Agent.agent-role-devops-engineer` + `Agent.active-role-rule`（不含其他角色）, 跑 transpile 后 /pt raw 检查产物——`### agent-info.senior-developer` 等 H3 粒度输出仅在应见 profile 中出现]