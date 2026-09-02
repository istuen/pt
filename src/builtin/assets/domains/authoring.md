---
type: workflow
name: authoring
---

# authoring

## Trigger
### authoring-trigger
- desc: 创作/修改 Pt 资产 md 时参考；含 Domain/Blueprint/Profile 格式 + 创建流程
- hint: /manual:authoring 查看完整创作手册

## Scene

### domain-format
- desc: frontmatter（type: term/workflow/stack + name: 模块名）+ H2 段（## Scene + ## Trigger + ## Manual，按需写）+ H3 项（### 项名 + - desc: 描述 / - path: 路径 / - check: 规则）。文件放 .pt/assets/domains/<name>.md。

### blueprint-format
- desc: frontmatter（name + agent: pi）+ H2 注入点（## 注入点名 + target: system_prompt/context_message + ### Modules 列 modName）+ ## Compilation（cache-dir + split）。文件放 .pt/assets/blueprints/<name>.blueprint.md。

### profile-format
- desc: frontmatter（name + blueprint: 引用名 + domains: [列表]）+ 可选 H2 注入点实例化（## 注入点名 + ### Domains 追加）。domains 顺序影响 LLM attention——身份类放前，约束类放后。文件放 .pt/assets/profiles/<name>.profile.md。

### term-domain-pattern
- desc: term Domain 写法：## Scene 下 ### 概念名 + - desc: 定义；## Manual 下 ### 规则名 + - desc: 不变量描述。适合概念/术语/架构知识。

### workflow-domain-pattern
- desc: workflow Domain 写法：## Scene 下 ### 引用名 + - path: 路径 + - desc: 说明；## Manual 下 ### 流程名 + - intent: 目的 + - step: 步骤。适合操作流程/开发手册。

### stack-domain-pattern
- desc: stack Domain 写法：## Scene 下 ### 工具名 + - role: 用途说明；无 Manual 段（stack 只声明工具栈，不承载规则/流程）。适合技术栈声明。

### build-roadmap
- desc: 从零构建 Pt 资产的顺序：（1）分析项目知识结构（参考 project-analysis 的 analyze-steps）→ 识别概念/流程/工具栈；（2）创建 Domain 资产（每种知识一个 .md）→ create-domain-procedure；（3）选 Blueprint（优先复用内建 dev-knowledge，注入点不同才 create-blueprint-procedure）→（4）创建 Profile 组装 Domain 列表 → create-profile-procedure；（5）/pt-context 验证产物。执行 procedure 时用 /pt manual <procedure-name> <args> 创建实例文档跟踪。

## Manual

### create-domain-procedure
- argument-hint: <type> <name>
- intent: 创建新 Domain 资产的步骤指引（LLM 读完后用 write 工具执行，非 Pi 注册命令）
- vars: [type, name]
- step: 确定类型：{{type}}（term=概念 / workflow=流程 / stack=工具栈）
- step: 用 write 工具创建 .pt/assets/domains/{{name}}.md
- step: 写 frontmatter（type: {{type}} + name: {{name}}）
- step: 按 type 对应 pattern 写 H2 段（参考 authoring Scene 的 *-pattern 项）
- step: 在目标 Profile 的 domains 列表追加 {{name}}
- step: 删 .pt/cache/contexts/*.context.md + /pt-context <profile> 验证

### create-profile-procedure
- argument-hint: <name>
- intent: 创建新 Profile 的步骤指引（LLM 读完后用 write 工具执行，非 Pi 注册命令）
- vars: [name]
- step: 用 write 工具创建 .pt/assets/profiles/{{name}}.profile.md
- step: 写 frontmatter（name: {{name}} + blueprint: dev-knowledge + domains: [按需列]）
- step: domains 顺序：身份类 domain 放前（如 me），项目知识中段，约束类放后
- step: 删 .pt/cache/contexts/*.context.md + /pt-context {{name}} 验证产物

### create-blueprint-procedure
- argument-hint: <name>
- intent: 创建新 Blueprint 的步骤指引（仅当内建 dev-knowledge 注入点不满足时；优先复用内建；LLM 读完后用 write 工具执行）
- vars: [name]
- step: 确认需要新注入点——dev-knowledge 只有会话知识(system_prompt) + 参考手册(context_message)，不够才新建
- step: 用 write 工具创建 .pt/assets/blueprints/{{name}}.blueprint.md
- step: 写 frontmatter（name: {{name}} + agent: pi）
- step: 写 H2 注入点（## 注入点名 + target: system_prompt/context_message + ### Modules 列 modName）
- step: 写 ## Compilation（cache-dir: .pt/cache/contexts/ + split: single-file）
- step: Profile frontmatter 的 blueprint 字段改为 {{name}} 引用
- step: 删 .pt/cache/contexts/*.context.md + /pt-context <profile> 验证

### modify-asset-procedure
- argument-hint: (无)
- intent: 修改已有资产的步骤指引（LLM 读完后用 edit/write 工具执行）
- vars: []
- step: 用 read 工具读目标 .md（Domain/Blueprint/Profile）
- step: 用 edit 工具改内容（或 write 整体重写）
- step: 删 .pt/cache/contexts/*.context.md（强制重编译）
- step: /pt-context <profile> 重载验证
- step: 检查产物：/pt raw 看 segment，/pt full 看完整 prompt
