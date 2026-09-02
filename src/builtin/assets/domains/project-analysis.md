---
type: term
name: project-analysis
---

# project-analysis

## Scene

### what-is-pt
- desc: Pt 是 Pi 扩展，把你的项目知识资产（MD 文件）编译成 Pi Agent 的 System Prompt 和 Context Message。你写 .pt/assets/ 下的 md，Pt 转译成 LLM 能高效消费的上下文。

### four-layer-model
- desc: Domain（内容层——一个 md 文件 = 一个知识模块，frontmatter.type 区分 term/workflow/stack）+ Blueprint（结构层——定义注入点 H2 + target + Modules，跨项目复用）+ Profile（配置层——选 Blueprint + 列 domains，项目级）+ Context（产物层——编译输出，带 hash 缓存）。

### domain-types
- desc: term（概念/术语/规则，Scene 列条目 + Manual 列不变量）+ workflow（流程/手册，Scene 列外部引用 + Manual 列可触发 FlowTemplate）+ stack（技术栈声明，Scene 列工具引用）。

### analyze-steps
- desc: 识别项目知识结构的三步法：（1）列举项目里的领域概念/术语 → term Domain；（2）列举项目里的操作流程/开发手册 → workflow Domain；（3）列举项目用的技术栈/工具 → stack Domain。

### injection-point
- desc: Blueprint 的 H2 = 注入点（语义名，如"会话知识"/"参考手册"），target 字段映射到 Pi 技术注入位置（system_prompt = 每轮固定 / context_message = 轮次级动态触发）。Profile 同名 H2 实例化注入点。

## Manual

### inv-domain-granularity
- desc: 一个 Domain 只承载一类知识——不要把术语和流程混在一个 Domain 里；按知识性质拆分（概念 → term，流程 → workflow，工具 → stack）。

### inv-blueprint-reuse
- desc: Blueprint 是跨项目复用的结构层——不要为单个项目定制 Blueprint；优先复用内建 Blueprint（dev-knowledge），只在注入点需求不同时新建。
