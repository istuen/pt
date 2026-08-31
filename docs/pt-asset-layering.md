# Pt 分层模型与转译架构

> **阅读指引**：本文档 §0 是语义锚定（**v7 模型**，2026-08-30 定稿），所有后续章节以 §0 为准。§1-§11 是历史演进章节（v1-v6），保留作背景，存在语义演进痕迹——遇到与 §0 冲突处，以 §0 为准。
>
> 关联文档：`docs/pt-prompt-optimization.md`（转译产物优化，已落地阶段 1+2+3）、`docs/pt-dev-phases.md`（开发执行计划，含 v7 重构 Phase）。
>
> 本文回答三个问题：
> 1. Pt 处理什么、产出什么、各概念如何分流？（§0 语义定义 — v7 四层模型）
> 2. Pt 与来源（OXN 等）的依赖关系如何反转？（§6 Schema/adapter）
> 3. 转译通道如何分段？（§11 前端/中端/后端，v7 改名 Domain/Layout/Render）
>
> 结论：**Domain → Channel → Blueprint → Context 四层模型 + Schema/adapter 依赖反转 + Pt 接管 Context 编译与注入（共存不覆盖）**。

---

## 零、Pt 语义定义

本节是 Pt 的语义基准，定义 Pt 处理什么、产出什么、各概念如何分流。后续架构章节均以此为准。

> **v7 模型**（2026-08-30 定稿）。v6 的 Struct/Scene/Blueprint 三层升级为 **Domain → Channel → Blueprint → Context** 四层。§1-§11 是历史演进章节，保留作背景，以本节为准。

Pt 的语义分四层，每层是有边界的模块，人各自管理其内容文件：

| 层 | 名 | 职责 | 载体 | 复用性 |
|---|---|---|---|---|
| **内容层** | **Domain** | 语义定义与上下文模块内容 | `domains/*.md` | 跨 Channel/Blueprint 复用 |
| **结构层** | **Channel** | 通道结构，定义含哪些上下文模块 | `channels/*.md` | 跨项目复用 |
| **配置层** | **Blueprint** | Channel + 具体 Domains 构建真正通道 | `blueprints/*.md` | 每场景一份 |
| **产物层** | **Context** | Blueprint 编译后的输出，按模块聚合多 Domain 内容 | `.pt/cache/*.context.md` | 缓存复用 |

**核心关系**（不是线性变换链，是 Domain + Channel 在 Blueprint 处合并）：

```
外部内容源 → Domain ─┐
                      ├──→ Blueprint ──[compile]──→ Context
           Channel ──┘
```

Domain 和 Channel 都是可独立复用的模块；Blueprint 把一个 Channel 和一组具体 Domain 组合成真正可执行的通道；Context 是这次组合编译出的产物文件。

### 0.1 内容层：Domain

**Domain 承载语义定义与上下文模块内容**。一个 Domain = 一个 md 文件，内部用 **H2 二级标题**划分内容模块。

Domain 的 H2 段名 = 上下文模块类型。当前固定约定两个产物模块：

| H2 段名 | 模块类型 | 注入目标 | 时机 | 性质 |
|---|---|---|---|---|
| `## Scene` | 静态知识模块 | System Prompt（`before_agent_start`） | session 级 | 可缓存 |
| `## Manual` | 操作手册模块 | Context Message（`input` 事件） | 轮次级 | 不缓存 |

Domain 可以有任意其他 H2 段（如 `## Term`、未来扩展模块），这些是**内部模块**，不直接注入 Pi，但可被 Channel 编排进 Context 供其他模块引用。

**关键**：H2 段名是开放的——加新模块类型 = 加新 H2 段名 + Channel 声明该模块。Pt 核心按 H2 名读段，不硬编码段名（产物模块的注入映射见 §0.5）。

#### Domain Type 标签

Domain 通过 frontmatter `type` 区分承载内容性质（term/workflow/stack/扩展）。Type 决定**各 H2 段内部的内容格式**（term 的 `## Scene` 是公理列表，workflow 的 `## Scene` 是手册清单 + 数据源），不决定 H2 段有哪些。Pt 核心按 type 分发 renderer，加新 type = 加 renderer，不动 Schema/主循环（扩展性实测通过）。

### 0.2 结构层：Channel

**Channel 是通道结构**，负责定义通道内有哪些上下文模块、怎么编排。Channel 可跨项目复用——比如「项目开发」这个结构在多个项目里都适用，只是具体 Domain 不同。

**Channel 只管结构，不含具体 Domain、不含触发条件**。后者是 Blueprint（配置层）的职责。

**Channel 的结构与配置都用 MD 标题层级表达**，YAML 只放文档级元信息（name 等）。

```markdown
---
name: project-dev
---

# project-dev

## Modules

- Scene
- Manual
- Term

## Layout

mode: hybrid
```

Channel 通过 `## Modules` 段声明含哪些上下文模块（对应 Domain 的 H2 段名），通过 `## Layout` 段声明编排策略（byDomain/byType/hybrid）。

### 0.3 配置层：Blueprint

**Blueprint 用 Channel + 具体 Domains 构建一个真正的通道**。一个 Channel 可被多个 Blueprint 引用（跨项目复用），每个 Blueprint 填入自己的 Domain 组合和触发条件。

**Blueprint 的配置也用 MD 标题层级表达**，YAML 只放文档级元信息。

```markdown
---
name: pt
---

# pt

## Channel

project-dev

## Domains

- pt-concepts
- pt-transpile
- pt-capabilities

## Trigger

当用户询问 Pt 自身相关知识（架构、转译流程、能力边界）时按以下流程回答；其余对话正常响应，勿套用本流程。

## Boundaries

### identify-topic
- deps: []
- desc: 识别用户问题属于哪一类（概念 / 转译流程 / 能力边界）

### cite-domain
- deps: [identify-topic]
- desc: 按类别引用对应 Domain 的 Scene 段

### compose-answer
- deps: [cite-domain]
- desc: 把 Scene 段与 Manual 模块组合成可执行回答
```

**字段职责**：
- `## Channel`：引用哪个 Channel（结构复用）
- `## Domains`：具体用哪些 Domain（配置组合）
- `## Trigger`：触发条件（实例级，每个 Blueprint 不同）
- `## Boundaries`：流程节点 DAG（实例级）

**Trigger 和 Boundaries 放 Blueprint 不放 Channel**——每个场景的触发条件和流程步骤都不同（pt/article/risk-check 各异），是实例配置不是可复用结构。

### 0.4 产物层：Context

**Context 是 Blueprint 编译后的输出**——把多个 Domain 的内容按 Channel 定义的结构组装成按各上下文模块聚合的文档。Context 是**物理文件**（`.pt/cache/*.context.md`），缓存复用，避免每次重新编译。

```markdown
# pt.context.md  （Blueprint「pt」编译后的 Context）

## Scene
  （所有引用 Domain 的 ## Scene 段聚合，按 Channel.layout 编排）
  ### 全局约束
  - [ ] ...
  ### 流程
  ① identify-topic — ...
  ### 模块「pt-concepts」
  **术语**
  - **Pt 是什么**：Pi 扩展，把业务知识资产...

## Manual
  （所有引用 Domain 的 ## Manual 段聚合）
  ### 可用手册
  - pt-transpile: 转译流程手册

## Term
  （若 Channel 声明了 Term 模块，则聚合各 Domain 的 ## Term 段）
```

**Context 的内容模块对应 Pi Agent 不同地方的 Prompt**：
- `## Scene` 模块 → 注入 System Prompt（`before_agent_start`）
- `## Manual` 模块 → 注入 Context Message（`input` 事件 transform）
- 其他模块（`## Term` 等）→ 不直接注入，供 Scene/Manual 引用或未来扩展

**内容由 Domain 定义**，因此 Context 的内容可以是普通文本，也可以是执行描述（协助 LLM 推理或告知 LLM 如何执行）。Pt 产出的是结构化上下文文档，LLM 做推理。

### 0.5 模块 → 注入目标映射（固定约定起步）

当前固定约定（v7 起步）：

| Context 模块 | 注入目标 | Pi 机制 |
|---|---|---|
| `## Scene` | System Prompt | `before_agent_start` 事件注入 |
| `## Manual` | Context Message | `input` 事件 transform（Pt 接管 `/name args` 展开） |

**未来扩展**：Pt 增加一个 CLI，让用户选择某个 H2 模块作为 `/模块名` 指令给 Pi 用。当前先固定 `/scene`，未来调整。

**Context Message 是 Pt 的编译输出术语**——内容模块才是对应 Agent 里不同地方的 Prompt。Context Message 替代 v6 的 "Manual/user message" 叫法，名实相符（Context 的消息形态产物）。

### 0.6 完整数据流

```
┌─ 编译期（session_start 或 /blueprint 切换时）─────────────────┐
│                                                                │
│  Channel（结构）─┐                                              │
│                   ├──→ Blueprint ──[compile]──→ Context 文件    │
│  Domain[] ───────┘    （配置）        （.pt/cache/*.context.md） │
│                                                          ↓      │
│                                                     hash 缓存    │
└────────────────────────────────────────────────────────────────┘
                           ↓ Pt 读取 Context 文件
┌─ 注入期 ──────────────────────────────────────────────────────┐
│                                                                │
│  Context.## Scene  ──→ 注入 System Prompt（每轮 before_agent） │
│  Context.## Manual ──→ 待命（用户 /name args 或 LLM 自选触发） │
│                                                                │
└────────────────────────────────────────────────────────────────┘
                           ↓ 用户 `/name args`
┌─ 实例化期（轮次级）───────────────────────────────────────────┐
│                                                                │
│  Context.## Manual + 参数 ──→ Context Message ──→ input 事件   │
│  （binder 展开模板，产出操作手册实例）                           │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

### 0.7 缓存与失效

Context 是物理文件，缓存复用。**失效策略：hash(Domains + Channel + Blueprint) 组合哈希**——三者任一变化即失效重编译。

```
Context 文件头记录源 hash：
  source-hash: <Domains 内容哈希 + Channel 内容哈希 + Blueprint 内容哈希>

Pt 读取 Context 时：
  1. 重算当前源的 hash
  2. 与文件头 hash 比对
  3. 一致 → 直接用缓存
  4. 不一致 → 重新编译，覆盖文件
```

### 0.8 Domain H2 段与 Domain Type 的关系

两个正交维度：
- **H2 段名** = 上下文模块类型（Scene/Manual/Term/扩展）——决定内容**去哪个注入点**
- **Domain Type** = 内容性质标签（term/workflow/stack/扩展）——决定各 H2 段内部**内容格式**

```
Domain「pt-concepts」（type: term）
  ├─ ## Scene   → 公理列表（What：是什么）   → Context.## Scene → System Prompt
  ├─ ## Manual  → 定理列表（Why：为什么）     → Context.## Manual → Context Message
  └─ ## Term    → 术语表（内部模块，不直接注入）
```

**type 决定 H2 段内部格式，H2 段名决定内容去向**——两者独立扩展。加新 type = 加 renderer；加新模块 = 加 H2 段 + Channel 声明。

### 0.9 术语速查

| 术语 | 定义 |
|---|---|
| **Domain** | 内容层模块，承载语义定义与上下文模块内容，用 H2 分段 |
| **Domain Type** | Domain 上的标签（term/workflow/stack/扩展），区分各 H2 段内部内容格式 |
| **H2 段** | Domain 内的上下文模块（`## Scene`/`## Manual`/`## Term`/扩展），段名决定注入去向 |
| **Channel** | 结构层模块，定义通道含哪些上下文模块 + 编排策略，跨项目复用 |
| **Blueprint** | 配置层模块，Channel + 具体 Domains + trigger + boundaries，每场景一份 |
| **Context** | 产物层文件，Blueprint 编译输出，按模块聚合多 Domain 内容，缓存复用 |
| **Context Message** | Pt 编译输出术语，Context 的 `## Manual` 模块注入 input 事件的产物 |
| **System Prompt** | Context 的 `## Scene` 模块注入 before_agent_start 的产物（Pi 精确术语） |
| **binder** | 把 Context 的 `## Manual` 模块里 workflow-Domain 的 steps 模板用参数填充，产出 Context Message 实例 |
| **source-hash** | Context 缓存失效依据，hash(Domains + Channel + Blueprint) 组合 |
| **module → injection 固定约定** | `## Scene`→System Prompt, `## Manual`→Context Message（v7 起步，未来可 CLI 选） |

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
    const blueprint = await readAsset(join(cwd, ".openxenon/assets/blueprints", `${blueprintName}.md`));
    const refs = parseBlueprintRefs(blueprint);
    const [domain, workflow, stack] = await Promise.all([
      readAsset(join(cwd, ".openxenon/assets/domains", `${refs.domain}.md`)),
      readAsset(join(cwd, ".openxenon/assets/workflows", `${refs.workflow}.md`)),
      readAsset(join(cwd, ".openxenon/assets/stacks", `${refs.stack}.md`)),
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
- Context → 产物层（物理文件 .pt/cache/*.context.md）
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
│   ├── cache.ts               # Context 文件读写 + hash 校验（.pt/cache/*.context.md）
│   └── index.ts               # 后端入口
├── schema.ts                  # v7 IR 类型（Domain/Channel/Blueprint/Context 四层）
├── transpile.ts               # 三段式链路：parse → compile → cache → render
├── config.ts                  # 读 .pi/settings.json + 探测 Blueprint
├── index.ts                   # Pi 事件调度
└── package.json               # @issac/pi-pt，pi.extensions: ["./src/index.ts"]

资产目录：
.openxenon/assets/
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
