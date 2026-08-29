# Pt 转译产物优化方案

> **状态**：本文档描述的 4 类优化（注释剥离、术语格式、跨 asset 拼接、全局约束语义修正）已由 [docs/pt-asset-layering.md](./pt-asset-layering.md) 的架构升级（Phase 0-4）覆盖。**本文档保留作为历史参考**，新设计、代码与本文档不一致时以 layering 文档为准。
>
> 覆盖映射：
> - 注释剥离（问题 3）→ `transpile.ts` 的 `<!-- =====...===== -->` 正则
> - 术语/术语格式（问题 4）→ `backend/prompt.ts` 的 `compileModule`（与本文档 §二 的判断一致）
> - 跨 asset 拼接 Externals/Bans/Invariants（问题 7）→ Phase 2 中端 layout + Phase 3 step-specific rules 挂载
> - "挂末步" 语义修正（问题 7 延伸）→ Phase 2 hybrid 模式 `### 全局约束` 段取代末步 checklist

---

# 历史版本（原内容）

> 基于 `.pt/fulls/prompt-1787911855984.md`（实际注入产物）与 `oxn/compiler.ts`（转译逻辑）的对照分析。
> 目标：提升转译产物对 session 的信噪比，消除冗余与错误约束，补齐功能性缺口。

---

## 一、现状诊断：对 Session 是否有帮助？

**结论：方向上有帮助，但当前这版产物的信噪比偏低，帮助被冗余和缺漏稀释了。**

### 1.1 有用的部分（补上了 Pi base prompt 没有的东西）

| 段 | 作用 | 评价 |
|---|---|---|
| Domain 业务术语 | 把"文章"定义成"成稿"而非草稿片段、把"选题"前置 | LLM 默认不会自行推断，有价值 |
| Domain 不变量/禁忌 | `≥800 字`、`禁标题党词` | 可被 LLM 自检的硬约束，是质量抓手 |
| Workflow slot DAG | 给 agent 一条显式计划线 | 比让它自己规划要稳 |

### 1.2 当前产物的 8 个问题

逐条对应实际注入内容：

#### 问题 1 — Workflow 与 Blueprint 是同一张 DAG 的两份表述

- Workflow 段：
  ```
  1. select-topic（确定选题和目标读者）
  2. outline ... — 依赖 select-topic
  ```
- Blueprint 段：
  ```
  第 1 步 · select-topic - 依赖：无 - 操作：read - 目标：...
  ```

slot 名、desc、deps 三者完全重复，Blueprint 只多了 `operate`。等于同一信息说两遍，白耗 ~150 token。

#### 问题 2 — `operate` 字段与 Pi 工具层冲突

- Stack 已写 `可用工具：read / write`，Blueprint 又每步重复 `操作：read` / `操作：write`。
- 更糟：Pi base prompt 已把 `read/bash/edit/write` 都给了 agent。Blueprint 写"操作：read"会被理解成"这一步只能 read"，构成**错误约束**（比如 outline 步真要 `bash` 查热度也合理）。

#### 问题 3 — HTML 注释不该进 LLM 上下文

`<!-- ===== Domain: writing ===== -->` 这类注释是给 `/pt raw` 调试看的，对 LLM 无语义价值，4 段就是 4 行 token。

#### 问题 4 — Externals 完全丢失（功能性缺口）

- `select-topic` 步的 desc 写着"查关键词热度数据"，但 `./data/keyword-stats.xlsx` 这个文件路径在任何地方都没出现。
- 查 `compiler.ts`：`compileDomain` 只输出 Terms/Bans/Invariants，不输出 Externals；`loadExternalsAll` 是"保留接口"未接线。
- 结果：agent 看到"查关键词热度数据"却不知道去哪查。设计文档 §7 本来说"MVP 先在 systemPrompt 里列路径"，但编译器没实现这一步。

#### 问题 5 — Stack 段格式 bug + 冗余

```
- fs-tools：read / write
                          ← 这里有个空行（compileStack 先 push "" 再 push dedup 行）
- 可用工具：read / write
```

`fs-tools: read / write` 和 `可用工具：read / write` 是同一信息的两遍。

#### 问题 6 — 触发条件缺失

Blueprint 每轮注入，但没说"什么时候该走这套流程"。agent 得自己猜"用户让写文章→走 4 步"。像本次会话（分析 Pt 本身），这套写作蓝图完全是 off-topic 噪音——这是 per-session 注入的固有代价，但至少该给 agent 一个"判断是否适用"的锚点。

#### 问题 7 — 约束与检查点分离

`≥800字` / `禁标题党` 放在 Domain 段开头，但真正要用它们的是第 4 步 revise。agent 得跨整段持有它们到末尾才自检，不如就地挂到 revise 步成 checklist。

#### 问题 8 — 标题对 agent 无信息量

"业务知识（来自多来源）"中"多来源"是 Pt 内部架构概念（polyglot adapter），agent 不需要知道。一个能直接告诉它"接下来是任务上下文"的标题更好。

---

## 二、优化原则

| 原则 | 对应解决的问题 |
|---|---|
| DAG 单一来源：只保留 Blueprint 的步骤视图，Workflow 不再重复列 slot | #1 |
| 删 `operate` 字段，工具约束只在 Stack 段出现一次 | #2 |
| 注入版剥离 HTML 注释（保留在 `/pt raw` 的 debug 产物里） | #3 |
| 补 Externals 段，把数据文件路径显式列出 | #4 |
| Stack 去掉 dedup 空行和重复行 | #5 |
| 开头加触发条件，让 agent 自判是否适用 | #6 |
| Invariants/Bans 挂到 revise 步成 checklist | #7 |
| 标题改成任务导向 | #8 |

---

## 三、优化后的产物（同等信息量，~300 token，比现在少 ~40%）

````markdown
## 当前任务上下文：article-blueprint（写作助理）

> 当用户请求"写文章"时按以下流程执行；其余对话正常响应，勿套用本流程。

### 流程（4 步，按序执行）
1. **select-topic** — 确定选题和目标读者。
   数据：读 `./data/keyword-stats.xlsx` 取关键词热度。
2. **outline** — 写大纲，每节一句话概括。← 依赖 ①
3. **draft** — 按大纲写初稿，正文用 markdown。← 依赖 ②
4. **revise** — 修订语言并做终检：← 依赖 ③
   - [ ] 正文 ≥ 800 字
   - [ ] 标题不含"震惊 / 惊呆了 / 必看"
   - [ ] 成稿结构完整（标题 + 正文）

### 术语
- **文章**：有标题、正文、结构完整的成稿；区别于片段或草稿笔记。
- **选题**：一篇文章要回答的核心问题；先定选题再写。

### 工具与数据
- 正文格式：markdown
- 数据文件：`./data/keyword-stats.xlsx`（select-topic 步用）
- 工具：read / write（其余按 Pi 默认工具集）
````

### 对比：优化前 vs 优化后

| 维度 | 优化前 | 优化后 |
|---|---|---|
| token 量 | ~500 | ~300 |
| DAG 重复 | Workflow + Blueprint 两份 | 单一来源 |
| `operate` 错误约束 | 每步"操作：read"限制工具 | 删除 |
| Externals | 丢失 | 显式列出路径 |
| 触发条件 | 无 | 开头一行 anchor |
| 检查点位置 | 约束在开头、检查在末尾，分离 | revise 步就地 checklist |
| HTML 注释 | 4 行进 LLM | 剥离（仅 raw 保留） |
| 标题 | "业务知识（来自多来源）" | "当前任务上下文：{blueprint}" |

---

## 四、代码改动点（落 `oxn/compiler.ts` 与 `index.ts`）

### 4.1 `compileWorkflow` — 二选一去重

**方案 A（推荐）：Workflow 不再输出 slot 列表**，只保留一句指向 Blueprint 的说明，或直接返回空串由 Blueprint 承载 DAG。

```ts
export function compileWorkflow(w: Asset): string {
  // 方案 A：Workflow 不再重复输出 slot DAG（由 Blueprint 统一承载）
  // 保留 frontmatter name 仅供 Externals 收集，不进 systemPrompt
  return "";
}
```

**方案 B：保留 Workflow、删 Blueprint 步骤重复**。二选一，不要两份。
若选 B，则 `compileBlueprint` 只输出触发条件 + checklist，不列步骤。

> 推荐 A：因为 Blueprint 段天然带 `operate`（虽要删）和更结构化的步骤视图，且 Blueprint 是"当前任务"的入口，承载 DAG 语义更顺。

### 4.2 `compileBlueprint` — 删 operate、补触发条件与 checklist

改动要点：
1. 删 `操作：{operate}` 行。
2. `desc` 直接挂到步骤名后，用 `← 依赖 ①` 紧凑引用替代单独成行。
3. 在段开头补触发条件行（从 frontmatter `trigger` 字段读，缺省则硬编码"当用户请求相关任务时"）。
4. 把 Domain 的 Invariants/Bans 挂到最后一步（revise）成 checklist。

> 注：第 4 点需要 `compileBlueprint` 能访问 Domain asset 的 Bans/Invariants。当前 `compileAsset` 是 per-asset 独立编译，**这是结构性约束**——要么把 checklist 下沉到 Blueprint 编译（需改 `compileAsset` 签名传入依赖 asset），要么在 `loadAndTranspile` 层做后处理拼接。
>
> **MVP 取舍**：checklist 下沉属于抛光，可分阶段。第一阶段不动 `compileAsset` 签名，先在 Blueprint 段末尾输出"终检清单（来自 Domain 不变量/禁忌）"占位，第二阶段再实现跨 asset 拼接。

```ts
export function compileBlueprint(b: Asset): string {
  const use = b.sections["Use"];
  const boundaries: Boundary[] = [];
  for (const item of b.sections["Boundaries"]?.items ?? []) {
    boundaries.push({
      slot: item.name,
      operate: sArr(item.fields.operate), // 保留解析，但输出时不用
      deps: sArr(item.fields.deps),
      desc: s(it.fields.desc) || s(it.fields.description),
    });
  }

  const lines: string[] = [];

  // 触发条件（frontmatter.trigger 或默认）
  const trigger = typeof b.frontmatter.trigger === "string" ? b.frontmatter.trigger : null;
  lines.push(`> ${trigger ?? "当用户请求相关任务时按以下流程执行；其余对话正常响应，勿套用本流程。"}`);
  lines.push("");

  lines.push("### 流程");
  if (boundaries.length === 0) {
    lines.push("（无 Boundaries 定义）");
    return lines.join("\n");
  }

  // 步骤序号用 ① ② ③ 圈码，依赖引用更紧凑
  const circled = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧"];
  const idxMap = new Map<string, number>();
  boundaries.forEach((bd, i) => idxMap.set(bd.slot, i));

  boundaries.forEach((bd, i) => {
    const depSuffix = bd.deps.length > 0
      ? ` ← 依赖 ${bd.deps.map((d) => circled[idxMap.get(d) ?? 0] ?? d).join(" ")}`
      : "";
    lines.push(`${i + 1}. **${bd.slot}** — ${bd.desc || "（未指定）"}${depSuffix}`);
  });

  return lines.join("\n").trimEnd();
}
```

### 4.3 `compileDomain` — 补 Externals 输出

```ts
export function compileDomain(d: Asset): string {
  const terms = d.sections["Terms"]?.items ?? [];
  const bans = d.sections["Bans"]?.items ?? [];
  const invariants = d.sections["Invariants"]?.items ?? [];
  const exts = d.sections["Externals"]?.items ?? []; // ← 新增

  const lines: string[] = [];

  if (terms.length > 0) {
    lines.push("### 术语");
    for (const it of terms) {
      const desc = s(it.fields.desc) || s(it.fields.description);
      lines.push(desc ? `- **${it.name}**：${desc}` : `- **${it.name}**`);
    }
    lines.push("");
  }

  if (bans.length > 0) {
    lines.push("### 禁忌");
    for (const it of bans) {
      const items = sArr(it.fields.items);
      const desc = s(it.fields.desc) || s(it.fields.description);
      const head = desc ? `- ${desc}：` : `- ${it.name}：`;
      lines.push(`${head}禁止 ${items.join(" / ")}`);
    }
    lines.push("");
  }

  if (invariants.length > 0) {
    lines.push("### 不变量");
    for (const it of invariants) {
      const desc = s(it.fields.desc) || s(it.fields.value) || s(it.fields.description);
      lines.push(`- ${desc || it.name}`);
    }
    lines.push("");
  }

  // ← 新增：Externals 显式列出路径
  if (exts.length > 0) {
    lines.push("### 外部数据");
    for (const it of exts) {
      const p = s(it.fields.path);
      if (p) lines.push(`- ${it.name || "data"}：\`${p}\``);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}
```

> 也可以新开一个 `compileExternals` 合并 domain/workflow/stack 三处 Externals，单独成段。建议合并：路径集中更好找。

### 4.4 `compileStack` — 去空行 bug + 删 dedup 重复行

改动要点：
1. 删 `lines.push("")` 后再 push dedup 行的逻辑（空行 bug）。
2. 二选一：要么只留 per-tool 行（带 role 更有信息），删 `可用工具` 汇总；要么只留汇总，删 per-tool。**建议保留 per-tool，删汇总**（信息更全）。

```ts
export function compileStack(st: Asset): string {
  const tools = st.sections["Tools"]?.items ?? [];
  if (tools.length === 0) return "";

  const lines: string[] = ["### 工具"];
  for (const it of tools) {
    const role = s(it.fields.role);
    const ops = sArr(it.fields.operations);
    if (role) lines.push(`- ${it.name}：${role}`);
    else if (ops.length > 0) lines.push(`- ${it.name}：${ops.join(" / ")}`);
    else lines.push(`- ${it.name}`);
  }
  // 删除原来的 dedup 汇总行 + 空行 bug
  return lines.join("\n").trimEnd();
}
```

### 4.5 剥离 HTML 注释 — `loadAndTranspile` 层统一处理

注入版剥注释，`/pt raw` 保留注释。在 `transpile.ts` 的 `loadAndTranspile` 返回前加一步：

```ts
export async function loadAndTranspile(cwd: string, blueprintName: string): Promise<string> {
  const segs = await Promise.all(
    sourceAdapters.map((a) =>
      a.load(cwd, blueprintName).catch((e) => {
        console.error(`[pt] adapter ${a.name} failed:`, e);
        return "";
      }),
    ),
  );
  const raw = segs.filter(Boolean).join("\n\n");
  // 注入版剥 HTML 注释（仅给 LLM）；注释保留在 /pt raw 的 debug 产物里
  return raw.replace(/<!-- =====[^\n]*-->\n?/g, "").trim();
}
```

> 注意：`/pt raw` 命令当前写的是 `cachedSegment`（已剥注释）。若要 raw 保留注释，需额外存一份未剥注释的版本，或 `/pt raw` 调用 `loadAndTranspile` 重跑一次。**MVP 取舍**：直接接受 raw 也无注释，注释本就调试用，去掉无妨。

### 4.6 `index.ts` — 改注入标题

```ts
pi.on("before_agent_start", async (event) => {
  if (!cachedSegment) return undefined;
  // 标题从"业务知识（来自多来源）"改为任务导向
  const finalPrompt =
    event.systemPrompt + "\n\n## 当前任务上下文\n\n" + cachedSegment;
  lastBuiltPrompt = finalPrompt;
  return { systemPrompt: finalPrompt };
});
```

---

## 五、落地路线（分阶段）

### 阶段 1 — 最小改动拿最大收益（3 处）

优先级排序：

1. **补 Externals**（问题 4）——功能性 bug，修了 agent 才真能跑 select-topic。改 `compileDomain`。
2. **Workflow / Blueprint 二选一**（问题 1）——最大 token 浪费源。改 `compileWorkflow` 返回空串。
3. **删 operate**（问题 2）——避免错误约束。改 `compileBlueprint`。

这三处改完，token 量从 ~500 降到 ~350，且 agent 不再被错误工具约束误导。

### 阶段 2 — 抛光（4 处）

4. 剥 HTML 注释（问题 3）——改 `loadAndTranspile`。
5. Stack 去空行 + dedup（问题 5）——改 `compileStack`。
6. 改注入标题（问题 8）——改 `index.ts`。
7. 补触发条件（问题 6）——改 `compileBlueprint`，加 frontmatter `trigger` 字段支持。

### 阶段 3 — 结构性优化（1 处，可选）

8. checklist 下沉到 revise 步（问题 7）——需改 `compileAsset` 签名或 `loadAndTranspile` 后处理，让 Blueprint 能访问 Domain 的 Bans/Invariants。

---

## 六、验证方式

改完后按以下步骤验证：

1. **重跑转译**：在 pt 项目根目录发任意消息触发 `before_agent_start`，然后 `/pt full`。
2. **对比产物**：
   ```bash
   ls -lt .pt/fulls/ | head -3
   ```
   读最新生成的 prompt 文件，确认：
   - 无 HTML 注释行
   - 无 `操作：read/write` 行
   - Workflow 段不再重复 slot 列表
   - 出现 `### 外部数据` 段含 `./data/keyword-stats.xlsx`
   - 标题为 `## 当前任务上下文`
3. **token 估算**：产物字符数应从 ~1500 降到 ~900（中文 token 约 1.5 字/token，对应 ~600 → ~300 token）。
4. **行为验证**：开新会话，让 agent 跑写作流程，确认 select-topic 步能引用到数据文件路径、revise 步能自检 ≥800 字与禁词。

---

## 七、阶段 1+2 核验

§六是高层冒烟（重跑 → 看产物 → 数 token）。本节做**逐条改动**的可执行核验——每条改动对应一项机械检查，全部通过才算阶段 1+2 落地。

### 7.1 核验脚本

在 pt 项目根目录跑一次，7 条全过即为通过：

```bash
cd /Users/issac/pro/pt
npx tsx -e '
import { readFile } from "node:fs/promises";
import { loadAndTranspile } from "./transpile.ts";
import { readAsset } from "./oxn/parser.ts";
import { compileAsset, compileBlueprint } from "./oxn/compiler.ts";

const cwd = "/Users/issac/pro/pt";
const seg = await loadAndTranspile(cwd, "article-blueprint");
const dom = compileAsset(await readAsset(`${cwd}/.openxenon/assets/domains/writing.md`));
const wf  = compileAsset(await readAsset(`${cwd}/.openxenon/assets/workflows/article-flow.md`));
const stk = compileAsset(await readAsset(`${cwd}/.openxenon/assets/stacks/md-stack.md`));
const domAsset = await readAsset(`${cwd}/.openxenon/assets/domains/writing.md`);
const bpAsset  = await readAsset(`${cwd}/.openxenon/assets/blueprints/article-blueprint.md`);
const bp  = compileBlueprint(bpAsset, { domain: domAsset });
const indexSrc = await readFile("index.ts", "utf8");
const transpileSrc = await readFile("transpile.ts", "utf8");

const checks: Array<[string, boolean]> = [
  // ---- 阶段 1：必修项 ----
  ["1.1 [Domain] 输出含 ### 外部数据 段 + keyword-stats.xlsx 路径",
    dom.includes("### 外部数据") && dom.includes("./data/keyword-stats.xlsx")],
  ["1.2 [Workflow] 输出为空串（不再重复 slot DAG）",
    wf.trim() === ""],
  ["1.3 [Blueprint] 输出无「操作：」行",
    !bp.includes("操作：")],
  // ---- 阶段 2：抛光项 ----
  ["2.1 [transpile] 注入版剥离 HTML 注释（产物无 <!--）",
    !seg.includes("<!--")],
  ["2.2 [Stack] 输出无三连换行 bug + 无「可用工具：」重复行",
    !stk.includes("\n\n\n") && !stk.includes("可用工具")],
  ["2.3 [index.ts] 注入标题改为「## 当前任务上下文」且无旧标题残留",
    indexSrc.includes("## 当前任务上下文") && !indexSrc.includes("## 业务知识")],
  ["2.4 [Blueprint] 开头是触发条件 anchor（> ...）",
    bp.trimStart().startsWith(">")],
  // ---- 阶段 3：跨 asset 拼接 + 顺序 ----
  ["3.1 [transpile] 拼接顺序 blueprint 在前（流程段先于术语段）",
    seg.indexOf("### 流程") < seg.indexOf("### 术语")],
  ["3.2 [transpile] 注释剥离规则收紧为 <!-- ===== xxx -->\n?",
    transpileSrc.includes("<!-- =====[^\n]*-->\n?") && !transpileSrc.includes("<!--[\\\\s\\\\S]*?-->")],
  ["3.3 [Blueprint] 步骤号与依赖引用统一为圈码（1./2. 与 ①/② 不应混用）",
    /^[①②③④⑤]\s+\*\*/m.test(bp) && !/^\d+\.\s+\*\*/m.test(bp)],
  ["3.4 [Blueprint] Externals 就地挂到首步（select-topic 步含 数据：）",
    /^[①]\s+\*\*select-topic\*\*[\s\S]*?\n\s+数据：/.test(bp)],
  ["3.5 [Blueprint] Bans/Invariants 挂到末步成 checklist（revise 步含 - [ ]）",
    /[\s\S]*④\s+\*\*revise\*\*[\s\S]*\n\s+-\s+\[\s\]/.test(bp)],
];

let pass = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? "✓" : "✗"} ${name}`);
  if (ok) pass++;
}
console.log(`\n${pass}/${checks.length} 通过`);
process.exit(pass === checks.length ? 0 : 1);
'
```

### 7.2 核验点对照表

| # | 改动文件 | 对应问题 | 通过条件 | 失败时怎么查 |
|---|---|---|---|---|
| 1.1 | `oxn/compiler.ts` (`compileDomain`) | #4 Externals 丢失 | Domain 段含 `### 外部数据` + `./data/keyword-stats.xlsx` | 看 writing.md 是否加了 `## Externals` 段 |
| 1.2 | `oxn/compiler.ts` (`compileWorkflow`) | #1 DAG 重复 | `compileWorkflow(w).trim() === ""` | 看是否还返回 slot 列表 |
| 1.3 | `oxn/compiler.ts` (`compileBlueprint`) | #2 operate 错误约束 | Blueprint 输出不含 `操作：` 子串 | 看是否还有 `- 操作：` 行 |
| 2.1 | `transpile.ts` (`loadAndTranspile`) | #3 注释污染 LLM | 注入版 `seg` 不含 `<!--` | 看正则 `<!--[\s\S]*?-->\n?` 是否还在 |
| 2.2 | `oxn/compiler.ts` (`compileStack`) | #5 空行 bug + dedup 重复 | Stack 输出无三连换行、无 `可用工具` 行 | 看是否还有 `lines.push("")` + dedup push |
| 2.3 | `index.ts` (`before_agent_start`) | #8 标题无信息量 | 源码含 `"## 当前任务上下文"`、不含 `## 业务知识` | grep 两个串对照 |
| 2.4 | `oxn/compiler.ts` (`compileBlueprint`) | #6 触发条件缺失 | Blueprint 字符串 trim 后首字符是 `>` | 看 frontmatter `trigger` 字段是否读到 |
| 3.1 | `transpile.ts` (`oxnAdapter.load`) | §八 新问题 A | 流程段先于术语段出现在 `seg` 里 | 看拼接数组是否含 blueprint |
| 3.2 | `transpile.ts` (`loadAndTranspile`) | §八 新问题 B | 正则含 `<!-- =====`、不含旧的 `<!--[\s\S]*?-->` | grep transpile.ts |
| 3.3 | `oxn/compiler.ts` (`compileBlueprint`) | §八 新问题 C | bp 用圈码 ① ②，不用阿拉伯 1. 2. | 看 `lines.push` 里的步骤号格式 |
| 3.4 | `oxn/compiler.ts` (`compileBlueprint` + `transpile.ts` ctx) | §八 问题 7 | select-topic 步下含 `数据：` 行 | 看是否传 ctx、是否对首步追加 |
| 3.5 | `oxn/compiler.ts` (`compileBlueprint` + `transpile.ts` ctx) | §八 问题 7 | revise 步下含 `- [ ]` checklist | 看是否对末步追加 Invariants/Bans |

### 7.3 通过标准

- **7/7 全过**：阶段 1+2 落地完成，可发版或继续阶段 3。
- **任一不过**：回到对应文件的对应行修复，改完重跑脚本直到全过。

### 7.4 为什么不做端到端

阶段 1+2 全是**编译期改动**，可在 Node 里直接调函数验证（无需启 pi session）。端到端（启 session → 发消息 → 读 `.pt/fulls/`）属于行为测试，留给 §六 第 4 步在真实会话里跑——那一步验的是 agent 真拿到正确 prompt 后的反应，超出本节静态核验范围。

---

## 八、阶段 3 待办与推进（基于重跑产物的发现）

> 本节来自对照最新一份重跑产物（`.pt/fulls/prompt-<ts>.md`，最近一份为 `prompt-1787913077028.md`）的逐条核验与新发现。

阶段 1+2 改完后重跑 `/pt full`，对照新产物逐条核验 8 个问题的解决情况。

### 7.1 解决情况逐条核验

| # | 问题 | 状态 | 证据 |
|---|---|---|---|
| 1 | Workflow/Blueprint DAG 重复 | ✅ 已解决 | `compileWorkflow` 返回空串，产物只有一份"### 流程" |
| 2 | `operate` 错误约束 | ✅ 已解决 | 步骤行无"操作：read/write"，`compileBlueprint` 不再输出 operate |
| 3 | HTML 注释进 LLM | ✅ 已解决 | `transpile.ts:77` `replace(/<!--[\s\S]*?-->\n?/g, "")` |
| 4 | Externals 丢失 | ✅ 已解决 | `compileDomain` 末尾输出 `### 外部数据 - keyword-stats: ./data/keyword-stats.xlsx` |
| 5 | Stack 空行 + dedup 重复 | ✅ 已解决 | 无空行、无"可用工具"汇总行 |
| 6 | 触发条件缺失 | ✅ 已解决 | `compileBlueprint` 开头输出 `> 当用户请求"写文章"时...` |
| 7 | 约束与检查点分离 | ❌ 未做（阶段 3，标了 TODO） | 代码里有 TODO 注释，但产物里看不到（见新问题 B） |
| 8 | 标题改成任务导向 | ✅ 已解决 | `## 当前任务上下文` |

**结论**：阶段 1+2 的 7 个问题全部解决，token 量从 ~1500 字降到 ~700 字，信噪比明显提升。

### 7.2 新发现的 3 个问题

#### 新问题 A — 结构顺序反了（最值得修）

`transpile.ts:37` 固定按 `[domain, workflow, stack, blueprint]` 拼接，导致产物顺序是：

```
## 当前任务上下文
### 术语 ...          ← 支撑信息排最前
### 禁忌 ...
### 不变量 ...
### 外部数据 ...
### 工具 ...
> 当用户请求"写文章"时...   ← 触发条件（判断锚点）排倒数第二
### 流程 ...           ← 核心执行内容排最后
```

问题：
1. **触发条件是 agent 判断"是否套用本流程"的锚点，却排在末尾**。agent 读完整段才知道适用条件，前面已经消耗注意力在术语上。
2. **流程是核心，却排最后**。第三节优化示例的顺序是「触发条件 → 流程 → 术语 → 工具与数据」，现在基本反过来了。

**修法**：`transpile.ts:37` 把拼接顺序改成 `[blueprint, domain, stack]`（blueprint 在前），或做后处理重排。

#### 新问题 B — TODO 注释被剥离规则误杀（逻辑 bug）

`compileBlueprint` 末尾留了阶段 3 占位：
```ts
lines.push("<!-- TODO(phase-3): 终检清单（来自 Domain 不变量/禁忌）待跨 asset 拼接 -->");
```

但 `loadAndTranspile` 的 `replace(/<!--[\s\S]*?-->\n?/g, "")` 把**所有** HTML 注释都剥了——包括这个 TODO。结果产物里完全看不到"这里该有 checklist"的提示，开发者对着产物会以为已经完工。

这是注释剥离规则（问题 3 的修复）和 TODO 占位的冲突。两个解法：
- **解法 1（推荐）**：剥离规则收紧，只剥 asset 分隔注释——`replace(/<!-- =====[^\n]*-->\n?/g, "")`（本文档第四节原本就是这么写的，实现时放宽成了 `<!--[\s\S]*?-->`，过度了）。
- **解法 2**：TODO 改用普通文本，如 `> _TODO(phase-3): 终检清单待拼接_`。

#### 新问题 C — 步骤号与依赖引用格式不一致（小瑕疵）

```
1. **select-topic** — ...
2. **outline** — ... ← 依赖 ①
3. **draft** — ... ← 依赖 ②
```

步骤号用阿拉伯 `1. 2. 3.`，依赖引用用圈码 `①②③`，agent 得自己映射"① = 第 1 步"。两种统一即可：要么步骤号也用圈码（`① **select-topic**`），要么依赖引用用阿拉伯（`← 依赖第 1 步`）。建议前者，更紧凑。

### 7.3 原计划的小遗漏（问题 7 的延伸）

`select-topic` 步 desc 写"查关键词热度数据"，但 `./data/keyword-stats.xlsx` 路径在外部数据段单独列，agent 需跨段关联。第三节优化示例是就地引用：
```
1. **select-topic** — 确定选题和目标读者。
   数据：读 `./data/keyword-stats.xlsx` 取关键词热度。
```

这和问题 7（checklist 下沉）同属"跨 asset 拼接"——`compileBlueprint` 需要访问 Domain 的 Externals/Bans/Invariants。建议阶段 3 一起做：改 `compileAsset` 签名或在 `loadAndTranspile` 层后处理，把 Externals 就地挂到对应步骤、把 Bans/Invariants 挂到 revise 步成 checklist。

### 7.4 阶段 3 待办汇总

基于核验，阶段 3 需做 3 件事（按优先级）：

1. **修新问题 A**：`transpile.ts` 拼接顺序改为 `[blueprint, domain, stack]`。
2. **修新问题 B**：注释剥离规则收紧为 `<!-- =====...===== -->`。
3. **做问题 7 + 延伸**：跨 asset 拼接——
   - Externals 就地挂到对应步骤（如 select-topic 步内列数据路径）
   - Bans/Invariants 挂到 revise 步成 checklist
   - 统一步骤号与依赖引用格式（新问题 C）

---

## 附：当前产物全文（供对照）

来源：`.pt/fulls/prompt-1787911855984.md` 末尾 `## 业务知识（来自多来源）` 段。

```markdown
## 业务知识（来自多来源）

<!-- ===== Domain: writing ===== -->
### 业务术语
- **文章**：有标题、正文、结构完整的成稿；区别于片段或草稿笔记。
- **选题**：一篇文章要回答的核心问题；选题决定文章价值，先定选题再写。

### 业务禁忌
- 标题党词汇：禁止 震惊 / 惊呆了 / 必看

### 业务不变量
- 成稿正文字数不少于 800 字。

<!-- ===== Workflow: article-flow ===== -->
### 执行流程
按以下 slot 顺序执行：
1. select-topic（确定选题和目标读者）
2. outline（写大纲，每节一句话） — 依赖 select-topic
3. draft（按大纲写初稿） — 依赖 outline
4. revise（修订语言、检查字数和禁忌） — 依赖 draft

<!-- ===== Stack: md-stack ===== -->
### 技术约束
- markdown：正文用 markdown 格式
- fs-tools：read / write

- 可用工具：read / write

<!-- ===== Blueprint: article-blueprint ===== -->
> 引用 assets：domain / workflow / stack（详见前述段）

### 当前任务蓝图
你要执行的是"article-blueprint"任务，按以下计划走：

**第 1 步 · select-topic**
- 依赖：无
- 操作：read
- 目标：查关键词热度数据，确定选题和目标读者。

**第 2 步 · outline**
- 依赖：select-topic
- 操作：read
- 目标：写大纲，每节一句话概括。

**第 3 步 · draft**
- 依赖：outline
- 操作：write
- 目标：按大纲写初稿，markdown 格式。

**第 4 步 · revise**
- 依赖：draft
- 操作：read, write
- 目标：检查字数≥800、无标题党词，修订成稿。
```
