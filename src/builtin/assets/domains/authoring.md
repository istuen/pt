---
name: authoring
---

# authoring

## Trigger
### authoring-trigger
- desc: 创作/修改 Pt 资产 md 时参考；含 Pt Domain/Blueprint/Pt Profile 格式 + 创建流程
- hint: /manual:authoring 查看完整创作手册

## Scene

### domain-format
- desc: frontmatter（name: 模块名，无 type 字段——H2 段名即 schema 选择器）+ H2 段（## Scene / ## Trigger / ## Rules / ## Flows / ## Checklists / ## Participant，按需写）+ H3 项（### 项名 + - desc: 描述 / - path: 路径 / - check: 规则 / - fields: 字段清单 / - note: 补充说明）。文件放 .pt/assets/domains/<name>.md。

### blueprint-format
- desc: YAML 格式（.blueprint.yaml）。字段：name + groups（聚合组列表，每个含 name + inject: session/turn + modules: [Domain Schema Name 列表]）。无 agent 字段（Blueprint Agent-agnostic，运行时硬编码 "pi"）。无 Compilation 段（cacheDir 用 CACHE_DIR 常量）。文件放 .pt/assets/blueprints/<name>.blueprint.yaml。

### profile-format
- desc: frontmatter（name + blueprint: 引用名 + domains: [全局 Domain 列表，自动分发到所有聚合组]）+ 可选 H2 聚合组实例化（## 聚合组名 + ### Domains 追加，只给该聚合组贡献）。domains 顺序影响 LLM attention——身份类放前，约束类放后。文件放 .pt/assets/profiles/<name>.profile.md。

### profile-h2-sections
- desc: v13.x 起（issue pt-no-agent-context-profile-h2-sections）Profile 范本必加 H2 聚合组段——即使无追加也保留空段让配置入口可见。具体格式：YAML 后用 H2 标题写出 Blueprint.groups[].name 同名的段；段下用 HTML 注释说明"此 Profile 用 Blueprint 全局 session/turn 聚合组，靠 YAML 全局 domains 兜底分发；无追加"。例如 pt-dev 范本保留 ## 会话背景 + ## 触发索引 + ## 参考手册 三段（与 dev-knowledge.yaml 的 groups 对齐）。配置可观测性：parseProfile groups 数 > 0，用户能看出本 Profile 覆盖哪些聚合组。

### term-domain-pattern
- desc: 概念/术语/规则类 Domain 写法：## Scene 下 ### 概念名 + - desc: 定义；## Rules 下 ### 规则名 + - check: 不变量描述。适合概念/术语/架构知识。（注：v9 已删 type 字段，不再有 term/workflow/stack 分类——H2 段名决定 schema。）

### workflow-domain-pattern
- desc: 流程/手册类 Domain 写法：## Scene 下 ### 引用名 + - path: 路径 + - desc: 说明；## Flows 下 ### 流程名 + - intent: 目的 + - step: 步骤。适合操作流程/开发手册。（注：v9 已删 type 字段。）

### build-roadmap
- desc: 从零构建 Pt 资产的顺序：（1）分析项目知识结构（参考 project-analysis 的 analyze-steps）→ 识别概念/流程/工具栈；（2）创建 Pt Domain 资产（每个知识单元一个 .md，H2 段名决定 schema）→ create-domain-procedure；（3）选 Blueprint（优先复用内建 dev-knowledge，聚合组需求不同才 create-blueprint-procedure）→（4）创建 Pt Profile 组装 Domain 列表 → create-profile-procedure；（5）/pt-profile 验证产物。执行 procedure 时用 /pt manual <procedure-name> <args> 创建实例文档跟踪。

## Flows

### create-domain-procedure
- argument-hint: <name>
- intent: 创建新 Pt Domain 资产的步骤指引（LLM 读完后用 write 工具执行，非 Pi 注册命令）
- vars: [name]
- step: 用 write 工具创建 .pt/assets/domains/{{name}}.md
- step: 写 frontmatter（name: {{name}}，无 type 字段）
- step: 按知识性质选 H2 段（概念→Scene+Rules，流程→Scene+Flows，规则→Rules，验收→Checklists）
- step: 在目标 Profile 的 domains 列表追加 {{name}}
- step: 删 .pt/cache/agent-contexts/*.agent-context.md + /pt-profile <profile> 验证

### create-profile-procedure
- argument-hint: <name>
- intent: 创建新 Pt Profile 的步骤指引（LLM 读完后用 write 工具执行，非 Pi 注册命令）
- vars: [name]
- step: 用 write 工具创建 .pt/assets/profiles/{{name}}.profile.md
- step: 写 frontmatter（name: {{name}} + blueprint: dev-knowledge + domains: [按需列]）
- step: domains 顺序：身份类 Domain 放前（如 me），项目知识中段，约束类放后
- step: 删 .pt/cache/agent-contexts/*.agent-context.md + /pt-profile {{name}} 验证产物

### create-blueprint-procedure
- argument-hint: <name>
- intent: 创建新 Blueprint 的步骤指引（仅当内建 dev-knowledge 聚合组不满足时；优先复用内建；LLM 读完后用 write 工具执行）
- vars: [name]
- step: 确认需要新聚合组——dev-knowledge 有会话背景/触发索引/参考手册三个聚合组（session×2 + turn×1），不够才新建
- step: 用 write 工具创建 .pt/assets/blueprints/{{name}}.blueprint.yaml
- step: 写 YAML（name: {{name}}，无 agent 字段）
- step: 写 groups（每个聚合组：name + inject: session/turn + modules: [Domain Schema Name]）
- step: Profile frontmatter 的 blueprint 字段改为 {{name}} 引用
- step: 删 .pt/cache/agent-contexts/*.agent-context.md + /pt-profile <profile> 验证

### modify-asset-procedure
- argument-hint: (无)
- intent: 修改已有资产的步骤指引（LLM 读完后用 edit/write 工具执行）
- vars: []
- step: 用 read 工具读目标 .md（Pt Domain/Blueprint/Pt Profile）
- step: 用 edit 工具改内容（或 write 整体重写）
- step: 删 .pt/cache/agent-contexts/*.agent-context.md（强制重编译）
- step: /pt-profile <profile> 重载验证
- step: 检查产物：/pt raw 看 segment，/pt full 看完整 Session Inject
