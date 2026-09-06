# Pt 全景概览

> 本文是 Pt 的权威技术概览。README 讲产品特性 + Quick Start，本文讲完整体系：术语分层、架构、生命周期、资产目录。读者读完应能完整理解 Pt 是什么、怎么工作、怎么扩展。

---

## 一、术语总表（分层用词）

Pt 用四层词表达同一物的不同侧面。混用会丢信息，**每层用每层的词**：

| 层 | 词 | 例 | 消费者 |
|---|---|---|---|
| **产品层** | Session Context / Turn Context / Pt Domain / Blueprint / Pt Profile / Agent Context | README / 用户文档 / What is Pt | 人（用户） |
| **结构层** | group / BlueprintGroup / ProfileGroup / Domain Schema Name（H2 段名） | Blueprint YAML / Profile H2 / schema.ts | Pt 编译器 |
| **契约接口层** | Session Inject / Turn Inject | AgentAdapter / render 函数名 / 文件名 | AgentAdapter |
| **Agent Runtime 层** | system_prompt / context_message | Pi ExtensionAPI 事件名 | Pi Agent Runtime |
| **技术层** | AgentContext IR / .agent-context.md | schema.ts interface / 缓存文件 | Pt 代码 IR |

**关键边界**：
- **产品层 vs Runtime 层**：用户听"Session Context"（产品），开发者看 `system_prompt`（Runtime）——Adapter 做映射
- **结构层 vs 契约接口层**：Blueprint.groups 是结构定义（设计），renderSessionInject 是契约实现（接口）——同一概念在两层的不同视角
- **Pt 前缀 vs 单名**：Pt Domain / Pt Profile 加 Pt（消歧 DDD / 通用 settings），Blueprint 单名（不撞，跨项目复用标识）

### 顶层概念四个

```
产品层（四个顶层概念）
├── Pt Domain              ← 知识原料（文档容器）
├── Blueprint              ← 聚合结构（单名，不加前缀）
├── Pt Profile             ← 配置（引用 Blueprint + 选 Domains）
└── Agent Context          ← 编译产物
    ├── Session Context    ← 会话级固定注入面（每轮重注）
    └── Turn Context       ← 轮次级按需触发面（/manual:xxx 触发）
```

---

## 二、产品特性（用户视角）

### 特性 1：资产化编译（知识复用）

| Before | After |
|---|---|
| 每次会话手动复制粘贴项目知识到 prompt | 写一次 .pt/assets/ 下的 Domain，Pt 自动编译注入 |
| 知识散落在 wiki / 笔记 / 文档各处，无版本控制 | 知识入 git，git 管理 + git diff + 团队协作 |
| 项目成员各自维护自己的 prompt 模板 | 项目级 Profile，团队共享一份配置 |

### 特性 2：配置驱动（场景解耦）

| Before | After |
|---|---|
| 不同项目 / 不同场景硬编码不同的 prompt | 一个 Blueprint，多个 Profile 切换场景 |
| 改知识要改代码 | 改知识只改 Domain md |

### 特性 3：双面注入（背景 + 按需深查）

| 面 | 时效 | 作用 | 触发 |
|---|---|---|---|
| Session Context | 每轮重注 | Agent 的人格/背景/索引 | 自动（before_agent_start 事件） |
| Turn Context | 按需触发 | 需要时查阅的详细内容 | LLM 调 /manual:xxx 或 /<flow-name> |

### 特性 4：Profile 会话内可切换

`/pt-profile <name>` 在会话内切换 Profile——下轮生效，两面内容都变。

---

## 三、技术特性（架构视角）

### 特性 1：四层模型（Pt Domain → Blueprint → Pt Profile → Agent Context）

四个 IR 类型（`src/schema.ts`），数据流单向：Domain → Blueprint（结构） → Profile（配置） → AgentContext（产物）。

### 特性 2：三段式编译（parse → compile → render）

```
src/parse/    (前端) Pt md/yaml → IR
src/compile/  (中端) IR → IR 变换，按聚合组编译
src/render/   (后端) IR → 产物字符串 + 缓存
```

各层只依赖 IR，不跨层互相调用。

### 特性 3：依赖反转（SourceAdapter / AgentAdapter）

Pt 定义接口（SourceAdapter / AgentAdapter），来源和 Agent 实现 adapter。Pt 核心不感知来源格式 / Agent API——加新来源/Agent 只加 adapter，不改核心。

### 特性 4：数据驱动聚合（modName 注册表 + generic fallback）

`compile/agent-context.ts` 维护 `moduleRenderers: Record<modName, fn>` 注册表，按 modName 分发渲染。加新 modName = 调 `registerModuleRenderer("xxx", fn)` 一行注册。未注册的 modName 走 generic fallback 自动聚合。

### 特性 5：缓存复用（sourceHash 失效）

`sourceHash = hash(Profile + Blueprint + Domains)`，三者任一变化即失效重编译。物理文件 `.pt/cache/agent-contexts/*.agent-context.md`。

### 特性 6：双面分面（inject: session / turn）

Blueprint.groups[].inject 字段决定该聚合组注入到哪一面。AgentAdapter 内部映射到 Pi API（system_prompt/context_message）。Render 按 inject 分发，不硬编码模块名。

---

## 四、架构

### 4.1 四层模型图

```
Pt Domain (md)  ───┐
                   ├──► Blueprint (yaml) ──► Pt Profile (md) ──► compile ──► AgentContext IR ──► render ──► Session Inject (每轮)
                                                                                                              Turn Inject (/manual:xxx)
```

### 4.2 三段式编译流程图

```
loadAndTranspile(cwd, profileName)
   │
   ├─ parse：mdAdapter.load() → SchemaBundle { domains[], blueprints[], profiles[], activeProfile }
   │
   ├─ compile：compileAgentContext(profile, blueprint, domains) → AgentContext IR
   │           - 遍历 blueprint.groups
   │           - 每个 group 找 profile 同名 ProfileGroup
   │           - resolveDomains：全局 domains + 聚合组追加 → 按 group.modules 过滤
   │           - dispatchGroup：遍历 group.modules，按 modName 注册表聚合
   │
   ├─ cache：sourceHash 一致 → load cache；不一致 → save + reload
   │
   └─ render：renderSessionInject(ctx, blueprint) → session segment
              renderTurnInject(ctx, blueprint, domains, "/manual:xxx") → turn segment
```

### 4.3 默认 Blueprint 组织（dev-knowledge）

```yaml
name: dev-knowledge
groups:
  - name: 会话背景         # session 面，聚合 Scene + Participant 段
    inject: session
    mode: hybrid
    modules: [Scene, Participant]
  - name: 触发索引         # session 面，聚合 Trigger 段（桥接会话背景 → 参考手册）
    inject: session
    modules: [Trigger]
  - name: 参考手册         # turn 面，聚合 Rules + Flows + Checklists 段
    inject: turn
    modules: [Rules, Flows, Checklists]
```

### 4.4 命名分层（四层各用各的词）

```
用户说："会话背景是什么？" → 产品层
开发者说："会话背景聚合组包含哪些 modules？" → 结构层
Adapter 说："renderSessionInject 调用" → 契约接口层
Pi 说："system_prompt 事件触发" → Agent Runtime 层
```

---

## 五、生命周期

### 5.1 资产生命周期

```
创建 Domain md → 选/创建 Blueprint yaml → 创建 Profile md
       ↓
  改 .md → 删 .pt/cache/agent-contexts/*.agent-context.md → 重编译
       ↓
  验证：/pt status / /pt raw / /pt full
```

### 5.2 编译生命周期

```
loadAndTranspile(cwd, profileName)
  → parse (mdAdapter.load)
  → compile (compileAgentContext)
  → cache check (sourceHash 比对)
  → render (renderSessionInject)
  → TranspileResult { segment, bundles, cacheHit, agentContext, blueprint, domains, activeProfile, profile }
```

### 5.3 会话生命周期（Pi API）

```
session_start         → transpile(profileName) 加载 + 编译产物
before_agent_start    → AgentAdapter 注入 Session Inject（每轮追加 segment）
input                 → AgentAdapter 检测 /manual:xxx 或 /<flow-name> → renderTurnInject
session_shutdown      → resetSessionState() 清理本 session 的 segment/injectedApi
```

### 5.4 Profile 切换生命周期

```
/pt-profile <name> 触发
  → loadAndTranspile(cwd, <name>) 重编译
  → PiAdapter.setAgentContext(...) 更新本 session 的 ctx/blueprint/domains/segment
  → 下一轮 before_agent_start 自动用新 segment
  → handler 不重新注册（同 runtime）
```

### 5.5 触发索引 → 参考手册的桥接（隐性机制）

Session 面有"触发索引"聚合组（modules: [Trigger]），Turn 面有"参考手册"（modules: [Rules, Flows, Checklists]）。

LLM 看 Session 面的 Trigger 索引，判断"需要查某手册" → 触发 Turn 注入。

**Pt 不建模这个显式链接**——完全靠 Domain 作者在 Trigger 段里写清楚索引。这是作者责任，不是 Pt 结构保证。

---

## 六、命令速查

### 用户命令

| 命令 | 作用 |
|---|---|
| `/pt-profile <name>` | 切换 Profile（下一轮生效） |
| `/pt-profile`（无参） | 列出所有可用 Profile |
| `/pt` | 查看当前编译产物/状态 |
| `/pt status` | 显示 active Profile + 段长度 + cache hit |
| `/pt flows` | 列出可触发手册（Turn Context 索引） |
| `/pt raw` | dump segment 到 `.pt/cache/raws/` |
| `/pt full` | dump 完整 Session Inject 到 `.pt/cache/fulls/` |
| `/pt logs` | 查看日志 |
| `/manual:<domain>` | 注入该 Domain 的 Rules/Flows/Checklists 段到 Turn Inject |
| `/<flow> <args>` | 触发 Domain 的 FlowTemplate |

### Flag

| Flag | 作用 |
|---|---|
| `--pt-profile <name>` | Pi 启动时激活 Profile（CLI 优先级最高） |

### LLM 工具

| 工具 | 作用 |
|---|---|
| `pt_status` | 查看编译状态 |
| `pt_flows` | 列出可用手册 |
| `pt_manual` | 创建手册实例文档 |
| `pt_verify` | 验证手册步骤执行结果 |
| `pt_check_refs` | 检查资产引用完整性 |

---

## 七、资产目录布局

```
.pt/
├── assets/              # 入 git — 转译资产
│   ├── domains/         #   Pt Domain（.md）
│   ├── blueprint/      #   Blueprint（.blueprint.yaml）
│   └── profiles/        #   Pt Profile（.profile.md）
├── docs/                # 入 git — 文档（designs 设计与执行 / issues 问题跟踪）
├── manuals/             # gitignore — pt_manual 工作文档
├── cache/               # gitignore — 运行产物
│   ├── agent-contexts/  #   编译后的 AgentContext
│   ├── raws/            #   segment dump
│   └── fulls/           #   完整 prompt dump
└── logs/                # gitignore — NDJSON trace
```

### 资产载体约定

| 资产 | 载体 | 为什么 |
|---|---|---|
| Pt Domain | `.md` | 含叙事正文（概念描述、规则展开），Markdown 自然 |
| Blueprint | `.yaml` | 纯结构化（groups 列表），无叙事；YAML 与 frontmatter 同构，parser 简化 |
| Pt Profile | `.md` | YAML frontmatter（blueprint + domains）+ H2 段（聚合组实例化），混合载体 |

---

## 八、扩展点

| 想加什么 | 怎么加 |
|---|---|
| 新 Pt Domain 知识单元 | 写 .pt/assets/domains/<name>.md，H2 段名决定 schema（Scene / Trigger / Rules / Flows / Checklists / Participant / 扩展） |
| 新 Blueprint 聚合组 | 改 Blueprint YAML 加 group；modules 列 Domain Schema Name |
| 新 modName（聚合标题） | registerModuleRenderer("xxx", fn) 一行注册；未注册走 generic fallback 自动聚合 |
| 新 SourceAdapter | 实现 SourceAdapter 接口（src/schema.ts），load() 返回 SchemaBundle |
| 新 AgentAdapter | 实现 AgentAdapter 接口，声明 supportedTargets + setAgentContext + registerInject + listManuals? |

---

## 九、相关文档

- **README.md** — 用户面 Quick Start + 命令速查
- **pt-positioning.md** — 产品定位（What is Pt 4 条 + 命名决策 §9.7-9.10）
- **pt-asset-layering.md** — 四层模型 + 三段式编译流程的权威定义
- **pt-terminology.md** — 术语决策记录（含 §12 term-final 决策）
- **pt-dev-phases-v9.md** — v9 演进历史
- **.pt/docs/designs/** — 各 Phase 执行简报与 issue 跟踪
