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
pi install npm:@issac/pi-pt
```

Pi 自动加载 Pt。项目级安装（团队共享，写入 `.pi/settings.json`）加 `-l`：

```bash
pi install -l npm:@issac/pi-pt
```

### 方式二：npm 安装 + 手动配置

```bash
npm install @issac/pi-pt
```

然后在 `.pi/settings.json` 或 `~/.pi/agent/settings.json` 配置扩展入口：

```json
{
  "pi": {
    "extensions": ["./node_modules/@issac/pi-pt/dist/index.js"]
  }
}
```

## 快速开始

### 1. 激活内建 Profile

```bash
pi --pt-profile guide
```

内建 `guide` Profile 用 dev-knowledge Blueprint + 五个内建 Domain（`user-info` / `agent-info` / `project-analysis` / `authoring` / `usage`）——Agent 立刻有“用户身份 + Agent 身份 + 怎么写 Pt 资产 / 怎么分析项目 / 怎么用 Pt”的知识。装包后不改配置也会自动激活 guide（可用 `pt.default-profile` 关闭或改默认）。

### 2. 加自己的知识

在项目 `.pt/assets/` 下加 Domain 和 Profile。项目资产优先级高于内建（同名覆盖）：

`.pt/assets/domains/user-info.md`：
```markdown
---
name: user-info
---
# user-info
## Participant
### user_profile
- desc: 我是这个项目的作者，偏好类型安全、模块化设计
```

`.pt/assets/profiles/my-dev.profile.md`：
```markdown
---
name: my-dev
blueprint: dev-knowledge
domains: [me, project-analysis, authoring, usage]
---
```

会话中切换：`/pt-profile my-dev`（下一轮生效）。

---

## Pt 的机制：四个概念

Pt 用四个概念组织——你写原料，定结构，组装配置，编译出产物：

```
Pt Domain ──→ Blueprint ──→ Pt Profile ──→ Agent Context
  原料          结构           配置            产物
```

### Pt Domain — 原料

领域知识，一个 `.md` 文件。内部用 H2 段切分内容——`## Scene`（概念/背景）、`## Rules`（规则/约束）、`## Flows`（流程模板）、`## Checklists`（验收清单）等。H2 段名决定内容去向，是开放的（加新段名走 generic fallback，不改代码）。放 `.pt/assets/domains/`。

### Blueprint — 结构

聚合结构模板，一个 `.blueprint.yaml` 文件。定义有哪些聚合组（`groups`），每个组聚合哪些 Domain 的 H2 段，注入到哪（`inject: session` 会话级 / `inject: turn` 轮次级）。跨项目复用。放 `.pt/assets/blueprints/`。

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

### Pt Profile — 配置

业务实例，一个 `.profile.md` 文件。选一个 Blueprint + 列要用的 Domain。项目级，不跨项目复用。放 `.pt/assets/profiles/`。

### Agent Context — 产物

Profile 编译后的产物，分两面：

| 面 | 注入 | 时效 | 作用 |
|---|---|---|---|
| **Session Context** | Session Inject | 每轮注入 | Agent 的人格/背景/索引 |
| **Turn Context** | Turn Inject | 按需触发 | 需要时查阅的详细手册 |

带 hash 缓存（`.pt/cache/agent-contexts/`），资产变了自动重编译。

**一句话串起来**：写 Domain → 用 Blueprint 定聚合结构 → 用 Profile 组装 → 编译出 Agent Context 两面注入。

---

## 命令速查

| 命令 | 作用 |
|---|---|
| `/pt-profile <name>` | 切换 Profile（下一轮生效） |
| `/pt` | 查看当前编译状态 |
| `/pt flows` | 列出可触发手册 |
| `/manual:<domain>` | 注入该 Domain 的手册段到 Turn Inject |
| `/<flow> <args>` | 触发 Domain 的 FlowTemplate |
| `--pt-profile <name>` | Pi 启动时激活 Profile（CLI 优先级最高） |

LLM 工具（Agent 可调用）：`pt_status` / `pt_flows` / `pt_manual` / `pt_verify` / `pt_check_refs`。

---

## 进一步阅读

- [全景概览](.pt/docs/designs/pt-overview.md) — 术语 + 架构 + 生命周期的权威技术概览
- [分层模型与转译架构](.pt/docs/designs/pt-asset-layering.md) — 四层模型 + 三段式编译流程
- [产品定位](.pt/docs/designs/pt-positioning.md) — Pt 在知识资产化领域的产品定位
- [术语决策](.pt/docs/designs/pt-terminology.md) — 命名决策记录

Pt 项目自身就用 Pt 配置自己——看真实资产：[`.pt/assets/`](.pt/assets/)（10 个 Domain + dev-knowledge Blueprint + pt-dev Profile）。

---

## 开发

```bash
npm run verify      # biome check + vitest
npm run typecheck   # tsc --noEmit
npm run build       # tsup
```

技术栈：TypeScript + tsup + Vitest + Biome。零运行时依赖（除 yaml 库用于 Blueprint 解析）。

---

## License

MIT
