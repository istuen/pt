本页面聚焦 **Pt 资产文件的目录布局与文件命名约定**，回答三个核心问题：**资产放在哪里**、**文件怎么命名**、**文件名如何映射到资产名（IR `name`）**。理解这些约定是编写 Domain / Channel / Blueprint 三类资产的基础前置知识——具体资产的内部格式（frontmatter、H2/H3 段写法）请参看 [编写 Domain / Channel / Blueprint 三类资产](4-bian-xie-domain-channel-blueprint-san-lei-zi-chan)。

## 资产根目录：`.pt/assets/` 三子目录布局

Pt 把所有可编译的业务知识资产集中在仓库根的 **`.pt/assets/`** 目录下，按资产类型分成三个并列的子目录。这三个子目录的职责一一对应 v8 四层模型中的 **内容层（Domain）**、**结构层（Channel）**、**配置层（Blueprint）**：

```
.pt/assets/
├── domains/       # 内容层：业务知识原始素材（按 type 区分内容性质）
├── channels/      # 结构层：注入点 + target + modules（跨项目复用）
└── blueprints/    # 配置层：Channel引用 + 按注入点选 Domain + Trigger/Boundaries + Compilation
```

**目录职责速览：**

| 子目录 | 加载器入口 | 解析器 | 产出 IR |
|---|---|---|---|
| `domains/` | `loadAllDomains()` | `parseDomain()` | `Domain[]` |
| `channels/` | `loadAllChannels()` | `parseChannel()` | `Channel[]` |
| `blueprints/` | `loadAllBlueprints()` | `parseBlueprint()` | `Blueprint[]` |

三个加载器在 `parse/index.ts` 的 `oxnAdapter.load()` 中被顺序调用，组装成统一的 `SchemaBundle`。**目录路径在代码里是硬编码的相对路径**（`join(cwd, ".pt/assets/<subdir>")`），不是配置项——所以你不能改目录名（如把 `domains/` 改成 `content/`），否则 Pt 会把目录当作"不存在"返回空数组。

Sources: [src/parse/index.ts](src/parse/index.ts#L67-L83)

## 三类资产文件的命名规则

Pt 对三类资产采用**不同的命名后缀约定**——这是因为后缀同时承担两个职责：**（1）让目录里一眼分清资产类型**；**（2）让解析器自动从文件名推导资产名**（剥掉后缀即得 IR `name`）。

|资产类型 | 文件名格式 | 后缀是否强制 | 示例 |
|---|---|---|---|
| **Domain**（内容层） | `<name>.md` | 无后缀（v8 不带 `.term/.workflow/.stack`） | `pt-concepts.md`、`pt-dev-flow.md`、`pt-stack.md` |
| **Channel**（结构层） | `<name>.channel.md` | **必须**以 `.channel` 结尾 | `pt-dev.channel.md`、`dev-knowledge.channel.md` |
| **Blueprint**（配置层） | `<name>.blueprint.md` | **必须**以 `.blueprint` 结尾 | `pt.blueprint.md`、`pt-dev.blueprint.md`、`glossary-test.blueprint.md` |

**后缀强制的代码依据：**

- Channel 解析器：`stripChannelSuffix()` 用正则 `/\.channel$/` 剥后缀；如果你的 Channel 文件名没有 `.channel` 后缀，剥后缀会失败但不会报错，结果就是**文件名变成 `name`**（包括 `.md` 已被前级剥离）。所以 `.channel` 后缀本质是**约定**而非**校验**——但省略它会让同一目录里 Channel 与 Domain 视觉混淆。
- Blueprint 解析器：`stripBlueprintSuffix()` 用正则 `/\.blueprint$/` 剥后缀；同理省略后缀不会报错但会破坏目录视觉一致性。
- Domain 解析器：`stripTypeSuffix()` 只剥 `.term/.workflow/.stack` 这三个 v6 兼容后缀；**v8 不需要任何后缀**。

**实战建议：** 即使后缀在代码层是"软约定"，**始终按表格里的格式命名**——这能让任何打开仓库目录的人（包括你自己一周后）一眼分清类型。

Sources: [src/parse/channel.ts](src/parse/channel.ts#L70-L73)、[src/parse/domain.ts](src/parse/domain.ts#L148-L151)、[src/config.ts](src/config.ts#L31-L46)

## 文件名 → IR `name` 的解析优先级

Pt 解析每个资产文件时，会按以下**优先级顺序**推导 IR 的 `name` 字段（Domain / Channel / Blueprint三个解析器都遵循同一规则）：

1. **frontmatter `name:` 字段**（最高优先级）—— 若 YAML frontmatter 里显式写了 `name: <x>`，就用 `<x>`。
2. **文件名去后缀**（兜底）—— 若 frontmatter 没有 `name`，就把 `<name>.md` 的 `<name>` 部分作为 IR `name`。

这个优先级对应 schema 里的三段解析代码：

```typescript
// Domain解析器（src/parse/domain.ts 第25 行附近）
const name = typeof asset.frontmatter.name === "string"
 ? asset.frontmatter.name
  : stripTypeSuffix(asset.name, type);
```

```typescript
// Channel 解析器（src/parse/channel.ts 第 47 行附近）
const name = typeof asset.frontmatter.name === "string"
  ? asset.frontmatter.name
  : stripChannelSuffix(asset.name);
```

```typescript
// Blueprint 解析器（src/parse/blueprint.ts 第 75 行附近）
const name = typeof asset.frontmatter.name === "string"
  ? asset.frontmatter.name
  : stripBlueprintSuffix(asset.name);
```

**为什么这个优先级有意义？** 因为 IR `name` 是 **Blueprint 引用 Channel / Domain 的唯一标识**。举例：`pt.blueprint.md` 的 frontmatter 里写 `name: pt`，但它的 `## Channel` 段引用的是 `dev-knowledge`——所以 `dev-knowledge.channel.md` 里也必须写 `name: dev-knowledge`。**文件名必须和 IR `name` 一致**（或至少让后者可被前级覆盖）；否则 Blueprint 引用会找不到目标。

Sources: [src/parse/domain.ts](src/parse/domain.ts#L23-L26)、[src/parse/channel.ts](src/parse/channel.ts#L45-L50)、[src/parse/blueprint.ts](src/parse/blueprint.ts#L73-L77)

## frontmatter 契约：每个类型必填的最小字段

不同资产对 frontmatter 的要求差异很大——Domain 必须有 `type`，Channel/Blueprint 的 `name` 都是可选的（但**强烈建议显式写**）。

| 资产类型 | 必填 frontmatter | 推荐 frontmatter | 说明 |
|---|---|---|---|
| **Domain** | `type: <term\|workflow\|stack\|扩展>` | `name: <domain-name>` | `type` 决定各 H2 段**内部**字段解析规则（Scene→Term[]/ExternalRef[]/ToolRef[]）；`name` 是 Blueprint 引用时的标识 |
| **Channel** | （无） | `name: <channel-name>` | Channel 是结构层复用件，frontmatter 只承载 `name`；不写 `name` 时从文件名推导 |
| **Blueprint** | （无） | `name: <blueprint-name>` | Blueprint 是激活入口，`name` 会成为 Context 物理文件的 `<name>.context.md` 主名 |

**实战中三个文件的 frontmatter 范本：**

```yaml
# .pt/assets/domains/pt-concepts.md（Domain必填 type + 推荐 name）
---
type: term
name: pt-concepts
---
```

```yaml
# .pt/assets/channels/pt-dev.channel.md（Channel 推荐 name）
---
name: pt-dev
---
```

```yaml
# .pt/assets/blueprints/pt.blueprint.md（Blueprint 推荐 name）
---
name: pt
---
```

注意 `glossary-test.md` 的 frontmatter `type: glossary`——这演示了 **"扩展 type"** 的扩展点：`type` 字段是开放的（不限于 `term/workflow/stack`），Pt 主循环不识别时走通用 fallback（term 形态解析）。这正是 v8 Schema 反转设计的扩展性入口，具体注册方式详见 [注册新的 Domain Type 渲染器](18-zhu-ce-xin-de-domain-type-xuan-ran-qi)。

Sources: [src/parse/domain.ts](src/parse/domain.ts#L20-L21)、[src/parse/channel.ts](src/parse/channel.ts#L45-L50)、[src/parse/blueprint.ts](src/parse/blueprint.ts#L73-L77)、[.pt/assets/domains/pt-concepts.md](.pt/assets/domains/pt-concepts.md#L1-L4)

## 目录枚举机制：扁平加载、无嵌套

Pt 用 `loadDir()` 函数枚举资产目录里的**所有 `.md` 文件**（`readdir` + `endsWith(".md")` 过滤），**不递归子目录**。这意味着每个资产类型目录必须是**扁平的**——你不能在 `.pt/assets/domains/` 下再建一层子目录。

```typescript
// src/parse/index.ts 第 80 行附近的 loadDir() 实现
async function loadDir<T>(dir: string, suffix: string, parser: (f: string) => Promise<T>): Promise<T[]> {
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(suffix));
  } catch {
    return [];  // 目录不存在返空（channels/ 在 7.4 前可能尚未建立）
  }
  // ... 并发解析每个文件，单个失败不阻塞整体
}
```

**关键行为细节：**

- **不存在即空**：`catch` 块捕获 `readdir` 异常并返空数组。这意味着即使你没建 `.pt/assets/channels/` 目录（早期版本没有 Channel概念），Pt 也不会报错——只是 channels 列表为空。
- **单文件失败不阻塞**：`parser` 抛异常会被捕获并 `console.error`，该文件返回 `null`，最后被 `.filter()` 剔除。**所以一个写错的资产不会让整个 Pi 会话崩溃**，只会在终端看到 `[pt] parse <dir>/<file> failed: ...` 错误。
- **并发解析**：`Promise.all(files.map(...))` 同时启动所有解析任务；解析大量资产时比串行快。

Sources: [src/parse/index.ts](src/parse/index.ts#L85-L94)

## 当前仓库的资产清单（参考）

为方便你对照上面的约定理解实际形态，下面是当前仓库 `.pt/assets/` 的完整清单：

| 子目录 | 文件 | 后缀 | frontmatter `name` |用途 |
|---|---|---|---|---|
| `domains/` | `pt-concepts.md` | （无） | `pt-concepts` | term-type：Pt 核心概念 |
| `domains/` | `pt-architecture.md` | （无） | `pt-architecture` | term-type：架构设计 |
| `domains/` | `pt-transpile.md` | （无） | `pt-transpile` | term-type：转译流程 |
| `domains/` | `pt-dev-flow.md` | （无） | `pt-dev-flow` | workflow-type：开发手册 |
| `domains/` | `pt-collab.md` | （无） | `pt-collab` | term-type：协作约定 |
| `domains/` | `pt-quality.md` | （无） | `pt-quality` | term-type：质量判据 |
| `domains/` | `pt-stack.md` | （无） | `pt-stack` | stack-type：技术栈 |
| `domains/` | `glossary-test.md` | （无） | `glossary-test` | glossary-type：扩展 type演示 |
| `channels/` | `dev-knowledge.channel.md` | `.channel` | `dev-knowledge` | 会话知识 + 对话记忆注入点 |
| `channels/` | `pt-dev.channel.md` | `.channel` | `pt-dev` | 同上结构，独立 Channel |
| `blueprints/` | `pt.blueprint.md` | `.blueprint` | `pt` | 用户问 Pt 知识时激活 |
| `blueprints/` | `pt-dev.blueprint.md` | `.blueprint` | `pt-dev` | 用户问 Pt 开发时激活 |
| `blueprints/` | `glossary-test.blueprint.md` | `.blueprint` | `glossary-test` | 扩展性回归用例 |

注意观察 `pt-dev.channel.md` 和 `dev-knowledge.channel.md` 这两个 Channel 文件**结构几乎相同**（都是"会话知识" + "对话记忆"两个注入点）——这印证了 Channel **可被多个 Blueprint 复用**的设计；同结构不同 Blueprint 的差异在于按注入点选哪些 Domain。

Sources: [src/parse/index.ts](src/parse/index.ts#L67-L83)、[.pt/assets/channels/pt-dev.channel.md](.pt/assets/channels/pt-dev.channel.md#L1-L17)、[.pt/assets/channels/dev-knowledge.channel.md](.pt/assets/channels/dev-knowledge.channel.md#L1-L17)

## 命名常见误区与兼容性说明

**误区 1：给 Domain 加 `.domain` 后缀。** Pt 的 Domain 解析器**不识别 `.domain` 后缀**（只识别 v6 兼容的 `.term/.workflow/.stack`）。如果你写 `pt-concepts.domain.md`，`stripTypeSuffix()` 不会剥它，结果 IR `name` 变成 `pt-concepts.domain`——这会让 Blueprint `### Domains` 列表里写 `pt-concepts` 时找不到匹配。

**误区 2：省略 Channel / Blueprint 的后缀。** 代码不会报错，但会造成目录视觉混乱。强烈建议**始终加 `.channel` / `.blueprint` 后缀**。

**误区 3：在资产子目录下嵌套文件夹。** `loadDir()` 不递归——`.pt/assets/domains/v1/pt-concepts.md` 不会被加载。Pt 不支持资产分组。

**兼容性事实：** v8 不再需要 `.term/.workflow/.stack` 后缀（Domain 用 frontmatter.type 区分），但 `stripTypeSuffix()` 仍保留 v6 兼容逻辑。如果你的团队从旧版本迁移，老的 `xxx.term.md` 仍可加载（IR `name` 会被剥成 `xxx`）。**新写的 Domain 文件不要再加 v6 后缀**。

**命名字符约束：** 文件名应仅用 ASCII 字母、数字、`-`（连字符）、`_`（下划线）。解析器正则 `/\.[^.]+$/` 只剥最后一个 `.xxx` 后缀，前段字符没有强制限制，但 frontmatter 字段名解析正则 `^([a-zA-Z_][\w-]*)` 要求字段名以字母/下划线开头，所以 `name` 字段只能用 ASCII。**H2/H3 段名（如"会话知识"、"对话记忆"）则完全支持中文**。

Sources: [src/parse/shared.ts](src/parse/shared.ts#L66-L68)、[src/parse/domain.ts](src/parse/domain.ts#L148-L151)

## 下一步建议

掌握目录与命名约定后，建议按以下顺序继续阅读：

- **入门**：下一步是 [编写 Domain / Channel / Blueprint 三类资产](4-bian-xie-domain-channel-blueprint-san-lei-zi-chan)——本页面只讲"放哪里 / 叫什么"，下页面讲"里面写什么"。
- **调试**：写完资产后，用 [常用命令与调试输出](5-chang-yong-ming-ling-yu-diao-shi-shu-chu) 验证加载是否正确，用 [查看与导出转译产物](6-cha-kan-yu-dao-chu-zhuan-yi-chan-wu-pt-status-raw-full-flows) 看 Context 编译结果。
- **深入**：当你想知道"为什么这样分层"，读 [v8 四层模型](7-v8-si-ceng-mo-xing-domain-channel-blueprint-context)；当你想知道"解析器到底怎么读我的 frontmatter"，读 [解析前端：MD 词法与 H2/H3 切分](13-jie-xi-qian-duan-md-ci-fa-yu-h2-h3-qie-fen)。