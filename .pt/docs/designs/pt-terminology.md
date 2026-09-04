# Pt 术语定型

> **状态**：已定稿（2026-09-02，多轮讨论收敛）
> **性质**：决策记录。本文档是 Pt 命名的最终权威，后续代码/资产/文档改动以此为准。
> **关联**：`pt-asset-layering.md §0`（语义基准，待按本文档重写为 Context-first 倒推叙事）、`pt-context-first-narrative.md`（倒推叙事样板）

---

## 1. 目的

Pt 经多轮命名讨论，收敛出一套定型术语。本文档记录每个术语的**最终决定 + 理由**，并登记**不采纳方案及否决原因**（防止反复讨论）。后续所有代码、资产、文档以此为准。

---

## 2. 术语总表

| 层 | 术语 | 决定 | 消费者 | 一句理由 |
|---|---|---|---|---|
| 内容层 | **Domain** | 保留 | Pt 编译器 | Pt 自身容器，DDD 心智普及，依赖反转下"只认 Domain 不绑死格式"成立 |
| 结构层 | **Blueprint** | 保留 | Pt 编译器 | Pt 自身容器，声明式结构=蓝图，基础设施领域通用 |
| 配置层 | **Profile** | 保留 | Pt 编译器 | Pt 自身容器，profile=配置集合，软件工程通用词 |
| 产物层 | **Context → Agent Context** | **改名** | Agent | 唯一消费者是 Agent；加修饰说明去向；归入 Agent 概念族（AgentAdapter/AgentAPI/AgentUI/AgentContext） |
| Domain H2 段 | **Manual** | 保留（=模板） | — | Domain H2 段名，手册模板声明 |
| 执行追踪 | **Manual → Manual Run** | **改名**（面向用户） | — | .pt/manuals/ 里的实例文档，与模板区分生命周期 |
| 命令 | **/pt-context → /pt-profile** | **改名** | — | 操作对象是 Profile（参数/存值都是 profile name），名实相符 |
| 命令 | **/pt** | 保留 | — | Pt 工具总入口，查看 Agent Context 产物 |
| 命令 | **/manual** | 保留 | — | 触发手册模板实例化，动词短语自然 |

---

## 3. 逐项决定与理由

### 3.1 Domain / Blueprint / Profile — 保留（不加 Agent 修饰）

**判断标准**：消费者是不是 Agent。Agent 见不到的层，不冠 Agent 之名。

- Domain / Blueprint / Profile 的消费者都是 **Pt 编译器**（compile 读这三者产出 Agent Context）
- Profile 在编译完就退出舞台——AgentAdapter 全部方法签名是 `(ctx, blueprint, domains)`，**无 Profile 参数**（已核实 `src/schema.ts:352-374`）
- 三者同属"Pt 自身容器"（编译器输入），命名保持同族、不加 Agent 修饰

**三层职责定位（消费者链内的细分）**：

| 层 | 职责 | 一句话 |
|---|---|---|
| **Blueprint** | Agent Context 结构 + LLM 注入点 | Modules 列表 = Agent Context 的 schema；Blueprint 让 Agent Context 结构化（非平铺）。**结构先于内容** |
| **Profile** | Session 配置（分情况注入） | 选 Blueprint 结构 + 选 Domain 原料；不同 Profile 产出不同 Agent Context，注入不同场景 |
| **Domain** | 原料（最后） | 填充 Blueprint 结构的具体内容；H2 段（Scene/Trigger/Manual/Participant/...）是聚合点供给侧 |

**派生链（结构先于内容）**：Blueprint 在 Domain 之上——Blueprint 是结构框架，Domain 是填充原料。没有 Blueprint，Domain 内容不知去哪；没有 Domain，Blueprint 是空架。

**不采纳 Agent Profile**：消费者链不对称（Profile 不是 Agent 消费）；且"Agent profile"通用语义=Agent 人格=Agent Context 静态面，会和 Context 静态面撞名，加剧混淆。

### 3.2 Context → Agent Context — 改名

**理由（四重）**：
1. **自说明去向**：原名 Context 没表达"给谁用"；Agent Context 字面即"给 Agent 的上下文"
2. **消除撞名**：原名撞 Pi 的 `context_message`（不同概念同名）；"agent context" vs "context_message" 连词都不同，彻底不撞
3. **归入概念族**：与 AgentAdapter / AgentAPI / AgentUI 同族，命名整齐
4. **不跳层**：Context 是注入前材料，Agent 是注入目标，主客体清晰（不像 Assistant 跳到"注入后状态"）

**Agent Context 的结构（两面模型）**：

| 面 | 注入位置（Pi） | 时效 | 心智 | 承载 |
|---|---|---|---|---|
| 静态面 | System Prompt（`before_agent_start`） | session 级，每轮 | 会话基准 | Domain 的 Scene + Trigger 段聚合 |
| 动态面 | Input Message（`input` 事件触发） | turn 级，按需 | 推理选择 | Domain 的 Manual 段聚合 |

**Session 里用户同时关心两件事**：
- Profile（意图层）——我选了什么配置
- Agent Context（效果层）——实际注入了什么

Profile MD 是配置项，看不出注入内容，所以需要 `/pt status|raw|full|flows` 暴露 Agent Context 的不同切面。`/pt status` 输出已天然分裂成两簇（Profile 簇 + Agent Context 簇，已核实 `src/commands.ts:34`）。

### 3.3 Manual（模板）/ Manual Run（实例）— 拆分

Manual 在 Pt 里实际承担三层，面向用户全叫同一个词，造成混淆：

| 层 | 实体 | 性质 | 代码类型 |
|---|---|---|---|
| Domain H2 段 `## Manual` | 手册**模板**声明 | 模板 | `FlowTemplate[]` |
| `.pt/manuals/*.md` | 手册**实例**文档 | 实例（一次执行追踪） | `ManualDocResult` |

**决定**：
- Domain H2 段名 `## Manual` 保留（语义清晰，段名开放扩展不动）
- 代码类型 `FlowTemplate`（模板）保留
- 实例文档面向用户改称 **Manual Run**；代码 `ManualDoc*` → `ManualRun*`
- 目录 `.pt/manuals/` 保留（manuals = manual runs 简写，可接受）
- 命令 `/manual:xxx` 保留（动词"按手册跑一次"）

### 3.4 /pt-context → /pt-profile — 命令改名

**理由**：
1. **名实相符**：命令参数是 Profile 名（`listProfiles` 返回），flag 存值也是 profile name——命令名就该用 Profile。当前名实错位已在代码里（用 context 命名的 flag 存 profile 语义）
2. **职责分工清晰**：改完命令族三层各管一段（见 §5）
3. **CLI 惯例**：命令名反映用户做什么（选配置），不是系统做什么（造 Context）

**联动**：
- flag `pt-context` → `pt-profile`
- `.pi/settings.json` 的 `pt.pt-context` → `pt.pt-profile`
- 向后兼容：读时 fallback 旧名 `pt-context`，写用新名

---

## 4. 叙事方向规则

**核心原则**：理解时倒推（产物优先），运行时正向（原料先行）。两方向不矛盾。

| 场景 | 方向 | 理由 |
|---|---|---|
| 代码 / IR / 数据流 | Domain → Blueprint → Profile → Agent Context（正向） | 跟数据流一致，给实现者看 |
| `schema.ts` 类型注释顺序 | Domain → ... → Agent Context（正向） | 跟数据流一致 |
| 对外文档 / README / layering §0 | **Agent Context → Profile → Blueprint → Domain（倒推）** | 产物导向，结构先于内容（Blueprint 在 Domain 之上） |
| 术语速查表 | 倒推顺序 | 与对外叙事一致 |

**派生链（对外叙事用，结构先于内容）**：
```
Agent Context        ← 用户关心的产物：会话知识 + 参考手册
  ↑ Profile 编译产出
Profile              ← Session 配置：选 Blueprint + 选 Domains，分情况注入
  ↑ 引用结构
Blueprint            ← Agent Context 结构：注入点 + target + Modules（= Context schema）
  ↑ 填充原料
Domains              ← 原料：异构领域知识（H2 段 Scene/Trigger/Manual/Participant/...）
```

---

## 5. 命令族定位（三层分工）

```
意图层（Profile 操作）：
  /pt-profile [name]     切换 Profile（编译+注入 Agent Context）

效果层（Agent Context 可见性）：
  /pt status             两簇都看：Profile 意图 + Agent Context 效果
  /pt raw                看静态面：System Prompt 段原文
  /pt full               看静态面：完整 systemPrompt（LLM 实际所见）
  /pt flows              看动态面：可触发手册索引
  /pt manual <proc>      看动态面：手册模板内容

触发层（动态面实例化）：
  /manual <proc> [args]  触发 Input Message 注入（实例化 → Manual Run）
```

---

## 6. 不采纳方案登记（防反复讨论）

### 6.1 已否决方案

| 方案 | 否决理由 |
|---|---|
| Context → Artifact | 撞 AI 执行产物（同义高频）；Pt 自己的 Manual Run 也有 `## 产物` 段 |
| Context → Assistant | 撞 OpenAI Assistants API（产品名）+ 跳层（产物 vs 注入后状态）+ Agent 边界模糊 |
| Context → Profile Context | 修饰词歧义（Profile 是 Pt 专有名当修饰词有歧义）+ 强调来源而非去向 + 概念族孤立 |
| Profile → Agent Profile | 消费者链不对称（Profile 非 Agent 消费）+ 撞"Agent profile"通用语义（=Context 静态面） |
| 合并 profiles + contexts 目录 | git 属性相反（Profile 进 git，Context 不进，已核实 `.gitignore` L5 `.pt/cache/`） |
| name 子目录内放 profile + context | 同因，子目录部分跟踪混乱 |
| Compilation 升为产物结构定义 | Compilation 是缓存配置（cacheDir + split），产物结构由 Blueprint 注入点定义 |
| Blueprint 保留 `agent` 字段 | agent 是运行时选择，不是结构定义；Blueprint Agent-agnostic 化要求移除（见 §11） |
| target 用 Pi 技术名（system_prompt/context_message） | Pi 词汇绑死结构定义；结构术语应来自 LLM 约束（session/turn），AgentAdapter 映射 |

### 6.2 待观察命名（暂不采纳，登记触发条件）

> 以下命名经评估为"偏弱/有误导"但未到"必须改"程度。暂不采纳，登记触发重新评估的条件，避免反复讨论。

| 概念 | 现名 | 问题 | 严重度 | 触发重新评估的条件 |
|---|---|---|---|---|
| Domain H2 段 `## Scene` | Scene | 暗示"一个情境/场面"，实际装背景知识/目录结构/元信息（内容异构） | 低（偏弱） | 新人反馈 Scene 命名不直觉；或出现明显更优候选 |
| Domain H2 段 `## Trigger` | Trigger | 编程 trigger=满足条件自动执行；实际是索引/提示（人工或 LLM 判断后手动触发）。**语义反向** | 中（误导） | 新人反馈 Trigger 误导（实证）；或出现明显更优候选（如 Index，但需验证与 `### Modules` 语义是否撞） |
| Domain H2 段 `## Manual` | Manual | ✓ 符合（手册=详细指南，职责匹配） | — | 不重新评估 |

**为何不现在改 Scene/Trigger**：
1. 无撞名问题（是"不够精准"而非"有冲突"，属优化非修正）
2. 成本不低（8 个 Domain 文件 H2 段名 + Blueprint Modules 引用 + `moduleRenderers` 注册键 + 文档，范围比 Context 改名还广）
3. 无"第一个无缺陷候选"（Trigger 的"索引"替代名 Index 可能撞 `### Modules` 语义，Hint 偏弱，Cue 生僻）

对比 Context→AgentContext 的改名标准：撞名是结构性冲突（必修），Scene/Trigger 是精度问题（可选优化）。

---

## 7. 改动清单

### 7.1 代码改动

| 改动 | 范围 | 性质 |
|---|---|---|
| `interface Context` → `AgentContext` | `src/schema.ts` + 全 `src/*.ts` 引用（约 130 处） | 机械替换 |
| 产物后缀 `.context.md` → `.agent-context.md` | `src/render/cache.ts` | 路径常量 |
| 文件 `src/compile/context.ts` → `agent-context.ts` | rename + import 修正 | 机械 |
| flag `pt-context` → `pt-profile` | `src/index.ts`（registerFlag + getFlag + readProjectSetting） | 含向后兼容 fallback |
| 命令 `/pt-context` → `/pt-profile` | `src/index.ts`（registerCommand） | rename |
| settings key `pt.pt-context` → `pt.pt-profile` | `src/index.ts`（+ fallback 旧 key） | 兼容 |
| 提示文本 `/pt-context` → `/pt-profile` | `src/commands.ts`（flowsText 等）+ `src/index.ts` | 文案 |
| `ManualDoc*` → `ManualRun*` | `src/commands.ts`（buildManualDoc → buildManualRun, ManualDocResult → ManualRunResult） | rename |

### 7.2 资产改动

| 改动 | 范围 |
|---|---|
| `.pt/cache/contexts/*.context.md` 全删 | 后缀变了，强制重编译（cache miss 自动） |
| `.pt/assets/blueprints/*.md` 的 `## Compilation` 移除 | 待办 P4（见 §8） |
| `.pt/assets/blueprints/*.md` 的 `agent: pi` 移除 | 待办 P4（见 §8） |
| `.pt/assets/blueprints/*.md` 的 `target: system_prompt/context_message` → `session`/`turn` | 待办 P4（见 §8） |

### 7.3 文档改动

| 改动 | 范围 |
|---|---|
| `pt-asset-layering.md §0` 重写 | 按 `pt-context-first-narrative.md` 样板改为 Context-first 倒推叙事 |
| 术语速查表 | 倒推顺序，Context/会话知识/参考手册置顶 |
| 所有文档的 "Context" | → "Agent Context"（面向用户语境；代码注释保留简称 Context 可接受） |
| 所有文档的 "/pt-context" | → "/pt-profile" |

---

## 8. 待办优先级

| 优先级 | 待办 | 依赖 |
|---|---|---|
| **P0** | 本文（术语定型） | — 已完成 |
| P1 | Context → Agent Context 代码改名（机械替换 + tsc + verify） | P0 |
| P2 | /pt-context → /pt-profile 改名（含 flag/settings 兼容） | P0 |
| P3 | §0 重写为 Context-first 倒推叙事 | P1（术语名定了才好写） |
| P4 | **Blueprint 定型化（五合一打包）**：①移除 `agent` 字段（→ 全局/Profile 多选配置，见 §11）；②移除 `## Compilation` 段（cacheDir 用 `constants.ts` 常量，split 硬编码 single-file，YAGNI）；③`target` 值改 `session`/`turn`（AgentAdapter 映射，render 去硬编码）；④**载体转 YAML**（Blueprint 是纯结构化无叙事，MD 的 H2/H3 是用叙事格式装非叙事数据，语义错位；转 YAML 后 parser 简化为 `yaml.load() + 校验`，与 frontmatter 同构，人写可读 + git diff 友好；Domain 仍用 MD 因有叙事正文）；⑤**概念名 + 函数名 + 文件名对齐 session/turn**：System Prompt → Session Prompt，Context Message → Turn Message，`renderSystemPrompt`→`renderSessionPrompt`，`renderContextMessage`→`renderTurnMessage`，`system-prompt.ts`→`session-prompt.ts`，`context-message.ts`→`turn-message.ts`，`InjectionTarget` 类型 + `supportedTargets` + render 硬编码全改 `session`/`turn`（AgentAdapter 内部映射到 Pi `system_prompt`/`context_message` API，边界仍在） | P1 |
| P5 | Manual 模板/实例拆分命名（Manual Run，代码 rename） | P0 |
| P6 | ~~stack 死术语清理~~ → **并入 P9**（stack 随 Type 删除一并清除） | — |
| P7 | Agent Context 拆分 prompt.md + manuals.md（by-target split，复活已预留策略） | P1，可选优化 |
| P8 | Blueprint 会话知识加 `Participant` 模块 + me Domain 拆 `## Participant` 段（分离参与者信息与领域背景，me 回归普通 Domain） | **P9**（Domain 是 H2 段容器模型才有意义），零代码改动（generic fallback） |
| **P9** | **Domain Schema 重构（H2 段 schema 驱动）**：①删除 `type` frontmatter 字段（Domain 从 Type 驱动 → H2 段 schema 驱动，一个 MD 可混装多种知识）；②删除 stack（死类型，renderer 全返空）；③Manual 拆段（`## Manual` → `## Rules` + `## Flows` + `## Checklists`，一个 H2 段一个 schema）；④Scene 段统一（workflow 的 externals 合并进 `Term[]`，加 `path?` 字段）；⑤product-design 的 `inv-*` 迁移 Manual → Scene（它是 What 不是 How） | **P4**（Blueprint 先转 YAML，再改 Modules） |

---

## 9. 目录布局决定（不合并）

```
.pt/assets/profiles/pt-dev.profile.md      ← 配置面，进 git（人写、可 diff）
.pt/cache/contexts/pt-dev.context.md       ← 效果面，不进 git（编译产物、缓存）
```

**决定**：保留物理分离。Profile 和 Agent Context 是同一概念的两面（配置面 + 效果面），但 git 属性相反——配置进 git，产物不进。概念统一靠命名（同属 Agent Context 概念族）+ 叙事，不靠物理合并目录。

**类比**：Cargo 的 `Cargo.toml`（进 git）和 `target/`（不进 git）不合并目录，但都属于"这个 crate"的概念。

---

## 10. 验收标准

术语定型落地的验收：
- [ ] `tsc --noEmit` 通过（Context→AgentContext 全替换后类型正确）
- [ ] `npm run verify` 全测试通过
- [ ] `.gitignore` 仍正确忽略 `.pt/cache/`（布局未动）
- [ ] `/pt-profile pt-dev` 能切换并编译注入
- [ ] 旧 flag `pt-context` 向后兼容（fallback 读取成功）
- [x] `pt-asset-layering.md §0` 按 Context-first 倒推叙事重写（Phase term-P3 完成）
- [x] 术语速查表按倒推顺序排列（Phase term-P3 §0.9 完成）

---

## 11. 架构决策：agent 作为编译维度（v9+ 方向，待实现）

### 背景

Blueprint 原有 `agent: pi` 字段（frontmatter），声明用哪个 AgentAdapter。但：
- Blueprint 定位是“Agent Context 结构定义”，应 Agent-agnostic
- `agent` 是运行时选择，不是结构定义的一部分
- 趋势：聚合多 Agent Runtime 的产品已出现，用户可能用不同 Agent 执行同一项目

### 决定

**agent 从 Blueprint 参数变成编译维度配置项**（v9+ 方向，P4 打包实现）。Blueprint 移除 `agent` 字段，彻底 Agent-agnostic。

### 配置模型（多选 + 子集收窄）

```
全局配置（.pi/settings.json）:
  pt.agents: [pi, opencode, codex]     ← 项目支持哪些 Agent（多选）

Profile frontmatter:
  agents: [pi, opencode]               ← 本 Profile 只用其中部分（⊆ 全局，可缺省=全局全集）

编译时:
  transpile(profileName, agentName)   ← agent 作为编译维度参数
    agentName ∈ Profile.agents ⊆ 全局 pt.agents
    → 同一 Profile + Blueprint + Domains 可编译出不同 Agent 版的 Agent Context
```

**Profile.agents 是全局的子集**：全局声明项目可用哪些 Agent，Profile 收窄到本场景只用哪些。这比单值更贴合多 Agent 趋势（同项目多 Agent，但不同场景可能只用部分）。

### 能力缺口显式化

agent 作为编译维度后，AgentAdapter 声明能力（`supportedTargets`），Blueprint 声明需求（`target: session`/`turn`），匹配与否显式：

| Agent | session | turn |
|---|---|---|
| Pi | ✓（→ system_prompt） | ✓（→ context_message） |
| OpenCode | ✓（等价位置） | ✓（等价位置） |
| Codex | ✓ | ✗（不支持，降级处理） |

Blueprint 的 `target: turn` 注入点用 Codex 编译时，CodexAdapter 声明不支持 turn → 显式降级（塞进 session 或跳过），不被 Pi 的名隐藏。

### 实现节奏（克制）

当前只实现 PiAdapter，无第二个 Adapter 验证映射机制。建议：
1. **P4 先做** Blueprint Agent-agnostic 化的静态部分（移除 agent 字段、移除 Compilation、target 改 session/turn）——这些不改编译入口签名，agent 名暂时 fallback 到全局配置或硬编码 `pi`
2. **待第二个 AgentAdapter**（OpenCodeAdapter）实现后，再落实编译维度参数（`transpile(profile, agent)`）和多选配置——有第二个 Adapter 才能验证映射与降级机制

### 不做：同 Profile 多 Agent 版本并存（v9 范围外）

“同一 Profile 同时编译出 Pi 版 + OpenCode 版并存使用”是趋势需求，但当前无实证、且涉及多实例 session 管理复杂度。v9 不做，留作 v10+ 评估。当前单项目单 Agent（Pi）为主场景。
