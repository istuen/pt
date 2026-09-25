---
name: mentor
---

# mentor

Pt 分步教学 domain——比 guide 更细，按 7 步引导用户从零到第一个可用的 Pt 配置。
builtin profile `mentor` 引用本 domain 做主线，深度参考通过 `/pt_turn_inject` 按需触发 authoring / usage / project-analysis。

**定位**：guide = 全量参考（按概念组织，6 domain 完整展示）；mentor = 分步教学（按步骤组织，7 步主线 + 按需深度参考）。第一次用 Pt 跟 mentor 走完 7 步，能跑通最小闭环。

## Trigger

### mentor-trigger
- desc: 想一步步学 Pt 时参考；含 7 步从零到可用配置的引导路径，每步带深度参考指引
- hint: 深度创作参考 /pt_turn_inject authoring；命令查询参考 /pt_turn_inject usage；概念模型参考 /pt_turn_inject project-analysis

## Scene

### step-1-understand-pt
- desc: 第 1 步——理解 Pt 是什么。Pt 是异构上下文编译器：你写 .pt/assets/ 下的 Domain（知识原料，md 文件）和 Profile（配置，md 文件），Pt 编译成 Agent Context 注入 Agent。四层模型：Domain（内容层，一个 md = 一个知识单元，H2 段名即 schema 选择器）→ Blueprint（结构层，聚合组插槽契约 name+inject+mode，可复用内建 pt-default）→ Profile（配置层，引用 Blueprint + 选 Domains + 填 modules）→ Agent Context（产物层，Session Context 每轮固定注入 + Turn Context 按需触发，带 sourceHash 缓存）。
- depth: 概念深度参考 /pt_turn_inject project-analysis（what-is-pt / four-layer-model）

### step-2-setup
- desc: 第 2 步——启用 Pt 并切换到 mentor。CLI 启动用 `--pt-profile mentor` 指定 profile；会话中用 `/pt-profile mentor` 切换（下一轮生效）；`/pt` 查看当前状态（profile + segment 长度 + cache hit）。第一次可先 `/pt-profile guide` 看 Pt 自描述全貌，再切 mentor 跟着学。**启用后立刻个性化 user-info**——builtin `user-info.md` 三个 H3（who-am-i / preferences / goals）都是占位符"修改为你的真实身份/偏好/目标"，不改的话 Agent 上下文是字面量提示，Session Context 注入的是占位符。改法：编辑 `.pt/assets/domains/user-info.md` 把 desc 文本改成自己的内容，删 cache 重编译即可生效。mentor profile `### Modules: [User]` 整段聚合 user-info，所以改这一处就够。
- depth: 命令深度参考 /pt_turn_inject usage（pt-commands / pt-profile-command）

### step-3-analyze-project
- desc: 第 3 步——识别你项目的知识结构。三步法：(1) 列举项目里的领域概念/术语 → Domain 用 Scene + Rules 段；(2) 列举项目里的操作流程/开发手册 → Domain 用 Scene + Flows 段；(3) 列举项目用的技术栈/工具 → Domain 用 Scene 段（带 path 字段引用外部资源）。一个 Domain 可混装多种段，不必按类型拆分。
- depth: 方法深度参考 /pt_turn_inject project-analysis（analyze-steps）

### step-4-create-first-domain
- desc: 第 4 步——创作第一个 Domain。最小结构：frontmatter（`name: <域名>`，无 type 字段）+ `## Scene` + `### 项名` + `- desc: 描述`。文件放 .pt/assets/domains/<name>.md。从最小开始——先写一个 Scene 段一个 H3 项，能编译过再加内容。最小示例可照抄 authoring 的 minimal-example（user-info.md 的 ## User 段 + agent-info.md 的 ## Agent 段，两个 Domain 各一个 H3 项即可跑通）。
- depth: 格式深度参考 /pt_turn_inject authoring（domain-format + minimal-example）

### step-5-create-first-profile
- desc: 第 5 步——创作第一个 Profile。frontmatter（`name: <profile名>` + `blueprint: pt-default` + `domains: [你的 domain 列表]`）+ 三个 H2 聚合组段：`## session-context` 下 `### Modules` 填 `- Scene` / `- User` / `- Agent`；`## trigger-index` 下 `### Modules` 填 `- Trigger`；`## reference-manual` 下 `### Modules` 填 `- Rules` / `- Flows` / `- Checklists`。blueprint 可省略——自动 fallback 到 builtin pt-default。modName 两种形态：段名（整段聚合，如 `Scene`）或 段.项（精确选 H3，如 `Agent.agent-role-architect`）；不要用形态 3（domain:段.项）。
- depth: 格式深度参考 /pt_turn_inject authoring（profile-format + profile-modules-section）

### step-6-compile-verify
- desc: 第 6 步——编译并验证。改完资产后：(1) 删 .pt/cache/agent-contexts/*.agent-context.md 强制重编译；(2) `/pt-profile <你的profile>` 激活；(3) `/pt` 看 cache miss + segment 长度变化；(4) `/pt raw` dump segment 到 .pt/cache/raws/ 看实际聚合内容；(5) `/pt full` dump 完整 Session Inject 到 .pt/cache/fulls/ 看 Agent 实际收到的上下文。
- depth: 命令深度参考 /pt_turn_inject usage（pt-commands / cache-invalidation-rule）

### step-7-iterate
- desc: 第 7 步——迭代。加/改资产的标准循环：改 .md → 删 cache → /pt 验证 → 不满意再改。资产变了 sourceHash 自然不同，cache miss 自动重编译。每个阶段一个 git commit（baseline 可回退，搞砸了 git revert）。进阶后可学 pack-management 组织多项目复用的资产包。
- depth: 流程深度参考 /pt_turn_inject authoring（modify-asset-procedure）；pack 组织参考 /pt_turn_inject pack-management

## Flows

### mentor-flow
- intent: 7 步教学完整流程——从理解 Pt 到迭代第一个可用配置
- step: 读 step-1-understand-pt，理解 Pt 是什么 + 四层模型
- step: 读 step-2-setup，启用 Pt + 切换到 mentor profile
- step: 读 step-3-analyze-project，用三步法识别项目知识结构
- step: 读 step-4-create-first-domain，创作第一个 Domain（从最小示例开始）
- step: 读 step-5-create-first-profile，创作第一个 Profile（填 modules）
- step: 读 step-6-compile-verify，删 cache + /pt 验证产物
- step: 读 step-7-iterate，进入改→删cache→验证的迭代循环
- done: 能独立创作 Domain + Profile + 激活验证，完成最小闭环

## Rules

### step-order
- check: 7 步有顺序依赖——1 理解 → 2 启用 → 3 分析 → 4 创 Domain → 5 创 Profile → 6 验证 → 7 迭代。跳步容易卡（如没创 Domain 就创 Profile，domains 列表引用会 unresolved）

### minimal-first
- check: 第 4/5 步从最小开始——Domain 先一个 Scene 一个 H3，Profile 先引一个 Domain，跑通再加内容。不要一开始就写完整知识体系

### cache-after-change
- check: 每次改资产后必须删 .pt/cache/agent-contexts/*.agent-context.md——否则 cache hit 走旧产物，看不到改动效果

### depth-on-demand
- check: 深度参考（authoring/usage/project-analysis）通过 /pt_turn_inject 按需触发，不常驻 session——保持 session context 精简，需要时才注入

## Checklists

### mentor-checklist
- items: [能说出 Pt 四层模型（Domain/Blueprint/Profile/Agent Context）各自职责, 能用 /pt-profile 切换 profile + /pt 看状态, 个性化了 user-info（改 who-am-i / preferences / goals 三个占位符为自己的真实身份 / 偏好 / 目标，否则 Agent 上下文是占位符提示）, 用三步法识别了项目至少 1 个知识单元, 创作了第一个 Domain（frontmatter name + ## Scene + ### H3 + - desc）, 创作了第一个 Profile（frontmatter + 3 个 H2 聚合组 + ### Modules）, 删 cache + /pt 验证产物 + /pt raw 看到 segment, 进入迭代循环（改→删cache→验证）]
