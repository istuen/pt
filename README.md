# Pt — Turn domain knowledge into agent context

> 把领域知识转化为智能体上下文

Pt 是一个 Pi 扩展。它把你写的领域知识（Markdown 资产）按配置编译成智能体上下文，注入 Pi——让 Agent 每轮对话都带着正确的背景知识，需要时还能查阅详细手册。

> pt 名取自铂（Platinum）的化学符号。铂是催化剂——Pt 把杂乱的领域知识催化成 Agent 能直接用的上下文。

---

## What is Pt

- **Pt Profile 配置两面内容：Session Context（每轮固定注入的会话背景+触发索引）+ Turn Context（按需触发的参考手册，LLM 推理选择使用）。Profile 会话内可切换——换 Profile，两面内容都变。**
- **Pt Profile 使用 Blueprint 与 Pt Domain 组合配置，一次配置，多会话使用。**
- **Blueprint 设计聚合结构——定义 Session Context 和 Turn Context 各聚合哪些 Pt Domain 的 H2 段。**
- **Pt Domain 是文档容器，用户决定装什么——规则与经验、知识与使用方式、项目内与外部系统；内容编译后成为 Agent Context。**

---

## 为什么需要 Pt

LLM 是失忆且被动的：知识在权重里，但不主动浮现；每个会话从零开始。所以每次输入必须自包含——固定背景（Agent 是谁、要做什么）+ 可调阅索引（有什么手册、何时查）。

Pt 把这件事固化成资产：你写一次领域知识，配一份 Profile，Pt 每次会话自动编译成 Agent Context（Session Context + Turn Context）注入。换 Profile 就换场景，不必重写。

---

## 怎么用

### 1. 安装

Pt 是 Pi 扩展，随 Pi 加载。在 Pi 配置里指向 Pt 的 dist：

```json
{
  "pi": {
    "extensions": ["./node_modules/@issac/pi-pt/dist/index.js"]
  }
}
```

### 2. 配置三件资产

Pt 的资产放在项目根目录的 `.pt/assets/` 下，三类：

| 资产 | 目录 | 作用 | 载体 |
|---|---|---|---|
| **Pt Domain** | `.pt/assets/domains/` | 领域知识原料（H2 段切分内容） | `.md` |
| **Blueprint** | `.pt/assets/blueprints/` | 聚合结构（哪些聚合组 + 各聚合什么） | `.yaml` |
| **Pt Profile** | `.pt/assets/profiles/` | 业务实例（选哪些 Domain + 套哪个 Blueprint） | `.md` |

**最小示例**——三个文件跑起来：

`.pt/assets/domains/me.md`（Domain，写知识）：
```markdown
---
name: me
---

# me

## Participant
### user_profile
- desc: 我是这个项目的作者，偏好类型安全、模块化设计

### pt-goal
- desc: 把领域知识变成智能体上下文
```

`.pt/assets/blueprints/dev-knowledge.blueprint.yaml`（Blueprint，定结构）：
```yaml
name: dev-knowledge
groups:
  - name: 会话背景
    inject: session
    modules: [Participant]
```

`.pt/assets/profiles/my-dev.profile.md`（Profile，组装）：
```markdown
---
name: my-dev
blueprint: dev-knowledge
domains: [me]
---
```

### 3. 激活 Profile

两种方式：

```bash
# 方式 A：Pi 启动时用 flag
pi --pt-profile my-dev

# 方式 B：会话中切换（下一轮生效）
/pt-profile my-dev
```

激活后，Pt 自动编译：把 `me` Domain 的 `Participant` 段聚合成 Session Context 的会话背景，每轮注入 Session Inject。你的 Agent 就知道"我是谁、要做什么"。

---

## 核心概念

Pt 用四层模型组织资产，理解时从产物倒推：

```
Agent Context  ← 产物：编译后的两面上下文（Session Context + Turn Context）
      ↑ Profile 编译产出
Profile        ← 配置：选 Blueprint + 选 Domain，组合出不同场景
      ↑ 引用
Blueprint      ← 结构：声明有哪些聚合组（groups）+ 各聚合什么 Domain Schema Name + 注入到哪（inject: session/turn）
      + Domain  ← 原料：领域知识，按 H2 段切模块
```

### Agent Context（产物）

Profile 编译后的产物，是 Pt 的核心价值。分两面：

| 面 | 注入位置 | 时效 | 作用 |
|---|---|---|---|
| **Session Context** | Session Inject | 静态，每轮重注 | Agent 的人格/背景/索引 |
| **Turn Context** | Turn Inject | 动态，按需触发 | 需要时查阅的详细内容 |

物理文件在 `.pt/cache/agent-contexts/`，带 hash 缓存——资产变了自动重编译。

### Profile（配置）

业务实例，把 Blueprint 和 Domain 组装成具体场景。项目级，不跨项目复用。

- YAML `domains`：全局 Domain 列表，自动分发到所有聚合组
- 聚合组 H2 下 `### Domains`：只给该聚合组追加

### Blueprint（结构）

聚合结构模板，Agent 端设计。载体是 YAML，跨项目复用。

- 每个 group = 一个聚合组（name 人类自定义，如"会话背景"/"参考手册"）
- `inject`：注入位置（`session` 会话级 / `turn` 轮次级）
- `modules`：该聚合组聚合哪些 Domain Schema Name

### Domain（原料）

领域知识，一个 `.md` 文件，内部用 H2 段切分内容。H2 段名决定内容去向：

| H2 段 | 内容 | 聚合到 |
|---|---|---|
| `## Scene` | 公理/概念/背景 | 会话背景（Session Context） |
| `## Trigger` | 索引（何时查手册） | 触发索引（Session Context） |
| `## Participant` | 参与者画像 | 会话背景（Session Context） |
| `## Rules` | 规则/约束 | 参考手册（Turn Context） |
| `## Flows` | 流程模板 | 参考手册（Turn Context） |
| `## Checklists` | 验收清单 | 参考手册（Turn Context） |

H2 段名是开放的——加新段名走 generic fallback，不改代码。

---

## 命令速查

### 用户命令

| 命令 | 作用 |
|---|---|
| `/pt-profile <name>` | 切换 Profile（下一轮生效） |
| `/pt-profile`（无参） | 列出所有可用 Profile |
| `/pt` | 查看当前编译产物/状态 |
| `/pt status` | 显示 active Profile + 段长度 + cache hit |
| `/pt flows` | 列出可触发手册 |
| `/pt raw` | dump 当前 segment 到 `.pt/cache/raws/` |
| `/pt full` | dump 完整 Session Inject 到 `.pt/cache/fulls/` |
| `/pt logs` | 查看日志 |
| `/manual:<domain>` | 注入该 Domain 的 Rules/Flows/Checklists 段到 Turn Inject |
| `/<flow> <args>` | 触发 Domain 的 FlowTemplate |

### Flag

| Flag | 作用 |
|---|---|
| `--pt-profile <name>` | Pi 启动时激活 Profile（CLI 优先级最高） |

### LLM 工具（Agent 可调用）

| 工具 | 作用 |
|---|---|
| `pt_status` | 查看编译状态 |
| `pt_flows` | 列出可用手册 |
| `pt_manual` | 创建手册实例文档 |
| `pt_verify` | 验证手册步骤执行结果 |
| `pt_check_refs` | 检查资产引用完整性 |

---

## 资产目录布局

```
.pt/
├── assets/              # 入 git — 转译资产
│   ├── domains/         #   领域知识（.md）
│   ├── blueprint/      #   聚合结构（.blueprint.yaml）
│   └── profiles/        #   业务实例（.profile.md）
├── docs/                # 入 git — 设计文档 / issue 跟踪
├── manuals/             # gitignore — 手册实例工作文档
├── cache/               # gitignore — 运行产物
│   ├── agent-contexts/  #   编译后的 AgentContext
│   ├── raws/            #   segment dump
│   └── fulls/           #   完整 prompt dump
└── logs/                # gitignore — NDJSON trace
```

Pt 自带一组内建资产（`src/builtin/assets/`，随 npm 包发布），项目 `.pt/assets/` 优先级高于内建——同名时项目覆盖内建。

---

## 配置示例

Pt 项目自身就用 Pt 配置自己。看真实资产：

- Blueprint：[`.pt/assets/blueprints/dev-knowledge.blueprint.yaml`](.pt/assets/blueprints/dev-knowledge.blueprint.yaml)
- Profile：[`.pt/assets/profiles/pt-dev.profile.md`](.pt/assets/profiles/pt-dev.profile.md)
- Domain：[`.pt/assets/domains/`](.pt/assets/domains/)（10 个，覆盖开发流程/issue/release/质量规范等）

`pt-dev` Profile 编译出两面 Agent Context：
- Session Context：me（参与者）+ product-design（项目认知）+ 各 workflow 的 Scene/Trigger
- Turn Context：各 workflow 的 Flows + pt-quality 的 Rules + pt-collab 的 Checklists

---

## 进一步阅读

- [全景概览](.pt/docs/designs/pt-overview.md) — Pt 权威技术概览（术语 + 架构 + 生命周期）
- [分层模型与转译架构](.pt/docs/designs/pt-asset-layering.md) — 四层模型 + 三段式编译流程的权威定义
- [术语决策](.pt/docs/designs/pt-terminology.md) — 命名决策记录
- [产品定位](.pt/docs/designs/pt-positioning.md) — Pt 在知识资产化领域的产品定位
- [执行者简报](.pt/docs/designs/) — 各 Phase 的执行文档

---

## 开发

```bash
npm run verify      # biome check + vitest
npm run typecheck   # tsc --noEmit
npm run lint        # biome check
npm run build       # tsup
```

技术栈：TypeScript + tsup + Vitest + Biome。零运行时依赖（除 yaml 库用于 Blueprint 解析）。

---

## License

MIT
