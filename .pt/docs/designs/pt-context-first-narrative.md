# §0 Context-first 重写样板（**P3 已落地**——见 `pt-asset-layering.md §0`）

> **历史定位**：本文是 P3 重写 §0 前的样板，写于 session/turn 术语对齐决策**之前**——含旧术语（Context IR、`system_prompt`/`context_message` target、Blueprint `agent` 字段、`## Compilation` 段、Domain `type` 字段、`## Manual` 段、stack、`renderSystemPrompt`/`renderContextMessage` 函数名等）。**保留为历史参考，不反映最终状态**。
>
> **P3 已落地**：最终版见 [`pt-asset-layering.md §0`](./pt-asset-layering.md#零pt-语义定义)。结构沿用本文（Context-first 倒推 + 派生链图 + 两种适配器），术语全部对齐到 P1+P2+P4+P9+P8 后的代码最终状态（AgentContext / session / turn / Rules/Flows/Checklists/Participant / H2 段名 schema 驱动 / Blueprint 载体 YAML）。
>
> **保留价值**：本文记录"为什么 Context-first 优于正叙"的论证过程（LLM 约束表 + 机制-约束对应表 + 派生链倒推）。新读者看 P3 后的 `pt-asset-layering.md §0` 即可，需要理解设计决策时回看本文。

---

## 零、Pt 语义定义

本节是 Pt 的语义基准。后续架构章节均以此为准。

> **v9 模型**（2026-09-01 定稿）。

### 为什么需要 Pt（问题域）

**LLM 是失忆且被动的图书馆智能体**——知识在权重里但不主动浮现，每个 session 从零开始。因此每次输入必须自包含：

| LLM 约束 | 含义 | 输入必须带什么 |
|---|---|---|
| **失忆** | 无跨会话记忆，session_start 从零 | 固定背景（场景 + 参与者 + 边界） |
| **被动** | 知识在权重里但不主动浮现 | 可调阅索引（提示有什么可召唤、何时召唤） |
| （会话累积） | 对话推进产生新内容 | 当前对话记忆 |

Pt 的工作：把领域知识组织成这种自包含输入。**Profile 定义场景**（背景 + 参与者 + 边界），**编译成 Agent Context**（静态面=每轮重注的背景，动态面=按需召唤的手册），注入 LLM。

这个动机解释了每个机制为什么存在：

| 机制 | 解决 LLM 的哪个约束 |
|---|---|
| Profile（场景定义，持久化可复用） | 失忆——场景定义不能每次手写，需持久化 |
| Agent Context 静态面（每轮注入 System Prompt） | 失忆——每轮必须重注背景 |
| Agent Context 动态面（按需触发 Context Message） | 被动 + 省 token——手册不每轮注，按需才召唤 |
| Trigger 索引（提示有什么手册可查） | 被动——LLM 不会主动想起，需提示可调阅 |
| Manual 触发（`/manual:xxx`） | 被动——主动召唤具体知识进输入 |

### Pt 是什么

**Pt 是异构上下文编译器**——把领域知识按配置编译成 Agent 上下文并注入。

使用者最关心的是**编译产物 Context**：一份配一次就让 Agent 获取更有效、更专注的上下文。Context 由两面组成，对应 Agent 的两种上下文需求：

| 面 | 注入位置 | 时效 | 心智 | 通俗类比 |
|---|---|---|---|---|
| **会话知识** | System Prompt（`before_agent_start`） | 静态、贯穿整个会话 | Agent 的人格/背景 | "Agent 是谁、要做什么" |
| **参考手册** | Context Message（`input` 事件触发） | 动态、按需触发 | Agent 的工具书 | "需要时查哪本手册" |

**领域知识是上下文的原料**。用户配一份 **Profile**（选哪些知识 + 套哪种结构），Pt 就把领域知识按 Profile 编译成 Context，注入 Agent。不同 Profile 编译出不同场景的 Context。

### 派生链（自顶向下倒推）

```
Context              ← 用户关心的产物：会话知识 + 参考手册
  ↑ Profile 编译产出
Profile              ← 配置：选 Blueprint + 选 Domains，组合出不同场景的 Context
  ↑ 引用
Blueprint            ← 结构：声明有哪些注入点 + 各注入点聚合什么 + 注入到 Agent 哪里
  +                  +
Domains              ← 原料：异构领域知识，按 H2 段（Scene/Trigger/Manual/...）切模块
```

**一句话**：Domains 是原料，Blueprint 是结构模板，Profile 是"选哪些原料套哪种结构"的配置，Context 是编译出来的 Agent 上下文。**改 Profile（换知识组合）即可换场景，不必改 Blueprint 或 Domains。**

### 两种适配器（扩展边界）

Pt 的扩展性集中在两套适配器，依赖反转，Pt 核心定义接口、具体实现可插拔：

| 适配器 | 适配什么 | MVP 实现 | 扩展方式 |
|---|---|---|---|
| **SourceAdapter** | 知识源格式（MD/YAML/DB/...） | oxnAdapter（MD） | 加 adapter 类 |
| **AgentAdapter** | Agent 注入机制（Pi/Codex/...） | PiAdapter | 加 adapter 类 |

左边吃异构知识源，右边接异构 Agent。Pt 核心不感知来源格式，也不感知 Agent API。

---

### 0.1 产物层：Context（编译后 Agent 上下文）

**Context 是 Profile 编译后的产物**——Pt 的核心价值所在。Context 是**物理文件**（`.pt/cache/contexts/*.context.md`），按注入点组织，缓存复用，避免每次重新编译。

Context 的结构按注入点划分（与 Blueprint 的 H2 一一对应）：

```markdown
# pt-dev.context.md  （Profile「pt-dev」编译后的 Context）

## 会话知识              ← target: system_prompt，每轮注入 System Prompt
  （Domain 的 Scene + Trigger 段聚合，按 Blueprint.mode 编排）
  ### 模块「pt-architecture」
  **术语**
  - **三段式编译架构**：...
  ### 参考手册索引         ← Trigger 段聚合：告诉 LLM 有什么手册可查 + 何时查
  - **pt-quality**：改 Pt 代码时参考；含 9 条技术规范
    /manual:pt-quality 查看完整规范

## 参考手册              ← target: context_message，触发时注入 Context Message
  （Domain 的 Manual 段聚合，待命）
  ### 模块「pt-quality」
  - [ ] modules-type-safety
  - [ ] path-constant
```

**两面各自的生命周期**：

- **会话知识**每轮注入 System Prompt（含 Scene axioms + Trigger 索引）。LLM 每轮看到索引，知道"有什么手册可查、何时查"。
- **参考手册**不每轮注入——用户 `/manual:xxx` 或 LLM 判断需要时才触发，内容作为 Context Message 注入（省 token，compact 时进消息流会被压缩）。

**缓存与失效**：Context 文件头记录 `sourceHash = hash(Profile + Blueprint + Domains)`。三者任一变化即失效重编译。Pt 读取时比对 hash：一致用缓存，不一致重编译覆盖。

**Context 不自描述 target**：modules 按注入点名（语义名）聚键，但哪个是静态(system_prompt)、哪个是动态(context_message)需回头查 `Blueprint.injectionPoints[].target`。（未来 IR 可带 target 标注自包含——见末尾"可选跟进"。）

> 内容由 Domain 定义，因此 Context 内容可以是普通文本，也可以是执行描述。Pt 产出结构化上下文文档，LLM 做推理。

---

### 0.2 配置层：Profile（怎么配出 Context）

**Profile 是配置——把 Blueprint 和 Domains 衔接起来，组合出不同场景的 Context**。Profile 是项目级的：每个项目/场景一份 Profile，填入自己的 Domain 组合。配一次，全员生效。

**v9 核心设计：Domains 自动分发**。Profile 的 YAML frontmatter 有全局 `domains` 列表，自动分发到所有注入点；注入点 H2 下的 `### Domains` 是追加列表，只给该注入点贡献。两者合并后，compile 按 Blueprint 的 `### Modules` 自动判断每个 Domain 贡献哪些 H2 段（有则贡献，无则跳过）。

Profile 配置用 MD 标题层级 + YAML frontmatter 表达：

```markdown
---
name: pt
blueprint: dev-knowledge
domains: [pt-concepts, pt-architecture, me, pt-transpile]
---

# pt (profile)

## 会话知识
### Domains
- pt-quality
- pt-collab

## 参考手册
### Domains
- pt-quality
- pt-collab
```

**字段职责**：
- YAML `name`：Profile 名（项目级标识）
- YAML `blueprint`：引用哪个 Blueprint（结构复用）
- YAML `domains`：全局 Domain 列表，自动分发到所有注入点（有匹配 H2 段则贡献）
- `## 会话知识` / `## 参考手册`：H2 = 注入点（与 Blueprint 的 H2 同名，实例化该注入点）
  - `### Domains`：追加到本注入点的 Domain 列表（只贡献该注入点）

**全局 vs 注入点追加**：全局 `domains` 是"基集"——写一次自动分发；注入点 `### Domains` 是"追加"——精确控制只给某注入点贡献。Domain 列一次（全局），不必每个注入点重复写；需要精确控制时用追加。

**Profile 不跨项目复用**。跨项目复用的是 Blueprint（结构）和 Domain（知识）——Profile 是把两者组装成具体场景的胶水。

---

### 0.3 结构层 + 内容层：Blueprint 与 Domains（Profile 引用什么）

Profile 引用两样东西：**Blueprint（结构模板）** 和 **Domains（知识原料）**。两者都可独立复用，Profile 负责组装。

#### Blueprint：注入点结构模板

**Blueprint 是 Agent 端的注入点结构设计**——定义用哪个 Agent（`agent` 字段）、有哪些上下文场景（注入点）、每个注入点聚合哪些 H2 段（聚合模块）、注入到 Agent 的哪个位置（`target`）、用什么聚合方式（`mode`）、怎么编译（Compilation）。Blueprint 可跨项目复用——「开发知识」这个结构在多个项目都适用，只是具体 Domain 不同。

**核心设计：H2 = 注入点（人类自定义名）**。Blueprint 的每个 H2 是一个注入点，H2 名由人类自定义（会话知识/参考手册/背景知识/操作手册/...），不由代码写死。`target` 字段把语义名映射到 **Agent 技术注入点**（Pi 的 `system_prompt`/`context_message`），AgentAdapter 解释 target，Pt 核心不感知其具体含义。

```markdown
---
name: dev-knowledge
agent: pi
---

# dev-knowledge (blueprint)

## 会话知识
target: system_prompt
mode: hybrid
### Modules
- Scene
- Trigger

## 参考手册
target: context_message
### Modules
- Manual

## Compilation
cache-dir: .pt/cache/contexts/
split: single-file
```

**字段职责**：
- YAML `agent`：声明用哪个 AgentAdapter（默认 `pi`）
- `## 会话知识` / `## 参考手册`：H2 = 注入点（人类自定义语义名，可任意命名）
- `target`：Agent 技术注入点名（由 AgentAdapter 解释）
- `mode`：聚合方式（byDomain / byType / hybrid，仅对 system_prompt 类 target 有意义）
- `### Modules`：聚合模块列表，列出参与本注入点的 Domain H2 段名
- `## Compilation`：编译方式（缓存目录 + 拆分策略）

> **待讨论**：`## Compilation` 当前与注入点同列 H2，但它不是注入点（无 target），是 Blueprint 元配置。是否降级为 `### Compilation` 或移入 frontmatter，以消除"三个 H2 两个是注入点"的结构噪音？（见原 §0 问题盘点 P0）

**Blueprint 只管结构**：不含具体 Domain、不含 Trigger/Boundaries。选 Domain 是 Profile 的职责；Trigger 在 Domain 内（H2 段）；Boundaries v9 丢弃。

#### Domains：异构领域知识原料

**Domain 承载异构领域知识**。一个 Domain = 一个 md 文件，内部用 **H2 二级标题**划分内容模块。H2 段名开放——`## Scene`、`## Trigger`、`## Manual`、`## Term`、`## Glossary`、未来扩展均可。

Domain 的 H2 段是**聚合点的供给侧**——Blueprint 的 `### Modules` 决定哪些 H2 段进哪个注入点，Domain 只管提供内容。一个 Domain 可同时贡献多个注入点（如 `## Scene` + `## Trigger` 进会话知识、`## Manual` 进参考手册），也可只贡献一个。

**关键**：Domain 不感知注入点。同一个 Domain 被不同 Profile 引用时，可能贡献不同 H2 段——由 Profile 的 Domains 列表 + Blueprint 的 Modules 列表共同决定。

**两个正交维度**：
- **H2 段名** = 内容模块类型（Scene/Trigger/Manual/扩展）——决定内容**去哪个注入点**
- **Domain Type** = 内容性质标签（term/workflow/stack/扩展）——决定各 H2 段内部**内容格式**

```
Domain「pt-quality」（type: term）
  ├─ ## Scene    → 公理列表（What：是什么）      → 供会话知识聚合
  ├─ ## Trigger  → 索引（When：何时查手册）      → 供会话知识聚合（索引段）
  └─ ## Manual   → 规范列表（How：怎么做）       → 供参考手册聚合（触发时注入）
```

**type 决定 H2 段内部格式，H2 段名决定内容去向**——两者独立扩展。加新 type = renderer 内部加 type 分支；加新 H2 段 = Domain 加 H2 + Blueprint Modules 加项（generic fallback 自动聚合，不改代码）。

> **待讨论**：`type` 当前注释列 `term/workflow/stack/扩展`，但 0 个资产用 stack。是否删 stack 死术语，或补 stack 资产证明有用？（见原 §0 问题盘点 P2）

#### 三种 H2 段（Domain 内的原料形态）

| H2 段 | 内容 | 聚合到哪个注入点 | 作用 |
|---|---|---|---|
| `## Scene` | 公理/概念/背景（What） | 会话知识（system_prompt） | Agent 每轮看到的背景知识 |
| `## Trigger` | 索引（When） | 会话知识（system_prompt） | 告诉 LLM 何时查哪本手册 |
| `## Manual` | 详细规范/流程步骤（How） | 参考手册（context_message） | 触发时注入的详细内容 |

v8 的 Trigger 是 Blueprint 注入点下的实例级文本（"这个注入点何时激活"）。v9 移到 Domain 内作 H2 段——是索引，跟手册内容紧邻维护（"何时参考 pt-quality"是 pt-quality 自身属性，不该每个 Profile 重写）。

---

### 0.4 派生链总图（Context→Domain 倒推 + 数据流）

```
┌─ 配置期：人写资产（进 git）──────────────────────────────────┐
│                                                              │
│  Blueprint（注入点结构）─┐                                    │
│         可跨项目复用       ├──→ Profile ──┐                   │
│  Domain[]（知识原料）─────┘    项目级       │                   │
│         可跨项目复用         （选结构+选原料）│                   │
└────────────────────────────────────────────│──────────────────┘
                                             ↓
┌─ 编译期：Pt 编译（session_start 或切换 Profile）─────────────┐
│                                                              │
│                                    Profile ──[compile]──→ Context
│                                                              │物理文件
│                                                              │.pt/cache/
│                                                              │contexts/
│                                                    hash 缓存 ↓
└──────────────────────────────────────────────────────────────┘
                                             ↓ Pt 读取 Context
┌─ 注入期：AgentAdapter 注入 Agent ────────────────────────────┐
│                                                              │
│  Context.会话知识 ──→ target=system_prompt                    │
│    （Scene axioms + Trigger 索引）  → 每轮注入 System Prompt    │
│                                                              │
│  Context.参考手册 ──→ target=context_message                  │
│    （Manual 段聚合）  → 待命，/manual:xxx 触发时注入           │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

**方向说明**：
- **理解 Pt（对外叙事）**：自顶向下倒推——Context（要什么）→ Profile（怎么配）→ Blueprint/Domain（原料和结构）。本节就是这个方向。
- **数据流（代码运行）**：自底向上正向——Domain/Blueprint → Profile → compile → Context → 注入。§0.7 完整数据流按此方向描述。
- 两方向不矛盾：理解时倒推（产物优先），运行时正向（原料先行）。

### 0.4a 四层 Schema 全景（每层怎么承载结构）

派生链里每层都有自己的"Schema 承载"——定义该层怎么解析/聚合/分发内容。理解这四个 Schema 的分工，就理解了 Pt 编译架构的核心。

#### 三个 Schema 的职责

| Schema | 谁定义 | 定义什么 | 承载形式 | 代码位置 |
|---|---|---|---|---|
| **Domain Schema** | Pt 代码（parse 注册表） | H2 段文本怎么解析成 IR | `getDomainSectionParser(h2Name, type)` 注册表，未注册走 fallback（Term[]） | `src/parse/domain.ts` |
| **Blueprint Schema** | 资产（Blueprint MD/YAML，使用者写） | 注入点结构 + Modules 聚合点 + target | `injectionPoints[].modules` + `injectionPoints[].target` | `.pt/assets/blueprints/` |
| **Context Schema** | Pt 代码（compile 注册表） | Domain IR 怎么聚合成 Context | `moduleRenderers[modName]` 注册表，未注册走 generic fallback（name+desc） | `src/compile/context.ts` |

**关键**：Blueprint Schema 是资产层定义的（使用者写），Domain Schema 和 Context Schema 是代码层定义的（Pt 核心）。使用者能定义 Blueprint Schema（注入点结构 + Modules），但 Domain/Context Schema 是 Pt 预定义的——generic fallback 是开放口（加新 H2 段名不注册也能走 name+desc 通用形态）。

#### 三段式编译流程（每层做什么）

```
Profile（选哪些 Domain）+ Blueprint（注入点结构 + Modules 聚合点 + target）
    ↓
┌─ parse 层（前端）：MD 资产 → IR ─────────────────────────────┐
│  按 Domain Schema（parse 注册表）把 Domain MD 解析成 Domain IR  │
│  每个 H2 段调 getDomainSectionParser(h2Name, type)：           │
│    注册的：Scene/Trigger/Manual 各 type 有专项 parser           │
│    未注册：fallbackTerms（Term[] 通用形态）                     │
│  产出：Domain IR { name, type, modules: Record<H2段名, IR> }    │
└────────────────────────────────────────────────────────────────┘
    ↓ Domain IR + Blueprint IR + Profile IR
┌─ compile 层（中端）：IR → Context IR ──────────────────────────┐
│  按 Blueprint Schema（注入点 × Modules）+ Context Schema        │
│  （moduleRenderers 注册表）聚合 Domain IR：                      │
│                                                                │
│  compileContext(profile, blueprint, domains):                  │
│    1. 建 domainByName 索引                                     │
│    2. 遍历 blueprint.injectionPoints：                         │
│       a. 找 profile 同名 InjectionPointInstance                │
│       b. resolveDomains：全局 domains + 注入点追加 → 合并去重   │
│          → 按 ipConfig.modules 过滤（Domain 有该 H2 段才贡献）  │
│       c. dispatchInjectionPoint：遍历 ipConfig.modules，        │
│          renderer = moduleRenderers[modName] ?? generic fallback│
│          遍历 refDomains：content = d.modules[modName]          │
│          renderer(d, content) → markdown 字符串                │
│          拼接所有 Domain 的该段渲染结果                          │
│          modules[注入点名] = 拼接结果                           │
│    3. sourceHash = hash(profile + blueprint + domains)         │
│  产出：Context IR { name, blueprint, sourceHash,                │
│         modules: Record<注入点名, 聚合后 markdown> }            │
│                                                                │
│  关键：compile 不感知 target——只按注入点名聚合。               │
│  target 的分发在 render 层。                                   │
└────────────────────────────────────────────────────────────────┘
    ↓ Context IR
┌─ render 层（后端）：Context IR → 产物字符串 + 缓存 ────────────┐
│  按 Blueprint.target 分发（target 在注入点配置里，不在 Context）│
│    target=session → renderSessionPrompt：筛 target=session 的        │
│      注入点，取 ctx.modules[ip.name] 拼接 → Session Prompt            │
│    target=turn → renderTurnMessage：触发时按 target=turn          │
│      取手册内容 → Turn Message                                  │
│  cache：写 .agent-context.md 物理文件 + sourceHash 头            │
└────────────────────────────────────────────────────────────────┘
```

#### 为什么 parse 和 compile 两个注册表键相同但函数不同

parse 注册表和 compile 注册表都按 H2 段名（modName）分发，但做的事不同：

| 注册表 | 输入 → 输出 | 职责 |
|---|---|---|
| parse 层 `getDomainSectionParser` | MD 文本 → IR | 怎么解析（提取字段成结构化 IR） |
| compile 层 `moduleRenderers` | IR → markdown 字符串 | 怎么渲染聚合（IR 转成 LLM 可读文本） |

理论上可以让 parse 直接产出渲染好的内容，省一层。但分层有价值：
- **parse 产 IR**（结构化，可校验、可被其他消费方用，如未来可视化、跨 Agent 适配）
- **compile 产 markdown**（文本，给 LLM 读）
- 保持分层让 IR 可复用——Domain IR 不只是为 Context 服务，未来可被其他工具消费

#### compile 和 render 分层的好处

compile 按 modName 聚合（内容结构），render 按 target 分发（注入位置）——两个维度独立：
- 加新注入点（Blueprint 加 H2 + target），compile 主循环不用改（modName 驱动）
- render 按 target 自动分发
- 这就是 v9 "data-driven，加新聚合标题不改代码"的实现机制

---

### 0.5–§0.11 机制细节（保留原序，方向中性）

以下各节是编译/分发/适配的内部机制，与叙事方向无关，保留原文：

- §0.5 聚合点数据驱动（modName 注册表 + generic fallback）
- §0.6 Profile Domains 分发机制
- §0.7 完整数据流（正向，代码视角）
- §0.8 缓存与失效
- §0.9 术语速查（**建议改为倒推顺序，见下**）
- §0.10 v8 → v9 变更说明
- §0.11 AgentAdapter

---

### 术语速查（倒推顺序版）

> 原版按 Domain→Context 正向排列。倒推版按 Context→Domain 排列，与 §0 叙事一致：

| 术语 | v9 定义 |
|---|---|
| **Context** | 编译后 Agent 上下文，产物层文件。按注入点聚合多 Domain 内容，两面：会话知识（system_prompt，静态）+ 参考手册（context_message，动态）。缓存复用 |
| **会话知识** | Context 的一面，target=system_prompt，每轮注入 System Prompt。含 Scene axioms + Trigger 索引 |
| **参考手册** | Context 的一面，target=context_message，按需触发注入 Context Message。含 Manual 段聚合 |
| **Profile** | 配置层，业务端实例。引用 Blueprint + 选 Domains（全局 + 注入点追加），编译出 Context。项目级 |
| **Blueprint** | 结构层，Agent 端注入点结构。H2=注入点（人类自定义名），target 映射 Agent 技术注入点，Modules 聚合点 + Compilation。跨项目复用 |
| **注入点** | Blueprint 的 H2（人类自定义语义名），由 target 映射到 AgentAdapter 技术注入点 |
| **target** | Blueprint 注入点字段，映射语义名到 Agent 技术注入点（Pi: system_prompt/context_message） |
| **agent** | Blueprint YAML 字段，声明用哪个 AgentAdapter（默认 `pi`） |
| **Domain** | 内容层，异构领域知识。H2 段开放（Scene/Trigger/Manual/...），Type 标签区分内容性质。跨项目复用 |
| **Domain Type** | Domain 标签（term/workflow/扩展），区分各 H2 段内部内容格式 |
| **H2 段** | Domain 内的内容模块（`## Scene`/`## Trigger`/`## Manual`/扩展），聚合点的供给侧 |
| **Scene** | Domain H2 段，公理/概念/背景（What），聚合到会话知识 |
| **Trigger** | Domain H2 段，索引（When），聚合到会话知识，告诉 LLM 何时查手册 |
| **Manual** | Domain H2 段，详细规范/流程（How），聚合到参考手册，触发时注入 |
| **聚合模块** | Blueprint 注入点下 `### Modules` 列表项，指向参与本注入点的 Domain H2 段名 |
| **全局 domains** | Profile YAML 的 domains 列表，自动分发到所有注入点 |
| **注入点追加** | Profile 注入点 H2 下 `### Domains` 列表，只给该注入点贡献 |
| **sourceHash** | Context 缓存失效依据，hash(Profile + Blueprint + Domains) |
| **System Prompt** | Context 会话知识面注入 before_agent_start 的产物 |
| **Context Message** | Context 参考手册面注入 input 事件的产物 |
| **AgentAdapter** | 适配不同 Agent 的注入机制（PiAdapter / 未来 CodexAdapter），Pt 核心调接口不感知 Agent API |
| **SourceAdapter** | 适配不同知识源格式（oxnAdapter / 未来 yamlAdapter），Pt 核心不感知来源格式 |
| **Channel** | （预留）Domain 连接外部知识源的 Connector，未来实现 |

---

## 改动对照（样板 vs 原文）

| 维度 | 原 §0 | 本样板 |
|---|---|---|
| 开篇切入 | "Pt 本质是异构上下文编译器，核心产物是 Context" 后立刻平铺四层 | 先讲 Context 两面价值（会话知识+参考手册），再倒推派生链 |
| 四层顺序 | Domain → Blueprint → Profile → Context（§0.1→§0.4） | Context → Profile → Blueprint/Domains（§0.1→§0.3） |
| 四层呈现 | 平铺表（层/名/语义/载体/归属/复用性） | 派生链图（Context↑Profile↑Blueprint+Domains） |
| Context 章节 | §0.4，很薄，被压在最后 | §0.1，提顶，详写两面 + 生命周期 |
| Profile 章节 | §0.3 | §0.2，强调"衔接 Blueprint+Domains 组合出 Context" |
| 术语速查 | 正向顺序 | 倒推顺序，Context/会话知识/参考手册置顶 |
| Compilation 混排 | 未提及问题 | 标注"待讨论"（降级 H2） |
| stack 死术语 | 列在 type 注释 | 标注"待讨论"（删或补） |

## 待讨论的术语点（沿用前几轮结论）

1. **Context 命名**：提顶后 Context 是父概念（整个 Agent 上下文），`context_message` 是其动态面的交付通道——父/子层级让同名可辩护。建议保留 + 文档消歧。
2. **Manual 双义**：Manual=模板（Domain H2 段），Manual Run=实例（.pt/manuals/ 执行追踪）。建议拆分，优先级高于 Context。
3. **Profile vs "Agent Profile"**：文档解释 Context 静态面时避开"Agent Profile"短语，改说"会话知识"，避免和 Pt Profile 撞名。
4. **Context IR 自描述 target**：modules 项带 target 标注，让 Context 自包含（可选跟进，等术语定后再说）。
