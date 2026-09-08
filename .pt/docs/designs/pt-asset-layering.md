# Pt 分层模型与转译架构

> **阅读指引**：本文档 §0 是语义锚定（**v9 模型**，2026-09-01 定稿，术语对齐系列 P1+P2+P4+P9+P8 落地后），所有后续章节以 §0 为准。§1-§11 是历史演进章节（v1-v8），保留作背景，存在语义演进痕迹——遇到与 §0 冲突处，以 §0 为准。
>
> 关联文档：`docs/pt-prompt-optimization.md`（转译产物优化）、`docs/pt-dev-phases.md`（开发执行计划）、`docs/pt-dev-phases-v8.md`（v8 实现执行描述，已执行完毕）。
>
> 本文回答三个问题：
> 1. Pt 处理什么、产出什么、各概念如何分流？（§0 语义定义 — v9 四层模型）
> 2. Pt 与来源（OXN 等）的依赖关系如何反转？（§6 Schema/adapter）
> 3. 转译通道如何分段？（§11 前端/中端/后端）
>
> 结论：**Domain → Blueprint → Profile → AgentContext 四层模型 + H2 段名 schema 驱动（无 Type）+ 聚合点数据驱动 + Profile Domains 自动分发 + Trigger 索引 + Participant 分离 + target session/turn Agent-agnostic**。
>
> **v9 相对 v8 的变化**（详见 §0.10 共 18 项）：
> - **职责重分配**：v8 Channel（结构层）→ v9 Blueprint（Agent 端结构）；v8 Blueprint（配置层）→ v9 Profile（业务端实例）
> - **Channel 保留为未来** Domain 连接外部知识源的 Connector（当前不实现）
> - **Trigger 段移到 Domain**（H2 段，不在 Profile/Blueprint）
> - **Boundaries 丢弃**（Trigger 索引 + Scene axioms 替代流程 DAG）
> - **聚合点数据驱动**：`modules` 是聚合标题列表，compile 按 modName 注册表分发 + generic fallback，加新聚合标题不改代码
> - **Profile Domains 自动分发**：YAML 全局 domains + 聚合组追加
> - **聚合组名人类自定义**：Blueprint H2 是任意语义名，target 字段映射到 Agent 注入位置（`session`/`turn`，Agent-agnostic）
> - **AgentAdapter 抽象**：Blueprint 暂硬编码 `"pi"`（P4.1 删 agent 字段），AgentAdapter 内部把 `target` 映射到 Agent API（Pi: `system_prompt`/`context_message`）
> - **"对话记忆" → "参考手册"** 改名
> - **新增 me Domain** 概念 → Phase term-P8 拆为 `## Participant` 段
> - **Phase term-P1**：Context IR 改名 AgentContext（避免与 Pi `context_message` 撞名）
> - **Phase term-P2**：`/pt-context` → `/pt-profile` 改名（命令参数是 Profile 名）
> - **Phase term-P4.1**：Blueprint `agent` 字段移除，agent 运行时选择（暂硬编码 `"pi"`）
> - **Phase term-P4.2**：Blueprint `## Compilation` 段移除（cacheDir 用 CACHE_DIR 常量，split 硬编码 single-file）
> - **Phase term-P4.3**：target 值 `system_prompt`/`context_message` → `session`/`turn`；函数名 renderSystemPrompt/renderContextMessage → renderSessionInject/renderTurnInject
> - **Phase term-P4.5**：Blueprint 载体 `.blueprint.md` → `.blueprint.yaml`（首次引入运行时依赖 `yaml`）
> - **Phase term-P9.1**：Scene 段统一 Term[]（workflow externals 合并进 path 字段）
> - **Phase term-P9.2**：`## Manual` 拆为 `## Rules` / `## Flows` / `## Checklists`（一 H2 段一 schema）
> - **Phase term-P9.3**：Domain `type` 字段删除，H2 段名是唯一 schema 选择器；`stack` 死类型删除
> - **Phase term-P8**：me Domain 拆 `## Participant` 段（复用 Scene renderer 一行注册）

---

## 零、Pt 语义定义

本节是 Pt 的语义基准，定义 Pt 处理什么、产出什么、各概念如何分流。后续架构章节均以此为准。

> **v9 模型**（2026-09-01 定稿，术语对齐系列 P1+P2+P4+P9+P8+P-naming 落地后）。四层：**Domain（内容层）→ Blueprint（结构层）→ Profile（配置层）→ AgentContext（产物层）**。Channel 保留为未来 Domain 连接外部知识源的 Connector。

> **Phase term-naming**：Blueprint 字段 `target` → `inject`（语义更直白）；会话背景 / 参考手册三层拆出 `触发索引` 中间层（Trigger 拉出独立，原在会话背景内）。详见 §0.5a / §0.5b。

**Pt 的本质是「异构上下文编译器」**——核心产物是 **AgentContext**（编译后目标上下文）。Domain 是异构领域知识（人类业务端，H2 段开放：Scene/Trigger/Rules/Flows/Checklists/Participant），Blueprint 是 Agent 端聚合组结构（定义有哪些上下文场景 + 每个场景聚合什么模块 + 注入到 Agent 哪里），Profile 是业务端实例（引用 Blueprint + 选哪些 Domain），AgentContext 是编译后产物。Pt 把异构的领域知识按 Blueprint 定义的聚合组编译成统一的 Agent 上下文，供 Agent 各注入位置消费。

### 为什么需要 Pt（问题域）

**LLM 是失忆且被动的图书馆智能体**——知识在权重里但不主动浮现，每个 session 从零开始。因此每次输入必须自包含：

| LLM 约束 | 含义 | 输入必须带什么 |
|---|---|---|
| **失忆** | 无跨会话记忆，session_start 从零 | 固定背景（场景 + 参与者 + 边界） |
| **被动** | 知识在权重里但不主动浮现 | 可调阅索引（提示有什么可召唤、何时召唤） |
| （会话累积） | 对话推进产生新内容 | 当前对话记忆 |

Pt 的工作：把领域知识组织成这种自包含输入。**Profile 定义场景**（背景 + 参与者 + 边界），**编译成 AgentContext**（静态面=每轮重注的背景，动态面=按需召唤的手册），注入 LLM。

这个动机解释了每个机制为什么存在：

| 机制 | 解决 LLM 的哪个约束 |
|---|---|
| Profile（场景定义，持久化可复用） | 失忆——场景定义不能每次手写，需持久化 |
| AgentContext 静态面（每轮注入 Session Inject） | 失忆——每轮必须重注背景 |
| AgentContext 动态面（按需触发 Turn Inject） | 被动 + 省 token——手册不每轮注，按需才召唤 |
| Trigger 索引（提示有什么手册可查） | 被动——LLM 不会主动想起，需提示可调阅 |
| `/manual:xxx` 触发 | 被动——主动召唤具体知识进输入 |

### Pt 是什么

**Pt 是异构上下文编译器**——把领域知识按配置编译成 Agent 上下文并注入。

使用者最关心的是**编译产物 AgentContext**：一份配一次就让 Agent 获取更有效、更专注的上下文。AgentContext 由两面组成，对应 Agent 的两种上下文需求：

| 面 | 注入位置（target） | 时效 | 心智 | 通俗类比 |
|---|---|---|---|---|
| **会话背景** | `session` → Session Inject（`before_agent_start`） | 静态、贯穿整个会话 | Agent 的人格/背景（身份+主题） | "Agent 是谁、要做什么" |
| **触发索引** | `session` → Session Inject（与会话背景同注入位置） | 静态、每轮可见 | Agent 的查阅索引 | "何时查哪本手册" |
| **参考手册** | `turn` → Turn Inject（`input` 事件触发） | 动态、按需触发 | Agent 的工具书 | "需要时查哪本手册" |

**领域知识是上下文的原料**。用户配一份 **Profile**（选哪些知识 + 套哪种结构），Pt 就把领域知识按 Profile 编译成 AgentContext，注入 Agent。不同 Profile 编译出不同场景的 AgentContext。

> **target 是结构层术语（`session` / `turn`）**。AgentAdapter 内部映射到 Agent 的技术 API 名（Pi: `system_prompt` / `context_message`）。详见 §0.11。

### 派生链（自顶向下倒推）

```
AgentContext            ← 用户关心的产物：会话背景 + 触发索引 + 参考手册
  ↑ Profile 编译产出
Profile                 ← 配置：选 Blueprint + 选 Domains，组合出不同场景的 AgentContext
  ↑ 引用
Blueprint               ← 结构：声明有哪些聚合组 + 各聚合组聚合什么 + 注入到 Agent 哪里（target）
  +                     +
Domains                 ← 原料：异构领域知识，按 H2 段（Scene/Trigger/Rules/Flows/Checklists/Participant）切模块
```

**一句话**：Domains 是原料，Blueprint 是结构模板，Profile 是"选哪些原料套哪种结构"的配置，AgentContext 是编译出来的 Agent 上下文。**改 Profile（换知识组合）即可换场景，不必改 Blueprint 或 Domains。**

### 两种适配器（扩展边界）

Pt 的扩展性集中在两套适配器，依赖反转——Pt 核心定义接口、具体实现可插拔：

| 适配器 | 适配什么 | MVP 实现 | 扩展方式 |
|---|---|---|---|
| **SourceAdapter** | 知识源格式（MD/YAML/DB/...） | mdAdapter | 加 adapter 类 |
| **AgentAdapter** | Agent 注入机制（Pi/Codex/...） | PiAdapter | 加 adapter 类 |

左边吃异构知识源，右边接异构 Agent。Pt 核心不感知来源格式，也不感知 Agent API。

---

### 0.1 产物层：AgentContext（Pt 核心价值）

**AgentContext 是 Profile 编译后的产物**——Pt 的核心价值所在。AgentContext 是**物理文件**（`.pt/cache/agent-contexts/<name>.agent-context.md`），按聚合组组织，缓存复用，避免每次重新编译。

AgentContext 的结构按聚合组划分（与 Blueprint 的 H2 一一对应）：

```markdown
# pt-dev.agent-context.md  （Profile「pt-dev」编译后的 AgentContext）

## 会话背景               ← inject: session，每轮注入 Session Inject（身份 + 主题）
  （Domain 的 Scene + Participant 段聚合，按 Blueprint.mode 编排）
  ### 模块「pt-architecture」
  **术语**
  - **三段式编译架构**：...

## 触发索引               ← inject: session，桥接会话背景与参考手册（与上一面同注入位置）
  （Domain 的 Trigger 段聚合）
  ### pt-architecture
  - **pt-quality**：改 Pt 代码时参考；含 9 条技术规范
    /manual:pt-quality 查看完整规范

## 参考手册               ← inject: turn，触发时注入 Turn Inject
  （Domain 的 Rules/Flows/Checklists 段聚合，待命）
  ### 模块「pt-quality」
  - [ ] modules-type-safety
  - [ ] path-constant
```

**三面各自的生命周期**：

- **会话背景**每轮注入 Session Inject（含 Scene 背景 + Participant 会话信息）—— Agent 知道自己是谁、在什么场景。
- **触发索引**也每轮注入 Session Inject（与会话背景同 inject: session，但独立 group）—— Agent 看到索引后才知道"有什么手册可查、何时查"。**触发索引与会话背景分离是默认 Blueprint 组织**：让"桥接"角色可见，但同注入位置 = 同注入时机。
- **参考手册**不每轮注入——用户 `/manual:xxx` 或 LLM 判断需要时才触发，内容作为 Turn Inject 注入（省 token，compact 时进消息流会被压缩）。

**缓存与失效**：AgentContext 文件头记录 `source-hash = hash(Profile + Blueprint + Domains)`。三者任一变化即失效重编译。Pt 读取时比对 hash：一致用缓存，不一致重编译覆盖。**缓存目录硬编码** `.pt/cache/agent-contexts/`（`src/constants.ts CACHE_DIR` 常量，Blueprint 无配置项）。

**AgentContext 不自描述 target**：modules 按聚合组名（语义名）聚键，但哪个是 `session`、哪个是 `turn` 需回头查 `Blueprint.groups[].target`。

> 内容由 Domain 定义，因此 AgentContext 内容可以是普通文本，也可以是执行描述。Pt 产出结构化上下文文档，LLM 做推理。

---

### 0.2 配置层：Profile（怎么配出 AgentContext）

**Profile 是配置——把 Blueprint 和 Domains 衔接起来，组合出不同场景的 AgentContext**。Profile 是项目级的：每个项目/场景一份 Profile，填入自己的 Domain 组合。配一次，全员生效。

**核心设计：Domains 自动分发 + 聚合组 modules 由 Profile 填写**。Profile 的 YAML frontmatter 有全局 `domains` 列表，自动分发到所有聚合组；聚合组 H2 下的 `### Domains` 是追加列表，只给该聚合组贡献。两者合并后，compile 按 Profile H2 下的 `### Modules` 段判断每个 Domain 贡献哪些 H2 段（有则贡献，无则跳过）。详见 §0.6。

> **v9.1 变更**（modules-to-profile 迁移）：Blueprint 退化为插槽契约（只声明 `name` + `inject` + `mode`），聚合组的 `modules`（参与本插槽的 H2 段名列表）由 Profile 的 H2 段 `### Modules` 填写。Blueprint 不再带 modules——Profile 持有 modules 选择权，角色身份 / 段类型选择与结构定义解耦。详见 .pt/docs/designs/pt-modules-ownership.md。

Profile 配置用 MD 标题层级 + YAML frontmatter 表达：

```markdown
---
name: pt
blueprint: dev-knowledge
domains: [pt-concepts, pt-architecture, me, pt-transpile]
---

# pt (profile)

## 会话背景
### Modules          ← v9.1：聚合组填本插槽的 modules（具名身份段 + 段类型）
- Scene
- Participant
### Domains
- pt-quality
- pt-collab

## 参考手册
### Modules
- Rules
- Flows
- Checklists
### Domains
- pt-quality
- pt-collab
```

**字段职责**：
- YAML `name`：Profile 名（项目级标识）
- YAML `blueprint`：引用哪个 Blueprint（结构复用）
- YAML `domains`：全局 Domain 列表，自动分发到所有聚合组（有匹配 H2 段则贡献）
- `## 会话背景` / `## 触发索引` / `## 参考手册`：H2 = 聚合组（与 Blueprint 的 H2 同名，实例化该聚合组）
  - `### Modules`：v9.1 新增——本插槽的 modules 列表（H2 段名，如 Scene/Participant/Trigger/Rules/Flows/Checklists）
  - `### Domains`：追加到本聚合组的 Domain 列表（只贡献该聚合组）

**全局 vs 聚合组追加**：全局 `domains` 是"基集"——写一次自动分发；聚合组 `### Domains` 是"追加"——精确控制只给某聚合组贡献。Domain 列一次（全局），不必每个聚合组重复写；需要精确控制时用追加。

**Profile 不跨项目复用**。跨项目复用的是 Blueprint（结构）和 Domain（知识）——Profile 是把两者组装成具体场景的胶水。

---

### 0.3 结构层 + 内容层：Blueprint 与 Domains（Profile 引用什么）

Profile 引用两样东西：**Blueprint（结构模板）** 和 **Domains（知识原料）**。两者都可独立复用，Profile 负责组装。

#### Blueprint：聚合组结构模板

**Blueprint 是 Agent 端的聚合组结构设计**——定义有哪些上下文场景（聚合组），注入到 Agent 的哪个位置（`inject`），用什么聚合方式（`mode`）。Blueprint 可跨项目复用——「开发知识」这个结构在多个项目都适用，只是具体 Profile 的 Domain/modules 组合不同。

> **v9.1 变更**（modules-to-profile 迁移）：Blueprint 退化为**插槽契约**——只声明 `name` + `inject` + `mode`，**不再持有 modules 字段**。每个聚合组参与哪些 H2 段（modules 列表）由 Profile 的 H2 段 `### Modules` 填写。详见 .pt/docs/designs/pt-modules-ownership.md（设计依据 + 与方案 A / 合并方案对比）。**根因**：modules 混了"具名身份模块"（tech-lead / senior-developer）和"段类型"（Scene / Trigger / Rules）两种语义，把角色身份选择塞进 Blueprint.modules（结构层）会压缩复用空间——4 份 blueprint 各自独立就是根因。迁移后 Blueprint 只管结构（插槽契约），Profile 持角色身份选择，结构层与配置层职责清晰。

**核心设计：H2 = 聚合组（人类自定义名）**。Blueprint 的每个 H2 是一个聚合组，H2 名由人类自定义（会话背景/触发索引/参考手册/背景知识/操作手册/...），不由代码写死。`inject` 字段把语义名映射到 **Agent 注入位置**（`session` / `turn`，Agent-agnostic 术语）。AgentAdapter 内部把 `inject` 映射到 Agent 的技术 API（Pi: `system_prompt` / `context_message`），Pt 核心不感知其具体含义。

**Phase term-P4**：Blueprint **去 agent 字段**（Blueprint 应 Agent-agnostic；agent 是运行时选择不是结构定义，当前只有一个 PiAdapter 故硬编码 `"pi"`，等第二个 Adapter 后改 `transpile(profile, agent)` 编译维度参数）和 **去 ## Compilation 段**（cacheDir 用 `constants.CACHE_DIR` 常量，split 硬编码 single-file）。**Phase term-P4.5**：载体从 `.blueprint.md` 转为 `.blueprint.yaml`（纯结构化数据，避开 MD 叙事格式）。**Phase term-naming**：字段名 `target` → `inject`（语义更直白："注入到 session"），同 inject 多组可聚合（`renderSessionInject` 按 inject 遍历拼接，详情 §0.5b）。

```yaml
name: dev-knowledge
groups:
  - name: 会话背景
    inject: session        # Agent-agnostic：session/turn 语义值
    mode: hybrid
    # v9.1：modules 字段已删除——由 Profile `### Modules` 提供
  - name: 触发索引
    inject: session        # 同 inject：会话背景 + 触发索引均每轮注入 Session Inject（中间层）
  - name: 参考手册
    inject: turn           # Agent-agnostic：session/turn 语义值
```

**字段职责**：
- `name`：Blueprint 名
- `groups[]`：聚合组列表
  - `name`：聚合组名（人类自定义语义名，可任意命名）
  - `target`：Agent 注入位置（`session` / `turn`，由 AgentAdapter 映射到 Agent API）
  - `mode`：聚合方式（byDomain / byType / hybrid，仅 session 类 target 有意义）
  - `modules`：**v9.1 已删除**——改由 Profile H2 下的 `### Modules` 段提供（详见 .pt/docs/designs/pt-modules-ownership.md）

**Blueprint 只管结构**：不含具体 Domain、不含 modules（Profile 持有）、不含 Trigger（Trigger 在 Domain 内作 H2 段）。

> **可选跟进**：`target` 未来可下沉到 AgentContext IR 自带 target 标注（自包含 target 信息，AgentAdapter 不必再查 Blueprint）——见末尾"可选跟进"。

#### Domains：异构领域知识原料

**Domain 承载异构领域知识**。一个 Domain = 一个 md 文件，内部用 **H2 二级标题**划分内容模块。H2 段名开放——`## Scene`、`## Trigger`、`## Rules`、`## Flows`、`## Checklists`、`## Participant`、未来扩展均可。

**Phase term-P9**：Domain **去 type 字段**——H2 段名是唯一 schema 选择器（一个 H2 段一个 schema）。删 type 一身二任（知识性质标签 + schema 选择器）的耦合，stack 死类型随之删除。加新 H2 段名 = 加 parser 一行注册（未注册走 fallback）；加新 schema 类型 = 改对应 H2 段 parser 即可，不动其他 H2 段。

Domain 的 H2 段是**聚合点的供给侧**——Blueprint 的 `modules` 决定哪些 H2 段进哪个聚合组，Domain 只管提供内容。一个 Domain 可同时贡献多个聚合组（如 `## Scene` + `## Participant` 进会话背景、`## Trigger` 进触发索引、`## Flows` 进参考手册），也可只贡献一个。

**关键**：Domain 不感知聚合组。同一个 Domain 被不同 Profile 引用时，可能贡献不同 H2 段——由 Profile 的 Domains 列表 + Blueprint 的 modules 列表共同决定。

**Domain frontmatter**（极简——只剩 name）：

```markdown
---
name: pt-quality
---
```

**五种 H2 段（Domain 内的原料形态）**：

| H2 段 | 内容 | 聚合到哪个聚合组 | 作用 |
|---|---|---|---|
| `## Scene` | 公理/概念/背景（What）——Term[]（含可选 path 字段指向外部数据源） | 会话背景（inject=session） | Agent 每轮看到的背景知识 |
| `## Trigger` | 索引（When）——H3+desc/hint 列表 | 会话背景（inject=session） | 告诉 LLM 何时查哪本手册 |
| `## Participant` | 会话参与者信息（who/goal/how）——Term[]，复用 Scene renderer | 会话背景（inject=session） | Agent 的会话参与者背景（me Domain 专用） |
| `## Rules` | 规则/约束（How-约束）——Rule[] | 参考手册（target=turn） | 触发时注入的规则列表 |
| `## Flows` | 流程模板（How-流程）——FlowTemplate[] | 参考手册（target=turn） | 触发时注入的流程步骤 |
| `## Checklists` | 清单（How-验收）——Checklist[]（name + items[]） | 参考手册（target=turn） | 触发时注入的检查清单 |

**Phase term-P9.2**：原 `## Manual` 段装 4 种不同 schema（Rule/FlowTemplate/Checklist/Term）违背"一个 H2 段一个 schema"原则，拆为 `## Rules` / `## Flows` / `## Checklists` 三个段。`## Participant` 是 `## Scene` 的语义化别名（复用 Scene renderer）——me Domain 专用。

**Phase term-P9.1**：workflow Domain 的 `## Scene` 段原本装 `{ externals: ExternalRef[] }`，合并进 `Term[]` + 可选 `path?` 字段——渲染时带 path 输出 `- name: path — desc`，无 path 输出 `- name: desc`，与原输出一致。统一了 term/workflow Scene 渲染逻辑。

> **可选跟进**：`target` 自描述 + 产物命名（`pt-dev.session-prompt.md` / `pt-dev.turn-message.md` 分文件缓存）——见末尾"可选跟进"。

---

### 0.4 派生链总图（Context→Domain 倒推 + 数据流）

```
┌─ 配置期：人写资产（进 git）───────────────────────────────────┐
│                                                              │
│  Blueprint（聚合组结构）─┐                                    │
│         可跨项目复用       ├──→ Profile ──┐                   │
│  Domain[]（知识原料）─────┘    项目级       │                   │
│         可跨项目复用         （选结构+选原料）│                   │
└────────────────────────────────────────────│──────────────────┘
                                             ↓
┌─ 编译期：Pt 编译（session_start 或切换 Profile）─────────────┐
│                                                              │
│                                    Profile ──[compile]──→ AgentContext
│                                                              │物理文件
│                                                              │.pt/cache/
│                                                              │agent-contexts/
│                                                    hash 缓存 ↓
└──────────────────────────────────────────────────────────────┘
                                             ↓ Pt 读取 AgentContext
┌─ 注入期：AgentAdapter 注入 Agent ────────────────────────────┐
│                                                              │
│  AgentContext.会话背景 ──→ target=session                     │
│    （Scene + Trigger + Participant）  → 每轮注入 Session Inject │
│                                                              │
│  AgentContext.参考手册 ──→ target=turn                        │
│    （Rules/Flows/Checklists）  → 待命，/manual:xxx 触发时注入  │
│                                                              │
└──────────────────────────────────────────────────────────────┘
                                             ↓ 用户 /manual:xxx
┌─ 实例化期（轮次级）─────────────────────────────────────────┐
│                                                              │
│  AgentContext.参考手册 + 参数 ──→ Turn Inject ──→ input 事件│
│  （renderTurnInject 展开模板 / Rule 聚合，产出手册实例）     │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

**方向说明**：
- **理解 Pt（对外叙事）**：自顶向下倒推——AgentContext（要什么）→ Profile（怎么配）→ Blueprint/Domain（原料和结构）。本节就是这个方向。
- **数据流（代码运行）**：自底向上正向——Domain/Blueprint → Profile → compile → AgentContext → 注入。§0.7 完整数据流按此方向描述。
- 两方向不矛盾：理解时倒推（产物优先），运行时正向（原料先行）。

### 0.4a 四层 Schema 全景（每层怎么承载结构）

派生链里每层都有自己的"Schema 承载"——定义该层怎么解析/聚合/分发内容。理解这四个 Schema 的分工，就理解了 Pt 编译架构的核心。

#### 四个 Schema 的职责

| Schema | 谁定义 | 定义什么 | 承载形式 | 代码位置 |
|---|---|---|---|---|
| **Domain Schema** | Pt 代码（parse 注册表） | H2 段文本怎么解析成 IR | `getDomainSectionParser(h2Name)` 注册表（Phase term-P9.3 删 type 维度），未注册走 fallback（Term[]） | `src/parse/domain.ts` + `domain-renderers.ts` |
| **Blueprint Schema** | 资产（Blueprint YAML，使用者写） | 聚合组结构 + Modules 聚合点 + target | `groups[].modules` + `groups[].target`（Phase term-P4.5 载体转 YAML） | `.pt/assets/blueprints/*.blueprint.yaml` |
| **Profile Schema** | 资产（Profile MD + frontmatter） | 业务端实例（选 Blueprint + 选 Domains） | YAML frontmatter + H2 聚合组追加 | `.pt/assets/profiles/*.profile.md` |
| **AgentContext Schema** | Pt 代码（compile 注册表） | Domain IR 怎么聚合成 AgentContext | `moduleRenderers[modName]` 注册表（Phase term-P9.2 拆 Manual→Rules/Flows/Checklists），未注册走 generic fallback（name+desc） | `src/compile/agent-context.ts` |

**关键**：Blueprint Schema 和 Profile Schema 是资产层定义的（使用者写），Domain Schema 和 AgentContext Schema 是代码层定义的（Pt 核心）。使用者能定义聚合组结构 + Modules 列表，但 Domain/AgentContext Schema 是 Pt 预定义的——generic fallback 是开放口（加新 H2 段名不注册也能走 name+desc 通用形态）。

#### 三段式编译流程（每层做什么）

```
Profile（选哪些 Domain）+ Blueprint（聚合组结构 + Modules 聚合点 + target）
    ↓
┌─ parse 层（前端）：MD 资产 → IR ──────────────────────────────┐
│  按 Domain Schema（parse 注册表）把 Domain MD 解析成 Domain IR  │
│  每个 H2 段调 getDomainSectionParser(h2Name)：                 │
│    注册的：Scene/Trigger/Participant/Rules/Flows/Checklists      │
│    未注册：fallbackTerms（Term[] 通用形态）                     │
│  产出：Domain IR { name, modules: Record<H2段名, IR> }          │
│  Phase term-P9.3：Domain 不再有 type 字段（删了）               │
└────────────────────────────────────────────────────────────────┘
    ↓ Domain IR + Blueprint IR + Profile IR
┌─ compile 层（中端）：IR → AgentContext IR ────────────────────┐
│  按 Blueprint Schema（聚合组 × Modules）+ AgentContext Schema   │
│  （moduleRenderers 注册表）聚合 Domain IR：                     │
│                                                                │
│  compileAgentContext(profile, blueprint, domains):              │
│    1. 建 domainByName 索引                                     │
│    2. 遍历 blueprint.groups：                         │
│       a. 找 profile 同名 ProfileGroup                │
│       b. resolveDomains：全局 domains + 聚合组追加 → 合并去重   │
│          → 按 ipConfig.modules 过滤（Domain 有该 H2 段才贡献）  │
│       c. dispatchGroup：遍历 ipConfig.modules，        │
│          renderer = moduleRenderers[modName] ?? generic fallback│
│          遍历 refDomains：content = d.modules[modName]          │
│          renderer(d, content) → markdown 字符串                │
│          拼接所有 Domain 的该段渲染结果                          │
│          modules[聚合组名] = 拼接结果                           │
│    3. sourceHash = hash(profile + blueprint + domains)         │
│  产出：AgentContext IR { name, blueprint, sourceHash, modules } │
└────────────────────────────────────────────────────────────────┘
    ↓ AgentContext IR
┌─ render 层（后端）：IR → 物理文件 ─────────────────────────────┐
│  按 Blueprint Schema 的 target 映射：                          │
│    saveAgentContext(cwd, ctx) → .pt/cache/agent-contexts/      │
│    <name>.agent-context.md（含 YAML 头：source-hash/profile/   │
│    blueprint）                                                  │
│                                                                │
│  按 H2 段切分（## 会话背景 / ## 触发索引 / ## 参考手册）→ 注入时用              │
│  Phase term-P1：文件后缀 .context.md → .agent-context.md         │
│  Phase term-P4.2：cacheDir 改用 CACHE_DIR 常量（无 compilation）│
└────────────────────────────────────────────────────────────────┘
    ↓ Pt 读取 .agent-context.md
┌─ 注入层（AgentAdapter）：物理文件 → Agent ─────────────────────┐
│  target=session → renderSessionInject → before_agent_start     │
│  target=turn → renderTurnInject → input 事件 transform          │
│  Phase term-P4.3：函数名 renderSystemPrompt→renderSessionInject│
│                          renderContextMessage→renderTurnInject│
│  PiAdapter 内部把 session→system_prompt / turn→context_message │
│  （AgentAdapter 映射边界）                                    │
└────────────────────────────────────────────────────────────────┘
```

#### 模块级 Domain 引用（核心扩展点）

Profile 按聚合组分别列 Domain（`### Domains`），一个 Domain 的不同 H2 段可贡献不同聚合组。v9 改 Phase term-P9 后 H2 段是 schema 选择器——同一 Domain 在不同 Blueprint 下可贡献不同 H2 段（被 `modules` 列表过滤）。

**term-Domain 的 Manual Rule[] 不再是死代码**——拆段后 term-Domain 用 `## Rules` 段承载 Rule[] schema，贡献到参考手册聚合组（target=turn），通过 `/manual:<domain>` 触发时按 Rule checklist 渲染输出。

#### 三段式架构的依赖反转

Pt 核心的 Schema/Adapter 边界：
- **Pt 核心** 定义 `Domain` / `Blueprint` / `Profile` / `AgentContext` / `AgentAdapter` / `SourceAdapter` 接口
- **SourceAdapter**（mdAdapter）实现 `load(cwd, name) → SchemaBundle`，从 MD 资产 → Domain IR
- **AgentAdapter**（PiAdapter）实现 `setAgentContext / registerInject`，把 AgentContext 注入到 Pi
- 加新知识源（YAML/DB）= 加 SourceAdapter；加新 Agent（Codex/OpenCode）= 加 AgentAdapter
- 核心不感知来源格式，不感知 Agent API

### 0.5 聚合点数据驱动（modName 注册表 + generic fallback）

> 本节描述 compile 内部的聚合模块分发机制。Agent 注入适配机制见 §0.11。

**核心扩展机制**：`modules` 是聚合标题列表，compile 按 modName 驱动分发，未注册 modName 用 generic fallback 自动聚合。

#### 机制

```
Blueprint.会话背景.modules = [Scene, Trigger, Participant]
Blueprint.参考手册.modules = [Rules, Flows, Checklists]

compile 遍历聚合组的 modules 列表:
  for modName in ipConfig.modules:
    for d in refDomains:
      content = d.modules[modName]      // Domain 的 H2 段内容
      if content === undefined: continue  // Domain 无该段则跳过
      renderer = moduleRenderers[modName] ?? renderGenericModule
      parts.push(renderer(d, content))
```

- `moduleRenderers`：注册表，`Record<modName, ModuleRenderer>`
- 已注册 modName（Scene/Trigger/Participant/Rules/Flows/Checklists）：用特化 renderer
- 未注册 modName（如未来加 `Glossary`）：用 generic fallback（原样输出 `### H3标题` + 列表项）

#### 为什么数据驱动

v8 的 renderer 按 **type 分发**（`domainSceneRenderers[type]`），内部 `if (modName === "Scene")` 硬编码——加新 modName 要改 renderer 代码。v9 改为按 **modName 分发**，renderer 内部按 H2 段 schema 直接取内容：

```
v8: domainSceneRenderers[type] → renderer 内 if(modName===Scene) if(modName===Manual)
    加 Trigger: 要改所有 renderer 加 if(modName===Trigger)  ← 违背"不改代码"

v9: moduleRenderers[modName] → renderer 内按 H2 段 schema 取内容（不再依赖 type switch）
    Phase term-P9.3：type 字段已删——H2 段名是唯一 schema 选择器
    加 Trigger: 注册 moduleRenderers["Trigger"] = renderTriggerModule  ← 一行注册
    加未注册 modName: 不用注册, generic fallback 自动聚合  ← 零改动
```

**加新聚合标题（H2 段类型）**：Domain 加 `## NewSection` 段 + Blueprint modules 加 `- NewSection` 项 → generic fallback 自动聚合，不改代码。要特化才 `registerModuleRenderer("NewSection", fn)`。

#### renderer 注册表（Phase term-P9 后状态）

```typescript
type ModuleRenderer = (d: Domain, content: unknown, mode?: string) => string;

const moduleRenderers: Record<string, ModuleRenderer> = {
  Scene: renderSceneModule,         // Term[] 渲染（path/fields/note 统一处理）
  Trigger: renderTriggerModule,     // 索引聚合（H3 + desc/hint 列表）
  Participant: renderSceneModule,   // 复用 Scene renderer（Term[] 同构，Phase term-P8）
  Rules: renderRulesModule,         // Rule[] checklist（Phase term-P9.2 从 Manual 拆出）
  Flows: renderFlowsModule,         // FlowTemplate[] 列表（Phase term-P9.2 从 Manual 拆出）
  Checklists: renderChecklistsModule, // Checklist[] name+items 列表（Phase term-P9.2 新增）
};

function renderGenericModule(d: Domain, content: unknown): string {
  // 原样输出 ### H3标题 + 列表项，不解析内容格式
}
```

### 0.5a Blueprint 字段命名：target → inject（Phase term-naming）

Blueprint 聚合组字段 `target` → `inject`：
- `target: session` 读作"目标是 session"——抽象，要理解"什么的目标"
- `inject: session` 读作"注入到 session"——直接表达动作意图

YAML 字段用动词常见（`extends`/`requires`），`inject` 不违和。语义上 `inject` 比 `target` 更清楚传达"这组聚合内容注入到哪"。代码改动范围：`schema.ts` / `parse/blueprint.ts` / `render/session-prompt.ts` / `render/turn-message.ts` / `agent/pi-adapter.ts` / 所有 Blueprint 资产 / 所有测试 fixture。机械替换为主。

### 0.5b 同 inject 多组聚合 + Trigger 中间层（Phase term-naming）

#### 隐性触发机制（设计特性）

会话背景与会话参考手册两个聚合组之间有语义依赖，但 Pt 不结构化建模这个依赖：
- 会话参考手册是"按需注入"——但"按什么需"？
- 触发逻辑在会话背景里——具体在 Trigger 段（"有什么手册、何时查"的索引）
- LLM 看会话背景里的 Trigger 索引，判断"需要查某手册"→ 触发 Turn 注入

但会话背景→参考手册的触发关系是隐性的：-Pt 不强制会话背景必须有 Trigger 段，不校验 Trigger 索引是否对应参考手册里的手册，不建模"这个 Trigger 引用那个手册"的显式链接。完全靠 Domain 作者在 Trigger 段里写清楚索引——作者责任，不是 Pt 结构保证。

#### Trigger 拉出作中间层

为让隐性的桥接角色可见，默认 Blueprint 把 Trigger 拉出来作独立 group（仍 inject: session），三层概念模型：

```
会话背景（inject=session）  — 身份 + 主题（Scene, Participant）
    ↓ 指向
触发索引（inject=session）  — 有什么手册、何时查（Trigger，独立 group）
    ↓ 触发
参考手册（inject=turn）     — 执行指导（Rules, Flows, Checklists）
```

三层概念，两个聚合组（会话背景 + 触发索引 同 inject=session；参考手册 inject=turn）。触发索引仍每轮注入 Session Inject（LLM 要看到索引才知道何时查手册），但它概念上是"中间层"——桥接背景和手册。

#### 同 inject 多组：代码原生支持

`renderSessionInject` 按 inject 遍历拼接（不是按 name 分发）：
```ts
for (const ip of blueprint.groups) {
  if (ip.inject === "session") {
    const content = ctx.modules[ip.name];
    if (content) parts.push(content);
  }
}
return parts.join("\n\n");
```

两个 `inject: session` 的组（会话背景 + 触发索引）会被聚合成一个 Session Inject。拼按 Blueprint YAML 里的聚合组声明顺序。无需代码改动。

#### 默认 Blueprint 组织 vs Pt 结构强制

和"name 是用户自定义"一致——三层是 Pt 默认 Blueprint（`dev-knowledge.blueprint.yaml`）的推荐组织，用户可以改（把 Trigger 并回会话背景，或拆得更细）。Pt Session 只定义注入位置（session/turn），不强制必须分三层。

### 0.6 Profile Domains 分发机制

Profile 的 Domains 列表有两层：YAML 全局 + 聚合组追加。compile 自动分发。

> **v9.1 变更**（modules-to-profile 迁移）：过滤白名单从 Blueprint.modules 改为 ProfileGroup.modules（H2 段下 `### Modules` 段）。`resolveDomains` 读 `profileGroup.modules`，`dispatchGroup` 遍历 `profileGroup.modules`。Blueprint.modules 已删除——见 .pt/docs/designs/pt-modules-ownership.md。

#### 分发规则

某聚合组的最终 Domain 集 = (全局 domains ∩ 该聚合组有匹配 H2 段) ∪ (该聚合组 ### Domains 追加)

```
Profile pt:
  YAML domains: [pt-concepts, pt-architecture, me, pt-transpile]   ← 全局基集
  ## 会话背景 ### Modules: [Scene, Trigger, Participant]            ← v9.1：Profile 填本插槽 modules
  ## 会话背景 ### Domains: [pt-quality, pt-collab]                  ← 会话背景追加
  ## 参考手册 ### Modules: [Rules, Flows, Checklists]
  ## 参考手册 ### Domains: [pt-quality, pt-collab]                  ← 参考手册追加

Blueprint dev-knowledge:
  ## 会话背景  inject: session, mode: hybrid
  ## 参考手册  inject: turn

分发结果:
  会话背景（inject=session）的 Domain 集:
    pt-concepts    (全局, 有 ## Scene → 贡献 Scene)
    pt-architecture(全局, 有 ## Scene → 贡献 Scene)
    me             (全局, 有 ## Participant → 贡献 Participant)
    pt-transpile   (全局, 有 ## Scene → 贡献 Scene; 无 ## Trigger → 跳过)
    pt-quality     (追加, 有 ## Trigger → 贡献 Trigger; 无 ## Scene → 跳过 Scene)
    pt-collab      (追加, 有 ## Trigger → 贡献 Trigger)

  参考手册（inject=turn）的 Domain 集:
    pt-concepts    (全局, 无 ## Rules/Flows/Checklists → 跳过)
    pt-architecture(全局, 有 ## Rules → 贡献 Rules)
    me             (全局, 无 ## Rules/Flows/Checklists → 跳过)
    pt-transpile   (全局, 有 ## Flows → 贡献 Flows)
    pt-quality     (追加, 有 ## Rules → 贡献 Rules)
    pt-collab      (追加, 有 ## Checklists → 贡献 Checklists)
```

**规则**：Domain 有该聚合组 modules 列出的 H2 段 → 贡献；没有 → 跳过。全局 domains 自动判断，聚合组追加也自动判断。**Domains 写一次（全局），需要精确控制时用追加**。

**modules 来源**：v9.1 前 Blueprint.modules 是过滤白名单；v9.1 起 Profile H2 下的 `### Modules` 段是过滤白名单（Profile 持有角色身份 / 段类型选择权）。

#### 为什么不全用聚合组分别列（v8 方式）

v8 按聚合组分别列 Domain，显式但重复——同一个 Domain 在多个聚合组出现时要写多次。v9 的全局 + 追加：常用 Domain 写一次全局自动分发，需要精确控制时用追加。灵活性 + 简洁性兼顾。

#### 为什么不全用 YAML 全局（不允聚合组追加）

纯 YAML 全局虽然写一次最简，但不够灵活——无法说"pt-quality 只贡献会话背景的 Scene + 触发索引的 Trigger + 参考手册的 Rules，不自动分发到其他聚合组"。聚合组追加允许精确控制，换取灵活性。

### 0.7 完整数据流

```
┌─ 编译期（session_start 或 /pt-profile 切换时）────────────────┐
│                                                                │
│  Blueprint（聚合组结构）─┐                                      │
│                          ├──→ Profile ──[compile]──→ AgentContext│
│  Domain[] ──────────────┘    （引用 Blueprint +                 │
│                               选 Domains）     （.pt/cache/      │
│                                                  agent-contexts/│
│                                                       <name>.    │
│                                                  agent-context.md)
│                                                          ↓      │
│                                                     sourceHash  │
└────────────────────────────────────────────────────────────────┘
                           ↓ Pt 读取 AgentContext 文件
┌─ 注入期 ──────────────────────────────────────────────────────┐
│                                                                │
│  AgentContext.## 会话背景 ──→ inject=session                    │
│     （含 Scene + Trigger + Participant）                       │
│                          → renderSessionInject → 注入 Session   │
│                            Prompt（每轮 before_agent_start）    │
│  AgentContext.## 参考手册 ──→ target=turn                       │
│     （含 Rules + Flows + Checklists）                           │
│                          → 待命（用户 /manual:xxx 触发）         │
│                                                                │
└────────────────────────────────────────────────────────────────┘
                           ↓ 用户 `/manual:xxx` 或 LLM 判断需要
┌─ 实例化期（轮次级）───────────────────────────────────────────┐
│                                                                │
│  AgentContext.## 参考手册 + 参数 ──→ Turn Inject ──→ input 事件│
│  （renderTurnInject 展开模板 / Rule 聚合，产出手册实例）       │
│                                                                │
└──────────────────────────────────────────────────────────────┘
```

### 0.8 缓存与失效

AgentContext 是物理文件，缓存复用。**失效策略：hash(Domains + Blueprint + Profile) 组合哈希**——三者任一变化即失效重编译。

```
AgentContext 文件头记录源 hash：
  source-hash: <Domains 内容哈希 + Blueprint 内容哈希 + Profile 内容哈希>

Pt 读取 AgentContext 时：
  1. 重算当前源的 hash
  2. 与文件头 hash 比对
  3. 一致 → 直接用缓存
  4. 不一致 → 重新编译，覆盖文件
```

#### 缓存策略（Phase term-P4.2 后硬编码）

| 项 | 值 | 位置 |
|---|---|---|
| 缓存目录 | `.pt/cache/agent-contexts/`（硬编码） | `src/constants.ts CACHE_DIR` |
| 文件后缀 | `.agent-context.md` | `src/render/cache.ts` |
| 拆分策略 | single-file（by-injection-point 已 YAGNI 移除） | 硬编码 |

**Phase term-P4.2**：Blueprint `## Compilation` 段移除——cacheDir 用 `CACHE_DIR` 常量（无 frontmatter 配置），split 硬编码 single-file（唯一选项）。**删了"按聚合组拆分"分支**——`by-injection-point` 是 v9 预留，v10+ 未实现，YAGNI 移除。

### 0.9 术语速查（倒推顺序）

| 术语 | v9 定义（最终状态） |
|---|---|
| **AgentContext** | 编译后 Agent 上下文，产物层文件。按聚合组聚合多 Domain 内容，三面：会话背景（inject=session，静态）+ 触发索引（inject=session，独立 group）+ 参考手册（inject=turn，动态）。缓存复用 |
| **会话背景** | AgentContext 的一面，inject=session，每轮注入 Session Inject。含 Scene + Participant 段聚合 |
| **触发索引** | AgentContext 的一面，inject=session，每轮注入 Session Inject。含 Trigger 段聚合（桥接会话背景 → 参考手册的索引） |
| **参考手册** | AgentContext 的一面，inject=turn，按需触发注入 Turn Inject。含 Rules + Flows + Checklists 段聚合 |
| **Session Inject** | AgentContext 会话背景面注入 before_agent_start 的产物（Pi 的 system_prompt 事件） |
| **Turn Inject** | AgentContext 参考手册面注入 input 事件的产物（Pi 的 input 事件 transform） |
| **Profile** | 配置层，业务端实例。引用 Blueprint + 选 Domains（全局 + 聚合组追加），编译出 AgentContext。项目级 |
| **Blueprint** | 结构层，Agent 端聚合组结构。H2=聚合组（人类自定义名），target 映射 Agent 注入位置，Modules 聚合点。载体 YAML（`.blueprint.yaml`）。跨项目复用 |
| **聚合组** | Blueprint 的 H2（人类自定义语义名），由 target 字段映射到 AgentAdapter 技术聚合组 |
| **target** | Blueprint 聚合组字段，映射语义名到 Agent 注入位置。值：`session`（会话级）/ `turn`（轮次级）。AgentAdapter 内部映射到 Agent API（Pi: `system_prompt`/`context_message`） |
| **Domain** | 内容层，异构领域知识。H2 段开放（Scene/Trigger/Rules/Flows/Checklists/Participant/扩展）。**Phase term-P9.3 删 type 字段**——H2 段名是唯一 schema 选择器。跨项目复用 |
| **H2 段** | Domain 内的内容模块，聚合点的供给侧。H2 段名 = 唯一 schema 选择器（一个 H2 段一个 schema） |
| **Scene** | Domain H2 段，公理/概念/背景（What）——Term[]（含可选 path 字段），target=session 聚合 |
| **Trigger** | Domain H2 段，索引（When）——H3+desc/hint 列表，target=session 聚合 |
| **Participant** | Domain H2 段，会话参与者信息（who/goal/how）——Term[]，target=session 聚合（me Domain 专用，复用 Scene renderer） |
| **Rules** | Domain H2 段，规则/约束（How-约束）——Rule[]，target=turn 聚合 |
| **Flows** | Domain H2 段，流程模板（How-流程）——FlowTemplate[]，target=turn 聚合 |
| **Checklists** | Domain H2 段，清单（How-验收）——Checklist[]（name + items[]），target=turn 聚合 |
| **聚合模块** | Blueprint 聚合组下 `modules` 列表项，指向参与本聚合组的 Domain H2 段名 |
| **全局 domains** | Profile YAML 的 domains 列表，自动分发到所有聚合组 |
| **聚合组追加** | Profile 聚合组 H2 下 `### Domains` 列表，只给该聚合组贡献 |
| **sourceHash** | AgentContext 缓存失效依据，hash(Profile + Blueprint + Domains) |
| **AgentAdapter** | 适配不同 Agent 的注入机制（PiAdapter / 未来 OpenCodeAdapter），Pt 核心调接口不感知 Agent API。Blueprint `target` 字段通过 Adapter 映射到 Agent API（Pi: `system_prompt`/`context_message`） |
| **SourceAdapter** | 适配不同知识源格式（mdAdapter / 未来 yamlAdapter），Pt 核心不感知来源格式 |
| **Channel** | （预留）Domain 连接外部知识源的 Connector，未来实现 |

**已删术语**：`Context`（旧 IR interface 名，改 AgentContext）/ `stack`（死类型，P9.3 删）/ `## Manual`（拆为 Rules/Flows/Checklists）/ `type`（P9.3 删）/ `agent`（Blueprint 字段，P4.1 移除）/ `## Compilation`（P4.2 移除）。

### 0.10 v8 → v9 变更说明

v9 保留 v8 的核心（异构上下文编译器定位、H2=聚合组、AgentContext 缓存），重新分配层职责 + 新增 Trigger 索引机制 + AgentAdapter 抽象 + 拆 Manual 段 + 删 Type 字段。以下是具体变化：

#### 变化 1：职责重分配（Channel → Blueprint，Blueprint → Profile）

| 维度 | v8 | v9 |
|---|---|---|
| 结构层（Agent 端） | Channel（H2=聚合组, target, Modules） | **Blueprint**（吸收 v8 Channel 的 target/Modules + v8 Blueprint 的 Compilation） |
| 配置层（业务端） | Blueprint（选 Domain + Trigger/Boundaries + Compilation） | **Profile**（引用 Blueprint + 选 Domains） |
| 预留层 | — | **Channel**（保留为未来 Domain 连接外部知识源的通道） |

**根因**：v8 把 Agent 端结构（target/Modules）放 Channel，把业务端实例（选 Domain + Trigger）放 Blueprint，但 Compilation 也是 Agent 端的——职责混淆。v9 按"Agent 端 vs 业务端"清晰分：Blueprint 是 Agent 端设计（可跨项目复用），Profile 是业务端实例（项目级）。

#### 变化 2：Trigger 段移到 Domain

| 维度 | v8 | v9 |
|---|---|---|
| 位置 | Blueprint 聚合组下的 `### Trigger`（实例级文本） | **Domain 的 H2 段** `## Trigger`（索引，聚合到触发索引（Trigger 已从会话背景拆出独立 group）） |
| 语义 | "这个聚合组何时激活" | "什么时候该参考本 Domain 的手册" |
| 作用 | 塞进 Scene 模块 | 聚合成索引段，LLM 每轮看到"有什么手册可查" |

**根因**：v8 Trigger 是实例级（每个 Profile 不同），但"何时参考 pt-quality"是 pt-quality 自身的属性，不该每个 Profile 重写。移到 Domain 内，跟手册内容紧邻维护。

#### 变化 3：Boundaries 丢弃

| 维度 | v8 | v9 |
|---|---|---|
| 机制 | Blueprint 聚合组下的 `### Boundaries`（流程节点 DAG） | **丢弃** |
| 替代 | — | Trigger 索引（LLM 知道何时查手册）+ Scene axioms（概念引导） |

**根因**：Boundaries 的本质是"引导 LLM 按步骤做"，但 Trigger 索引已让 LLM 知道"有什么手册可查 + 何时查"，加上 Scene axioms 的概念引导，足够。流程步骤（如 identify-task → cite-stack → execute）可拆进 Domain 的 Scene 段作为 axioms 描述，不需要独立 DAG 结构。MVP 最简。

#### 变化 4：聚合点数据驱动（modName 注册表 + generic fallback）

| 维度 | v8 | v9 |
|---|---|---|
| renderer 分发 | 按 type 分发（`domainSceneRenderers[type]`） | 按 modName 分发（`moduleRenderers[modName]`） |
| 加新聚合标题 | 改 renderer 代码（加 `if(modName===...)` 分支） | 不改代码（generic fallback 自动聚合）/ 一行注册 |
| 内部特化 | renderer 内 modName 硬编码 | renderer 内 H2 段 schema 直接取内容（不再依赖 type switch） |

**根因**：v8 renderer 按 type 分发，内部 modName 硬编码——加 Trigger 聚合标题要改所有 renderer。v9 改为 modName 驱动 + generic fallback，加新聚合标题零改动。

#### 变化 5：Profile Domains 自动分发（全局 + 聚合组追加）

| 维度 | v8 | v9 |
|---|---|---|
| Domain 引用 | Blueprint 每个聚合组下 `### Domains` 分别列（显式但重复） | Profile YAML 全局 `domains` + 聚合组 `### Domains` 追加 |
| 重复 | 同一 Domain 多聚合组出现要写多次 | 全局写一次，自动分发 |
| 精确控制 | 天然支持（每聚合组分别列） | 聚合组追加（只给该聚合组贡献） |

**根因**：v8 方式显式但重复；v9 全局 + 追加兼顾简洁与灵活。

#### 变化 6："对话记忆" → "参考手册"改名

| 维度 | v8 | v9 |
|---|---|---|
| 聚合组名 | 对话记忆 | 参考手册 |
| 语义 | 偏"记忆对话" | 准确——是给 LLM 参考的手册，按需查 |

#### 变化 7：新增 me Domain 概念

| 维度 | v8 | v9 |
|---|---|---|
| 会话背景内容 | 只有系统知识（Pt 是什么） | 系统知识 + 用户知识（me Domain：我是谁、目标、偏好，参与会话背景 Participant 段） |

**根因**：LLM 作为共同设计者需要理解用户意图，缺少"我"视角导致每次要花很多轮解释。

#### 变化 8：聚合组名人类自定义（不写死）

| 维度 | v8 | v9 |
|---|---|---|
| 聚合组名 | 代码硬编码 `会话背景\|对话记忆`（parse 判断文件类型） | Blueprint H2 人类自定义，不由代码写死 |
| target 值 | 代码硬编码 `"system_prompt"\|"context_message"` 判断 | AgentAdapter 解释 inject，Pt 核心不硬编码（Phase term-naming：target → inject） |
| 文件类型判断 | 用聚合组名正则匹配 | 用 frontmatter 字段（`type`/`agent`/`blueprint`） |
| 自定义聚合组名 | 不支持（必须叫会话背景/对话记忆） | 支持（会话背景/触发索引/参考手册/背景知识/操作手册/...均可） |

**根因**：v8 把聚合组名当代码标识符用，违背"资产层用语义名、代码层用技术名"原则。v9 彻底数据驱动——聚合组名是 Blueprint 的 H2（人类定义），target 是 AgentAdapter 的技术聚合组名（Agent 解释）。

#### 变化 9：AgentAdapter 抽象（Blueprint 声明 Agent）

| 维度 | v8 | v9 |
|---|---|---|
| Agent 绑定 | 硬编码 Pi（`pi.on("before_agent_start")` 直接调） | Blueprint `agent` 字段声明，AgentAdapter 解释 |
| 注入逻辑 | index.ts 直接调 Pi API | PiAdapter 封装 Pi API，Pt 核心调 Adapter 接口 |
| 加新 Agent | 改 index.ts（重写注入逻辑） | 加新 AgentAdapter（不改 compile/render 核心） |

**根因**：v8 直接调 Pi API，跟 Pi 强耦合。v9 抽出 AgentAdapter 接口——Pt 核心调 `adapter.inject(ctx, blueprint)`，具体怎么注入由 Adapter 实现。加 Codex/OpenCode 支持只加 Adapter，不改核心。依赖反转，同 SourceAdapter（知识源）同构。

#### 变化 10：Blueprint 载体转 YAML（Phase term-P4.5）

| 维度 | v8/v9 early | v9 final |
|---|---|---|
| 载体 | `.blueprint.md`（MD + H2 段叙事格式） | `.blueprint.yaml`（纯结构化数据，避开 MD 叙事格式） |
| 解析 | `readAsset` 走 frontmatter + H2 切段 | `yaml.load() + 校验` 直接读 YAML |

**根因**：Blueprint 是纯结构化无叙事（target + mode + modules），MD 的 H2/H3 是用叙事格式装非叙事数据。转 YAML 后 parser 简化为 `yaml.load() + 校验`，与 frontmatter 同构。**首次引入运行时依赖**（`yaml` 包）。

#### 变化 11：Blueprint 移除 agent + Compilation 字段（Phase term-P4.1+P4.2）

| 维度 | v8/v9 early | v9 final |
|---|---|---|
| `agent` 字段 | Blueprint YAML `agent: pi` | **删除**——Blueprint Agent-agnostic；当前硬编码 `"pi"`，等第二个 Adapter 后改 `transpile(profile, agent)` |
| `## Compilation` 段 | `cache-dir` + `split` | **删除**——`cacheDir` 用 `CACHE_DIR` 常量（`.pt/cache/agent-contexts/`）；`split` 硬编码 single-file |

**根因**：agent 是运行时选择不是结构定义（§11 实现节奏：当前只 PiAdapter，多选配置是死代码）；Compilation 是 dead config（YAGNI）。

#### 变化 12：target 值 system_prompt/context_message → session/turn（Phase term-P4.3）

| 维度 | v8/v9 early | v9 final |
|---|---|---|
| target 值 | `system_prompt` / `context_message`（Pi API 字符串） | `session` / `turn`（结构层语义值，Agent-agnostic） |
| 概念名 | System Prompt / Context Message | Session Inject / Turn Inject |
| 函数名 | `renderSystemPrompt` / `renderContextMessage` | `renderSessionInject` / `renderTurnInject` |
| 文件名 | `system-prompt.ts` / `context-message.ts` | `session-prompt.ts` / `turn-message.ts` |
| AgentAdapter 边界 | `supportedTargets` 用 Pi API 名 | `supportedTargets = ["system_prompt", "context_message"]` **保留**——这是 Adapter 映射边界，声明 Pi 支持哪些技术聚合组 |

**根因**：target 是结构层术语，Agent-agnostic；AgentAdapter 内部映射到 Agent API。Blueprint 用语义值 `session`/`turn`，Adapter 解释后映射到 Pi 的 `system_prompt`/`context_message`。

#### 变化 13：Domain Type 字段删除（H2 段名是唯一 schema 选择器，Phase term-P9.3）

| 维度 | v8/v9 early | v9 final |
|---|---|---|
| Domain `type` frontmatter | `type: term/workflow/stack/扩展` | **删除**——Type 一身二任（知识性质标签 + schema 选择器）导致耦合 |
| `stack` 类型 | 死类型——renderer 全返空，没意义 | **删除**（Type 删后 stack 一起删） |
| Schema 选择 | H2 段名 × Type 两个维度 | H2 段名是唯一 schema 选择器（一个 H2 段一个 schema） |
| renderer 逻辑 | `switch(d.type)` 内按 H2 段名分支 | `moduleRenderers[modName]` 按 modName 分发，renderer 内按 H2 段 schema 直接取内容 |

**根因**：Type 字段是历史遗留——v6 时期不同内容性质需不同 schema。v9 把 schema 选择权下放给 H2 段名，Type 失去作用。一身二任拆解后：加新 H2 段名 = 加 schema（H2 段名 = schema 选择器）；Type 退化为无用标签删除。

#### 变化 14：Manual 拆段为 Rules/Flows/Checklists（Phase term-P9.2）

| 维度 | v8/v9 early | v9 final |
|---|---|---|
| Domain H2 段 | `## Manual`（一个 H2 段装 4 种不同 schema：Rule/FlowTemplate/Checklist/Term） | 拆为 `## Rules` + `## Flows` + `## Checklists`（各一个 schema） |
| 渲染 | `renderManualModule` 按 type 分流（workflow→FlowTemplate，term→Rule） | 三个独立 renderer（renderRulesModule / renderFlowsModule / renderChecklistsModule）各调对应 type guard |
| pt-collab 的 checklist | 被误解析为 Rule ban 类型（`name: check` 空输出） | 正确解析为 `### name` + `- item` 列表 |

**根因**："一个 H2 段一个 schema"是核心原则——`## Manual` 装 4 种 schema 违背它。拆为 3 段后每段 schema 单一清晰。

#### 变化 15：Scene 段统一为 Term[]（Phase term-P9.1）

| 维度 | v8/v9 early | v9 final |
|---|---|---|
| term Scene | Term[]（`{name, desc}`） | Term[] 不变 |
| workflow Scene | `{ externals: ExternalRef[] }` | 合并进 `Term[]` + 可选 `path?` 字段 |
| 渲染 | 按 `d.type` 分发：term→Term list，workflow→externals list | 统一：term/workflow 合并 case，按 path/desc 字段输出 |
| 守卫 | `isTermArray` + `isWorkflowScene` | 只 `isTermArray`（`isWorkflowScene` 删除） |

**根因**：workflow Scene 的 externals（`{name, path, desc}`）和 Term（`{name, desc, fields?, note?, path?}`）高度相似，强行分 type 没有独立 renderer 可走。统一 Term[] + path 字段后渲染逻辑一致。

#### 变化 16：Context IR 改名 AgentContext（Phase term-P1）

| 维度 | v8/v9 early | v9 final |
|---|---|---|
| Interface 名 | `Context` | **`AgentContext`** |
| 文件后缀 | `.context.md` | **`.agent-context.md`** |
| 目录 | `.pt/cache/contexts/` | **`.pt/cache/agent-contexts/`** |
| 函数名 | `compileContext` / `loadContext` / `saveContext` | `compileAgentContext` / `loadAgentContext` / `saveAgentContext` |
| 文件名 | `compile/context.ts` | `compile/agent-context.ts` |

**根因**：`Context` 与 Pi 的 `context_message` 撞名（target 值 `context_message` → Context Message）——Pt 产物层需独立名字。`AgentContext` 加入 Agent 概念族，语义清晰。

#### 变化 17：/pt-context → /pt-profile 命令改名（Phase term-P2）

| 维度 | v8/v9 early | v9 final |
|---|---|---|
| 启动 flag | `--pt-context` | `--pt-profile`（命令参数是 Profile 名，名该匹配操作目标） |
| 用户命令 | `/pt-context <name>` | `/pt-profile <name>` |
| 向后兼容 | — | 旧 flag/settings key 作 fallback 保留 |

**根因**：命令参数是 Profile 名（不是 Context 名）——名该匹配操作目标。

#### 变化 18：me Domain 拆 ## Participant 段（Phase term-P8）

| 维度 | v8/v9 early | v9 final |
|---|---|---|
| me Domain H2 段 | `## Scene`（user-profile/pt-goal/collab-mode 三个 H3） | `## Participant`（同上三个 H3，H2 段名改） |
| Blueprint 会话背景 modules | `[Scene, Trigger]` | `[Scene, Trigger, Participant]` |
| Renderer | 走 Scene renderer | 复用 Scene renderer（`[MOD_PARTICIPANT]: renderSceneModule` 一行注册，Term[] 同构） |

**根因**：me 的 H3 是会话参与者信息（who/goal/how），不是领域场景元数据——`## Participant` 语义更准确。复用 Scene renderer 是因为 Term[] schema 同构，零代码改动一行注册。

#### 变化 19：modules 归属从 Blueprint 挪到 Profile（Phase modules-to-profile，v9 → v9.1）

| 维度 | v9 | v9.1 |
|---|---|---|
| Blueprint `groups[].modules` | 声明聚合组参与哪些 H2 段 | **删除**——Blueprint 退化为插槽契约（`name` + `inject` + `mode`） |
| Profile H2 段下 `### Modules` | 无 | **新增**——Profile 填本插槽的 modules 列表 |
| `ProfileGroup` schema | `{ name, domains }` | `{ name, domains, modules: string[] }` |
| 聚合组参与 Domain 过滤 | `bpGroup.modules.some(m => d.modules[m])` | `profileGroup.modules.some(m => d.modules[m])` |
| 加新插槽（Blueprint） | 旧 Profile 无 H2 实例化 → 模块越界警告 | 旧 Profile 无 H2 → 产出空段（render 跳过），完全兼容 |
| Profile 越权 H2 | 静默忽略（主循环遍历 Blueprint.groups） | 静默忽略 + 告警（log warn + notify，告警分级见设计文档 §5） |
| Profile 缺填 H2 | 无告警 | log debug only（可能故意） |
| 4 份 blueprint 合一 | 4 份 `dev-knowledge-{arch,design,dev,devops}.blueprint.yaml` | 1 份 `dev-knowledge.blueprint.yaml`（各 profile 引同一份，差异全在 `### Modules`） |
| Blueprint 间复用 | arch / design 除注释外雷同却复刻两份 | 1 份通用 Blueprint + N 份 Profile 填 modules |

**根因**：

1. **modules 混两种语义**：会话背景 `[user-profile, pt-goal, tech-lead, senior-developer, ...]` 是**具名身份模块**（角色选择），触发索引 `[Trigger]` 是**段类型**。`dispatchGroup` 两者渲染机制相同（都是 `d.modules[modName]` 取 H2 段），区别只在 renderer 是否注册。角色身份选择被写进 Blueprint（结构层）→ Profile 想换角色只能换整个 Blueprint→ 4 份 blueprint 各自独立，arch/design 雷同却复刻两份，复用空间被压缩。
2. **角色身份归属应是配置层**：Profile 本就该管"角色身份选择"，但被 Blueprint 抢走。modules 挪回 Profile 后，Blueprint 退化为插槽契约（声明有哪些插槽 + inject + mode），Profile 持角色身份选择权——结构层与配置层职责清晰。
3. **复用空间与 modules 偏向相关**：modules 越偏向"段类型"（Scene / Trigger / Rules）→ 复用空间越大；modules 越偏向"具名角色"（tech-lead / senior-dev）→ 复用空间越小。把具名角色挪到 Profile 后，Blueprint.modules 仅需保留段类型语义，复用空间释放。

**向后兼容性**：
- **加插槽**：Blueprint 加新 group（无旧 Profile H2 实例化）→ 主循环遍历 Blueprint.groups，旧 Profile 无对应 ProfileGroup → `dispatchGroup` 读 `?? []` → 产出空字符串 → `renderSessionInject` 的 `if (content)` 跳过。✅ 旧 Profile 不受影响。
- **Profile 越权**：Profile 独有 H2（Blueprint 未声明）→ 主循环遍历 Blueprint.groups（非 profile.groups），越权 H2 被静默忽略 + log warn + notify。✅ 永远以 Blueprint 为准。
- **Profile 缺填**：Blueprint 有插槽但 Profile 无 H2 或 modules 为空 → `dispatchGroup` 返空，产出空段。✅ "故意缺填"是合法用法（log debug 留痕，不打扰）。

**告警分级**（设计文档 §5）：越权（Profile H2 不在 Blueprint.groups）→ log warn + notify（几乎总是错误）；缺填（Blueprint 有插槽但 Profile 未填）→ log debug only（可能故意）。两处都有 log 留痕。

**代码改动**（封闭性已验证）：
- `src/schema.ts`：`BlueprintGroup` 删 `modules`；`ProfileGroup` 加 `modules: string[]`
- `src/parse/blueprint.ts`：去掉 modules 解析 + 校验（YAML 中 modules 行若有则忽略）
- `src/parse/profile.ts`：每 H2 段调 `extractModulesList(section)` 填 `ProfileGroup.modules`（函数复用 `shared.ts` 的旧 Channel 死代码）
- `src/compile/agent-context.ts`：`resolveDomains` 过滤 + `dispatchGroup` 遍历改读 `profileGroup?.modules ?? []`；加越权 / 缺填告警；加可选 `ctx?: SourceAdapterContext` 参数透传 `log` + `notify`

**封闭性已验证**：
- `bpGroup.modules` 消费点全部集中在 `compile/agent-context.ts`（grep 确认）
- render 层（`session-inject.ts` / `turn-inject.ts`）只读 `group.inject`，不碰 modules
- `pi-adapter.listManuals` 遍历 `blueprint.groups` 按 `group.inject === "turn"` 过滤，内容取自 `d.modules[MOD_FLOWS]` 硬编码常量——不读 `group.modules`

**核心验收**：迁移前后 AgentContext 产物逐字一致（项目侧 4 份 + builtin guide = 全部 baseline diff 为空）。v9.1 是纯职责重分配（modules 从 blueprint 挪到 profile），不改聚合语义。

**外部项目同步**：方案 D 是破坏性 schema 变更，所有使用 Pt 的项目（pt-writing / pt-xxx）资产都需同步迁移——blueprint 删 modules、profile 加 ### Modules。执行流程见 `.pt/docs/designs/pt-modules-to-profile-external-migration-brief.md`。

**首次发现遗漏**：pt-writing 跨项目测试 `tests/verify/phase9.test.ts:322-325` 失败（`segment.length = 0`）——根因是 pt-writing 资产仍是旧格式（blueprint 带 modules + profile 无 ### Modules），代码层方案 D 已正确但未在外部项目资产同步。修复后 pt-writing commit `7270336`，phase9 199/199 通过。

**硬指标差异**：项目侧 Pt 资产适用"产物逐字一致"（baseline diff 全空）；外部项目不适用（旧资产本就未在 v9 编译通路里），改用"段结构对齐"为硬指标（3 段标题 + 内容非空）。

#### 不变的部分

- Pt 定位（异构上下文编译器，核心产物是 AgentContext）
- H2=聚合组显式化（v8 引入，v9 继承）
- Schema/adapter 依赖反转（§6）
- 三段式编译架构（parse/compile/render）
- AgentContext 缓存 hash 失效策略
- render 按 modName 分发（不硬编码模块名）

### 0.11 Agent 适配器（AgentAdapter）

**AgentAdapter 适配不同 Agent 的注入机制**。Blueprint 用 `target` 声明语义名（`session`/`turn`），AgentAdapter 解释 `target` 并映射到该 Agent 的技术 API。Pt 核心调 Adapter 接口，不直接调 Agent API——加新 Agent 只加 Adapter，不改 compile/render 核心。

#### 为什么需要 AgentAdapter

v8 直接调 Pi API（`pi.on("before_agent_start")` + `pi.on("input")`），跟 Pi 强耦合。如果未来要支持 Codex、OpenCode 等 Agent，要重写整个 index.ts 的注入逻辑。v9 抽出 AgentAdapter 接口——依赖反转，同 SourceAdapter（知识源格式）同构。

**`target` 映射边界**：
- Blueprint 用 Agent-agnostic 语义值（`session` / `turn`）
- AgentAdapter `supportedTargets` 声明 Agent 支持的技术聚合组名（**Pi: `system_prompt` / `context_message`**——保留 Pi API 名，因为这是 Adapter 映射边界，声明"Pi 支持哪些技术聚合组"）
- 编译时 `agent-context.ts` 按 modName 分发渲染（Pt 核心不感知 target 具体值）
- 注入时 PiAdapter 内部把 `target=session` 映射到 `pi.on("before_agent_start")`、`target=turn` 映射到 `pi.on("input")` 事件 transform

#### AgentAdapter 接口

```typescript
export interface AgentAdapter {
  /** Agent 名（pi / codex / opencode / ...） */
  name: string;
  /** 该 Agent 支持的技术聚合组 target 名（Pi: system_prompt, context_message）。
   *  Phase term-P4.3：保留 Pi API 名——这是 AgentAdapter 映射边界。Blueprint 用 session/turn，Adapter 内部映射。 */
  supportedTargets: string[];
  /** 设置编译产物（transpile 后调） */
  setAgentContext(ctx: AgentContext, blueprint: Blueprint, domains: Domain[]): void;
  /** 启动时注册：把 AgentContext 注入到 Agent（session_start 调用） */
  registerInject(api: AgentAPI, ctx: AgentContext, blueprint: Blueprint, domains?: Domain[]): void;
  /** 轮次级触发：参考手册注入（input 事件调用，Phase term-P4.3 函数名改） */
  triggerManual?(ctx: AgentContext, blueprint: Blueprint, name: string, args: string): string | null;
  /** 查询可用手册（/pt flows 用） */
  listManuals?(ctx: AgentContext, blueprint: Blueprint, domains: Domain[]): Array<{ name: string; hint?: string; domain: string }>;
}
```

**Phase term-P1 改名**：`setContext` → `setAgentContext`（Context → AgentContext 同步）；`registerInject` 签名第二个参数 `Context` → `AgentContext`。

**Phase term-P4.1**：Blueprint `agent` 字段移除后，`getAgentAdapter(pi, name)` 调用方传字面量 `"pi"`（当前只有 PiAdapter；等 OpenCodeAdapter 后改 `transpile(profile, agent)` 编译维度参数，见 §11）。

#### MVP 策略

当前只实现 **PiAdapter**（封装现有 index.ts 的 Pi 注入逻辑），但接口先定义好：

```typescript
const agentAdapters: Record<string, AgentAdapter> = {
  pi: new PiAdapter(),         // 当前实现
  // 未来: codex: new CodexAdapter(), opencode: new OpenCodeAdapter(), ...
};
```

加 Codex 支持 = 加 `CodexAdapter` 类 + 在注册表加一行，**不改 compile/render/transpile 核心**。Blueprint 改 `target` 映射（session→Codex 的 `system_prompt` 等价物）即可用。

#### AgentAPI 抽象

AgentAdapter 不直接依赖 Pi 的 `ExtensionAPI`——通过 **AgentAPI** 接口隔离（只暴露 Adapter 需要的方法：on 事件、registerCommand、getFlag、ui.notify 等）。这样 CodexAdapter 不会被 Pi API 污染。MVP 阶段 AgentAPI 可以是 Pi ExtensionAPI 的子集类型别名，后续再抽象。

#### 与 SourceAdapter 的对称性

| 适配器 | 适配什么 | 接口 | MVP 实现 | 扩展方式 |
|---|---|---|---|---|
| **SourceAdapter** | 知识源格式（MD/YAML/DB） | `load(cwd, name) → SchemaBundle` | mdAdapter | 加 adapter 类 |
| **AgentAdapter** | Agent 注入机制（Pi/Codex） | `setAgentContext / registerInject / triggerManual` | PiAdapter | 加 adapter 类 |

两者都是依赖反转——Pt 核心定义接口，具体实现可插拔。Pt 的扩展性集中在两套适配器：左边吃异构知识源，右边接异构 Agent。

#### 数据流（含 AgentAdapter）

```
知识源(MD/YAML/DB) ──SourceAdapter──→ Domain IR ─┐
                                                    │
                                    Blueprint ──→ Profile ──[compile]──→ AgentContext
                                        │                               │
                                        ↓                               ↓
                                   AgentAdapter(PiAdapter) ←──────────────┘
                                        ↓
                                   Pi Agent (before_agent_start / input)
```

---

---

## 一、为什么从两层升级到两套三层

> ⚠️ 本章是演进历史，保留作背景。当前语义以 §0 为准。§0 已演进到 v6：Domain 是唯一模块类型（Module 即 Domain），workflow/stack 是 Domain Type 标签；每个 Domain 用 `## Scene` / `## Blueprint` 两个 H2 段分内容；Scene 读 `## Scene` 产 System Prompt，Blueprint 读 `## Blueprint` 产 Manual。

### 1.1 旧两层模型的局限

`pt-asset-layering.md` 早期版本用"描述层 / 结构层"两层。问题：

1. **知识与执行混在一起谈**。描述层既含静态语义，又含动态约束；结构层既含执行骨架，又含动态流程。两个关注点（知识表示 vs 推理执行）没分开。
2. **模块层缺失**。知识按"类型"（公理/定理/规则）分，不是按"业务领域"分。真实业务知识天然按领域分包（注册登录、下单发货），不是按知识类型分包。
3. **动态层定位错**。把动态结构层叫"业务推理"，但 Pt 产出的是 prompt 不是推理——推理是 LLM 做的。

### 1.2 升级方向

拆成两套正交的三层：

- **静态知识库三层**（组织知识）：语义层 / 模块层 / 结构层
- **动态手册三层**（指引推理）：数据语义层 / 流程层 / 结构层

两套命名加前缀区分，避免同名漂移。底层是 AI 经典的**知识库 vs 推理机分离**——静态三层组织知识库，动态三层产出推理机的操作手册。

---

## 二、静态知识库三层

组织"有什么知识、怎么打包、怎么布局"。

### 2.1 三层定义

| 层 | 内容 | 性质 |
|---|---|---|
| 语义层 | 身份数据、业务定义、业务规则（信息原子） | 事实 |
| 模块层 | **业务领域模块**（注册登录、下单发货...），每模块内含自己的公理/定理/规则 | 业务领域边界 |
| 结构层 | 模块编排：按业务模块排序，或按内容类型聚合排序 | 编排策略 |

### 2.2 模块层：业务领域，不是知识类型

模块是**业务领域模块**，不是"公理模块/定理模块"这种知识类型分类。

```
✅ 正确：模块 = 业务领域
  模块「用户注册与登录」
    - 公理：用户有唯一ID
    - 定理：注册后自动登录
    - 规则：密码至少8位
  模块「下单管理与发货」
    - 公理：订单有金额
    - 定理：付款后触发发货
    - 规则：金额>1万需审核

❌ 错误：模块 = 知识类型
  公理模块 / 定理模块 / 规则模块
```

每个业务模块内含自己的公理/定理/规则，知识在领域内聚。

### 2.3 结构层：编排策略可配置

结构层的核心设计抉择：模块排序 vs 内容类型聚合。

**选项 A：byDomain（领域内聚）**

```
### 用户注册与登录
  - 公理：用户有唯一ID
  - 定理：注册后自动登录
  - 规则：密码至少8位

### 下单管理与发货
  - 公理：订单有金额
  - 定理：付款后触发发货
  - 规则：金额>1万需审核
```

领域导向推理："遇到登录问题→查注册登录模块全部知识"。

**选项 B：byType（类型内聚）**

```
### 业务公理
  - 用户有唯一ID（注册登录）
  - 订单有金额（下单发货）

### 业务定理
  - 注册后自动登录（注册登录）
  - 付款后触发发货（下单发货）

### 业务规则
  - 密码至少8位（注册登录）
  - 金额>1万需审核（下单发货）
```

推导导向推理："先看公理→推导定理→套规则"。

**选项 C：hybrid（混合，默认推荐）**

按 **Rule 的 slot 归属** 判定，不是任意混合。

**Rule.slot 的语义契约**（adapter / midend / backend 三方共识）：
- `slot: "global"` — adapter 映射时填的值，表示该 Rule 是全局领域规则（跨步骤/跨模块共享），非步骤专属。Domain 的 Bans/Invariants 默认归此。
- `slot: "<具体 slot 名>"` — 步骤专属规则（如 `slot: "revise"`），由 asset 显式声明，留在对应步骤内。
- adapter 填值，midend 按 mode 解读，backend 按解读结果输出。adapter 不感知 mode（前端/中端分离）。

**hybrid 模式按 slot 归属判定**：
- `slot: "global"` 的 Rule → 进顶部「全局约束」段（跨模块聚合）
- 每个 `DomainModule` → 整体输出（模块内 terms/rules 内聚）
- 全局约束段在前，模块段在后

```
### 全局约束              ← slot:global 的规则聚合（跨模块）
- 密码至少8位
- 标题不含"震惊/惊呆了/必看"

### 模块「用户注册与登录」   ← 整模块内聚输出
- 术语：用户、注册
- 规则（slot:register）：手机号未注册
- 规则（slot:login）：密码校验

### 模块「下单管理与发货」
- 术语：订单、发货
- 规则（slot:order）：金额>1万需审核
```

判定依据明确：全局的归全局，领域的归领域。hybrid 兼顾两种推理路径——跨模块共享约束走聚合，领域专属知识走内聚。

> **Phase 2 实现约定**：Domain 的 Bans/Invariants 在 adapter 映射时填 `slot: "global"`（Phase 1 已填）。hybrid 模式下 midend 把这些 Rule 抽到 `### 全局约束` 段，保留 checklist 格式（`- [ ]`）；步骤描述（如 revise 步"检查字数≥800"）保留在流程段，不再末步内嵌 checklist。这是**语义修正**：全局规则本就属于全局，旧代码"挂末步"是把"在哪校验"和"规则属于谁"混淆了。

**编排策略在 Schema 里声明，不写死**：

```typescript
export interface StructureLayout {
  mode: "byDomain" | "byType" | "hybrid";
  domainOrder?: string[];  // byDomain/hybrid 时的模块顺序
}
```

compiler 读 `layout.mode` 决定拼接顺序。默认 hybrid，业务可覆盖。

### 2.4 模块粒度：一个 Domain = 一个模块

**一个 OXN domain asset 直接映射一个 `DomainModule`**。不在 domain 内部再切分子模块。

如 `writing` domain = 一个模块「写作」；`commerce` domain = 一个模块「电商」。粒度清晰，与 OXN asset 一一对应。

### 2.5 公理与定理：实用定义

不追求语义清晰，能反映业务即可。

- **公理 = 业务语义源**：基础术语、事实。如"客户有信用额度"、"文章是成稿"。
- **定理 = 公理的组合描述或业务具体描述**。如"额度不足则拒绝放款"、"选题决定文章价值"。

关键原则：

1. **写的人决定放哪**。"文章是成稿"当公理还是定理，取决于作者把它放在 Terms 段还是 Rules/推导段，不做强制判定。
2. **描述层是相对静态，不是写完即固定**。基于业务理解、变化会更新。追求"能反映业务"，不追求"公理必须不证自明"。
3. **公理/定理作为 frontmatter 可选标签**（`level: axiom|theorem`），不强制标注。先把分层做对，标签是第二迭代。

---

## 三、动态手册：Blueprint 实例化 Workflow

> ⚠️ 本章是 v4 语义的描述，保留作背景。v6 语义以 §0 为准：FlowTemplate 是 workflow-type Domain 的 `## Blueprint` 段内容，被 Blueprint 实例化成 Manual。本章用“Blueprint/Workflow”旧名对应 v6 的“Blueprint/workflow-Domain”，语义已对齐。

### 3.1 核心关系：Structure 实例化 Module

**动态手册不是和静态知识并列的另一套知识，而是 Blueprint（动态 Structure）把 Workflow（Module）的 business-flow 实例化后的产物。**

概念对应（以 §0 语义为准）：

| 概念 | 角色 | 载体 |
|---|---|---|
| Blueprint | 动态 Structure（编排者） | blueprint asset |
| Workflow | Module（内容提供者，含 FlowTemplate business-flow） | workflow asset |
| 手册实例 | Blueprint 实例化 Workflow 后的产出 | Input Message |

```
Workflow (FlowTemplate 模板)    ──Blueprint 实例化──>  手册实例
  {{客户ID}}                                             客户A
  {{金额}}                                               5000
  步骤模板                                               具体步骤
  ↓                                                      ↓
  在 Scene 里声明“这本手册可用”                          在 Input Message 里注入
  （进 systemPrompt 的手册清单）                          （“这次按这本手册走”）
```

Workflow 里的 FlowTemplate 是**手册模板**；动态手册是模板被参数填充后的**手册实例**。实例化动作 = Blueprint 的 binder 把 FlowTemplate 的 `{{变量}}` 用上下文参数填充。

### 3.2 Pt 产出的是手册，不是推理

**Pt 不产出推理，推理是 LLM 做的。** Pt 产出的是**手册/参照**，指引 LLM：

- 该按什么步骤走
- 每步能从哪拿到数据源
- 最终要推理出怎样的业务描述

Blueprint 产出的 Input Message 是"给 LLM 看的操作手册"，不是推理结果。LLM 依手册走，自己推理。

### 3.3 FlowTemplate 归属 Workflow 模块

FlowTemplate **是 Workflow 模块的内容**，不是 Blueprint 的内部段。Workflow 模块分两层（§0.4）：
- **meta-flow**：给 Scene 用，声明“有这个手册可用 + 引用哪个 Blueprint + 数据去哪读”
- **business-flow**：给 Blueprint 用，即 FlowTemplate 模板（带 `{{}}` 占位符的步骤）

运行时通过两种方式触发 Blueprint 实例化：
- **用户 Prompt Template 机制触发**：`/risk-check 客户A 5000` 显式触发
- **LLM 基于上下文自选**：Scene 在 systemPrompt 里列手册清单（来自 Workflow meta-flow），agent 判断用哪个 Blueprint

### 3.4 FlowTemplate 内部三层（实例化后即动态手册三层）

FlowTemplate 模板内部结构对应动态手册三层：

| 动态手册层 | FlowTemplate 字段 | 含义 |
|---|---|---|
| 数据语义层 | `externals` + `steps[].dataSource` | 数据从哪来、如何组合 |
| 流程层 | `steps` 序列 | 步骤流程 |
| 手册结构层 | 绑定后产出的完整内容 | 参照脚手架 |

### 3.5 风控手册示例

```markdown
## 前提（Intent）
客户 {{客户ID}} 申请下单，订单金额 {{金额}}

## 步骤
1. **取额度** — 读 `./data/credit-limits.xlsx` 查 {{客户ID}} 的信用额度。
2. **取等级** — 读 `./data/customer-tier.xlsx` 查 {{客户ID}} 的客户等级。
3. **校验 R1（额度）** — 条件: 信用额度 >= {{金额}}；否则: 拒绝（额度不足）。
4. **校验 R2（黑名单）** — 条件: 客户等级 = 黑名单；则: 拒绝（触发 ban:放款）。
5. **产出** — 给出"通过/拒绝 + 理由"的业务描述。
```

这是手册模板：告诉 LLM 每步取什么数据、按什么规则判断、最终产出什么。`{{客户ID}}` `{{金额}}` 被参数填充后，成为手册实例进 user message，LLM 依此走，自己完成读数据 + 比对 + 推理。

### 3.6 FlowTemplate 在 Workflow asset 里的声明格式

> ⚠️ 本节描述目标格式（FlowTemplate 归 workflow asset）。Phase 3 当前实现仍把 FlowTemplate 声明在 blueprint.asset 的 `## Templates` 段，是临时方案，Phase 5 重构时迁回 workflow asset。

FlowTemplate **声明在 workflow asset 内**，是 Workflow 模块的 business-flow 内容。一个 workflow asset = 一个 FlowTemplate 模板（文件名即手册名）。

#### 3.6.1 格式定义（Phase 3 MVP）

```markdown
## Templates
### <name>                              # FlowTemplate 触发名（/name）
- argument-hint: <var1> <var2> ...    # 可选，<...> 顺序即变量顺序（fallback）
- intent: <前提文本>                  # 必填，可含 {{var}} 占位符
- vars: [var1, var2, ...]             # 可选，优先于 argument-hint 的变量声明
- step: <步骤描述>                    # 重复多次，每行一个步骤，可含 {{var}}
- step: <步骤描述>
```

#### 3.6.2 字段语义

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` (H3 标题) | ✅ | FlowTemplate 名，对应 `/<name>` 触发。需全局唯一（多个 blueprint 同时加载时不得重名） |
| `argument-hint` | ❌ | 参数提示。Pi 原生 `/cmd` 补全会读取。`<...>` 顺序也是变量顺序 fallback |
| `intent` | ✅ | 手册前提/上下文文本，可含 `{{var}}` 占位符（binder 替换） |
| `vars` | ❌ | 命名变量列表（顺序即位置参数顺序）。与 `argument-hint` 冲突时 `vars` 优先 |
| `step` | ✅×N | 步骤描述，每行一个步骤。重复多次表示多步。MVP 每步仅 `desc`（字符串） |

#### 3.6.3 步骤结构（Phase 3 MVP vs Phase 4+）

- **Phase 3 MVP**：每步仅 `desc`（字符串），含 `{{var}}` 占位符。Schema 中的可选字段（`dataSource`/`rule`/`output`）暂不使用，填 `undefined`。
- **Phase 4+**：引入结构化格式（`- dataSource: ...` `- rule: ...` `- output: ...` 作为 step 的补充字段），用于 L2 数据预绑定、公理/定理标注等场景。

#### 3.6.4 完整示例（风控手册模板）

```markdown
## Templates
### risk-check
- argument-hint: <客户ID> <金额>
- intent: 客户 {{客户ID}} 申请下单，订单金额 {{金额}}
- vars: [客户ID, 金额]
- step: 取额度 — 读 `./data/credit-limits.xlsx` 查 {{客户ID}} 的信用额度
- step: 校验 R1（额度）— 条件: 信用额度 >= {{金额}}；否则: 拒绝（额度不足）
- step: 校验 R2（黑名单）— 条件: 客户等级 = 黑名单；则: 拒绝（触发 ban:放款）
- step: 产出最终结论 — 通过/拒绝 + 理由的业务描述
```

映射后产出 `FlowTemplate`：

```typescript
{
  name: "risk-check",
  argumentHint: "<客户ID> <金额>",
  intent: "客户 {{客户ID}} 申请下单，订单金额 {{金额}}",
  steps: [
    { desc: "取额度 — 读 `./data/credit-limits.xlsx` 查 {{客户ID}} 的信用额度" },
    { desc: "校验 R1（额度）— 条件: 信用额度 >= {{金额}}；否则: 拒绝（额度不足）" },
    { desc: "校验 R2（黑名单）— 条件: 客户等级 = 黑名单；则: 拒绝（触发 ban:放款）" },
    { desc: "产出最终结论 — 通过/拒绝 + 理由的业务描述" },
  ],
  externals: [],
  // vars 是 OXN 内部扩展（adapter 读取并存入闭包/辅助表，不进入 Pt 核心 Schema）
}
```

**vars 字段的处理**：当前 `FlowTemplate` Schema 不含 `vars` 字段。Phase 3 adapter 在 `toFlowTemplate` 里读取 `vars`/`argument-hint` 推导变量顺序，作为 binder metadata 附在 FlowTemplate 对象上（如 `tpl._vars: string[]`）。Pt 核心不感知，binder 模块从该 metadata 取。

#### 3.6.5 OXN Parser 兼容性

格式与 OXN 现有 `- key: value` frontmatter 风格一致，复用 parser 的 H3 解析逻辑：

- `### risk-check` 解析为 Item，`name: "risk-check"`
- 下面每行 `- key: value` 解析为 `item.fields[key]`
- `vars: [a, b]` 解析为 `string[]`（parser 已支持 inline array）
- `step:` 重复行：item.fields 里会出现多个 `step` 键（后写覆盖前写），adapter 需要在 `toFlowTemplate` 里收集体所有 `- step:` 行（从 raw markdown 而非 fields）— **这是对当前 parser 输出的唯一调整**。

具体收集策略：parser 已把每行原始文本存于 `Section.raw`，adapter 在 `toFlowTemplate` 里直接 regex 扫 `### risk-check` 下的 `- step:` 行，避免依赖被 fields 覆盖后的结果。

#### 3.6.6 与 blueprint 其他段的关系

`## Templates` 与 `## Boundaries` 是 blueprint 的两个并列段：
- `## Boundaries` 定义静态知识库的**流程节点**（slot DAG，进 systemPrompt）
- `## Templates` 定义动态手册的**模板清单**（FlowTemplate，进 systemPrompt 手册清单 + 被 binder 实例化进 user message）

两者各自独立，互不引用。Phase 3+ 手册可以套用 Boundaries 里的检查逻辑，但模板里需显式重写（不允许隐式引用边界名）。Phase 4+ 可考虑增 `cross-ref` 语法。

---

## 四、两套三层的关系

### 4.1 模板与实例的关系（非两套独立知识）

静态三层和动态三层不是两套并列的知识，而是**模板与实例**的关系：

| 维度 | 角色 | 产物去向 |
|---|---|---|
| 静态知识库三层 | **模板**（含 FlowTemplate 手册模板） | systemPrompt（知识布局 + 手册清单） |
| 动态手册三层 | **实例**（FlowTemplate 被参数绑定后的产物） | user message（手册实例） |

动态手册是静态 FlowTemplate 的实例化产物，不是独立一套知识。静态知识进 systemPrompt 一次（含手册模板声明），动态手册实例只引用不复制模板内容——实例化时只填充 `{{变量}}`，不重复模板骨架。

### 4.2 注入时机

| 结构 | 注入位置 | 变化频率 | 机制 |
|---|---|---|---|
| 静态知识库 | systemPrompt（`before_agent_start`） | session 级稳定 | Pt compiler 注入 |
| 动态手册 | user message（`input` 事件展开） | 任务实例级变化 | Pt binder 展开 |

动态手册不进 systemPrompt——每个任务实例不同，进 systemPrompt 会破坏 cache 友好性。

### 4.3 命名约定（避免同名漂移）

两套都叫"语义层/模块层/结构层"会混淆，加前缀区分：

| 视角 | 三层 |
|---|---|
| 静态（知识库） | 知识语义层 / 知识模块层 / 知识结构层 |
| 动态（手册） | 数据语义层 / 流程层 / 手册结构层 |

---

## 五、Pt 接管 Prompt Template 展开

### 5.1 共存策略

Pt 接管 template 展开，但**只管自己声明过的 template**（Schema 里的 FlowTemplate），其余放行给 Pi 原生 `$1 $2` 机制。

| 层级 | 职责 |
|---|---|
| Pt 扩展层 | 接管 Schema 声明的 FlowTemplate，支持 `{{命名变量}}`、数据源引用、L2 预绑定 |
| Pi 原生层 | fallback，处理非 Pt 管的 template，用 `$1 $2` 位置参数 |

Pt = 扩展层，Pi 原生 = fallback 层。不覆盖，只增强。

### 5.2 实现机制：`input` 事件拦截

Pi 事件流（`docs/extensions.md` §Input Events）：

```
用户输入
  1. 扩展命令 /cmd 检查
  2. input 事件触发 ← Pt 在这里拦截
  3. skill 展开
  4. prompt template 展开
  5. agent 处理
```

`input` 事件返回 `action: "transform"` 可改写 text 后继续，`action: "handled"` 可跳过 agent。Pt 用 transform 接管：

```typescript
pi.on("input", async (event) => {
  const match = event.text.match(/^\/(\S+)\s+(.*)/);
  if (!match) return { action: "continue" };
  const [_, tplName, args] = match;
  const tpl = await loadFlowTemplate(tplName);  // 从 Schema 查
  if (!tpl) return { action: "continue" };      // 非 Pt 管的，放行给 Pi 原生

  // Pt 自定义绑定引擎——支持 {{命名变量}}、缺省值、数据源预查
  const expanded = bindTemplate(tpl, args);
  return { action: "transform", text: expanded };
});
```

transform 后 Pi 看到的 text 已是展开后的完整内容，Pi 原生 template expansion 自动跳过。

### 5.3 Pt 自定义绑定的能力（不受 Pi `$1 $2` 限制）

| 能力 | Pi 原生 | Pt 接管后 |
|---|---|---|
| 位置参数 `$1 $2` | ✅ | ✅ |
| 命名变量 `{{客户ID}}` | ❌ | ✅ |
| 缺省值 / 条件块 | 仅 `${1:-default}` | ✅ 任意 |
| 数据源预查后替换（L2） | ❌ | ✅（调工具/API 后注入） |
| 类型校验 | ❌ | ✅ |

### 5.4 binder 变量绑定语法（Phase 3 MVP）

`pt/backend/message.ts` 的 `bindFlowTemplate(tpl, args)` 是 Pt 接管 template 展开的核心。
输入：`FlowTemplate` + 参数字符串（`/risk-check 客户A 5000` 的参数部分 "客户A 5000"）。
输出：变量被替换后的完整手册 markdown（进 user message）。

#### 5.4.1 变量语法

| 语法 | 含义 |
|---|---|
| `{{name}}` | 必填变量，无缺省值。参数不足时**留为字面量**（不报错，让 LLM 看到缺口） |
| `{{name\|default:value}}` | 可选变量，参数不足时用缺省值 `value` 替换 |

MVP 不支持：条件块、循环、嵌套表达式、转义（`\{\{` 字面量输出）、算术/逻辑运算。
Phase 4+ 可考虑增加：L2 数据预查（调 External 数据源把变量预填为实际值）。

#### 5.4.2 变量声明与顺序

FlowTemplate 的变量声明顺序决定位置参数映射。**优先级**：

1. `vars: [客户ID, 金额]` frontmatter 字段（**优先**）
2. `argument-hint: <客户ID> <金额>` 的 `<...>` 顺序（**fallback**）
3. 两者皆无 / 冲突 / 空数组 → binder 报错（“模板未声明变量顺序”，交给验收者修复 asset）

两者冲突示例：
- `vars: [客户ID, 金额]` 但 `argument-hint: <金额> <客户ID>` → 以 `vars` 顺序为准
- `vars: []` 但 `argument-hint: <客户ID> <金额>` → 以 `argument-hint` 顺序为准

#### 5.4.3 位置参数 → 命名变量映射

`args` 是 `/name <args>` 去掉命令名后的原始字符串。映射规则：

1. 按**空白**拆分为 token 数组（`split(/\s+/)`）。Phase 3 MVP **不处理引号转义**（如 `"客户 A"` 会拆为 `"客户` 和 `A"` 两个 token，含引号字符）。
2. 按变量声明顺序依次绑定：`token[0]` → 第一个变量，`token[1]` → 第二个变量，以此类推。

示例：

```typescript
// FlowTemplate:
//   vars: [客户ID, 金额]
//   intent: "客户 {{客户ID}} 申请下单，订单金额 {{金额}}"
//   steps: [{ desc: "查 {{客户ID}} 的信用额度，判断是否 >= {{金额}}" }]

// 输入："/risk-check 客户A 5000"
// args: "客户A 5000"
// tokens: ["客户A", "5000"]
// 映射：客户ID="客户A"，金额="5000"

// 输出 intent:
//   "客户 客户A 申请下单，订单金额 5000"
// 输出 step.desc:
//   "查 客户A 的信用额度，判断是否 >= 5000"
```

#### 5.4.4 缺省值处理

| 情况 | 处理 |
|---|---|
| 参数足够（token 数 ≥ 变量数） | 按顺序绑定，多余 token 忽略 |
| 参数不足且变量无 `default` | 留为字面量 `{{name}}`（不报错） |
| 参数不足且变量有 `default` | 用缺省值替换（`{{name\|default:0}}` → `0`） |
| 参数完全为空（`/name` 后无内容） | 所有变量走缺省值或留字面量 |
| 模板出现未声明的 `{{var}}` | 留为字面量，不报错（**静默忽略**，便于模板编写者调试） |

**为什么缺值不报错**：MVP 优先简单 + LLM 容错。LLM 看到 `{{name}}` 字面量有机会主动询问用户补全。Phase 4+ 可加 strict 模式供调试用。

#### 5.4.5 缺省值与位置参数交互

```
// 模板：vars: [客户ID, 金额|default:0]
// 调用："/risk-check 客户A"
// 映射：客户ID="客户A"，金额=缺省=0
// 意图：args 只有 1 个 token，但金额有 default → 仍能完整展开

// 模板：vars: [客户ID, 金额|default:0]
// 调用："/risk-check"
// 映射：客户ID=留字面量{{客户ID}}，金额=0
// 意图：第一个变量无 default → 留字面量
```

#### 5.4.6 实现位置与签名

```typescript
// pt/backend/message.ts
import type { FlowTemplate } from "../schema.js";

/**
 * 把 FlowTemplate 模板 + 用户参数 展开为完整手册 markdown。
 * 错误 / 缺失变量 → 留为字面量（不抛异常）。
 */
export function bindFlowTemplate(
  tpl: FlowTemplate & { _vars?: string[] },  // _vars 是 OXN adapter 附加的 metadata
  args: string,
): string {
  const tokens = args.trim() ? args.trim().split(/\s+/) : [];
  const varNames = tpl._vars ?? parseVarsFromHint(tpl.argumentHint);
  const bound = bindVariables(varNames, tokens);

  let out = `# ${tpl.name}\n\n`;
  out += `## 前提（Intent）\n${replaceVars(tpl.intent, bound)}\n\n`;
  out += `## 步骤\n`;
  tpl.steps.forEach((s, i) => {
    out += `${i + 1}. ${replaceVars(s.desc, bound)}\n`;
  });
  return out.trim();
}
```

**`_vars` 字段**：OXN adapter 在 `toFlowTemplate` 里从 `fields.vars` 读出后，挂为 `tpl._vars`。不属于 Schema，binder 内部使用。下划线前缀表示“Pt 核心不感知”的内部 metadata（与其他 IR 字段区分）。

#### 5.4.7 input 事件接入点

```typescript
// pt/index.ts
pi.on("input", async (event) => {
  const match = event.text.match(/^\/(\S+)\s*(.*)$/);
  if (!match) return { action: "continue" };
  const [, tplName, args] = match;
  const tpl = cachedBundle?.knowledgeBase.flows.find((f) => f.name === tplName);
  if (!tpl) return { action: "continue" };  // 非 Pt 管的，放行给 Pi 原生

  const expanded = bindFlowTemplate(tpl, args);
  return { action: "transform", text: expanded };
});
```

#### 5.4.8 Pi 原生 template 共存

Pt 只拦截 `cachedBundle.flows` 里声明过的 `/name`，其他 `/name`（如 Pi 原生 `/commit` `/help` 等）`return { action: "continue" }` 放行给 Pi 原生 template 机制（`$1 $2` 展开）。

验证例：定义 `risk-check` 模板后，调用 `/help` 仍走 Pi 原生，不被 Pt 拦截。

#### 5.4.9 边界与未决项

| 边界情况 | Phase 3 处理 | 后续 |
|---|---|---|
| 多个模板同名 | adapter 报错（不覆盖） | — |
| 模板里 `\{\{name\}\}` 转义 | MVP 不支持，原样输出 | Phase 4+ |
| 引号包围的参数 `/risk-check "客户 A" 5000` | MVP 不处理引号，token 会带引号 | Phase 4+ |
| L2 数据预绑定（调工具拉 External 填值） | MVP 不支持 | Phase 4 （需评估 au-core 升级） |

---

## 六、依赖反转：Pt 定 Schema，来源实现

### 6.1 当前是假解耦

当前 `SourceAdapter.load()` 返回 `string`，转译逻辑在 adapter 里调了 `compileAsset`。`compileAsset` 消费的 `Asset`/`Section`/`Item` 结构带着 OXN MD 的解析痕迹（`## H2`/`### H3`/`- key: value`）。

如果来一个 YAML 来源，它的 adapter 得把 YAML 转成 OXN 的 `Asset` 结构才能用 `compileAsset`。这不是解耦，是**让所有来源学 OXN 的形状**。依赖方向反了。

```
当前（依赖向外）：
  Pt 核心 --消费--> OXN Asset 结构 <--解析-- OXN MD
```

### 6.2 反转方向

```
反转后（依赖向内）：
  Pt 核心 --消费--> Pt Schema 接口 <--实现-- OXN Adapter <--解析-- OXN MD
                                  <--实现-- YAML Adapter（未来）
                                  <--实现-- DB Adapter（未来）
```

Pt 定义 Schema，OXN 来实现。换来源换 adapter，Pt 核心不动。**OXN 降级为"一等公民 adapter"**，不再是 Pt 的"内部格式"。

### 6.3 Schema 设计原则

**Schema 是语义化的，不带任何格式痕迹**。不是 `Section {heading, raw, items}`（这是 MD 痕迹），而是直接表达业务语义。

```typescript
// pt/schema.ts — Pt 核心定义，与任何来源格式无关

/** 静态知识库 · 语义层 */
export interface Term { name: string; desc: string; level?: "axiom" | "theorem" }
export interface ExternalRef {
  name: string;
  path: string;
  protocol?: "file" | "api" | "db";
}

/** 静态知识库 · 模块层（业务领域模块） */
export interface DomainModule {
  name: string;             // 业务领域名，= domain asset name（一个 Domain 一个模块）
  terms: Term[];
  rules: Rule[];
  externals: ExternalRef[];
}

/** 静态知识库 · 结构层（编排策略） */
export interface StructureLayout {
  mode: "byDomain" | "byType" | "hybrid";
  domainOrder?: string[];  // byDomain/hybrid 时的模块顺序
}

export interface Rule {
  slot: string;             // 挂到哪个步骤，或 "global"（hybrid 模式下 global 规则聚合到全局段）
  type: "ban" | "invariant";
  check: string;
  items?: string[];
}

/** 静态知识库整体（进 systemPrompt） */
export interface KnowledgeBase {
  identity: { trigger: string; boundaries: BoundaryNode[]; tools: ToolRef[] };
  modules: DomainModule[];
  flows: FlowTemplate[];    // 手册模板（类 OXN Workflow，静态声明在知识库里）
  layout: StructureLayout;
}

export interface BoundaryNode { slot: string; deps: string[]; desc: string }
export interface ToolRef { name: string; role?: string; operations?: string[] }

/** 动态手册：FlowTemplate 是 workflow-type Domain 的 `## Blueprint` 段，被 Blueprint 实例化后产出 Manual */
export interface FlowTemplate {
  name: string;             // /name 触发
  argumentHint?: string;
  intent: string;           // 数据语义层：带 {{}} 占位符的前提
  steps: FlowStep[];        // 手册结构层：步骤 + 数据源 + 期望产出
  externals: ExternalRef[]; // 数据语义层：引用知识库的数据源
}
export interface FlowStep {
  desc: string;             // 做什么
  dataSource?: ExternalRef; // 从哪取数据（数据语义层）
  rule?: string;            // 套哪条规则（引用知识库的 Rule）
  output?: string;          // 期望产出什么
}

/** 一个来源 adapter 应提供的完整 Schema 包 */
export interface SchemaBundle {
  knowledgeBase: KnowledgeBase;   // 静态知识库（含 FlowTemplate 模板）
  // 动态手册不是独立部分，是 knowledgeBase.flows 被实例化后的产物
}
```

注意：没有 `Section`/`Item`/`heading`/`raw` 这些 MD 痕迹。`Term` 就是 `name + desc`，`Rule` 就是 `slot + type + check`——纯语义。

### 6.4 反转后各组件职责

| 组件 | 职责 | 当前 | 反转后 |
|---|---|---|---|
| `pt/schema.ts` | 定义 Schema 接口 | ❌ 不存在 | **新增，Pt 核心** |
| `pt/compiler.ts` | KnowledgeBase → systemPrompt | 消费 OXN `Asset` | **改为消费 Schema** |
| `pt/binder.ts` | FlowTemplate + 参数 → user message | ❌ 不存在 | **新增，`input` 事件接管** |
| `oxn/adapter.ts` | OXN MD → SchemaBundle | `transpile.ts` 里揉一起 | **独立，输出 SchemaBundle** |
| `oxn/parser.ts` | MD 解析中间表示 | 返回 OXN `Asset` | 不变，但只供 oxn/adapter 内部用 |
| `transpile.ts` | 注册 adapter，调度 | 调 adapter.load() 拿 string | 调 adapter.load() 拿 SchemaBundle，交 compiler/binder |

OXN 的 `Asset`/`Section`/`Item` 降级为 **OXN adapter 内部的中间表示**，不再出现在 Pt 核心视野里。

### 6.5 OXN Adapter 实现示意（Phase 3 实际实现）

```typescript
// pt/frontend/oxn/adapter.ts — OXN MD → Pt SchemaBundle
export const oxnAdapter: SourceAdapter = {
  name: "oxn",
  async load(cwd, blueprintName): Promise<SchemaBundle> {
    // 读 4 个 OXN asset（parser.ts 内部逻辑）
    const blueprint = await readAsset(join(cwd, ".pt/assets/blueprints", `${blueprintName}.md`));
    const refs = parseBlueprintRefs(blueprint);
    const [domain, workflow, stack] = await Promise.all([
      readAsset(join(cwd, ".pt/assets/domains", `${refs.domain}.md`)),
      readAsset(join(cwd, ".pt/assets/workflows", `${refs.workflow}.md`)),
      readAsset(join(cwd, ".pt/assets/stacks", `${refs.stack}.md`)),
    ]);

    const trigger = blueprint.frontmatter.trigger?.trim() ?? DEFAULT_TRIGGER;

    return {
      knowledgeBase: {
        identity: {
          trigger,
          boundaries: parseBoundaries(blueprint).map(toBoundaryNode),
          tools: (stack.sections["Tools"]?.items ?? []).map(toToolRef),
        },
        modules: [toDomainModule(domain)],         // 一个 OXN domain = 一个业务模块
        flows: collectFlows(blueprint),             // Phase 3：从 ## Templates 段提取 FlowTemplate
        layout: parseLayout(blueprint.frontmatter.layout),  // 默认 { mode: "hybrid" }
      },
    };
  },
};
```

OXN 内部映射函数（每个都逐字段对照 asset H2/H3 语法）：
- `toTerm(item)` — `### 文章 - desc: ...` → `Term {name, desc}`
- `toRule(item)` — `### ban-name - items: [...]` 或 `### inv-name - desc: ...` → `Rule {slot: "global", type: "ban"|"invariant", check, items?}`
- `toExternalRef(item)` — `### name - path: ./data/...` → `ExternalRef {name, path}`
- `toBoundaryNode(b)` — Blueprint Boundaries H3 → `BoundaryNode {slot, deps, desc}`
- `toToolRef(item)` — `### fs-tools - operations: [read, write]` → `ToolRef {name, operations}`
- `toDomainModule(d)` — Domain asset → `DomainModule {name, terms, rules, externals}`
- `toFlowTemplate(item, sectionRaw)`（Phase 3）— `### tpl-name` + `- step: ...` × N → `FlowTemplate & {_vars}`
- `collectSteps(itemName, sectionRaw)`（Phase 3）— 从 `## Templates` 段 raw markdown 扫所有 `- step:` 行（避免 parser fields 覆盖）
- `collectFlows(blueprint)`（Phase 3）— 调 `toFlowTemplate` 拿全部 FlowTemplate
- `parseLayout(raw)` — frontmatter `layout: { mode: hybrid }` 或 string → `StructureLayout`（默认 hybrid）

详细映射表见 §6.5.1。

Pt 核心只看到映射后的 Schema 字段（`Term`/`Rule`/`BoundaryNode`/`ToolRef`/`FlowTemplate`），不认 OXN 内部 `Asset`/`Item`/`Section` 结构。

### 6.5.1 OXN asset → Schema 字段完整映射表

> ⚠️ 本表反映 Phase 3 当前实现。Phase 5 重构后将按 §0 语义调整：workflow → FlowTemplate（不再“不消费”），blueprint.Templates 移除（FlowTemplate 迁回 workflow asset），blueprint 成为独立动态 Structure。标注 `【Phase 5 待改】` 的行为迁移目标。

以下是 Phase 3 实现的实施参考。Pt 核心只看到映射后的 Schema 字段；映射函数是 OXN adapter 内部逻辑。

| OXN asset | OXN H2 段 / 位置 | 解析产物 | Schema 字段 | 映射函数 / 位置 |
|---|---|---|---|---|
| domain | `## Terms` 的 H3 子项 | `Item[]` | `DomainModule.terms: Term[]` | `toTerm(item)` |
| domain | `## Bans` 的 H3 子项 | `Item[]` | `DomainModule.rules: Rule[]`（`type: "ban"`，slot 由 adapter 填） | `toRule(item)` |
| domain | `## Invariants` 的 H3 子项 | `Item[]` | `DomainModule.rules: Rule[]`（`type: "invariant"`，slot 由 adapter 填） | `toRule(item)` |
| domain | `## Externals` 的 H3 子项 | `Item[]` | `DomainModule.externals: ExternalRef[]` | `toExternalRef(item)` |
| workflow | `## Slots` 的 H3 子项 | `Item[]` | **Phase 3：不消费**（`void workflow`）。**【Phase 5 待改】workflow asset 承载 FlowTemplate（business-flow），映射到 `KnowledgeBase.flows: FlowTemplate[]`；meta-flow 映射到 Scene 的手册清单** | — |
| stack | `## Tools` 的 H3 子项 | `Item[]` | `KnowledgeBase.identity.tools: ToolRef[]` | `toToolRef(item)` |
| blueprint | frontmatter `trigger` | string | `KnowledgeBase.identity.trigger: string` | 内联取值（trim 后 fallback 到 DEFAULT_TRIGGER） |
| blueprint | frontmatter `layout` | inline object / string | `KnowledgeBase.layout: StructureLayout` | `parseLayout(frontmatter.layout)`（默认 `{ mode: "hybrid" }`） |
| blueprint | `## Use` 的顶层 list | `Item[]` | `BlueprintRefs = { domain, workflow, stack }`（用于加载引用的 3 个 asset 文件名）。**【Phase 5 待改】workflow 支持多引用（`workflows: [a, b]`）** | `parseBlueprintRefs(asset)` |
| blueprint | `## Boundaries` 的 H3 子项 | `Item[]` | `KnowledgeBase.identity.boundaries: BoundaryNode[]`。**【Phase 5 待改】Boundaries 迁到 Scene asset（静态 Structure）** | `toBoundaryNode(boundary)` |
| blueprint | `## Templates` 的 H3 子项 | `Item[]` | `KnowledgeBase.flows: FlowTemplate[]`。**【Phase 5 待改】移除（FlowTemplate 迁回 workflow asset）** | `toFlowTemplate(item)` |

**映射约定**：

1. **Rule.slot 填充策略**（adapter 不感知 mode，见 §2.3）：
   - Domain 的 Bans/Invariants → adapter 填 `slot: "global"`（hybrid 模式下 midend 抽到全局约束段；byDomain 留模块内）
   - 步骤专属 rules（`slot: "<具体 slot 名>"`）→ 由 asset 显式声明（Phase 3+ 由 `## Templates` 或扩展 domain 语法定义；当前 MVP 无实例）
2. **Term 字段对齐**：`fields.desc` 优先，`fields.description` fallback（OXN 两种写法都允许）
3. **Trigger 默认值**：未声明或空字符串 → `DEFAULT_TRIGGER = "当用户请求相关任务时按以下流程执行；其余对话正常响应，勿套用本流程。"`
4. **Layout 默认值**：未声明 / 无效 / mode 非法 → `{ mode: "hybrid" }`（设计文档 §2.3 默认推荐）
5. **workflow asset 状态**：Phase 3 当前 Pt 不消费 `## Slots` 段，workflow 仅作 Use 段引用的“存在性校验”。**【Phase 5 待改】workflow asset 成为 FlowTemplate 载体（business-flow），meta-flow 声明手册可用性与 Blueprint 引用**。
6. **Templates 段**（Phase 3 临时）：FlowTemplate 当前声明在 blueprint.asset 的 `## Templates` 段。**【Phase 5 待改】迁回 workflow asset，见 §3.6**。

### 6.6 未来加非 OXN 来源

YAML adapter 示例：

```yaml
# my-domain.yaml — 直接写 Schema 形状
knowledgeBase:
  modules:
    - name: 用户注册与登录   # 一个 Domain = 一个模块
      terms:
        - { name: 用户, desc: 有唯一ID的注册主体, level: axiom }
      rules:
        - { slot: global, type: invariant, check: 密码至少8位 }
  flows:                    # FlowTemplate（Workflow 模块的 business-flow，被 Blueprint 实例化）
    - name: register
      intent: 用户 {{手机号}} 申请注册
      steps:
        - { desc: 检查手机号未注册, dataSource: { name: users, path: ./data/users.xlsx } }
  layout: { mode: byDomain }
```

```typescript
export const yamlAdapter: SourceAdapter = {
  name: "yaml",
  async load(cwd, name): Promise<SchemaBundle> {
    const raw = await readFile(join(cwd, ".pt/yaml", `${name}.yaml`), "utf8");
    return YAML.parse(raw);  // 直接就是 Schema 形状，无需映射
  },
};
```

**Pt 核心完全不知道来源是 OXN 还是 YAML**。

---

## 七、两套三层与 Pt 实现的映射

### 7.1 概念模型 vs 实现映射

两套三层是**概念模型**，用于沟通和理解。实现不强行 6 层映射——代码维持 Schema 三类型（KnowledgeBase / FlowTemplate / SchemaBundle）+ 两转译器（compiler / binder）。

| 模型层 | 实现映射 | 产物 |
|---|---|---|
| 静态·知识语义 | `Term`/`Rule`/`ExternalRef` Schema 字段 | 信息原子 |
| 静态·知识模块 | `DomainModule` Schema 类型（领域包） | 业务领域边界 |
| 静态·知识结构 | `StructureLayout.mode` + compiler 拼接逻辑 | systemPrompt 段落布局 |
| 动态·数据语义 | `FlowTemplate.externals` + `FlowStep.dataSource` | 数据指引 |
| 动态·流程 | template 选择（路由规则或 agent 选） | 选哪个手册 |
| 动态·手册结构 | `binder` 展开 `FlowTemplate.steps` | user message 手册内容 |

### 7.2 转译公式

```
Pt 转译 = 静态知识库 → systemPrompt（before_agent_start）
        + 动态手册实例 → user message（input 事件）

其中：
  静态知识库 = identity + modules + flows（含手册模板） + layout
  动态手册实例 = flows 中的某个 FlowTemplate 经 binder 参数绑定后产出
  数据源引用 = agent 执行时用工具查 Externals 声明的路径
```

Pt 产出的是 prompt 脚手架（systemPrompt + user message），推理由 LLM 在脚手架里完成。

---

## 八、落地路线

### 阶段 1：定 Schema + 依赖反转

1. 新增 `pt/schema.ts`，定义 `KnowledgeBase`/`FlowTemplate`/`SchemaBundle`，不带任何 OXN 痕迹。
2. 重写 `oxn/adapter.ts`：现有 `parser.ts` + `compiler.ts` 的 OXN 专有部分归入 adapter，输出 `SchemaBundle`。
3. 重写 `pt/compiler.ts`：消费 `KnowledgeBase`，输出 systemPrompt。支持 `StructureLayout.mode`（默认 hybrid）。
4. 改 `transpile.ts`：`adapter.load()` 返回 `SchemaBundle`，交给 compiler。

收益：Pt 核心与 OXN 解耦，可接其他来源。

### 阶段 2：分层验证

用写作助理 + 一个静态风控例子（规则写死，不带 `{{}}`）验证：
- `StructureLayout.mode` 三种模式的产物差异
- `DomainModule` 按业务领域组织是否清爽
- Rules 挂到步骤的 checklist 形态

### 阶段 3：Pt 接管 template 展开

1. 新增 `pt/binder.ts`：消费 `FlowTemplate` + 参数，输出 user message。支持 `{{命名变量}}`、缺省值。
2. `index.ts` 注册 `input` 事件 handler，拦截 Pt 管的 template，transform 后放行。
3. 验证：`/risk-check 客户A 5000` 触发，binder 展开后 agent 能按手册走。

**不覆盖 Pi 原生 template**——非 Pt 管的 `/name` 仍走 Pi `$1 $2`。

### 阶段 4（可选）：公理/定理标签 + L2 数据预绑定

- 给 `Term`/`Rule` 加 `level: axiom|theorem` 可选标签。
- binder 展开时调 Externals 声明的数据源，把 `信用额度({{客户ID}})` 预替换成实际值（L2）。需评估是否升级 au-core。

---

## 九、待确认的设计点

1. **结构层编排默认值**：byDomain / byType / hybrid 哪个作默认？本文暂定 hybrid，需业务场景验证。
2. **静态/动态的耦合点**：动态手册引用静态知识库的规则，是只引用不重复，还是必要时复制关键规则到手册内？关系到 token 经济和一致性。
3. **L2 数据预绑定**：binder 展开时是否调 Externals 数据源把 `信用额度({{客户ID}})` 预替换成实际值？还是只绑定参数，数据查询留给 agent 执行时？（MVP 建议后者，撞到瓶颈再升级。）
4. **Scene 与 Blueprint 载体拆分**（Phase 5）：当前 blueprint.asset 同时承担静态结构（Boundaries/trigger/Use）和动态结构（Templates），需拆为 `scenes/*.md`（Scene，静态）+ `blueprints/*.md`（Blueprint，动态）。拆分后 `## Use` 的 workflow 改为多引用（`workflows: [a, b]`），Domain 可与 Blueprint 正交切换（`/scene` + `/domain` 两命令，或 MVP 先合为 `/scene`）。
5. **插槽通用化**（Phase 5）：Schema 从硬编码 `modules/flows/tools` 改为通用 `slots: Slot[]`，Pt 核心不硬编码模块类型，加新模块类型不动中后端（详见 §0.2、§11.5）。

### 已确定的设计点

- **模块粒度**：一个 Domain = 一个 md（含 `## Scene` + `## Blueprint` 两段），不二次切分。✅
- **Domain 即 Module**：workflow/stack 是 Domain Type 标签，不是平级 Module 类型。✅
- **两段配对**：每个 Domain 有 `## Scene` 段（What）+ `## Blueprint` 段（How/Why），一个 md 内两个 H2 段。✅
- **Struct 命名**：Scene 读 `## Scene` 产 System Prompt；Blueprint 读 `## Blueprint` 产 Manual。✅
- **手册选用方式**：用户 Prompt Template 机制触发（`/risk-check`）或 LLM 基于上下文自选。✅
- **Blueprint 组合性**：1:N Domain，一个 Blueprint 可引多个 workflow-type Domain（§0.6）。✅
- **Blueprint 与 term-Domain 正交**：同一 Blueprint 配不同 term-Domain 构成不同场景变体（§0.6）。✅
- **Scene / Blueprint 独立载体**：各自独立 asset（§0.7）。✅
- **Pt 是稳定结构框架**：不硬编码 Domain Type，插槽机制保证可扩展（§0.2）。✅

---

## 十、与 Pt 当前实现的关系

| 组件 | 新模型下的角色 | 改动 |
|---|---|---|
| `pt/schema.ts` | Pt Schema 定义（核心契约） | **新增** |
| `pt/compiler.ts` | KnowledgeBase → systemPrompt | 重写为消费 Schema |
| `pt/binder.ts` | FlowTemplate → user message | **新增** |
| `pt/index.ts` | 注册 `input` 事件接管 template | 新增 input handler |
| `oxn/adapter.ts` | OXN MD → SchemaBundle | 重写（OXN 专有逻辑归此） |
| `oxn/parser.ts` | OXN MD 解析中间表示 | 不变，降级为 adapter 内部用 |
| `transpile.ts` | adapter 调度 | 改为返回 SchemaBundle |
| Pi prompt template | fallback 层 | 不接管，Pt 管的 transform 后跳过原生展开 |

**核心原则不变**：Pt 是 stage 0（Pi extension），负责"Schema 定义 + 转译注入"。动态手册走 `input` 事件，不造独立引擎。只有 L2 数据预绑定撞到瓶颈时，才考虑升级 au-core。

---

## 十一、转译通道架构：前端 / 中端 / 后端

### 11.1 Pt 的定位

**Pt 是异构知识源 → 结构化 prompt 的转译器。**

- **异构知识源**：OXN MD、YAML、未来可能的其他格式——语法各异，语义同构。源由 Module（内容）+ Structure（编排）组成（§0.2）。
- **结构化 prompt**：不是任意文本，是有明确语义结构的产物（段落有角色：触发条件 / 流程 / 术语 / 工具 / 手册步骤），且去向明确（systemPrompt vs user message）。

Pt 产出的不是"上下文"（太泛，Pi 里 context 特指对话上下文）、不是"Prompt"（太笼统，Pi 严格区分 systemPrompt 和 user message）、不是"文本"（太弱，丢掉了结构化这层）。准确说是**两类结构化 prompt 产物**：

| 产物 | 去向 | 对应 Struct | 读 Domain 哪段 |
|---|---|---|---|
| System Prompt | `before_agent_start` 注入 | Scene（静态） | `## Scene`（What） |
| Manual | `input` 事件 transform | Blueprint（动态） | `## Blueprint`（How/Why） |

### 11.2 为什么采用编译架构

Pt 的转译任务与编译任务本质同构：

```
编译：源语言（有语法语义）→ 变换 → 目标语言（有语法语义）
P t：异构知识格式（frontmatter + H2/H3）→ 变换 → Pi prompt markdown
```

源有语法树（asset 的 Section/Item），目标有产物结构（systemPrompt 段落），中间需要 IR 解耦多来源。**Pt 不只是"像编译"，是在做编译**——源语言是异构知识格式，目标语言是 LLM prompt。

采用编译架构（三段式 + IR 契约）的标准结构：

| 编译阶段 | 职责 | 通用编译器对应 | Pt 对应 |
|---|---|---|---|
| **前端 (Frontend)** | 源 → IR | Clang: C/C++ → LLVM IR | adapter: OXN MD → SchemaBundle |
| **中端 (Midend)** | IR → IR 变换 | LLVM pass: 优化、分析 | layout/flow-select: 编排策略、模板选择 |
| **后端 (Backend)** | IR → 目标 | LLVM codegen: IR → x86/ARM | prompt-backend / message-backend |

关键特征（与标准编译一致）：
- 前端有**多个**（OXN adapter、YAML adapter），共享一个 IR
- 中端对 IR 做变换，**不碰源语言也不碰目标语言**
- 后端有**多个**（prompt-backend、message-backend），共享一个 IR
- IR（SchemaBundle）是契约，解耦前后端

### 11.3 转译通道图

```
┌──────────────────────────────────────────────────────────────┐
│ 前端（Frontend）— 解析层                                       │
│   异构知识源 → Schema IR                                        │
│   ┌─────────────┐  ┌─────────────┐  ┌─────────────┐           │
│   │ oxn/adapter │  │ yaml/adapter│  │  ...        │           │
│   │ OXN MD→IR   │  │ YAML→IR     │  │             │           │
│   └──────┬──────┘  └──────┬──────┘  └──────┬──────┘           │
│          └────────────────┼────────────────┘                  │
│                           ▼                                    │
│                    SchemaBundle (IR)                           │
│   含 KnowledgeBase + FlowTemplate[]（手册模板）                │
├──────────────────────────────────────────────────────────────┤
│ 中端（Midend）— 变换层                                         │
│   对 IR 做变换，不碰来源格式                                   │
│   ┌──────────────────────────────────────────────┐            │
│   │ layout-transform: byDomain/byType/hybrid 编排│            │
│   │ flow-select: 选哪个 FlowTemplate（LLM 或用户）│            │
│   └──────────────────┬───────────────────────────┘            │
│                      ▼                                         │
│              变换后的 IR（含已选手册模板）                       │
├──────────────────────────────────────────────────────────────┤
│ 后端（Backend）— 生成层                                        │
│   IR → 结构化 prompt 产物                                      │
│   ┌──────────────────┐  ┌──────────────────┐                 │
│   │ prompt-backend   │  │ message-backend  │                 │
│   │ IR → systemPrompt│  │ FlowTemplate     │                 │
│   │ (before_agent_   │  │ + 参数 → user    │                 │
│   │  start 注入)     │  │  message 手册    │                 │
│   │                  │  │ (input 事件)     │                 │
│   └──────────────────┘  └──────────────────┘                 │
└──────────────────────────────────────────────────────────────┘
```

### 11.4 各层职责边界（v7 三段式严格分离）

| 层 | v7 名 | 输入 | 输出 | 不允许做 |
|---|---|---|---|---|
| **前端** | parse/ | OXN MD / YAML / ... | `SchemaBundle { domains, channels, blueprints }` | 生成 prompt 字符串、做 layout 编排 |
| **中端** | compile/ | `SchemaBundle` + 选定的 `Blueprint` + `Channel` | `Context { name, sourceHash, modules }` | 读来源文件、直接出 prompt 字符串 |
| **后端** | render/ | `Context` | System Prompt / Context Message 字符串 + 缓存文件 | 读来源文件、做 layout 编排 |

三个判据检验架构是否清晰：
1. **能否换来源不动核心？** 前端换 adapter，中后端不动 → 解耦成立。
2. **能否换编排不动解析和生成？** 中端换 layout 实现（byDomain/byType/hybrid），前后端不动 → 解耦成立。
3. **能否换后端目标不动前端？** 后端换目标（如未来输出到非 Pi agent），前端不动 → 解耦成立。

**Phase 7 三段式恢复**：Phase 5.5 时 midend 退出（layout 逻辑并入 backend），三段式叙事塌陷。Phase 7 v7 重构重新拉回 compile/ 为中端：
- 中端职责：Blueprint + Channel + Domains → Context IR（按 channel.layout.mode 编排）
- 后端职责：Context IR → 产物字符串 + 缓存（不再做编排，只渲染）

**v7 三层叙事命名对齐 Pi 产物层**：
- Domain → 内容层（OXN asset）
- Channel → 结构层（OXN asset）
- Blueprint → 配置层（OXN asset）
- Context → 产物层（物理文件 .pt/contexts/cache/*.context.md）
- System Prompt / Context Message → 注入产物（Pi 机制名）

### 11.5 文件结构对应（Phase 7 实际状态，v7 四层模型）

```
src/
├── parse/                     # 前端：Pt md → IR（三 adapter 按目录位置分发载体）
│   ├── shared.ts              # 通用 MD 词法+语法（四层共享）+ 共享类型（Asset/Section/Item）
│   ├── domain.ts              # domains/*.md → Domain IR
│   ├── channel.ts             # channels/*.md → Channel IR
│   ├── blueprint.ts           # blueprints/*.md → Blueprint IR
│   └── index.ts               # oxnAdapter 入口（按目录位置分发到三个 adapter）
├── compile/                   # 中端：IR → IR 变换（Phase 7 恢复）
│   ├── context.ts             # (Blueprint+Channel+Domains) → Context IR（layout 编排）
│   └── index.ts               # 中端入口，导出 compileContext / computeSourceHash
├── render/                    # 后端：IR → 产物字符串 + 缓存
│   ├── system-prompt.ts       # Context.## Scene → System Prompt 字符串
│   ├── context-message.ts     # FlowTemplate + 参数 → Context Message 字符串（binder 展开）
│   ├── cache.ts               # Context 文件读写 + hash 校验（.pt/contexts/cache/*.context.md）
│   └── index.ts               # 后端入口
├── schema.ts                  # v7 IR 类型（Domain/Channel/Blueprint/Context 四层）
├── transpile.ts               # 三段式链路：parse → compile → cache → render
├── config.ts                  # 读 .pi/settings.json + 探测 Blueprint
├── index.ts                   # Pi 事件调度
└── package.json               # @issac/pi-pt，pi.extensions: ["./src/index.ts"]

资产目录：
.pt/assets/
├── domains/                   # 10 个 Domain（type=term/workflow/stack/glossary）
├── channels/                  # 1 个 Channel：project-dev.channel.md
└── blueprints/                # 4 个 Blueprint（*.blueprint.md）

Phase 7 废弃旧结构：
- pt/frontend/ → src/parse/（重构为三 adapter）
- pt/backend/ → src/render/（拆为 system-prompt / context-message / cache 三文件）
- pt/midend/ → src/compile/（Phase 5.5 退出后于 Phase 7 恢复）
```

### 11.6 与通用编译器的差异（实现是简化形态）

采用编译的**架构模式**，不采用编译的**实现复杂度**。差异：

| 维度 | 通用编译器 | Pt |
|---|---|---|
| 源语言 | 形式语言（C/Rust，严格文法） | 半结构化（markdown + frontmatter，文法宽松） |
| IR | 严格类型化（SSA、类型系统、控制流图） | Schema 对象（普通 TS interface） |
| 中端 | 几十个 pass，性能优化 | 少量变换（编排策略、模板选择） |
| 后端目标 | 机器码（严格） | 自然语言 prompt（LLM 容错） |
| 语义保持 | 严格等价 | 宽松（prompt 有冗余容错） |

**不该硬套编译的三处**：
1. 不建复杂 IR 类型系统——Schema 是普通 TS interface，够用即可。
2. 不建 pass 管道框架——中端就 2-3 个变换，直接函数调用，别造 pass manager。
3. 后端不是 codegen 是 promptgen——拼结构化 markdown，不做指令选择/寄存器分配。

### 11.7 准确定位

**Pt 是采用编译架构（三段式 + IR 契约 + 多前端多后端）的异构知识转译器，任务本质是编译，实现是简化形态。**

- 任务本质同构于编译（源→变换→目标）→ 前中后端标准结构成立
- 实现复杂度远低于通用编译器 → 不照搬 IR 类型系统 / pass 框架 / codegen
- 产物是结构化 prompt（systemPrompt 段落 + user message 手册），不是任意文本

### 11.8 Phase 5：Domain/Struct 模型对齐

Phase 5 按本节语义模型对齐当前实现。核心是**让三段式架构兑现“Pt 是稳定结构框架”的定位**：

| 改动面 | 当前（Phase 4） | 目标（Phase 5，v6 语义） | 影响层 |
|---|---|---|---|
| Schema IR | 硬编码 `modules/flows/tools` | 通用 `Domain[]` + `Domain { type, scene, blueprint }` | Schema |
| Domain 模型 | 3 平级 Module（Domain/Workflow/Stack） | Domain 即 Module，workflow/stack 是 Domain Type 标签 | Schema + 前端 |
| Struct 命名 | Scene / Blueprint（语义混淆） | Scene / Blueprint（语义澄清：Scene→System Prompt，Blueprint→Manual） | 全局 |
| Domain 载体 | 分散在多 asset | 一个 Domain = 一个 md（`## Scene` + `## Blueprint` 两 H2 段） | asset + 前端 |
| 后端渲染 | `compileModule`/`compileFlows` 硬编码 | 渲染器注册制（`Record<type, renderFn>`），按 Domain Type 分发 | 后端 |
| 产物命名 | “user message” / “input message” | Manual（Blueprint 实例化的产物，对齐 Pi Prompt Template） | 后端 |
| FlowTemplate 归属 | blueprint.asset `## Templates` | workflow-type Domain 的 `## Blueprint` 段 | 前端 + asset |
| 模块类型扩展 | 加类型需改 Schema+中后端 | 只加 Domain Type 定义 + renderer，Schema/中端不动 | — |

**验证判据**（三段式架构成立的证据）：Phase 5 迁移只动前端（adapter/parser/types）+ asset + 后端渲染器注册，**中端和 Schema 的核心结构不变**（layout 三模式不受影响）。如果中端被迫改，说明抽象漏了。

> 渲染器注册制详情待 Phase 5 设计细化时补入本节。

---

## 附：模型演进对照

| 版本 | 模型 | 局限 |
|---|---|---|
| v1（优化文档） | 4 asset 平铺 | Domain 混装静态语义和动态约束 |
| v2（早期 layering） | 描述层 / 结构层 两层 | 知识与执行混谈；模块层缺失；动态层误称“推理” |
| v3 | 静态知识库三层 + 动态手册三层 + Schema 反转 + Pt 接管 template | Blueprint 误归静态；FlowTemplate 误放 blueprint.Templates |
| v4 | Module + Structure(静态/动态)：Scene 产 systemPrompt，Blueprint 产 input message；插槽通用化；1:N Workflow 组合 | 3 种平级 Module（Domain/Workflow/Stack）致命名碰撞；Scene/Blueprint 名不达意 |
| v5 | Domain 即 Module + meta/domain 两面 + meta-Struct/domain-Struct | 仍多一层与 Pi 无关的抽象词（meta/domain）；产物层借 Pi 的词凑数 |
| **v6** | **Domain 即 Module；每个 Domain 用 `## Scene` / `## Blueprint` 两个 H2 段；Scene 读 `## Scene` 产 System Prompt，Blueprint 读 `## Blueprint` 产 Manual；三层命名 Domain→Struct→Render 各有独立名** | **结构层与 Domain H2 段名碰撞（Struct.kind="blueprint" vs Domain.## Blueprint）；模板与实例未分离（Scene.refs 是具体 Domain 名，无复用机制）** |
| **v7（本文 §0）** | **Domain → Channel → Blueprint → Context 四层模型。Channel 负责结构复用（跨项目），Blueprint 负责实例配置（Channel + 具体 Domains + trigger + boundaries），产物 Context 是物理文件带 hash 缓存；三段式叙事（parse/compile/render）恢复** | **（v7 为当前模型）** |

v6 的关键修正（相对 v5）：
1. **命名回归 Scene / Blueprint**：废弃 meta-Struct/domain-Struct。Blueprint = 蓝图 = 模板 = Prompt Template，语义正向。Struct 名直接对齐 Pi 产出。
2. **段名 = Struct 名**：Domain md 用 `## Scene` / `## Blueprint` 两个 H2 段，转译器按段名分发，不再多一层“面”抽象。
3. **产物层正名**：Blueprint 的产物叫 Manual（操作手册），不叫“input message”（传输术语）。Manual 对齐 Pi Prompt Template 实例化后的产物。System Prompt 保留 Pi 精确术语。
4. **三层命名**：Domain（内容层）→ Struct（结构层：Scene/Blueprint）→ Render（产物层：System Prompt/Manual），各层有 Pt 自己的名。
5. **term-type 内部格式**：`## Scene` 段内继续用 H3 = 公理、无序号 = 定理的现有格式，与 OXN asset 习惯一致。
