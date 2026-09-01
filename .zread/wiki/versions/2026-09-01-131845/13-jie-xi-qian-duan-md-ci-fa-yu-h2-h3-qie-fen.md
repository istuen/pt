`src/parse/` 是 Pt 三段式编译架构的最前端入口，负责把 `.pt/assets/{domains,channels,blueprints}/*.md` 资产文件解析成 IR 中间表示。本页聚焦**词法与结构切分层**——即通用 MD 解析、H2 段切分、H3 子项解析、scalar 值解析——以及它们如何被三类资产（Domain/Channel/Blueprint）共享。

> 本页是 [三段式编译架构（parse→compile→render）](8-san-duan-shi-bian-yi-jia-gou-parse-compile-render) 的深入展开，重点在 parse 的词法/语法层。

## 解析前端在转译管道中的位置

`src/parse/` 由四个文件组成，按"共享 → 适配器 → 入口"分层：

| 文件 | 行数 | 职责 |
|---|---|---|
| `src/parse/shared.ts` | 332 | **共享词法 + IR契约**——通用 MD 解析、frontmatter、H2/H3 切分、scalar 值解析、字段取值辅助 |
| `src/parse/domain.ts` | 152 | **Domain adapter**——把 `domains/*.md` 解析成 `Domain` IR（type标签 + modules） |
| `src/parse/channel.ts` | 100 | **Channel adapter**——把 `channels/*.md` 解析成 `Channel` IR（H2=注入点 + target/mode/modules） |
| `src/parse/blueprint.ts` | 247 | **Blueprint adapter**——把 `blueprints/*.md` 解析成 `Blueprint` IR（Channel + 注入点实例化 + Compilation） |
| `src/parse/index.ts` | 93 | **OXN Source Adapter入口**——按目录位置分发到三个 adapter，组装 `SchemaBundle` |

Sources: [shared.ts](src/parse/shared.ts#L1-L10), [index.ts](src/parse/index.ts#L1-L12)

## 解析管道总览：四阶段流水线

`readAsset()` 把一个 `.md` 文件拆成四段独立阶段，每阶段产物独立可测，下游 adapter 拿到的是已结构化的 `Asset` 对象，不再接触原始正则。

```mermaid
flowchart LR A[".md 文件<br/>（UTF-8 文本）"] --> B["1. parseFrontmatter<br/>---...---<br/>→ {fm, body}"]
    B --> C["2. splitSections<br/>## 标题切分<br/>→ Section[]"]
    C --> D["3. parseItems<br/>### 子项 + - key: value<br/>→ Item[]"]
    D --> E["4. inferKind / name<br/>fallback<br/>→ Asset"]
    E --> F["Asset { kind, name,<br/>frontmatter, body, sections }"]
    F --> G["Adapter: domain /<br/>channel / blueprint"]
    G --> H["IR: Domain /<br/>Channel / Blueprint"]
```

四阶段的语义清晰度直接影响 IR契约的稳定性：

| 阶段 | 输入 | 输出 | 失败模式 |
|---|---|---|---|
| **frontmatter** | 完整文件文本 | `{ fm, body }`（fm 可能为 `{}`） | 无 `---` 包裹 → 返回原文作 body，fm 为空 |
| **H2 切分** | body字符串 | `Array<{heading, raw}>` | 无 H2 → 返回空数组（adapter拿到空 sections） |
| **H3/items** | 段 raw 文本 | `Item[]` | 空段 → 返回空 items（合法，例 `## Manual` 段可空） |
| **kind 推断** | frontmatter + body | `AssetKind` | 仅在 frontmatter 三字段皆缺时触发 |

Sources: [shared.ts: readAsset](src/parse/shared.ts#L56-L85), [shared.ts: parseFrontmatter](src/parse/shared.ts#L87-L103), [shared.ts: splitSections](src/parse/shared.ts#L160-L177), [shared.ts: parseItems](src/parse/shared.ts#L179-L225), [shared.ts: inferKind](src/parse/shared.ts#L323-L332)

## 共享 IR 契约：Asset / Section / Item

`Asset` / `Section` / `Item` 是**O（OXN）X N（namespace）**内部资产模型，Pt 核心不感知——它属于 Source Adapter 的私有产物，adapter 自己把 Asset 映射到 [Schema 与 IR 契约（src/schema.ts）](12-schema-yu-ir-qi-yue-src-schema-ts) 里的语义 IR（Domain/Channel/Blueprint）。

```typescript
//来自 src/parse/shared.ts
interface Item {
  name: string;              // H3 标题（如 "Pt 是什么" / "select-topic"）
  fields: Record<string, unknown>;  // "- key: value" / "- key: [a, b]" / "- key: { ... }"
}

interface Section {
  heading: string;           // "## Terms" 原文
  raw: string;               // 段内 markdown（含 H3 子项）
  items: Item[];             // H3 子项解析结果
}

interface Asset {
  kind: AssetKind;           //资产分类（domain/channel/blueprint/...）
  name: string;              // 文件名去后缀（"pt-concepts" / "pt-dev.channel"）
  frontmatter: Record<string, unknown>;
  body: string;              // frontmatter 之后的 markdown
  sections: Record<string, Section>;  // H2 段名 → Section（key 为标题原文）
}
```

**关键设计要点**：

- `Item.fields` 的值类型是 `unknown`，因为 `- key: [a, b]` 和 `- key: { ... }` 都会被解析为数组 / 嵌套对象，**消费者用 `typeof` 收窄**——这是 shared 层刻意不做语义约束、把语义判断推迟给 adapter 的关键决策。
- `AssetKind` 是个并集类型（`"domain" | "channel" | "blueprint" | "term" | "workflow" | "stack" | "glossary" | "scene" | "manual"`），保留了 v6/v7 资产迁移期的 `scope` / `manual` 残留以做向后兼容。
- `sections` 用 H2 段名（去 `#` 前缀后 trim）作 key——这样下游 Channel adapter 写 `asset.sections["会话知识"]` / `asset.sections["Modules"]`（v7 残留）就是直读直查。

Sources: [shared.ts: Item/Section/Asset/AssetKind 类型定义](src/parse/shared.ts#L13-L52)

## Frontmatter 解析：`parseFrontmatter`

`parseFrontmatter()` 是最简单的一层，只识别 `---\n...\n---\n` 包裹的 YAML 子集：

**正则模式**：`^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$`

- 第 1 组：frontmatter 内容（直到下一个 `---`）
- 第 2 组：剩余 body（`\n?` 允许 body 前不留空行）

**字段语法**（每行一次匹配 `^([a-zA-Z_][\w-]*)\s*:\s*(.*)$`）：
- `key: string` → 标量字符串
- `key: [a, b, c]` → 字符串数组
- `key: { nested: value }` → 嵌套对象（递归调用 `parseScalar`）

`parseScalar()` 是 recursive descent，**嵌套值通过 `parseScalar` 递归解析**——例如：

```yaml
type: term
name: pt-concepts
extensions:
  - extra: true
    level: axiom
```

会被解析为：

```typescript
{
  type: "term",
  name: "pt-concepts",
  extensions: [{ extra: "true", level: "axiom" }]  // 内层仍是字符串（parseScalar 只对顶层 {} 处理）
}
```

**反斜杠 / 嵌套对象深度**：`splitTopLevel()` 用 depth 计数器（`{`/`[` 加1、`}`/`]` 减 1）保证逗号只在 depth 0 时才切分顶层成员，从而支持 `{ a: { b: 1 }, c: 2 }` 这类嵌套结构。

`unquote()` 处理单/双引号包裹的字符串（`"value"` / `'value'` → `value`）。

Sources: [shared.ts: parseFrontmatter](src/parse/shared.ts#L87-L103), [shared.ts: parseScalar / parseInlineObject / splitTopLevel / unquote](src/parse/shared.ts#L105-L158)

## H2 段切分：`splitSections`

`splitSections()` 按 `## ` 行首标记把 body 切分成独立段。**算法是单 pass 行扫描 + 状态机**：

```typescript
for (const line of lines) {
  const h2 = line.match(/^##\s+(.+)$/);
  if (h2) {
    if (cur) sections.push({ heading: cur.heading, raw: cur.lines.join("\n") });
    cur = { heading: line.trim(), lines: [] };
  } else if (cur) {
    cur.lines.push(line);
  }
}
```

**关键行为约定**：

| 情形 | 行为 | 来源 |
|---|---|---|
| `# ` H1（asset标题） | **不作为 H2 段处理**——被忽略（asset 一般只有 1 个 H1 作文件标题） | [shared.ts:L160](src/parse/shared.ts#L160) |
| H2 出现在 body 开头（前无 H1） | 正常切分（head 前的空行不会进段） | [shared.ts:L161-L177](src/parse/shared.ts#L161-L177) |
| 连续两个 H2 间无内容 | 第二个 H2 切出一段空 `raw` 的 section（`items` 为 `[]`） | [shared.ts:L169-L170](src/parse/shared.ts#L169-L170) |
| 文件无 H2 | 返回空数组（adapter 拿到 `sections = {}`） | [shared.ts:L174-L175](src/parse/shared.ts#L174-L175) |
| H3 / H4 等更深标题 | 不参与段切分（归属其最近的 H2 段 raw 中，由 `parseItems` 处理） | [shared.ts:L166-L174](src/parse/shared.ts#L166-L174) |

> **设计取舍**：H1忽略 + H3归属最近 H2 的策略，把 H1 完全当"文件标题装饰"、把 H3 当"段内子项结构"，实现上只需识别 `## ` 一个层级。

Sources: [shared.ts: splitSections](src/parse/shared.ts#L160-L177)

## H3 子项解析：`parseItems` 的两种模式

`parseItems(sectionRaw: string): Item[]` 是段内解析的核心。它**先用 `lines.some((l) => /^###\s+/.test(l))` 检测段内是否有 H3，再分两条路径**：

### 模式 A：段内有 H3（最常见）

每个 H3 是一个 `Item`，下属 `- key: value` 行填进 `Item.fields`。H3 切换时把当前 `Item` push 进数组：

```markdown
### Pt 是什么
- desc: Pi 扩展，把业务知识资产...

### v8 四层模型
- desc: Domain + Channel + Blueprint + Context
```

→ `[{ name: "Pt 是什么", fields: { desc: "Pi 扩展..." } }, { name: "v8 四层模型", fields: { desc: "Domain + Channel + ..." } }]`

### 模式 B：段内无 H3（裸名列表）

整段是顶层 list，每行直接成一个 `Item`。支持两种行形态：

| 行形态 | 解析结果 | 典型用途 |
|---|---|---|
| `- key: value` | `{ name: "key", fields: { key: <scalar> } }` | `## Modules`、`## Domains` 的兜底形态 |
| `- name`（无冒号） | `{ name: "name", fields: {} }` | `## Modules` 列 Domain H2 段名（裸名列表） |

**两种模式的对比如下**：

| 维度 | 模式 A（有 H3） | 模式 B（无 H3） |
|---|---|---|
| **结构层级** | H3 → Item，`-` 行作 fields | H2 → Item，`-` 行作 Item自身 |
| **fields 来源** | H3 下属 `- key: value` 行 | 顶层 `- key: value`（key 重名于 name） |
| **典型场景** | term-Domain.## Scene 的术语条目 | Channel H2 下的裸字段（target/mode）、Blueprint H2 下的裸字段 |
| **示例** | `### Pt 是什么\n- desc: ...` | `target: system_prompt\nmode: hybrid` |

**字段值类型**：`- key: value` 中的 value 仍走 `parseScalar()`，所以 `- deps: [a, b]`、`- args: { x: 1 }` 都会被正确解析为数组 / 对象——见 [boundary节点定义](#字段取值辅助与别名) 的用法。

Sources: [shared.ts: parseItems 模式 A](src/parse/shared.ts#L187-L206), [shared.ts: parseItems 模式 B](src/parse/shared.ts#L208-L225)

## Scalar 值解析：递归的 YAML 子集

`parseScalar(val: string): unknown` 是所有 `- key: value` 行和 frontmatter 字段值的解析器。**它是一个三分支判断器**：

```
val 为空 → ""
val形如 [a, b, c] → 数组（, 切分 + unquote +过滤空）
val 形如 { k: v, ... } → 嵌套对象（parseInlineObject）
否则 → unquote(val)
```

`parseInlineObject()` 内部用 `splitTopLevel()` 按 depth-aware 的方式切分顶层逗号，然后每段递归调用 `parseScalar()`——这意味着**任意深度的嵌套 YAML 子集都能解析**。

**典型解析结果对照表**：

|原始 value字符串 | parseScalar 返回 | 类型 |
|---|---|---|
| `system_prompt` | `"system_prompt"` | string |
| `[Scene, Manual]` | `["Scene", "Manual"]` | string[] |
| `{ mode: hybrid, domainOrder: [a, b] }` | `{ mode: "hybrid", domainOrder: ["a", "b"] }` | object |
| `"含:冒号"` | `"含: 冒号"`（引号保留整体） | string |
| `''`（空） | `""` | string（空字符串，非 undefined） |

> **设计取舍**：`parseScalar` 故意只识别 `[...]` / `{...}` 两个特殊形态，其他都当字符串。这样既覆盖了 90% 的资产配置需求，又避免了引入完整 YAML 解析器的依赖。

Sources: [shared.ts: parseScalar](src/parse/shared.ts#L105-L122), [shared.ts: parseInlineObject](src/parse/shared.ts#L124-L133), [shared.ts: splitTopLevel](src/parse/shared.ts#L135-L151), [shared.ts: unquote](src/parse/shared.ts#L153-L158)

## 字段取值辅助：`s` / `sArr` / `extractFieldValue` / `extractBareListUnderH3`

为 v8 注入点机制配套，`shared.ts` 末尾新增了四个字段取值辅助函数。

### `s(v: unknown): string`

把 `unknown` 收窄为字符串。**数组 → join(", ")**，否则返回 `""`。用途：把 `Item.fields.desc` 这种可能是 string / string[] 的值统一成 string。

### `sArr(v: unknown): string[]`

把 `unknown` 收窄为 `string[]`。**单值 → 包成 1-数组**，空值 → `[]`。用途：`Item.fields.operations` 这种可能是单值或数组的字段。

### `extractFieldValue(section, key): string`

**兼容三种字段写法**——这是 v8 适配器读 `target` / `mode` / `cache-dir` 的关键工具：

1. **顶层 list 行**：扫描 `section.items`，找 `item.fields[key]` 有定义的 → `s(v)`
2. **裸值段**：扫 `section.raw` 行，找匹配 `^key: value$` 的第一行 → `parseScalar`
3. 都无 → 返回 `""`

**典型应用场景**：

| 调用方 | 段 | 读的字段 | 来源行 |
|---|---|---|---|
| `parseChannel` | `## 会话知识` | `target`, `mode` | `- target: system_prompt` 或 `target: system_prompt` 裸值 |
| `parseBlueprint` | `## Compilation` | `cache-dir`, `split` | `cache-dir: .pt/contexts/cache/` |
| `parseBlueprint` | `## Channel` | 引用哪个 Channel（裸值） | 由 `extractBareValue` 处理 |

### `extractBareListUnderH3(section, h3Name): string[]` + 两个别名

**从一个 H2 段下取指定 H3 名下的所有裸名列表项**（`- name`）。这是 Channel / Blueprint 注入点机制读"参与本注入点的 Domain H2 段名 / Domain 名"的核心工具：

- **Channel 用**：找 `### Modules`下的 Domain H2 段名（`- Scene`）
- **Blueprint 用**：找 `### Domains` 下的 Domain 名（`- pt-concepts`）

**主路径算法**：扫 `section.raw` 行，找到 `### <h3Name>` 后开启收集，遇下一 H3 / H4 终止，匹配 `^\s*-\s+([^\s:]+)\s*$`（裸名行，无冒号）。

**兼容路径**：`fields.modules` / `fields.refs` 是数组的旧写法也支持（v7 残留兼容）。

```typescript
export function extractModulesList(section: Section | undefined): string[] {
  return extractBareListUnderH3(section, "Modules");  // Channel 用
}
export function extractDomainsList(section: Section | undefined): string[] {
  return extractBareListUnderH3(section, "Domains");  // Blueprint 用
}
```

Sources: [shared.ts: s / sArr](src/parse/shared.ts#L228-L241), [shared.ts: extractFieldValue](src/parse/shared.ts#L243-L266), [shared.ts: extractBareListUnderH3 + 别名](src/parse/shared.ts#L268-L321)

## Kind 推断回退：`inferKind`

当 `frontmatter.kind` / `type` / `entity` 三个字段都不存在时（**极少见**，仅 v6 资产迁移期），`inferKind()` 按 H2 段名特征推断 asset kind：

| H2 模式 | 推断结果 |
|---|---|
| `## Channel` 且 (`## Compilation` 或 `## 会话知识`/`## 对话记忆`) | `blueprint` |
| `## 会话知识` 或 `## 对话记忆` | `channel` |
| `## Slots` | `workflow`（v6 残留） |
| `## Tools` | `stack`（v6 残留） |
| `## Boundaries` | `blueprint`（v6 残留） |
| **fallback** | `domain` |

**正常路径**走 frontmatter 优先级（`kind > type > entity > inferKind`），`inferKind` 仅作兜底——这是为了兼容早期没有 frontmatter 的资产文件（v6 → v7 → v8 演进过程中保留的过渡）。

Sources: [shared.ts: inferKind](src/parse/shared.ts#L323-L332), [shared.ts: readAsset 中 kind 推断优先级](src/parse/shared.ts#L62-L75)

## 三个 Adapter 的角色分工

`readAsset()` 输出 `Asset` 后，三个 adapter 各自把 Asset 映射到对应 IR。它们**共享 shared.ts 的所有辅助函数**：

```mermaid
classDiagram class Asset {
        +kind: AssetKind
        +name: string
        +frontmatter: Record~string,unknown~
        +body: string
        +sections: Record~string,Section~
    }
    class parseDomain {
        +parseDomain(cwd, fileName) Domain
        -parseDomainSection(h2Name, items, raw, type)
        -toTerms / toRules / toExternals / toTools / toFlowTemplates
    }
    class parseChannel {
        +parseChannel(cwd, fileName) Channel
        -parseInjectionPointFromSection
 }
    class parseBlueprint {
        +parseBlueprint(cwd, fileName) Blueprint
        -parseInjectionPointFromSection
        -extractTriggerFromSection
        -extractBoundariesFromSection        -parseCompilationFromSection
    }
    class shared {
        +readAsset(path) Asset
        +splitSections / parseItems / parseFrontmatter
        +s / sArr / extractFieldValue / extractBareListUnderH3
    }
    Asset <.. parseDomain : 输入
    Asset <.. parseChannel : 输入
    Asset <.. parseBlueprint : 输入
    shared <.. parseDomain : 复用
    shared <.. parseChannel : 复用
    shared <.. parseBlueprint : 复用
```

| Adapter | 输入 | 输出 IR | 关键映射 |
|---|---|---|---|
| **parseDomain** | `domains/<file>.md` | `Domain { name, type, modules: Record<H2名, 内容> }` | 按 `frontmatter.type` 分发 `parseDomainSection`；H2 段名开放（`Scene`/`Manual`/`Term`/扩展） |
| **parseChannel** | `channels/<file>.channel.md` | `Channel { name, injectionPoints: InjectionPointConfig[] }` | 每个 H2 = 1 个注入点（除 `Modules`/`Layout` v7 残留段）；H2 名 →注入点名 |
| **parseBlueprint** | `blueprints/<file>.blueprint.md` | `Blueprint { name, channel, injectionPoints, compilation }` | H2 = 注入点实例化；`## Channel` 读引用；`## Compilation` 读编译配置 |

**Domain adapter 的 H2 段名是开放的**——`parseDomainSection()` 对 `Scene` / `Manual` 各按 type 分发，对其他 H2 名（如 `Term` / `Glossary`）走 fallback term 形态。这是 v8 的核心扩展点：**加新 H2 模块类型 = 在 Channel声明该模块即可，Pt 核心不感知**。

Sources: [domain.ts: parseDomain](src/parse/domain.ts#L24-L40), [channel.ts: parseChannel](src/parse/channel.ts#L33-L50), [blueprint.ts: parseBlueprint](src/parse/blueprint.ts#L56-L88), [index.ts: oxnAdapter](src/parse/index.ts#L15-L57)

## 真实资产片段对照

以下为 `.pt/assets/blueprints/pt.blueprint.md` 的解析对照示例：

```markdown
## 会话知识
### Domains
- pt-concepts
- pt-architecture
### Trigger
当用户询问 Pt 自身相关知识...
### Boundaries
### identify-topic
- deps: []
- desc: 识别用户问题...
```

经过 `parseItems` 模式 A（段内有 H3）后：

```typescript
[
  { name: "Domains", fields: {} }, // 单独 H3 +裸名行（不会被 fields 捕获）
  { name: "Trigger", fields: { desc: "当用户询问 Pt 自身相关知识..." } },
  { name: "Boundaries", fields: {} },
  { name: "identify-topic", fields: { deps: [], desc: "识别用户问题..." } },
]
```

Blueprint adapter 用 `extractBoundariesFromSection()` 扫 `items` 找 `name === "Boundaries"`，然后取**紧随其后的** `deps` 字段非空的 H3 子项作为 BoundaryNode——这是 `parseItems` 模式 A 与 Blueprint解析约定的耦合点。

Sources: [pt.blueprint.md](.pt/assets/blueprints/pt.blueprint.md#L17-L33), [blueprint.ts: extractBoundariesFromSection](src/parse/blueprint.ts#L138-L166)

## Source Adapter 注册表集成

`src/parse/index.ts` 中的 `oxnAdapter` 是一个 `SourceAdapter` 实现（接口定义见 [Schema 与 IR 契约（src/schema.ts）](12-schema-yu-ir-qi-yue-src-schema-ts)）：

```typescript
export const oxnAdapter: SourceAdapter = {
  name: "oxn",
  async load(cwd, blueprintName): Promise<SchemaBundle> {
    const domains = await loadAllDomains(cwd); // 1. domains/*.md
    const channels = await loadAllChannels(cwd);     // 2. channels/*.md
    const blueprints = await loadAllBlueprints(cwd); // 3. blueprints/*.md
    const active = findBlueprint(blueprints, blueprintName); // 4. 找激活 Blueprint
    // ...校验 + 组装 SchemaBundle
  },
};
```

**关键设计原则**：

| 设计点 | 实现 | 意图 |
|---|---|---|
| **目录位置 → asset kind** | `domains/` → parseDomain / `channels/` → parseChannel / `blueprints/` → parseBlueprint | adapter 自描述，加新来源 = 加新 SourceAdapter |
| **目录不存在** | `loadDir` 的 `try/catch` 返回 `[]` | `channels/` 在早期可能尚未建立 |
| **单文件解析失败** | `console.error` + 返回 `null`，被 filter 过滤 | 单文件错不阻断整体加载 |
| **激活 Blueprint 缺省** | fallback 取 `blueprints[0]` | 给未指定 blueprintName 时兜底 |

> 关于 adapter 注册表与依赖反转的更多背景，参看 [Source Adapter 注册表与依赖反转设计](11-source-adapter-zhu-ce-biao-yu-yi-lai-fan-zhuan-she-ji)。

Sources: [index.ts: oxnAdapter](src/parse/index.ts#L15-L57), [index.ts: loadDir](src/parse/index.ts#L76-L94)

## 边界与失败模式

| 边界情形 | shared 层行为 | adapter 层应对 |
|---|---|---|
| 文件无 frontmatter | `parseFrontmatter` 返回 `{ fm: {}, body: text }` | `parseChannel` 用文件名 fallback name |
| 文件无 H2 段 | `splitSections` 返回 `[]`，`sections = {}` | adapter 拿到 `{}` → 通常产空 injectionPoints / modules |
| H2 段无 H3 子项 | `parseItems` 走模式 B（顶层 list） | Channel `target: system_prompt` 走裸值匹配 |
| `- key: value` 中 value 含特殊字符 | `parseScalar` 不识别 → 当字符串 | 引号包裹可保留整体（`- desc: "Pt: 扩展"`） |
| 嵌套对象内层 value 不是 string | `parseScalar` 对顶层 `{}` 调用，**内层字段值仍是字符串**（不再递归处理 value） | 消费者用 `parseScalar` 二次处理 |
| frontmatter 无 kind / type / entity | `inferKind()` 按 H2 特征推断 | 仅 v6 残留资产会触发，新资产应在 frontmatter 显式声明 |

## 下一步阅读

-理解 parse 后产生的 IR： [Schema 与 IR 契约（src/schema.ts）](12-schema-yu-ir-qi-yue-src-schema-ts)
- 看中端如何消费这些 IR： [中端编译：按注入点聚合与 mode 渲染](14-zhong-duan-bian-yi-an-zhu-ru-dian-ju-he-yu-mode-xuan-ran)
- 理解整体三段式流水线： [三段式编译架构（parse→compile→render）](8-san-duan-shi-bian-yi-jia-gou-parse-compile-render)
- 加新资产类型怎么写： [编写 Domain / Channel / Blueprint 三类资产](4-bian-xie-domain-channel-blueprint-san-lei-zi-chan)
- 加新来源（不限于 OXN MD）： [接入新的 Source Adapter（多来源转译）](19-jie-ru-xin-de-source-adapter-duo-lai-yuan-zhuan-yi)