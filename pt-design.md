# Pt — 多来源转译器（Polyglot Transpiler：多来源知识 → Pi 上下文）

> **Pt（Polyglot Transpiler，多来源转译器）** 是一个 Pi Extension，把**多个来源渠道**的业务知识（OXN Assets 是其中之一）统一转译成 Pi Agent 能理解的单一 systemPrompt 上下文 + 工具声明。
>
> "Polyglot"指输入来源多渠道：OXN 是已实现的来源渠道之一，未来可接入其他来源（裸 markdown 文件、JSON/YAML 配置、数据库、API、其他知识管理系统等）。每个来源渠道有自己的 Source Adapter，Pt 把它们的产物统一转译成 Pi 的 systemPrompt 段。"Transpiler"指 source-to-source 转译：把来源的 markdown DSL 转译成 Pi 的 systemPrompt markdown，而非编译成中间字节码。
>
> 这是 AU 架构的"阶段 0 最简 MVP"——不建 au-core 包、不 fork pi-web、不绕过 Pi 的 `main()`，只用一个 ~200 行的 `.ts` extension 文件实现核心价值：**让 Pi 直接加载多来源业务知识，用户不用每次写上下文。**

---

## 一、定位

### Pt 是什么

**Pt 是 Pi 的一个 extension**（多来源转译器），放在 `.pi/extensions/pt.ts` 或发布成 npm 包。直接 `pi` 命令启动即生效，零 fork、零入口脚本、零 SDK 组装。它读取多个来源渠道的业务知识，转译成 Pi 的 systemPrompt 段。

### 来源渠道（Polyglot 的"多"指这里）

Pt 的"多来源"不是指 OXN 内部的多种 AssetKind，而是指**多个来源渠道**——每个渠道是一个 Source Adapter：

| 来源渠道 | 状态 | 内容 | Adapter 职责 |
|---|---|---|---|
| **OXN Assets** | ✅ MVP 已实现 | domain/workflow/stack/blueprint（见第三节） | 读 `.openxenon/assets/`，按 AssetKind 转译 |
| 裸 Markdown | 🔜 未来 | 人写的 `.md` 文档 | 读指定目录的 `.md`，转成 systemPrompt 段 |
| JSON/YAML 配置 | 🔜 未来 | 结构化配置（术语表/规则表） | 解析 JSON/YAML，转成 systemPrompt 段 |
| 外部 API/数据库 | 🔜 未来 | 远程知识库 | 调 API/查 DB，转成 systemPrompt 段 |
| 其他知识系统 | 🔜 未来 | Notion/Confluence/飞书等 | 拉取内容，转成 systemPrompt 段 |

**MVP 只实现 OXN Adapter**，但架构上预留其他 Adapter 接入点（见第八节 source registry 模式）。

### OXN 在架构中的位置

OXN 是 Pt 的**第一个来源渠道**，不是唯一来源。OXN 内部的 5 种 AssetKind（domain/workflow/stack/blueprint/roadmap）是 **OXN 这个 Source Adapter 内部的子结构**，不是 Polyglot 的"多语言"。

```
Pt（多来源转译器）
  ├── Source Adapter 层（多来源 = polyglot）
  │   ├── OXN Adapter（MVP 已实现）        ← 本节重点
  │   │   └── 内部 5 种 AssetKind（domain/workflow/stack/blueprint/roadmap）
  │   ├── Markdown Adapter（未来）
  │   ├── Config Adapter（未来）
  │   └── ...其他来源渠道
  ├── 转译层（每个 adapter 把来源内容转译成 systemPrompt 段）
  └── 注入层（before_agent_start 合并所有来源的段）
```

### Pt 不是什么

- **不是 au-core 包**（那是阶段 1，当需要 workflow→agentsFiles / skills 合并 / 多 Agent 身份时才升级）
- **不是 fork pi-web**（那是阶段 2，当需要 Web UI 时才做）
- **不是框架**（单文件 extension，~200 行）
- **不是只服务 OXN**（OXN 是第一个来源渠道，架构支持接入其他来源）

### 阶段定位

| 阶段 | 形态 | 代码量 | 能力 |
|---|---|---|---|
| **阶段 0（Pt）** | Pi extension | ~200 行 | OXN 来源渠道 → systemPrompt + Externals → registerTool（架构预留多来源接入） |
| 阶段 1（au-core） | SDK 消费者 + au-tui 入口 | ~240 行 | + 加载时注入 / skills 合并 / 多 Agent / 更多来源渠道 |
| 阶段 2（au-web） | fork pi-web | ~120 行 patch | + Web UI |

**Pt 是阶段 0，不是终点。** 当撞到 extension 做不到的需求时升级到阶段 1。Pt 的转译逻辑（读来源 + 转 H2）不废弃，搬进 `au-core/knowledge.ts`，届时 Source Adapter 层可独立扩展。

---

## 二、核心设计：per-session 内存态（每会话隔离，不碰共享文件）

### 设计历程：三轮转变

| 轮次 | 方案 | 问题 |
|---|---|---|
| v1 | `before_agent_start` 每轮注入 + mtime 缓存 | 每轮重算（虽有缓存缓解） |
| v2 | 转译来源 → 写 `.pi/APPEND_SYSTEM.md` → Pi 加载时进 base | **项目级单文件，多会话并发会抢同一个文件** |
| **v3（当前）** | **`before_agent_start` + 内存态（每进程隔离）** | ✅ 每会话隔离 + 即时切换 + cache 友好 |

### 为什么放弃 APPEND_SYSTEM.md（v2 的教训）

`.pi/APPEND_SYSTEM.md` 是**项目级单文件**。同一项目多个并发会话（两个终端各跑 `pi`，选不同 blueprint）会抢同一个文件——后写覆盖先写。这是根本性缺陷。

**项目级提示词文件适合"所有会话共享的固定知识"（如 AGENTS.md），不适合"每会话选不同内容的转译产物"。**

### 扩展能否改造 Pi 读提示词文件的方式？（查证：不能）

查证了所有 extension 能触及 systemPrompt 的路径：

| 机制 | 能改 systemPrompt 文件读取吗 | 查证结果 |
|---|---|---|
| `discoverSystemPromptFile()` / `discoverAppendSystemPromptFile()` | ❌ | 硬编码 `.pi/SYSTEM.md` / `.pi/APPEND_SYSTEM.md`（resource-loader.js 第 808-825 行），扩展无权改 |
| `resources_discover` 事件 → `promptPaths` | ❌ | `promptPaths` 加载的是 **prompt 模板**（`/template` 展开），不是 systemPrompt 文件（第 521 行 `updatePromptsFromPaths` → `loadPromptTemplates`） |
| `systemPromptOverride` / `appendSystemPromptOverride` | ❌ | 在 `ResourceLoaderOptions` 里，**session 创建时定**（SDK 层 `createAgentSessionServices`），扩展设不了 |
| `before_agent_start` → 返回 `systemPrompt` | ✅ | 能返回 systemPrompt（链式），每轮覆盖层 |
| `context` 事件 → `messages` | ❌ | 改消息数组，不碰 systemPrompt |

**结论**：扩展无法改造 Pi 读提示词文件的路径。加载时 systemPrompt 文件发现是硬编码的。要改加载时行为，只能升级到阶段 1（au-core SDK，设 `appendSystemPromptOverride`）。

### 正确方案：before_agent_start + 内存态

**关键洞察：扩展模块状态 = 每进程独立 = 每会话隔离。**

每个 `pi` 命令 = 独立 Node 进程 = 独立加载扩展模块 = 独立的 `let activeBlueprint` / `let cachedSegment`。所以 `before_agent_start` + 内存态**天然每会话隔离**——不碰任何共享文件，多会话不冲突。

```
session_start 事件（每会话一次，reason: startup/new/resume/fork）
  ↓
Pt 从各来源渠道（MVP: OXN）转译知识 → 存入内存 cachedSegment（不写文件！）
  ↓
before_agent_start 事件（每轮）
  ↓
return { systemPrompt: event.systemPrompt + cachedSegment }
  ↓
LLM 每轮拿到稳定业务知识（内容稳定 → cache 命中）
```

### systemPrompt 两层结构（查证 agent-session.js）

```
_baseSystemPrompt（基础层 —— Pi 自己管，扩展够不着）
  ├── 构建时机：session 创建时 / 工具集变化时 / 资源重载时（/reload）
  ├── 内容：Pi 原生 prompt + AGENTS.md + skills 摘要 + tools 摘要 + APPEND_SYSTEM.md
  └── 加载时定，会话内不每轮变

_systemPromptOverride（每轮覆盖层 —— Pt 走这里）
  ├── 构建时机：每轮 agent loop 开始前（before_agent_start 事件）
  ├── 机制：extension 返回 { systemPrompt } 就 override 这一轮（agent-session.js 第 901-908 行）
  ├── 链式：event.systemPrompt 含前序扩展的修改，Pt 在其后追加
  └── 不返回就重置回 base
```

Pt 的做法：`return { systemPrompt: event.systemPrompt + "\n\n" + cachedSegment }`——在 Pi 的 base（含 AGENTS.md / tools / skills）之后追加各来源渠道转译的业务知识段。

### cache 友好性（查证确认）

**cache 看的是字符串内容稳定性，不是"base 还是 override"。** 查证 extensions.md 第 526-560 行：`before_agent_start` 返回的 systemPrompt 字符串就是发给 provider 的 systemPrompt。若内容稳定，prefix 稳定，provider prompt cache 命中。

cache 失效的唯一情况（extensions.md 第 2368 行）：激活带 `promptSnippet`/`promptGuidelines` 的工具会重建 system prompt → 失效。Pt 的来源段是纯文本追加，不触发重建——**只要来源选定不变，字符串稳定，cache 持续命中**。

| 场景 | cache 行为 |
|---|---|
| 同一来源选定内多轮 | cachedSegment 稳定 → systemPrompt 字符串稳定 → cache 持续命中 |
| `/blueprint` 切换（改来源选定） | cachedSegment 变 → 字符串变 → cache 失效一次 → 下一轮又稳定 |
| Pi 工具集变化（加/减工具） | base 重建 → event.systemPrompt 变 → 字符串变 → 失效一次（Pi 正常行为） |

### compaction 不碰 systemPrompt

查证 compaction.md：Pi 的 compaction 只 summarize **历史消息**（user/assistant/tool），不碰 systemPrompt（无论是 base 还是 override）。所以来源转译的业务知识段在 compaction 后依然完整存在——**长期业务知识不会因长会话被压缩丢失**。

### 多会话视角

| 层 | 职责 | 存储 |
|---|---|---|
| 来源渠道（MVP: `.openxenon/assets/`） | 所有会话共享的业务知识源（人写/系统管理） | 文件（git 管理） |
| 会话选定（`activeBlueprint` 内存变量） | 本次会话激活哪个来源选定 | 内存（每进程隔离） |
| 会话转译产物（`cachedSegment` 内存变量） | 转译出的提示词内容 | 内存（每进程隔离） |
| 项目默认（`.pi/settings.json` 的 `au.blueprint`） | 新会话启动时的默认来源选定 | 文件（可 git 管理） |

**一个项目可以有多个并发会话**，每个 `pi` 进程有自己的 `activeBlueprint` / `cachedSegment`，互不干扰。切来源选定 = 改内存 + 重转译，即时生效，无需 `/reload`。

### 关于"会话目录"

查证：Pi 的会话是**文件**（`sessionFile`，`sessionManager.getSessionFile()`），不是目录。没有 `.pi/sessions/<id>/` 概念。

Pt 不需要会话目录——内存态已隔离每会话状态。若未来要跨重启持久化（"这个会话上次选的来源选定"），可存入 session 文件（`pi.appendSessionEntry`）或读 `.pi/settings.json` 默认值。MVP 不需要。

---

## 三、来源渠道：OXN（MVP 已实现）

### OXN 是 Pt 的第一个来源渠道

OXN 作为 Source Adapter，读取 `.openxenon/assets/` 下的资产。OXN 内部有 5 种 AssetKind，是 **OXN 这个来源渠道内部的子结构**（不是 Polyglot 的多来源）：

| OXN AssetKind | 内容 | Pi 落点 | OXN Adapter 转译方式 |
|---|---|---|---|
| **domain** | Terms/Bans/Invariants/Externals | systemPrompt 段（业务知识） | 抽 H2 段，Terms 逐条列、Bans 列禁忌词、Invariants 列约束 |
| **workflow** | Slots（slot DAG） | systemPrompt 段（流程指导） | 抽 Slots，列 slot 顺序 + deps 依赖 |
| **stack** | Tools（runtime/linter/test） | systemPrompt 段（技术约束）+ Externals → registerTool | 抽 Tools 列约束，operations 声明工具 |
| **blueprint** | Refs + Boundaries | systemPrompt 段（任务蓝图） | **展开 refs + 重组 Boundaries 成可执行步骤** |
| roadmap | scenes | MVP 不转译 | 未来：scene 驱动选 blueprint |

### Blueprint 的特殊转译：方式 B（重组 Boundaries）

Blueprint 是"静态 Asset → 动态 Work"的衔接点。转译方式是**展开 refs + 重组 Boundaries 成可执行步骤**，不是简单复读三个 asset（方式 A）：

```
方式 A（错误）：Blueprint 段 = domain 段 + workflow 段 + stack 段（重复）
方式 B（正确）：Blueprint 段 = 重组 Boundaries 成"第 1 步 / 第 2 步..."的可执行计划
```

方式 B 的转译逻辑：
- 不重复 Terms（Domain 段已有），但引用"按 Domain 的 Bans 检查"
- 不重复 Slots 列表（Workflow 段已有），但重组成"第 1 步 / 第 2 步..."的可执行步骤
- 每个 slot 标注 operate（从 Stack 的 Tools 映射）+ deps + 目标

### Externals 的处理

四种 asset 都可能有 `## Externals`（blueprint 除外，它无 Externals）。Externals 声明"这个 asset 需要哪些动态数据工具"。

转译方式：
- Externals 不进 systemPrompt（动态数据不静态注入）
- 转译成 `registerTool` —— Pt 在 `session_start` 事件注册工具

```typescript
pi.on("session_start", async () => {
  for (const ext of allExternals(activeAssets)) {
    pi.registerTool(resolveExternalTool(ext))
  }
})
```

### 未来来源渠道的接入（架构预留）

OXN Adapter 之外的来源渠道，MVP 不实现，但架构预留接入点（见第八节 source registry）。未来加一个来源 = 加一个 Source Adapter 函数，不改注入层：

```typescript
// 未来：多来源合并
const segment = [
  await oxnAdapter.load(cwd, activeBlueprint),      // OXN（MVP）
  await markdownAdapter.load(cwd, mdConfig),        // 未来：裸 markdown
  await configAdapter.load(cwd, yamlConfig),        // 未来：YAML 配置
].filter(Boolean).join("\n\n")
```

---

## 四、Blueprint 选择机制（OXN 来源渠道内）

> **说明**：Blueprint 是 OXN 来源渠道内部的概念。若未来接入其他来源渠道，"选定"概念会泛化为"激活哪组来源"（可能是 OXN blueprint + 一组 markdown 文档）。MVP 只处理 OXN blueprint。

### 缺口

Blueprint 是 Work-scoped 的——"这次任务怎么走"。但 Pi session 启动时不知道用户要做哪个 Work。一个项目可能有多个 blueprint，不能全注入。

### 三种选法

| 选法 | 机制 | 适合阶段 |
|---|---|---|
| **A. 单 blueprint 约定** | 项目只有一个 blueprint，Pt 直接注入它 | MVP（个人单场景） |
| **B. 配置指定** | `.pi/settings.json` 写 `au.blueprint: article-blueprint`，Pt 读配置选 | MVP+（多场景手动切） |
| **C. extension 命令切换** | Pt 注册 `/blueprint <name>` 命令，改内存 + 重转译（即时生效） | MVP+（session 内切） |
| D. Roadmap scene 驱动 | Roadmap 定义 scene → blueprint 映射 | 未来（多场景自动切） |

### 推荐 MVP：B + C 组合

**配置指定（B）**——session 启动时读默认 blueprint：

```json
// .pi/settings.json
{
  "au": {
    "blueprint": "article-blueprint"
  }
}
```

**extension 命令切换（C）**——session 内动态切，**即时生效无需 /reload**：

```typescript
let activeBlueprint: string | null = null
let cachedSegment: string | null = null

pi.registerCommand("blueprint", {
  description: "切换当前 blueprint，即时重转译",
  handler: async (ctx) => {
    const name = ctx.args[0]
    activeBlueprint = name
    cachedSegment = await loadAndTranspile(ctx.cwd, name)  // 重转译内存
    ctx.ui.notify(`已切换到 ${name}，下一轮生效`, "info")
  }
})
// 用户敲 /blueprint article → 改内存 + 重转译 → 下一轮 LLM 就用新 prompt
```

**只读激活 blueprint 引用的 asset**——不全读，token 精简：

```typescript
async function loadAndTranspile(cwd: string, blueprintName: string) {
  // MVP: 只走 OXN adapter
  return oxnAdapter.load(cwd, blueprintName)
}
```

---

## 五、Pt 插件 + Skill 的分工

### Skill 的能力边界（查证 Pi skills.md + Agent Skills 标准）

| Skill 能做什么 | Skill 做不到什么 |
|---|---|
| ✅ 携带脚本文件（`scripts/*.sh`） | ❌ 自己执行代码（Skill 是 markdown） |
| ✅ SKILL.md 指导 LLM 用 bash 工具执行脚本 | ❌ 改 systemPrompt（展开成 user message） |
| ✅ `/skill:name` 用户手动触发 → 展开成 user message | ❌ 注册工具 / 设内部状态 |
| ✅ 模型自动调用（看摘要决定） | ❌ 选 Blueprint（不能设状态） |

**关键事实**：Skill 的 script 是"脚本文件 + SKILL.md 指导 LLM 调 bash 工具执行"，不是 Skill 自己执行代码。Skill frontmatter 只有 `name` / `description` / `disable-model-invocation`，没有 `exec` / `script` 字段。

Skill 展开成 **user message**（这一轮的消息，一次性），不是 **systemPrompt**（长期上下文）。所以 Skill 不适合做"固化长期业务知识"——那是 Pt 的 `before_agent_start` 的活。

### 正确分工

| | Pt 插件（extension） | Skill |
|---|---|---|
| 职责 | 多来源转译 → 内存态 → `before_agent_start` 每轮注入 systemPrompt（长期业务知识） | 声明这一轮的任务意图（一次性 user message） |
| 注入位置 | `_systemPromptOverride`（每轮覆盖，内容稳定 cache 命中） | user message（这一轮） |
| 选 Blueprint | extension 命令 `/blueprint <name>`（改内存，即时） | 不选（Skill 不设状态） |
| 触发时机 | `session_start` 转译 + `before_agent_start` 每轮注入 | `/skill:name` 用户手动 |
| 形态 | TypeScript（`.pi/extensions/pt.ts`） | Markdown（`.agents/skills/*/SKILL.md`） |
| 一次性 vs 长期 | 长期（会话内每轮都在） | 一次性（这一轮） |

### 配合使用示例

```
用户敲 /blueprint article          ← Pt 命令，改内存 + 重转译（即时，无需 /reload）
用户敲 /skill:write-article        ← Skill 展开 user message "请写一篇关于X的文章"
  ↓
before_agent_start 触发            ← 注入 cachedSegment（article-blueprint 转译产物）
  ↓
LLM 拿到 systemPrompt（业务知识 + 流程 + 蓝图，长期稳定）+ user message（这一轮意图）
  ↓
LLM 按 blueprint 步骤执行
```

**Skill 声明意图（一次性），Pt 注入知识（长期稳定）。** 两者互补，不重叠。

### Skill 携带脚本的潜在用法（未来）

Skill 能携带脚本文件（如 `scripts/select-blueprint.sh`），SKILL.md 指导 LLM 调 bash 执行。但这和 Pt 的 `/blueprint` extension 命令重复，MVP 用 extension 命令更直接。未来若需要"LLM 自动选 blueprint"（模型根据用户意图决定用哪个蓝图），可用 Skill + 脚本方式——但那是 Roadmap 驱动的场景，MVP 不做。

---

## 六、完整例子：写作助理（OXN 来源渠道）

### 输入：4 个 OXN asset

**domain: writing.md**
```markdown
---
entity: domain
name: writing
---

# Domain: writing

## Terms
### 文章
- desc: 有标题、正文、结构完整的成稿；区别于片段或草稿笔记。

### 选题
- desc: 一篇文章要回答的核心问题；选题决定文章价值，先定选题再写。

## Bans
### ban-title-party
- items: [震惊, 惊呆了, 必看]
- desc: 标题禁止使用标题党词汇。

## Invariants
### inv-article-min-words
- value: 成稿正文字数不少于 800 字。

## Externals
- path: ./data/keyword-stats.xlsx
```

**workflow: article-flow.md**
```markdown
## Slots
### select-topic
- desc: 确定选题和目标读者
- deps: []

### outline
- desc: 写大纲，每节一句话
- deps: [select-topic]

### draft
- desc: 按大纲写初稿
- deps: [outline]

### revise
- desc: 修订语言、检查字数和禁忌
- deps: [draft]
```

**stack: md-stack.md**
```markdown
## Tools
### markdown
- role: 正文用 markdown 格式
### fs-tools
- operations: [read, write]
```

**blueprint: article-blueprint.md**
```markdown
## Use
- domain: writing
- workflow: article-flow
- stack: md-stack

## Boundaries
### select-topic
- operate: [read]
- deps: []
- desc: 查关键词热度数据，确定选题和目标读者。

### outline
- operate: [read]
- deps: [select-topic]
- desc: 写大纲，每节一句话概括。

### draft
- operate: [write]
- deps: [outline]
- desc: 按大纲写初稿，markdown 格式。

### revise
- operate: [read, write]
- deps: [draft]
- desc: 检查字数≥800、无标题党词，修订成稿。
```

### Pt 转译输出：注入 systemPrompt 的内容（~500 token）

```markdown
## 业务知识（来自 OXN assets）

<!-- ===== Domain: writing ===== -->
### 业务术语
- **文章**：有标题、正文、结构完整的成稿；区别于片段或草稿笔记。
- **选题**：一篇文章要回答的核心问题；选题决定文章价值，先定选题再写。

### 业务禁忌
- 标题禁止使用：震惊 / 惊呆了 / 必看。

### 业务不变量
- 成稿正文字数不少于 800 字。

<!-- ===== Workflow: article-flow ===== -->
### 执行流程
按以下 slot 顺序执行：
1. select-topic（确定选题和目标读者）
2. outline（写大纲，每节一句话）— 依赖 select-topic
3. draft（按大纲写初稿）— 依赖 outline
4. revise（修订语言、检查字数和禁忌）— 依赖 draft

<!-- ===== Stack: md-stack ===== -->
### 技术约束
- 正文用 markdown 格式。
- 可用工具：read / write。

<!-- ===== Blueprint: article-blueprint ===== -->
### 当前任务蓝图
你要执行的是"文章写作"任务，按以下计划走：

**第 1 步 · select-topic**
- 操作：read（查 ./data/keyword-stats.xlsx 关键词热度）
- 目标：确定选题和目标读者

**第 2 步 · outline**
- 依赖：第 1 步完成
- 操作：read
- 目标：写大纲，每节一句话概括

**第 3 步 · draft**
- 依赖：第 2 步完成
- 操作：write
- 目标：按大纲写初稿，markdown 格式

**第 4 步 · revise**
- 依赖：第 3 步完成
- 操作：read + write
- 目标：检查字数≥800、无标题党词，修订成稿
```

Externals（`./data/keyword-stats.xlsx`）不进 systemPrompt，转译成 `registerTool` 注册 `read-keyword-stats` 工具。

---

## 七、Token 经济性分析

### 上下文构成

```
每轮 token = systemPrompt（Pi base + Pt 追加的来源段 ~500 token）+ 历史消息 + 当前 user message
```

### 三道防线

| 防线 | 机制 | 效果 |
|---|---|---|
| **内存态稳定** | cachedSegment 在来源选定不变时稳定，每轮返回相同字符串 | systemPrompt 字符串稳定 |
| **Prompt Cache** | systemPrompt 在消息序列最前且内容稳定 → provider cache 命中 | 几乎零额外 token 成本 |
| **Compaction** | 只 summarize 历史消息，不碰 systemPrompt（base 和 override 都不碰） | 业务知识长期保留不丢失 |
| **只读激活选定的 refs** | 不全读所有来源内容，只读当前选定引用的 | token 从 N× 降到 1× |

### 膨胀风险评估

| 场景 | 表现 |
|---|---|
| 短会话（< 20 轮） | 来源段 ~500 token，cache 命中，几乎零成本 |
| 中会话（20-100 轮） | cache 持续命中；历史消息增长但未触 compaction |
| 长会话（触 compaction） | 历史消息 summarize，来源段保留（在 systemPrompt override），不丢失 |
| 超长会话 | 来源段 + summary + 最近消息挤在 context window，需 `/compact` 手动清理 |

**膨胀风险在"来源内容特别胖"**（如 OXN domain 几十个术语 + 大量不变量）。缓解：只读激活选定的 refs + 未来可按 slot 阶段动态裁剪。

---

## 八、MVP 实现骨架

```typescript
// .pi/extensions/pt.ts（~200 行）
import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"

// === per-session 内存态（每进程隔离 = 每会话隔离）===
let activeBlueprint: string | null = null
let cachedSegment: string | null = null

// === Source Adapter 注册表（多来源 = polyglot）===
// MVP 只注册 OXN adapter；未来加来源 = 加一个 adapter 函数
const sourceAdapters = [
  oxnAdapter,   // MVP: 读 .openxenon/assets/
  // markdownAdapter,  // 未来
  // configAdapter,    // 未来
]

export default function (pi: ExtensionAPI) {
  // 1. session 启动：读默认 blueprint + 转译到内存 + 注册 Externals 工具
  pi.on("session_start", async (event, ctx) => {
    const cwd = ctx.cwd
    const settings = pi.getSettings?.()
    activeBlueprint = settings?.au?.blueprint ?? await detectSingleBlueprint(cwd)
    if (activeBlueprint) {
      cachedSegment = await loadAndTranspile(cwd, activeBlueprint)
      // 注册 Externals 工具（OXN adapter 的 Externals）
      const externals = await oxnAdapter.loadExternals(cwd, activeBlueprint)
      for (const ext of externals) {
        pi.registerTool(resolveExternalTool(ext))
      }
    }
  })

  // 2. 每轮注入 systemPrompt（内容稳定 → cache 命中）
  pi.on("before_agent_start", async (event, ctx) => {
    if (!cachedSegment) return undefined
    return {
      systemPrompt: event.systemPrompt + "\n\n## 业务知识（来自多来源）\n\n" + cachedSegment,
    }
  })

  // 3. extension 命令：切换 blueprint（改内存，即时生效，无需 /reload）
  pi.registerCommand("blueprint", {
    description: "切换当前 blueprint，即时重转译",
    handler: async (ctx) => {
      const name = ctx.args[0]
      activeBlueprint = name
      cachedSegment = await loadAndTranspile(ctx.cwd, name)
      ctx.ui.notify(`已切换到 ${name}，下一轮生效`, "info")
    }
  })
}

// === 多来源合并转译（polyglot 核心）===
async function loadAndTranspile(cwd: string, blueprintName: string): Promise<string> {
  // 遍历所有已注册的 source adapter，合并它们的转译产物
  const segments = await Promise.all(
    sourceAdapters.map(adapter => adapter.load(cwd, blueprintName))
  )
  return segments.filter(Boolean).join("\n\n")
}

// === OXN Source Adapter（MVP 唯一实现）===
const oxnAdapter = {
  async load(cwd: string, blueprintName: string): Promise<string> {
    const blueprint = await readAsset(join(cwd, `.openxenon/assets/blueprints/${blueprintName}.md`))
    const refs = parseRefs(blueprint)
    const domain = await readAsset(join(cwd, `.openxenon/assets/domains/${refs.domain}.md`))
    const workflow = await readAsset(join(cwd, `.openxenon/assets/workflows/${refs.workflow}.md`))
    const stack = await readAsset(join(cwd, `.openxenon/assets/stacks/${refs.stack}.md`))
    return [
      compileDomain(domain),
      compileWorkflow(workflow),
      compileStack(stack),
      compileBlueprint(blueprint, domain, workflow, stack),  // 方式 B：重组 Boundaries
    ].join("\n\n")
  },
  async loadExternals(cwd: string, blueprintName: string): Promise<External[]> {
    // 读 blueprint refs 的所有 asset 的 Externals 段
    // ...（省略，逻辑同 load 但抽 Externals）
    return []
  },
}

function compileDomain(d: Asset): string {
  const terms = extractH2(d.body, "Terms")
  const bans = extractH2(d.body, "Bans")
  const invariants = extractH2(d.body, "Invariants")
  return `<!-- ===== Domain: ${d.name} ===== -->\n### 业务术语\n${terms}\n\n### 业务禁忌\n${bans}\n\n### 业务不变量\n${invariants}`
}

function compileBlueprint(b: Asset, d: Asset, w: Asset, s: Asset): string {
  const boundaries = parseBoundaries(b.body)  // slot DAG + operate + deps
  const steps = boundaries.map((slot, i) =>
    `**第 ${i+1} 步 · ${slot.name}**\n- 依赖：${slot.deps.length ? slot.deps.join(", ") : "无"}\n- 操作：${slot.operate.join(", ")}\n- 目标：${slot.desc}`
  ).join("\n\n")
  return `<!-- ===== Blueprint: ${b.name} ===== -->\n### 当前任务蓝图\n你要执行的是"${b.name}"任务，按以下计划走：\n\n${steps}`
}
```

**架构要点**：`sourceAdapters` 数组是 polyglot 的接入点。MVP 只有 `oxnAdapter`，未来加来源渠道只需 push 一个 adapter 对象（实现 `load()` + `loadExternals()` 接口），注入层（`before_agent_start`）和命令层（`/blueprint`）完全不动。

---

## 九、何时升级到阶段 1（au-core）

Pt extension 撞到这些需求时不够，升级到 au-core：

| 需求 | 为什么 extension 做不到 | 升级路径 |
|---|---|---|
| 加载时进 base systemPrompt（不是每轮 override） | 扩展够不着 `appendSystemPromptOverride`（SDK 层） | au-core 调 `createAgentSessionServices({ resourceLoaderOptions: { appendSystemPromptOverride } })` |
| 来源内容要作为 Pi context files（让 LLM `@workflow` 引用） | 需要 `agentsFilesOverride`（resourceLoaderOptions） | au-core |
| skills 要和 Pi 原有 skills 合并 | 需要 `skillsOverride` | au-core |
| 来源的 runtime 要影响 Pi settings（model/tools 配置） | settings 在 session 创建时定，extension 改不了 | au-core |
| 多 Agent 不同身份/工具白名单（AgentCard） | 需要控制 sessionOptions | au-core |
| 跨重启持久化来源选定（内存态会丢） | extension 内存态进程退出即失 | au-core（或 Pt 存入 session 文件） |
| 接入远程来源（API/数据库）需长连接/认证管理 | extension 生命周期短，复杂连接管理受限 | au-core（管理连接池） |

**这些都不是 MVP 需求。** Pt 的 ~200 行能覆盖"业务知识进 prompt 让 LLM 知道"的核心价值。

**关于"加载时 vs 每轮"的补充说明**：Pt 用 `before_agent_start` 每轮注入，但 `cachedSegment` 在 `session_start` 时转译一次（内存缓存），之后每轮只是字符串拼接（开销可忽略）。所以"每轮注入"不等于"每轮重转译"——转译是一次性的，注入是每轮的。cache 命中保证不增加 token 成本。

---

## 十、一句话总结

> **Pt（Polyglot Transpiler，多来源转译器）是 ~200 行的 Pi extension，把多个来源渠道的业务知识（OXN Assets 是 MVP 已实现的第一个来源渠道，未来可接入裸 markdown / JSON/YAML / API / 数据库等其他来源）统一转译成 Pi 的单一 systemPrompt 上下文。架构上每个来源渠道是一个 Source Adapter（`sourceAdapters` 注册表），MVP 只实现 OXN Adapter。用 per-session 内存态（每进程隔离）解决多会话并发问题：`session_start` 时从各 adapter 转译知识到内存 `cachedSegment`，`before_agent_start` 每轮返回 `event.systemPrompt + cachedSegment`（内容稳定 → cache 命中），`/blueprint` 命令改内存即时切换（无需 /reload）。不碰项目级共享文件（APPEND_SYSTEM.md 多会话会冲突），不改造 Pi 读文件方式（扩展够不着，硬编码）。Skill 声明一次性意图（user message），Pt 注入长期业务知识（systemPrompt override），两者互补。**
