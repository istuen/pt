---
name: project-analysis
---

# project-analysis

## Scene

### what-is-pt
- desc: Pt 是异构上下文编译器——把领域知识按配置编译成 Agent 上下文并注入。你写 .pt/assets/ 下的 Pt Domain（知识原料）和 Pt Profile（配置），Pt 编译成 Agent Context（Session Context 固定注入面 + Turn Context 按需触发面），注入 Agent。

### four-layer-model
- desc: Pt Domain（内容层——一个 md = 一个知识单元，Module/H2 段名即 schema 选择器）+ Blueprint（结构层——聚合组插槽契约 name + inject + mode，跨项目复用，YAML 载体）+ Pt Profile（配置层——引用 Blueprint + 选 Domains + 填 modules，项目级）+ Agent Context（产物层——编译输出，Session Context + Turn Context 两面，带 sourceHash 缓存）。**v9.1+：Blueprint 不带 modules（退化为插槽契约）——modules 由 Profile 的 H2 段下 ### Modules 列表提供。**

### analyze-steps
- desc: 识别项目知识结构的三步法：（1）列举项目里的领域概念/术语 → Domain 用 Scene + Rules Module；（2）列举项目里的操作流程/开发手册 → Domain 用 Scene + Flows Module；（3）列举项目用的技术栈/工具 → Domain 用 Scene Module（带 path 字段引用外部资源）。一个 Domain 可混装多种 Module，不必按类型拆分。

### aggregation-group
- desc: Blueprint 的 groups 定义聚合组（语义名，如"session-context"/"trigger-index"/"reference-manual"），inject 字段映射到注入位置（session = 每轮固定 / turn = 轮次级按需触发）。**v9.1+**：Blueprint groups 不带 modules（插槽契约），modules 由 Profile H2 段下 ### Modules 列表填——Profile 通过 H2 名匹配 Blueprint 插槽，每 H2 下的 ### Modules 列本插槽的 modules 列表（段名 / 段.项 两种形态）。AgentAdapter 内部映射 session/turn 到 Pi API（system_prompt/context_message）。

### modname-2-forms
- desc: modName 2 形态（v9.1+）——(1) 段名（`Scene` / `User` / `Agent` / `Trigger` / `Rules` / `Flows` / `Checklists`）：跨所有引用域该段整段聚合；(2) 段.项（`Agent.senior-developer` / `User.user-profile`）：跨所有引用域该段下 H3 项精确选。**不引入形态 3（domain:段.项）**——限定到单 domain 通过专用段名（`User` / `Agent`）实现，避免 profile 重复写引用。

### section-as-namespace
- desc: 段名 = 命名空间（v9.1+）——通用段（Scene / Participant / Trigger / Rules / Flows / Checklists）跨 domain 通用；专用段（User / agent-info 用 / Agent / agent-info 用 / ...）限定到单 domain。加新专用段 = Domain 用新 H2 段名 + `KNOWN_SECTION_NAMES` 集合加一行 + `moduleRenderers` 注册一行（详见 authoring 的 renderer-registration）。

### multi-level-dir
- desc: 多级目录支持（v9.1+）——`.pt/assets/domains/<subdir>/<name>.md` 用子目录归类相关 Domain。`loadAllDomains` 自动递归扫描；Domain.name = POSIX 相对路径去 .md（`workflow/dev-workflow`）。Profile 的 `domains:` 列表用 path 形式引用——`[user-info, agent-info, workflow/dev-workflow, ...]`。**同目录不重名**（硬约束，文件系统约束）；不同子目录可同名（path 天然区分）。

### role-isolation
- desc: 角色隔离（v9.1+ 核心承诺）——通过专用段名 + 段.项粒度实现 Profile 间的角色隔离。例：pt-dev profile 用 `[Scene, User, Agent.agent-role-senior-developer, Agent.agent-role-qa-engineer, Agent.agent-role-code-reviewer, Agent.active-role-rule]`——只看 dev 3 角色 + active-role-rule，不看 architect / devops-engineer；pt-arch 用 `[Scene, User, Agent.agent-role-architect, Agent.active-role-rule]`；pt-devops 用 `[Scene, User, Agent.agent-role-devops-engineer, Agent.active-role-rule]`。**4 profile 共享同一 Blueprint（pt-default）+ 同一 Domain 集合（user-info + agent-info + ...），差异全在 ### Modules 段——真正的隔离**。

### h3-name-uniqueness
- desc: H3 项名唯一约束（v9.1+）——同段内 H3 重名 parse 时**后覆盖前**（保持 IR 唯一性）；跨段同名 H3 由段名命名空间避免（`Scene.x` 不匹配 `User` 段下同名 x，要跨段匹配必须改段名）。**`### <domain>.<item>` 渲染形式**——H3 项粒度产物输出形式（如 `### agent-info.senior-developer`）。

### inv-domain-granularity
- desc: 一个 Domain 承载一个知识单元——可以混装多种 Module（Scene + Rules + Flows），但语义上聚焦一个主题。按主题拆分 Domain，不按 Module 类型拆分。

### inv-blueprint-reuse
- desc: Blueprint 是跨项目复用的结构层——不要为单个项目定制 Blueprint；优先复用内建 Blueprint（pt-default，含session-context/trigger-index/reference-manual三个聚合组），只在聚合组需求不同时新建。**v9.1+**：Blueprint 是插槽契约（name + inject + mode），不带 modules——modules 来自 Provider。

## Flows

### quickstart-flow
- argument-hint: (无)
- intent: 新手 5 步上手引导
- vars: []
- step: npm install @issac/pi-pt + 配置 pi.extensions（见 README）
- step: 激活内建 guide Profile——pi --pt-profile guide，或不设配置装包即自动激活
- step: /pt 查看当前编译状态（profile + segment 长度 + cache hit）
- step: 读 project-analysis 的 analyze-steps + section-as-namespace + role-isolation 分析自己项目的知识结构
- step: /pt flows 列出可触发手册，试 /manual:authoring 查看创作手册