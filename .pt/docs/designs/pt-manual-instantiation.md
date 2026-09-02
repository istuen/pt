# /pt manual — 参考手册实例化机制

> **状态**：设计完成，待执行
> **执行者**：LLM coding agent（具备 read/bash/edit/write 工具）
> **前提**：已读 Pt 项目代码基线（src/index.ts, src/render/context-message.ts, src/builtin/assets/）
> **验收**：`npm run typecheck` + `npm run verify`（38→42 tests）全过

---

## 1. 背景与动机

### 1.1 当前手册机制

Pt 的"参考手册"是 workflow-type Domain 的 Manual 段里的 FlowTemplate。当前有两种触发方式：

| 触发 | 位置 | 性质 |
|---|---|---|
| `/manual:<domain>` | context-message.ts renderDomainManual | ephemeral——注入 Context Message，读完即逝 |
| `/<flow-name> <args>` | context-message.ts bindFlowTemplate | ephemeral——展开步骤注入 Context Message |

**共同问题**：手册内容是"一次性注入"，没有持久化产物。LLM 执行完步骤后，无法回溯"执行了哪个手册、产出了什么、完成度如何"。

### 1.2 用户需求

> "根据 pt 场景推荐选择一个参考手册后，就创建一份这手册的文档，然后手册里有产物能作为登记。"
> "统一新增一个指令，输入参考手册名称后就创建文档。这样不管多少手册都是统一的创建，而且这样就能让参考手册实例化。能让上下文作为手册概述，也有了产物计划能跟踪验证。"

### 1.3 三层模型

| 层 | 角色 | 生命周期 | 现状 |
|---|---|---|---|
| Segment (Scene/Trigger) | 手册概述——有什么可用 | 常驻 System Prompt | ✅ 已有 |
| `/manual:xxx` | 手册内容——快速参考 | ephemeral 注入 | ✅ 已有 |
| **实例文档** | 手册实例——计划 + 产物登记 | 持久化文件 | ❌ 本设计新增 |

---

## 2. 设计

### 2.1 核心命令

```
/pt manual <procedure-name> [args...]
```

- `/pt manual` 是 `/pt` 的子命令（跟 status/flows/raw/full/logs 一族）
- `procedure-name` = FlowTemplate.name（如 `create-domain-procedure`）
- `args...` = 绑定变量（如 `term my-concept`）

### 2.2 执行流程

```
用户/LLM 输入：/pt manual create-domain-procedure term my-concept
  ↓
Pt 查找 FlowTemplate（复用 findFlowInBlueprint）
  ↓
bindFlowTemplate 展开步骤（绑定 {{type}}=term, {{name}}=my-concept）
  ↓
包装成实例文档（frontmatter + checklist + 产物区 + 更新指引）
  ↓
write 到 .pt/manuals/<procedure-name>-<timestamp>.md
  ↓
notify 用户路径
  ↓
LLM 读文档 → 按计划执行 → 用 edit 更新文档（mark [x] + log 产物）
```

### 2.3 实例文档格式

```markdown
---
procedure: create-domain-procedure
domain: authoring
created: 2025-01-15T14:30:00.000Z
status: in-progress
args: term my-concept
---

# create-domain-procedure 实例

## 计划
- [ ] 确定类型：term（term=概念 / workflow=流程 / stack=工具栈）
- [ ] 用 write 工具创建 .pt/assets/domains/my-concept.md
- [ ] 写 frontmatter（type: term + name: my-concept）
- [ ] 按 type 对应 pattern 写 H2 段（参考 authoring Scene 的 *-pattern 项）
- [ ] 在目标 Profile 的 domains 列表追加 my-concept
- [ ] 删 .pt/contexts/cache/*.context.md + /pt-context <profile> 验证

## 产物
<!-- 执行后用 edit 在此追加：路径 + 动作(created/modified) + 日期 -->

## 更新指引
执行完每个 step 后：用 edit 把对应 `- [ ]` 改成 `- [x]`。
全部完成后：用 edit 在 ## 产物 下追加创建/修改的文件路径（每行一条）。
status 全部完成后可改为 completed。
```

**设计要点**：
- **checklist 格式**：steps 渲染成 `- [ ]` markdown checkbox，LLM 用 edit 标记完成
- **产物区占位**：HTML 注释提示 + 明确指引，LLM 知道往哪写
- **自文档化**：末尾"更新指引"段告诉 LLM 怎么更新——**不需要改 procedure 定义**
- **status 字段**：`in-progress`（创建时）→ `completed`（LLM 全部标 [x] 后改）
- **timestamp 命名**：每次执行独立文件，可追溯，不覆盖

### 2.4 与现有机制的关系

| 机制 | 保留/新增 | 互补关系 |
|---|---|---|
| `/manual:<domain>` | 保留 | 快速 ephemeral 参考（只读概览） |
| `/<flow-name> <args>` | 保留 | 快速 ephemeral 执行（一步展开注入） |
| `/pt manual <procedure> <args>` | **新增** | 持久化执行（计划 + 产物跟踪） |

三者不冲突：前两个是"即时注入"，第三个是"持久化实例"。用户根据场景选：快速查 → /manual；快速执行 → /<flow-name>；正式执行需跟踪 → /pt manual。

---

## 3. 执行步骤

### Step 0：回退 authoring.md 的 registry 改动

当前 `src/builtin/assets/domains/authoring.md` 有上一轮加的 registry 相关内容（被实例文档机制替代），需回退：

**Scene 段**：
- 删除 `### registry` 项（整个 H3 块）
- `### build-roadmap` 的 desc 去掉"（0）初始化 .pt/registry.md 登记簿..."，恢复为从（1）开始

**Manual 段 4 个 procedure**：
- `create-domain-procedure`：删除"如果 .pt/registry.md 不存在..."首步 + "登记到 .pt/registry.md..."末步
- `create-profile-procedure`：同上
- `create-blueprint-procedure`：同上
- `modify-asset-procedure`：删除"更新 .pt/registry.md 对应行..."中间步

**回退后 build-roadmap 应为**：
```markdown
### build-roadmap
- desc: 从零构建 Pt 资产的顺序：（1）分析项目知识结构（参考 project-analysis 的 analyze-steps）→ 识别概念/流程/工具栈；（2）创建 Domain 资产（每种知识一个 .md）→ create-domain-procedure；（3）选 Blueprint（优先复用内建 dev-knowledge，注入点不同才 create-blueprint-procedure）→（4）创建 Profile 组装 Domain 列表 → create-profile-procedure；（5）/pt-context 验证产物。执行 procedure 时用 /pt manual <procedure-name> <args> 创建实例文档跟踪。
```

（末尾加一句"执行 procedure 时用 /pt manual ..."引导用户用新命令）

### Step 1：加 MANUAL_DIR 常量

**文件**：`src/constants.ts`

在 `FULL_DIR` 后面加：

```typescript
/** /pt manual 输出目录（手册实例文档） */
export const MANUAL_DIR = ".pt/manuals";
```

### Step 2：在 src/index.ts 注册 /pt manual 子命令

**位置**：`src/index.ts` 的 `/pt` 命令 handler 里，在 `if (sub === "full")` 块之后、`ctx.ui.notify("用法: ...")` 之前插入。

**代码**：

```typescript
if (sub === "manual") {
  // /pt manual <procedure-name> [args...]
  // 创建手册实例文档到 .pt/manuals/<procedure>-<timestamp>.md
  const parts = args.trim().split(/\s+/);
  const procedureName = parts[0];
  const procedureArgs = parts.slice(1).join(" ");
  if (!procedureName) {
    ctx.ui.notify("用法: /pt manual <procedure-name> [args...]", "warning");
    return;
  }
  if (!session.cachedBundles || session.cachedBundles.length === 0 || !session.cachedBlueprint) {
    ctx.ui.notify("无激活 Profile，先用 /pt-context <name> 激活", "warning");
    return;
  }
  const tpl = findFlowInBlueprint(
    session.cachedBlueprint,
    session.cachedBundles[0].domains,
    procedureName,
  );
  if (!tpl) {
    ctx.ui.notify(`未找到手册: ${procedureName}（用 /pt flows 查可用手册）`, "warning");
    return;
  }
  // 复用 bindFlowTemplate 展开步骤
  const { bindFlowTemplate } = await import("./render/context-message.js");
  const bound = bindFlowTemplate(tpl, procedureArgs);
  // 查所属 domain（用于 frontmatter）
  const domainName = session.cachedBundles[0].domains.find((d) => {
    if (d.type !== "workflow") return false;
    const manual = d.modules[MOD_MANUAL];
    return Array.isArray(manual) && manual.some((t: unknown) => (t as { name?: string }).name === procedureName);
  })?.name ?? "";
  // 包装成实例文档
  const now = new Date().toISOString();
  const ts = Date.now();
  const lines: string[] = [];
  lines.push("---");
  lines.push(`procedure: ${procedureName}`);
  lines.push(`domain: ${domainName}`);
  lines.push(`created: ${now}`);
  lines.push("status: in-progress");
  lines.push(`args: ${procedureArgs || "(无)"}`);
  lines.push("---");
  lines.push("");
  lines.push(`# ${procedureName} 实例`);
  lines.push("");
  // bound 是 bindFlowTemplate 的输出（含 # name + 前提 + 步骤）
  // 转成 checklist 格式
  const boundLines = bound.split("\n");
  for (const line of boundLines) {
    // 步骤行形如 "1. xxx" → "- [ ] xxx"
    const stepMatch = line.match(/^(\d+)\.\s+(.*)$/);
    if (stepMatch) {
      lines.push(`- [ ] ${stepMatch[2]}`);
    } else {
      lines.push(line);
    }
  }
  lines.push("");
  lines.push("## 产物");
  lines.push("<!-- 执行后用 edit 在此追加：路径 + 动作(created/modified) + 日期 -->");
  lines.push("");
  lines.push("## 更新指引");
  lines.push("执行完每个 step 后：用 edit 把对应 `- [ ]` 改成 `- [x]`。");
  lines.push("全部完成后：用 edit 在 ## 产物 下追加创建/修改的文件路径（每行一条）。");
  lines.push("status 全部完成后可改为 completed。");
  const content = lines.join("\n");
  const dir = join(ctx.cwd, MANUAL_DIR);
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${procedureName}-${ts}.md`);
  await writeFile(file, content, "utf8");
  ctx.ui.notify(`手册实例已创建: ${file}`, "info");
  return;
}
```

**注意**：
- `bindFlowTemplate` 当前是 context-message.ts 的 export，但 index.ts 只 import 了 `findFlowInBlueprint`。需要在顶部 import 里加 `bindFlowTemplate`，或用动态 import（上面代码用了动态 import 避免改 import 行——执行者可选静态 import 更干净）。
- 推荐：改顶部 `import { findFlowInBlueprint } from "./render/context-message.js";` 为 `import { bindFlowTemplate, findFlowInBlueprint } from "./render/context-message.js";`，然后删掉动态 import 那行。
- `MANUAL_DIR` 需加到顶部 constants import：`import { FULL_DIR, MANUAL_DIR, MOD_MANUAL, PROFILES_DIR, RAW_DIR } from "./constants.js";`

**/pt 用法提示更新**：

找到这行（在 /pt handler 末尾）：
```typescript
ctx.ui.notify("用法: /pt [status|flows|raw|full|logs|logs:clear|sessions]", "warning");
```
改为：
```typescript
ctx.ui.notify("用法: /pt [status|flows|raw|full|manual|logs|logs:clear|sessions]", "warning");
```

### Step 3：更新 usage.md domain

**文件**：`src/builtin/assets/domains/usage.md`

在 `### manual-trigger` 项后加一个 Scene 项 + 不需要改 Manual（/pt manual 是 Pi 注册命令，不是 procedure）：

**Scene 段加**（在 `### pt-context-flag` 之后）：

```markdown
### pt-manual-command
- desc: /pt manual <procedure-name> [args...]（创建手册实例文档到 .pt/manuals/，含 checklist + 产物区，用于跟踪执行）。与 /manual:<domain>（ephemeral 参考）互补——前者持久化，后者即时注入。
```

**Trigger 段的 usage-trigger desc 追加**：

当前：
```markdown
- desc: 操作 Pt 时参考；含 /pt 命令族 + --pt-context flag + profile 切换
```
改为：
```markdown
- desc: 操作 Pt 时参考；含 /pt 命令族（含 /pt manual 实例化手册）+ --pt-context flag + profile 切换
```

### Step 4：测试

**文件**：`tests/verify/phase9.test.ts`

在 "17. Builtin 资产" describe 块之后（或之内）加一个新 describe 块 "18. /pt manual 手册实例化"：

```typescript
// ========== 18. /pt manual 手册实例化 ==========
describe("18. /pt manual 手册实例化", () => {
  it("bindFlowTemplate 输出含步骤 + 变量绑定", async () => {
    const { bindFlowTemplate } = await import("../../src/render/context-message.js");
    const r = await loadAndTranspile(cwd, "pt");
    const { findFlowInBlueprint } = await import("../../src/render/context-message.js");
    const tpl = findFlowInBlueprint(r.blueprint, r.bundles[0].domains, "create-domain-procedure");
    expect(tpl).toBeDefined();
    const bound = bindFlowTemplate(tpl!, "term my-concept");
    expect(bound).toContain("create-domain-procedure");
    expect(bound).toContain("my-concept");
    expect(bound).toContain("term");
  });

  it("实例文档格式含 checklist + 产物区 + 更新指引", async () => {
    const { bindFlowTemplate, findFlowInBlueprint } = await import("../../src/render/context-message.js");
    const r = await loadAndTranspile(cwd, "pt");
    const tpl = findFlowInBlueprint(r.blueprint, r.bundles[0].domains, "create-domain-procedure");
    const bound = bindFlowTemplate(tpl!, "term my-concept");
    // 模拟 /pt manual 的文档包装逻辑
    const lines: string[] = ["---", "procedure: create-domain-procedure", "---", ""];
    for (const line of bound.split("\n")) {
      const m = line.match(/^(\d+)\.\s+(.*)$/);
      lines.push(m ? `- [ ] ${m[2]}` : line);
    }
    lines.push("", "## 产物", "<!-- -->", "", "## 更新指引", "用 edit 标记完成。");
    const doc = lines.join("\n");
    expect(doc).toContain("- [ ]");
    expect(doc).toContain("## 产物");
    expect(doc).toContain("## 更新指引");
  });

  it("MANUAL_DIR 常量已定义", async () => {
    const constants = await import("../../src/constants.js");
    expect(constants.MANUAL_DIR).toBe(".pt/manuals");
  });

  it("index.ts 注册了 /pt manual 子命令", async () => {
    const src = await readFile("src/index.ts", "utf8");
    expect(src).toContain('sub === "manual"');
    expect(src).toContain("MANUAL_DIR");
  });
});
```

**注意**：
- 测试用 `await import()` 动态导入避免顶层类型问题
- 第 1、2 个测试直接测 bindFlowTemplate + 文档包装逻辑（纯函数，不依赖 Pi runtime）
- 第 3、4 个测试是结构性断言（确保代码存在）

### Step 5：验证

```bash
cd /Users/issac/pro/pt
npm run typecheck   # 应无错误
npm run verify      # 应 42/42 全过（38 + 4 新）
```

### Step 6：手动验收（可选但推荐）

```bash
# 模拟 /pt manual 执行
cd /Users/issac/pro/pt
node --import tsx -e "
import { loadAndTranspile } from './src/transpile.ts';
import { bindFlowTemplate, findFlowInBlueprint } from './src/render/context-message.ts';
const r = await loadAndTranspile(process.cwd(), 'pt');
const tpl = findFlowInBlueprint(r.blueprint, r.bundles[0].domains, 'create-domain-procedure');
console.log(tpl ? 'FOUND' : 'NOT FOUND');
const bound = bindFlowTemplate(tpl, 'term my-concept');
console.log(bound);
"
```

确认输出含绑定后的步骤（`my-concept` 替换了 `{{name}}`）。

---

## 4. 文件清单

| 文件 | 改动类型 | 内容 |
|---|---|---|
| `src/constants.ts` | 新增常量 | `MANUAL_DIR = ".pt/manuals"` |
| `src/index.ts` | 新增子命令 | `/pt manual` handler + import 调整 + 用法提示 |
| `src/builtin/assets/domains/authoring.md` | 回退 + 微调 | 删 registry 项 + 4 个 procedure 删 registry step + build-roadmap 末尾加 /pt manual 引导 |
| `src/builtin/assets/domains/usage.md` | 新增 Scene 项 | `pt-manual-command` + trigger desc 追加 |
| `tests/verify/phase9.test.ts` | 新增测试块 | "18. /pt manual 手册实例化"（4 tests） |

---

## 5. 设计决策记录

| 决策 | 选择 | 理由 |
|---|---|---|
| 命令形式 | `/pt manual` 子命令 | 跟 /pt status/flows/raw/full 一族，不新增顶级命令 |
| 文档粒度 | per-procedure（每次执行一份） | 执行单元 = 一个 FlowTemplate，独立可追溯 |
| 命名 | `<procedure>-<timestamp>.md` | 每次执行独立，不覆盖 |
| LLM 更新方式 | 文档自指引（末尾更新指引段） | 不污染 procedure 定义，文档自带说明 |
| 步骤格式 | `- [ ]` markdown checkbox | LLM 用 edit 标记 `[x]`，人也可读 |
| 产物区 | HTML 注释占位 + 指引 | 明确告诉 LLM 往哪写、写什么格式 |
| status 字段 | in-progress → completed | 简单状态机，LLM 可改 |
| 复用 bindFlowTemplate | 是 | 已有变量绑定逻辑，不重复造轮子 |
| 复用 findFlowInBlueprint | 是 | 已有跨 Domain 查找逻辑 |
| 回退 registry | 是 | 实例文档替代中央 registry——粒度更细、同步风险更低 |

---

## 6. 风险与边界

### 6.1 不处理的

- **不自动 mark [x]**：LLM 执行步骤后自己用 edit 标记——Pt 不追踪执行进度
- **不自动填产物**：LLM 执行完用 edit 追加——Pt 不监听 write/edit 工具调用
- **不清理旧实例文档**：.pt/manuals/ 会累积，用户自行清理（跟 .pt/raws/ .pt/fulls/ 一致）
- **不验证 procedure-name 是 procedure 还是 flow**：findFlowInBlueprint 统一查 FlowTemplate，procedure 和 flow 都是 FlowTemplate——用户可用 /pt manual 对任何 flow 实例化

### 6.2 已知限制

- **依赖 session.cachedBundles**：必须在 /pt-context 激活 Profile 后才能用——跟 /pt flows 一致
- **文档语言跟随 procedure 定义**：procedure 步骤是中文，实例文档也是中文（不翻译）
- **bindFlowTemplate 的 _vars 兼容**：findFlowInBlueprint 会附加 _vars，bindFlowTemplate 优先读 _vars——已处理

### 6.3 未来扩展（不在本次范围）

- `/pt manuals`（复数）列出所有实例文档
- `/pt manual:clean` 清理已完成/过期文档
- 实例文档的 git 友好性（timestamp → 日期目录？）

---

## 7. 验收清单

执行者完成后自检：

- [ ] `npm run typecheck` 无错误
- [ ] `npm run verify` 42/42 全过
- [ ] `src/constants.ts` 含 `MANUAL_DIR`
- [ ] `src/index.ts` 含 `sub === "manual"` 分支 + import 了 bindFlowTemplate + MANUAL_DIR
- [ ] `src/builtin/assets/domains/authoring.md` 无 `registry` 项 + 4 个 procedure 无 registry step
- [ ] `src/builtin/assets/domains/usage.md` 含 `pt-manual-command` Scene 项
- [ ] `tests/verify/phase9.test.ts` 含 "18. /pt manual" 测试块
- [ ] /pt 用法提示含 `manual`
- [ ] 手动验证 bindFlowTemplate 输出含变量绑定

---

**文档结束。执行者按 Step 0→6 顺序执行，每步完成后可运行 typecheck 渐进验证。**
