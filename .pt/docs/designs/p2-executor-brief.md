# P2 执行者简报：类型安全最后一公里 + 测试补强

> **基线 commit**：`c393f5c`（refactor: P1 extract profile-persist...）— HEAD 起点
> **任务来源**：`pt-code-quality-plan.md` §P2（7 项任务）+ §8.2 配套
> **目标**：清 legacy cast 残余（5→≤2）+ 测试补强（4 模块独立测试文件）
> **约束**：v9 四层语义不动；type guard 收窄（不用 as 断言）；每 commit 必过三件套
> **产出**：5 commit（按 cast 清理 + 测试模块拆分）

---

## ⚠️ 现状校准（HEAD c393f5c）

### Cast 清理盘点（5 处真实问题）

| 任务 | 位置 | cast 形式 | 范围 |
|---|---|---|---|
| **P2.1** | `src/render/context-message.ts:203` | `bt as unknown as { vars?: unknown }` | 双重 cast（cast vars 字段——实际为 dead code，因 BoundableTemplate 无 vars 字段）|
| **P2.2** | `src/commands.ts:139` | `(t: unknown) => (t as { name?: string }).name` | 回调内单 cast，manual.some 遍历 |
| **P2.3** | `src/index.ts:416` | `event as unknown as { reason?: string; messageCount?: number }` | turn_end 事件 |
| **P2.3** | `src/index.ts:423` | `event as unknown as { name?: string; toolName?: string }` | tool_call 事件 |
| **P2.3** | `src/index.ts:427` | `event as unknown as { name?: string; toolName?: string; isError?: boolean }` | tool_result 事件 |

**真实问题 cast 计数**：5 处（type-guards.ts / api-bridge.ts / profile-persist.ts 内的 `as { name?: unknown }` 是合规 type guard 实现，**不算**）

**验收目标**：5 → **≤2**（每处用 type guard 收窄 + 新建 Pi 事件 interface）

### 测试补强盘点（4 模块缺失）

| 任务 | 目标模块 | 现有测试 | 待建 |
|---|---|---|---|
| **P2.4** | `src/parse/` | 仅 fixtures + phase9 间接覆盖 | `tests/verify/parse-*.test.ts` 独立单测 |
| **P2.5** | `src/compile/context.ts` | phase9 间接覆盖 | `tests/verify/compile-context.test.ts` 独立单测 |
| **P2.6** | `src/render/cache.ts` | persist-profile 部分覆盖 | `tests/verify/render-cache.test.ts` round-trip 单测 |
| **P2.7** | `src/log.ts` PtLogger | probes / switch-integration 间接覆盖 | `tests/verify/log.test.ts` 独立单测 |

**测试用例数**：当前 124 passed。P2 验收"120+"**已满足**——P2.4-P2.7 是**结构上**补全（独立测试文件），不是数量目标。

### 关键基础设施

| API | 签名 | 测试策略 |
|---|---|---|
| `parseDomain(absDir, fileName)` | `(string, string) => Promise<Domain>` | 直接调，absDir 指 tests/fixtures/ |
| `parseBlueprint(absDir, fileName)` | 同上 | 同上 |
| `parseProfile(absDir, fileName)` | 同上 | 同上 |
| `compileContext(profile, blueprint, domains)` | `(Profile, Blueprint, Domain[]) => Context` | mock fixture 数据 |
| `computeSourceHash(profile, blueprint, domains)` | 同上 | 测稳定性（同输入 → 同 hash）|
| `saveContext(cwd, ctx, compilation)` | `(string, Context, CompilationConfig) => Promise<void>` | round-trip |
| `loadContext(cwd, name, sourceHash, compilation)` | `(string, string, string, CompilationConfig) => Promise<Context \| null>` | round-trip + 命中/降级/null |
| `PtLogger` class | `new PtLogger(cwd, profile, sessionId)` | 测 write/tail/clear |

---

## 任务清单

按 P2.1 → P2.7 顺序执行。

### P2.1 消 context-message.ts:203 双重 cast

- **位置**：`src/render/context-message.ts:201-207`
- **现状**：
  ```typescript
  const bt: BoundableTemplate = { ...hit };
  // 兼容：args 里 vars 字段（如 frontmatter 残留）
  const varsField = (bt as unknown as { vars?: unknown }).vars;
  if (Array.isArray(varsField)) {
    const strs = varsField.filter((x): x is string => typeof x === "string");
    if (strs.length > 0) bt._vars = strs;
  }
  ```
- **分析**：`BoundableTemplate = FlowTemplate & { _vars?: string[] }`（已声明字段），`{ ...hit }` spread FlowTemplate 不会产生 `vars` 字段。`bt.vars` 永远 undefined，整个 if 块是 dead code。
- **动作**：删除 varsField 中转 + if 块（dead code），仅保留 `const bt: BoundableTemplate = { ...hit };`
- **完成判定**：
  - `grep "as unknown as" src/render/context-message.ts` = 0
  - 124 tests 全过

### P2.2 commands.ts:139 用 type guard 收窄

- **位置**：`src/commands.ts:139`
- **现状**：
  ```typescript
  manual.some((t: unknown) => (t as { name?: string }).name === procedure)
  ```
- **动作**：用 `isFlowTemplateLike` 收窄（type-guards.ts 已有）:
  ```typescript
  manual.some((t: unknown) => isFlowTemplateLike(t) && t.name === procedure)
  ```
- **完成判定**：
  - `grep "as { name" src/commands.ts` = 0
  - 124 tests 全过

### P2.3 定义 Pi 事件本地接口

- **位置**：`src/index.ts:416, 423, 427`（3 处）
- **动作**：
  1. 在 index.ts 顶部定义本地接口（v9 之后稳定，外部无依赖）：
     ```typescript
     interface PiTurnEndEvent { reason?: string; messageCount?: number; }
     interface PiToolCallEvent { name?: string; toolName?: string; }
     interface PiToolResultEvent { name?: string; toolName?: string; isError?: boolean; }
     ```
  2. 替换 3 处双重 cast：
     ```typescript
     pi.on("turn_end", async (event, _ctx) => {
       const e = event as PiTurnEndEvent;
       slog("debug", "turn:end", { reason: e.reason, messageCount: e.messageCount });
     });
     // 类似 tool_call / tool_result
     ```
- **完成判定**：
  - `grep "as unknown as" src/index.ts` = 0（或仅剩 P2 范围外的合规 cast）
  - 124 tests 全过

### P2.4 补 parse 单元测试

- **新建**：`tests/verify/parse-domain.test.ts`、`parse-blueprint.test.ts`、`parse-profile.test.ts`
- **内容**：
  - 直接喂 MD 字符串（用 `parseDomain(absDir, fileName)` 通过 fixtures 路径）
  - 测试 frontmatter 解析（type/name 字段）
  - 测试 H2 段映射到 modules
  - 测试 type guard 兜底（未注册 type 走 default）
- **完成判定**：
  - 新测试文件存在
  - 124 + N tests passed（N = 新增数）
  - 三个 parse 函数各有 ≥3 个测试用例

### P2.5 补 compile 单元测试

- **新建**：`tests/verify/compile-context.test.ts`
- **内容**：
  - mock Profile + Blueprint + Domains 测 `compileContext`
  - 测 `computeSourceHash` 稳定性（同输入 → 同 hash；字段顺序不同 → 同 hash）
  - 测 sourceHash 包含 Profile + Blueprint + Domains
- **完成判定**：
  - 新测试文件存在
  - 124 + N tests passed

### P2.6 补 render/cache round-trip 测试

- **新建**：`tests/verify/render-cache.test.ts`
- **内容**：
  - save → load 命中（同 sourceHash）
  - hash mismatch 降级（load 返 null）
  - 损坏文件（写非法 JSON）→ load 返 null
- **完成判定**：
  - 新测试文件存在
  - 124 + N tests passed

### P2.7 补 log.ts PtLogger 测试

- **新建**：`tests/verify/log.test.ts`
- **内容**：
  - 测 write 链顺序（debug → info → warning → error）
  - 测 tail() 解析最后 N 行
  - 测 clear() 清空文件
- **完成判定**：
  - 新测试文件存在
  - 124 + N tests passed

---

## 5 commit 拆分

按 cast 清理合并 + 测试按模块拆分：

### Commit 1: P2.1 + P2.2 + P2.3（cast 清理整体）

- 改 `src/render/context-message.ts`（P2.1）
- 改 `src/commands.ts`（P2.2）
- 改 `src/index.ts`（P2.3，3 处合一）
- message: `refactor: P2 type safety last mile (5 cast → 0)`
- **理由**：3 项都是"清 cast 残余"，性质相同；P0/P1 都已示范 cast 清理是单 commit

### Commit 2: P2.4（parse 单元测试）

- 新建 `tests/verify/parse-domain.test.ts` + `parse-blueprint.test.ts` + `parse-profile.test.ts`
- message: `test: P2 parse unit tests (domain/blueprint/profile)`

### Commit 3: P2.5（compile 单元测试）

- 新建 `tests/verify/compile-context.test.ts`
- message: `test: P2 compile context unit tests (compileContext + sourceHash)`

### Commit 4: P2.6（render/cache round-trip）

- 新建 `tests/verify/render-cache.test.ts`
- message: `test: P2 render cache round-trip (save/load/mismatch/corrupt)`

### Commit 5: P2.7（log PtLogger 测试）

- 新建 `tests/verify/log.test.ts`
- message: `test: P2 log PtLogger tests (write/tail/clear)`

---

## 边界纪律

- **不动**：v9 四层语义
- **不动**：diagnostics.ts / api-bridge.ts / profile-persist.ts（P0/P1 抽出物）
- **不动**：transpile.ts 主体
- **不**改测试 fixtures（tests/fixtures/ 已存在，复用）
- **不**删除现有测试（只新增）
- **不**主动改 switch-injection / persist-profile / phase9 / probes 等行为测试
- **cast 清理严格遵守 pt-quality #1**：用 type guard 收窄，不用 as 断言
- **新增测试用 vitest 模式**：参考现有 `tests/verify/*.test.ts` 写法（describe/it/expect）

---

## 验证循环（每 commit 后必跑）

```bash
npm run typecheck   # 0 output
npm run verify      # ≥ 124 passed（commit 1 应仍 124，commit 2-5 应 +N）
npm run lint        # 0 error
```

---

## 完成判定（全部满足）

- [ ] `grep -rn "as unknown as" src/render/context-message.ts src/commands.ts src/index.ts` = 0（或仅 P2 范围外的合规 cast）
- [ ] `grep -rn "as { name" src/commands.ts` = 0
- [ ] `grep -rn "function isFlowTemplateLike" src/commands.ts` 引用次数 ≥ 1
- [ ] `tests/verify/parse-*.test.ts` 3 文件存在
- [ ] `tests/verify/compile-context.test.ts` 存在
- [ ] `tests/verify/render-cache.test.ts` 存在
- [ ] `tests/verify/log.test.ts` 存在
- [ ] 真实 `as` 问题数 ≤ 2（应 = 0）
- [ ] 测试用例数 ≥ 124（应 +12 ~ +20）
- [ ] typecheck 0 output
- [ ] verify 全过
- [ ] lint 0 error
- [ ] 5 commit 按序落地
