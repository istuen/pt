---
name: project-analysis
---

# project-analysis

## Scene

### what-is-pt
- desc: Pt 是异构上下文编译器——把领域知识按配置编译成 Agent 上下文并注入。你写 .pt/assets/ 下的 Pt Domain（知识原料）和 Pt Profile（配置），Pt 编译成 Agent Context（Session Context 固定注入面 + Turn Context 按需触发面），注入 Agent。

### four-layer-model
- desc: Pt Domain（内容层——一个 md = 一个知识单元，Module 名是 schema 选择器）+ Blueprint（结构层——定义聚合组 groups: name + inject + modules，跨项目复用，YAML 载体）+ Pt Profile（配置层——引用 Blueprint + 选 Domains，项目级）+ Agent Context（产物层——编译输出，Session Context + Turn Context 两面，带 sourceHash 缓存）。

### analyze-steps
- desc: 识别项目知识结构的三步法：（1）列举项目里的领域概念/术语 → Domain 用 Scene + Rules Module；（2）列举项目里的操作流程/开发手册 → Domain 用 Scene + Flows Module；（3）列举项目用的技术栈/工具 → Domain 用 Scene Module（带 path 字段引用外部资源）。一个 Domain 可混装多种 Module，不必按类型拆分。

### aggregation-group
- desc: Blueprint 的 groups 定义聚合组（语义名，如"会话背景"/"触发索引"/"参考手册"），inject 字段映射到注入位置（session = 每轮固定 / turn = 轮次级按需触发）。Pt Profile 同名 H2 实例化聚合组（追加 Domain）。AgentAdapter 内部映射 session/turn 到 Pi API（system_prompt/context_message）。

### inv-domain-granularity
- desc: 一个 Domain 承载一个知识单元——可以混装多种 Module（Scene + Rules + Flows），但语义上聚焦一个主题。按主题拆分 Domain，不按 Module 类型拆分。

### inv-blueprint-reuse
- desc: Blueprint 是跨项目复用的结构层——不要为单个项目定制 Blueprint；优先复用内建 Blueprint（dev-knowledge，含会话背景/触发索引/参考手册三个聚合组），只在聚合组需求不同时新建。

## Flows

### quickstart-flow
- argument-hint: (无)
- intent: 新手 5 步上手引导
- vars: []
- step: npm install @issac/pi-pt + 配置 pi.extensions（见 README）
- step: 激活内建 guide Profile——pi --pt-profile guide，或不设配置装包即自动激活
- step: /pt 查看当前编译状态（profile + segment 长度 + cache hit）
- step: 读 project-analysis 的 analyze-steps 分析自己项目的知识结构
- step: /pt flows 列出可触发手册，试 /manual:authoring 查看创作手册
