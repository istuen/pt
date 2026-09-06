# Pt 定位文档（Positioning）

> **用途**：Pt 的设计基准。讲 Pt / 写文档 / 做决策时以此为准。
> **状态**：定稿。推导过程保留，便于回溯为何这样定。
> **关联**：README 的 "What is Pt" 是本文档的面向用户浓缩版。

---

## 1. Pt 的边界：不修 LLM，在约束内做工程

**核心纠正**：Pt 不"解决" LLM 的根本约束。失忆和被动是 LLM 的本性，不是 bug，Pt 修不了也不试图修。

Pt 的正确定位是：**接受 LLM 的本性作为给定约束，在约束内做工程**——既然 LLM 每轮要自带背景才能高质量推理，Pt 就把"提供背景"这件事工程化。不是治 LLM 的病，是给 LLM 的工况配一套工程方案。

**不做什么**（边界）：
- 不是知识库——知识在 Pt Domain MD 里，git 管，Pt 不存储
- 不是 RAG——没有向量检索，是全量按配置编译注入，不是按查询捞片段
- 不是 Agent 框架——不决定 Agent 怎么推理，只管喂什么上下文
- 不是 prompt 模板引擎——不是变量填空，是聚合编译（多 Domain 的 H2 段按聚合组聚合 + 按 inject 分发）
- 不修 LLM 的根本问题——在现有 LLM 会话机制上工作

---

## 2. 方法论归属：上下文工程 + 知识工程

Pt 落在两个已有工程学科的交集：

- **上下文工程**：怎么结构化交付上下文——固定提示词 + 参考索引保持会话背景（静态面），参考手册供 LLM 按需查阅提高执行效果（动态面）
- **知识工程**：怎么把人类领域知识资产化——git 管理、可积累、可组合复用

Pt 是这两个工程的交集：知识工程把领域知识变成资产，上下文工程把资产组装成结构化上下文。**配置是两者的连接点**——把知识工程产出的资产，组合成上下文工程需要的结构，适应不同会话。

---

## 3. 产品术语链：Pt Domain → Pt Profile → AgentContext

三个产品术语，前缀差异编码数据流方向：

| 术语 | 性质 | 谁的 | 说明 |
|---|---|---|---|
| **Pt Domain** | 用户写的原料 | Pt 体系内 | 领域知识资产，文档容器 |
| **Pt Profile** | 用户配的组合 | Pt 体系内 | Blueprint + 多个 Pt Domain 组合 |
| **AgentContext** | Pt 编译的产物 | 交付给 Agent | 注入给 Agent 的上下文 |

**前缀差异是语义设计**：
- "Pt" 前缀（Pt Domain / Pt Profile）= Pt 体系内的创作概念，用户写/配
- "Agent" 前缀（AgentContext）= 交付给 Agent 的产物，Pt 编译产出
- 前缀从 Pt → Agent 画出数据流方向：**知识从 Pt 体系出发，交付给 Agent**

### 为什么不换 AgentContext → Pt Context

1. **丢消费者信息**——"Agent Context" 名字就说"这是 Agent 要用的"。"Pt Context" 读成"Pt 的上下文"，但 Pt 不消费上下文，Pt 是生产者
2. **丢数据流信号**——三个都 "Pt X" 看不出"最后一步交付给 Agent"
3. **和 tagline 不一致**——tagline `Turn domain knowledge into agent context` 用 agent context
4. **语义略拗**——Pt Domain/Pt Profile 读作"Pt 的概念"通顺；Pt Context 读作"Pt 的 Context 概念"略怪，Context 不是 Pt 持有的概念，是 Pt 产出的东西

### Agent Runtime（技术层，不在产品描述显化）

完整数据流是四段：

```
Pt Domain → Pt Profile → AgentContext → Agent Runtime
（写知识）   （配组合）   （编译产物）    （运行消费）
```

前三段是 Pt 的，第四段是 Agent 的。Agent Runtime 是 AgentContext 被消费的环境（Pi 把会话提示词注入 system_prompt，把回合消息注入 context_message，LLM 在 Runtime 里推理）。

**Agent Runtime 是 Agent 侧概念，不是 Pt 产物**。产品描述停在 AgentContext（"编译出注入给 Agent 的上下文"），Runtime 不显式提——Pt 不越界讲 Agent 怎么消费。AgentAdapter 作为"Pt 和 Agent 的桥梁"在架构文档里讲。

### 中文处理：保留英文不译

中文文档里三个核心术语保留英文不译，作品牌术语链：

| 术语 | 中文释义（非译名） |
|---|---|
| Pt Domain | 领域知识资产 |
| Pt Profile | 上下文配置 / 智能体画像 |
| AgentContext | 智能体上下文 |

**不译的理由**：译名容易撞语义——"领域"撞 DDD 的 bounded context，"配置"撞通用 settings。不译反而更准，读者知道这是 Pt 的专有概念。

---

## 4. 技术特性：三层转化

Pt 的第一特性是**转化**，具体是三层转化的叠加。这是 Pt 区别于 RAG/知识库的根本（RAG/知识库只是存储知识，Pt 是转化知识）：

### 转化一：配置化（存储 → 可组合配置）

知识库的知识是静态存储（存了等人查）。Pt 把 Domain 转化成**配置项**——被 Blueprint 声明、被 Profile 选择、可组合出不同场景。同一批 Domain，不同 Profile 组合出不同上下文。

**区别于 RAG/知识库**：RAG 的知识是被动的（等查询命中才出），Pt 的 Domain 是主动的（被配置选了就进编译）。知识从"存了等用"变成"配了就编译"。

### 转化二：静态 + 动态分面（一坨 → 双面上下文）

知识库把知识当一坨内容存。Pt 把 Domain 内容转化成**两面**：
- 静态面（会话提示词 / session）：每轮重注，解决失忆
- 动态面（回合消息 / turn）：按需触发，解决被动 + 省 token

**区别于 RAG/知识库**：RAG 是按查询捞片段（动态单一），知识库是全量存储（不分动静）。Pt 的双面是直接对应 LLM 两个约束的结构化解法——不是检索策略，是注入结构。

### 转化三：多 Domain 聚合（分散 → 按聚合组聚合）

知识库的知识是各条独立存。Pt 把多个 Domain 的 H2 段**按聚合组聚合**——pt-quality 的 Rules + dev-workflow 的 Flows + pt-collab 的 Checklists 都进"参考手册"聚合组，编译成一个连贯的参考手册面。

**区别于 RAG/知识库**：RAG/知识库的知识是分散条目，检索结果也是片段拼接。Pt 的聚合是结构化的——按 Blueprint 的 modules 声明聚合，产出的是有组织的整体，不是片段堆。

### 三层转化对应 Pt 的核心机制

- 转化一（配置）→ Profile 层
- 转化二（双面）→ Context 结构（session + turn）
- 转化三（聚合）→ compile 层（按聚合组聚合多 Domain）

缺一不可。

---

## 5. 产品特性（用户视角）

从"Pt 怎么工作"（技术）切到"Pt 改变了用户什么"（产品）。

### Before → After

**Before Pt**：
- 每次开新会话从零开始，手动复制背景进 prompt
- 知识散在聊天记录/脑子/临时文件里，会话结束就丢
- 换场景（项目/任务/角色）= 重新写一遍 prompt
- Agent 失忆——同样的事要重复说
- 知识无法积累，每次重造

**After Pt**：
- 开会话自动带正确背景，不用手动喂
- 知识是 git 管理的资产，持续积累不丢失
- 换场景 = 换一份配置，知识不用重写
- Agent 每轮带着背景思考，像"记得"
- 知识越写越多，越用越富

### 三个定义性产品特性

**1. 知识一次性投入，持续复用**
写一次 Domain，之后每次会话、每个场景都自动带上。知识从"消耗品"变成"资产"。用户愿意投入写好知识，因为知道会持续复用。
- 技术对应：资产化编译
- 区别于手写 prompt：手写用一次就丢，Pt 资产持续工作

**2. 场景与知识解耦**
知识（Domain）和场景（Profile）分开。同一批知识，不同 Profile 组合出不同场景。换场景不换知识，加知识不动场景。
- 技术对应：配置驱动场景
- 区别于"一个场景一套 prompt"：手写 prompt 场景和知识绑死，Pt 里两者独立组合

**3. Agent 有恒定背景 + 按需深查**
Agent 每轮带稳定背景（不失忆），需要细节时查阅手册（不被动）。背景不爆 token，手册不占常驻空间。
- 技术对应：双面注入
- 区别于 RAG：RAG 按查询捞片段（可能漏），Pt 按配置全量注入背景（稳定）+ 按需触发手册（精确）

### 技术 vs 产品 对照

| 技术特性 | 产品特性 | 关系 |
|---|---|---|
| 资产化编译 | 知识一次性投入持续复用 | 编译是实现复用的手段 |
| 配置驱动场景 | 场景与知识解耦 | 配置是实现解耦的手段 |
| 双面注入 | 恒定背景 + 按需深查 | 双面是实现这个体验的手段 |

技术特性是"怎么做"，产品特性是"做到了什么"。**产品特性是目的，技术特性是手段。** 讲给用户听用产品特性，讲给实现者听用技术特性。

---

## 6. Pt Domain 的容器定位

**Pt Domain 是文档容器，用户决定装什么。**

Pt 不预设内容性质分类。三组维度（规则与经验 / 知识与使用方式 / 项目内与外部系统）是**示例性质**，帮用户第一认知，不是 Pt 强制的内容分类：
- 规则与经验——涵盖显性规则 + 隐性经验
- 知识与使用方式——涵盖内容型 + 方法型
- 项目内与外部系统——涵盖项目内知识 + 外部系统操作方法

用户决定装什么，Pt 编译成 Agent Context。

**和技术层的对齐**：技术层"H2 段名是 schema 选择器，不是 Type 分类"——产品层说"容器，用户决定装什么"，技术层说"H2 段是结构，Type 不分类"。两层一致。

**领域知识不限于知识内容**：Domain 也可以是外部系统的使用方式（操作方法）。这扩展了 Domain 的性质：
- 内容型 Domain：编码知识本身（项目背景、规范、流程）
- 方法型 Domain：编码外部知识/工具的使用方式（怎么用某 API、何时查某资源）

方法型 Domain 不包含知识本体，包含"使用方法"——对应 Trigger 段（何时触发）和 Flows 段（怎么执行）。

---

## 6a. 四层命名分层（职责 vs 机制 vs 实现）

Pt 的命名分四层，各层用各自的词，Adapter 做层间映射：

| 层 | 概念 | 词 | 用在哪 |
|---|---|---|---|
| 产品层 | 职责语义 | 会话背景 / 参考手册 | README / 用户文档 / What is Pt |
| Pt 结构层 | Blueprint 聚合组 name（用户自定义语义名） | 会话背景 / 触发索引 / 参考手册（默认 Blueprint 示例值） | Blueprint YAML |
| Pt Session 层 | 注入位置枚举（供给侧） | session / turn | Blueprint target 字段 / Pt Session 供应的注入位置 |
| 契约接口层 | Pt 给 Adapter 的接口名 | Session Inject / Turn Inject | AgentAdapter 实现代码 |
| Agent Runtime 层 | 具体 Agent API 名 | system_prompt / context_message（Pi API） | Adapter 内部映射的终点 |

**关键澄清**：Session Inject / Turn Inject 是 Pt 的契约接口名，**不是 Pi 的 API 名**。Pi 的 API 名是 system_prompt / context_message，在 Agent Runtime 层。AgentAdapter 做契约接口 → Runtime API 的映射。

**Blueprint name 是用户自定义的**——"会话背景/参考手册/触发索引"是 Pt 默认 Blueprint（`dev-knowledge.blueprint.yaml`）的示例值，不是 Pt 固定术语。Pt 固定的是 target 枚举（session/turn）和 modules 段类型。用户的 Blueprint 可以用任何语义名，Pt 不强制。

**为什么要分层**：术语混合会丢信息——
- 产品层讲"做什么"（职责），用"会话背景/参考手册"
- Pt 结构层讲"注入组叫什么"（用户命名空间），用 Blueprint name
- Pt Session 层讲"有什么位置可选"（供给侧），用 session/turn
- 契约接口层讲"给 Adapter 的接口名"（技术契约），用 Session Inject / Turn Inject
- Runtime 层讲"具体 Agent API"（实现），用 system_prompt / context_message

强行统一任一层到其他层都会丢信息——比如用"会话提示词"做产品词会和 Runtime 层 system_prompt 撞；用"参考手册"做契约接口名又不传达机制语义。

---

## 6b. Blueprint 结构：聚合点为设计单位

### 两层职责分离

Blueprint **不是定义聚合组位置**——注入位置（session/turn）由 Pt Session 供给侧定义。
Blueprint **是设计 Domain 内容如何聚合**——这是 Blueprint 的本职。

两层分工：
- **Pt Session**（供给侧）：定义有哪些可用注入位置（当前 session/turn）。Pt Session 演化 → 可能有新位置
- **Blueprint**（需求侧）：设计聚合点——从 Domain 聚合什么、注入到哪个 Pt Session 位置

### 结构语义

```yaml
groups:
  - name: 会话背景        # 聚合组名（人类自定义语义名）
    inject: session       # Pt Session 枚举值（技术字段，用户不能自由发明）
    mode: hybrid
    modules: [Scene, Participant]
  - name: 触发索引        # 独立的中间层，桥接会话背景与参考手册
    inject: session
    modules: [Trigger]
  - name: 参考手册
    inject: turn
    modules: [Rules, Flows, Checklists]
```

- **name** = 用户自定义语义标签（Pt 不强制叫什么）
- **inject** = Pt Session 枚举值（用户不能自由发明）
- **modules** = 这组聚合哪些 Domain H2 段

### 字段命名：target → inject

Blueprint 字段名从 `target` 改为 `inject`：
- `target: session` 读作"目标是 session"——抽象，要理解"什么的目标"
- `inject: session` 读作"注入到 session"——直接表达动作意图

YAML 字段用动词常见（`extends`/`requires`），`inject` 不违和。语义上 `inject` 比 `target` 更清楚传达"这组聚合内容注入到哪"。

---

## 6c. Trigger 中间层与隐性触发机制

### 隐性触发机制（设计特性）

Session（会话背景）和 Turn（参考手册）两个聚合组之间有语义依赖，但 Pt 不结构化建模这个依赖：

- Turn（参考手册）的内容是"按需注入"——但"按什么需"？
- 触发逻辑在 Session（会话背景）里——具体在 Trigger 段（"有什么手册、何时查"的索引）
- LLM 看 Session 里的 Trigger 索引，判断"需要查某手册"→ 触发 Turn 注入

**但 Session→Turn 的触发关系是隐性的**：
- Pt 不强制 Session 必须有 Trigger 段
- Pt 不校验 Trigger 索引的内容是否对应 Turn 里的手册
- Pt 不建模"这个 Trigger 引用那个手册"的显式链接

完全靠 Domain 作者在 Trigger 段里写清楚索引——如果作者没写好，LLM 不知道有手册可查，Turn 内容永远不会被触发注入。这是**作者责任，不是 Pt 结构保证**。

### Trigger 拉出作中间层

为让隐性的桥接角色可见，默认 Blueprint 把 Trigger 拉出来作独立组（仍 inject: session），三层概念模型：

```
会话背景（Session）    — 身份 + 主题（Scene, Participant）
    ↓ 指向
触发索引（Session）    — 有什么手册、何时查（Trigger）
    ↓ 触发
参考手册（Turn）       — 执行指导（Rules, Flows, Checklists）
```

三层概念，两个聚合组。触发索引仍注入到 session（LLM 每轮要看索引才知道何时查手册），但它概念上是"中间层"——桥接背景和手册。

### 默认 Blueprint 组织 vs Pt 结构强制

和"name 是用户自定义"一致——三层是 Pt 默认 Blueprint 的推荐组织，用户可以改（把 Trigger 并回会话背景，或拆得更细）。Pt Session 只定义注入位置（session/turn），不强制必须分三层。

### 代码支持

代码原生支持同 inject 多组聚合——`renderSessionInject` 按 inject 聚合（不是按 name 分发）。两个 `inject: session` 的组会被拼成一个 Session Inject。无需代码改动，只改 Blueprint 资产。

---

## 7. What is Pt（4 条定稿）

已落 README。按"从用户已知 → 机制 → Domain 收尾"的渐进线路组织——用户从最熟的"提示词"切入，自然走到"怎么构建""从哪来""信息源是什么"。

1. **Pt Profile 注入会话提示词作为固定输入，提供回合消息由 LLM 推理选择使用；可在会话内切换，换配置即换场景。**
2. **Pt Profile 使用 Blueprint 与 Pt Domain 组合配置，一次配置，多会话使用。**
3. **Blueprint 设计会话提示词、回合消息与 Pt Domain 的聚合结构。**
4. **Pt Domain 是文档容器，用户决定装什么——规则与经验、知识与使用方式、项目内与外部系统；内容编译后成为 Agent Context。**

### 叙事线路设计

从用户最熟（提示词）切入，渐进深入到机制，落在 Domain 收尾——避免 Domain 作开头导致认知脱节：

```
会话提示词 + 回合消息（用户最熟：每轮要喂的）
    ↓ 怎么构建出这个上下文
Pt Profile（配置组合，含 Blueprint + Domain）
    ↓ 更深一层
Blueprint（聚合结构设计）
    ↓ 信息源是什么
Pt Domain（文档容器，资产化）
    ↓ Domain 不只是内容
外部系统使用方式（收尾）
```

**为什么 Domain 不作开头**：Domain 一词有 DDD 包袱（bounded context）和知识库联想（knowledge domain），作开头要先消除已有联想再建新认知，成本高。放结尾反而稳——用户已理解 Pt 做什么，最后才问"内容源叫什么"，Domain 是自然命名，不需预先消除包袱。

---

## 8. 通用描述（对外表达）

去掉 Pt 内部术语，用通用概念表达——让不懂 Pt 的人也能听懂。守两条原则：
- **说效果不说机制**——"每轮带背景""需要时查手册"是行为效果，不是注入机制
- **说动作不说结构**——"组装"是动作，"四层模型"是结构。动作好懂，结构要学

### 三档表达（按场合）

**最短（tagline 级）**：
> Turn domain knowledge into agent context / 把领域知识转化为智能体上下文

**一句话（电梯陈述）**：
> Pt 是一个上下文组装器：把分散的项目知识，按场景配置组装成智能体每轮对话带的背景，需要时还能查阅详细手册。

**一段话（README 开头级）**：
> LLM 每次会话从零开始，知识在权重里但不主动浮现，所以每轮输入都得自带背景——手动写不可持续。Pt 把这件事自动化：你把项目知识写成结构化文档，用配置定义场景，Pt 每次会话自动组装成上下文注入——静态背景每轮重注，详细手册按需触发。换场景换配置就行，知识不用重写。

### 关键词选择

- **"组装"而非"编译"**——"编译"是技术词，"组装"是通用词，更准表达 Pt 做的事（聚合多 Domain 成整体）
- **"分散的项目知识"而非"领域知识"**——"领域知识"有 DDD 包袱，"项目知识"更普适
- **"背景"而非"上下文"**——通用表达里用"背景"更直观；tagline 仍用"上下文"作品牌定位语

两套表达服务不同场合，不矛盾：tagline 用术语（正式），通用描述用口语词（降维给非技术读者）。

---

## 9. 命名决策记录

### 9.1 为什么保留 pt（不改 acc）

**评估结论**：pt 保留，不改 acc。加 tagline `Turn domain knowledge into agent context` 落实。

**关键纠正**：acc（Agent Context Compiler）编码的是"编译动作"，和 AgentAdapter 无关——不是"Agent-agnostic 品牌"。但即使纠正后，acc 仍不如 pt：

| 维度 | pt（铂，事物名词） | acc（缩写） |
|---|---|---|
| 品牌感 | 强（有个性、像产品名） | 弱（像内部技术代号） |
| 功能编码 | 不编码（tagline 负责） | 编码（但绑死 Compiler） |
| 记忆锚点 | 铂的意象 | 首字母映射 |
| 未来演化 | 不绑死 | 绑死"Compiler"语义 |

**真正的好记名字几乎都不编码功能**——Apple 不叫 "pc"，Rust 不叫 "mfc"。编码功能是缩写的活，不是品牌名的活。pt + tagline 是 100% 方案，acc 不但不加分反而减分（丢品牌个性）。

详见 `.pt/docs/designs/pt-to-acc-brand-migration-evaluation.md`。

### 9.2 为什么 tagline 用"转化"而非"转移"

- **变成 / turn into**：形态转换——内容从一种形式变成另一种（推荐）
- **转移 / transfer to**：位置搬迁——内容不变从 A 搬到 B（低估 Pt，暗示只是搬运）

Pt 不是搬迁是转换——内容经过筛选、聚合、结构化，不是原样搬运。用户会想"那我直接 cat 文件进 prompt 不就行了？"——Pt 的卖点正是 cat 做不到的形态转换。

### 9.3 为什么 Pt Domain 不译"Pt 领域"

"Pt 领域"读起来像"Pt 这个范围"，容易被读成 Pt 软件本身的范围，撞 DDD 的"领域"。保留 "Pt Domain" 英文，读者知道是 Pt 专有概念，不是泛指的"领域"。

### 9.4 为什么 Pt Profile 不译"Pt 配置"

"配置"太通用——任何软件都有配置，"Pt 配置"读起来像 Pt 的设置项，弱化"一套完整画像"的语义。保留 "Pt Profile" 英文，作品牌术语链。

### 9.5 为什么 Agent Runtime 留技术层

Agent Runtime 是 Agent 侧概念，不是 Pt 产物。产品描述停在 AgentContext——Pt 产出的东西。Runtime 是 Agent 怎么消费，Pt 不越界讲。AgentAdapter 作为桥梁在架构文档里讲。

### 9.6 为什么"What is Pt" 从提示词开头而非 Domain

Domain 作开头认知脱节——DDD/知识库联想成本高。从"会话提示词"切入（每个用 Agent 的人都懂"每轮要喂 prompt"），零联想成本，渐进深入到 Domain 收尾。详见 §7 叙事线路设计。

---

## 10. 相关文档

- **README.md** — 面向用户的浓缩版（含 "What is Pt" 4 条）
- **pt-terminology.md** — 术语决策记录（IR/函数/文件名等技术术语）
- **pt-context-first-narrative.md** — Context-first 倒推叙事样本（P3 待执行）
- **pt-to-acc-brand-migration-evaluation.md** — pt vs acc 品牌迁移评估（结论：不改）
- **pt-asset-layering.md** — 分层模型与转译架构（技术层权威定义）
