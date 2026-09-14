# Pt

Pt 把领域知识做成可配置的智能体上下文。通过切换配置，Agent 具备不同 Session Context（每轮注入），推理时可通过 Turn Context（按需触发）查阅手册。

---

## 用 Pt 做什么

- **复用 Prompt，不必每次重写**：把重复的 prompt 写成 Pt Domain，配一份 Profile，每次会话切换立即获取领域知识——换项目、换场景，不用重写。
- **拆分固定与按需，控制上下文成本**：领域知识拆成 Session Context（每轮注入的固定知识 + 参考索引）和 Turn Context（按索引触发的详细手册）——背景每轮都在，详细内容推理时按需查阅。
- **沉淀对话与经验为可迭代资产**：把对话里的决策、经验、知识用文档显化，入 git 可追溯、可迭代——知识更新改一处，所有会话生效。
- **连接外部系统与数据源**：领域知识不限于项目内——外部数据源的查询方式、外部系统的操作指引，都可写成 Domain 注入 Agent。

---

## 安装

Pt 是 Pi 扩展，两种安装方式任选其一。

### 方式一：Pi 插件安装（推荐）

```bash
pi install npm:@istuen/pt
```

Pi 自动加载 Pt。项目级安装（团队共享，写入 `.pi/settings.json`）加 `-l`：

```bash
pi install -l npm:@istuen/pt
```

### 方式二：npm 安装 + 手动配置

```bash
npm install @istuen/pt
```

然后在 `.pi/settings.json` 或 `~/.pi/agent/settings.json` 配置扩展入口：

```json
{
  "pi": {
    "extensions": ["./node_modules/@istuen/pt/dist/index.js"]
  }
}
```

## 快速开始

### 1. 激活内建 Profile

进入 pi 后用 `/pt-profile` 选择 `guide`，或直接 `/pt-profile guide`：

```
/pt-profile guide
```

也可以启动时用 flag 激活：

```bash
pi --pt-profile guide
```

内建 `guide` Profile 用 dev-knowledge Blueprint + 五个内建 Domain（`user-info` / `agent-info` / `project-analysis` / `authoring` / `usage`）——Agent 立刻有“用户身份 + Agent 身份 + 怎么写 Pt 资产 / 怎么分析项目 / 怎么用 Pt”的知识。

### 2. 加自己的知识

用自然语言告诉 Agent 你的项目情况——`guide` Profile 会分析当前项目，帮你创建合适的 Domain 和 Profile，或直接告诉你该怎么创建。

---

## 命令速查

| 命令 | 作用 |
|---|---|
| `/pt-profile` | 列出所有可用 Profile |
| `/pt-profile <name>` | 切换 Profile（下一轮生效） |
| `/pt` | 查看当前编译状态 |
| `/pt flows` | 列出可触发手册 |
| `/manual:<domain>` | 注入该 Domain 的手册段到 Turn Inject |
| `/<flow> <args>` | 触发 Domain 的 FlowTemplate |
| `--pt-profile <name>` | Pi 启动时激活 Profile（CLI 优先级最高） |

LLM 工具（Agent 可调用）：`pt_status` / `pt_flows` / `pt_manual` / `pt_verify` / `pt_check_refs`。

---

## Pt 的机制：四个概念

Pt 用四个概念组织——写领域知识，定转换结构，组装身份配置，编译出上下文：

```
Pt Domain ──→ Blueprint ──→ Pt Profile ──→ Agent Context
 领域知识      转换结构       身份配置      编译后上下文
```

### Pt Domain — 领域知识

领域知识，一个 `.md` 文件。用 MD 语法组成：**H2 做 Module**（内容段，如 `## Scene`、`## Flows`）、**H3 做语义**（项名，如 `### 角色分工`）、**列表项做描述**（`- desc: ...`）。可写业务领域的设计语义、工作流说明、外部系统操作指导。Module 允许自定义，通过 Profile 引用即可。放 `.pt/assets/domains/`。

例子：
```markdown
---
name: user-info
---
# user-info

## User
### who-am-i
- desc: 我是这个项目的开发者

### preferences
- desc: 偏好类型安全、模块化设计
```

### Blueprint — 转换结构

转换结构，一个 `.blueprint.yaml` 文件。定义 Profile 可以把哪些 Domain 注入到 Agent——声明有哪些聚合组（`groups`），每个组聚合哪些 Module，注入到哪（`inject: session` 会话级 / `inject: turn` 轮次级）。跨项目复用。放 `.pt/assets/blueprints/`。

```yaml
name: dev-knowledge
groups:
  - name: 会话背景
    inject: session
    modules: [Scene, Participant]
  - name: 触发索引
    inject: session
    modules: [Trigger]
  - name: 参考手册
    inject: turn
    modules: [Rules, Flows, Checklists]
```

### Pt Profile — 身份配置

Profile 是 Pt 最核心的功能，承接用户与 Agent 之间的会话配置。切换 Profile 会影响：会话背景、主题、用户与 Agent 的身份信息、参考信息等——让 Agent 专注当前推理范围。一个 `.profile.md` 文件，选一个 Blueprint + 列要用的 Domain。项目级，不跨项目复用。放 `.pt/assets/profiles/`。

例子：
```markdown
---
name: my-dev
blueprint: dev-knowledge
domains: [user-info, authoring, usage]
---
```

### Agent Context — 编译后上下文

Profile 编译后的产物，分两面——**Session Context**（每轮注入：会话背景、身份信息、触发索引）和 **Turn Context**（按需触发：推理时查阅的参考手册）。带 hash 缓存（`.pt/cache/agent-contexts/`），资产变了自动重编译。

**一句话串起来**：写 Domain → 用 Blueprint 定转换结构 → 用 Profile 组装身份 → 编译出 Agent Context 两面注入。

---

## Pt 资产包（Pack）

v15.x 起，Pt 资产按 **Pack** 组织——一个 Pack 是一个目录（含 `domains/` + `blueprints/` + `profiles/` 子目录 + 可选 `pt-asset-pack.yaml` manifest）。Pt 加载 4 类 Pack，优先级从高到低：

| Pack | 来源 | 寻址名 | 说明 |
|---|---|---|---|
| **project** | `<cwd>/.pt/assets/`（或 `pt.project-pack-dir` 配置） | `@prj` | 项目专属资产，永远最高优先 |
| **settings** | `.pi/settings.json` 的 `pt.asset-packs[]` | `@<manifest-name>` | 团队共享 / 第三方 Pack，按声明顺序后者赢 |
| **global** | `~/.pt/assets/` | `@gbl` | 用户跨项目共用资产 |
| **builtin** | `src/builtin/assets/`（随 npm 包） | `@pt` | 内建 fallback（guide / dev-knowledge 等） |

### 跨 Pack 引用

Profile / Domain / Blueprint 引用可限定 Pack：`@pack-name/asset-name`。不限定时按优先级自动解析（project > settings > global > builtin）。

```yaml
# profile.md frontmatter
blueprint: @pt-internal/dev-knowledge    # 限定到 pt-internal pack
domains: [@gbl/team-stdlib, workflow]    # @gbl 限定 + 无前缀自动解析
```

### settings 声明 Pack

在 `.pi/settings.json` 加载第三方 / 团队 Pack（只声明 path，name 从 manifest 读）：

```json
{
  "pt": {
    "asset-packs": [
      { "path": "~/projects/pt-team-stdlib/assets" },
      { "path": "../shared-pt-assets" }
    ],
    "project-pack-dir": ".pt/assets"
  }
}
```

`project-pack-dir` 可指向项目外路径（`~` / 绝对 / 相对 cwd 都支持）。

### Profile `use` 单继承

Profile 可 `use` 另一 Profile 作为基础，增量覆盖：

```yaml
---
name: my-dev
use: @pt-internal/pt-dev          # 继承 pt-dev 作为基础
blueprint: @team-stdlib/minimal   # 覆盖 use 的 blueprint
domains: [my-domain]              # 追加到 use 的 domains
---
```

合并规则：`name` 强制（不继承）/ `blueprint` 覆盖 / `tagline` 覆盖 / `domains` 追加去重 / `groups` 同名替换。不写 `use` = 完全独立 Profile（back-compat）。

---

## 开发

技术栈：TypeScript + tsup + Vitest + Biome。零运行时依赖（除 yaml 库用于 Blueprint 解析）。

---

## License

MIT
