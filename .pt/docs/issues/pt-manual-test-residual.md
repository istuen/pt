---
type: issue
name: pt-manual-test-residual
status: resolved
severity: medium
created: 2026-09-03
updated: 2026-09-03
resolved: 2026-09-03
domain: pt-dev
---

# 测试残留：`.pt/manuals/` 堆积 113 个空 deliver-feature 实例

## 现象

`.pt/manuals/` 目录曾堆积 113 个空的 `deliver-feature-<ts>.md` 实例文档，全部 `status: in-progress`，0 步骤勾选、0 产物。按 args 去重只有两个值：

- `manual-track-test`（57 个）
- `cmd-test`（56 个）

两者时间戳成对相差 ~10ms，每次跑 vitest 各产生 1 个，文件名带时间戳不覆盖 → 无限堆积。

> 已于 2026-09-03 手动清理（删 113 个，保留 8 个真实任务文档）。但根因未修——下次跑 `npm run verify` 会再产生 2 个。

## 根因

`tests/verify/manual-track-integration.test.ts` 两个用例调 `pt_manual` 写真实文件，但**未隔离 `ctx.cwd`**：

- **L95-145** `pt_manual tool → 写 activeManual + ...`：L117 `{ procedure: "deliver-feature", args: "manual-track-test" }` 调 `ptManualTool.execute(..., m.ctx)`
- **L218-245** `/pt manual 命令 → 同 tool 路径`：L230 `ptCmd.handler("manual deliver-feature cmd-test", m.ctx)`

mock 的 `ctx.cwd = process.cwd()`（L88 `makePi` 硬编码），pt_manual 按 cwd 解析 `.pt/manuals/` 写入路径 → 文件落进真实仓库。

**对比**：同文件 L150-175 / L184-205 / L210-216 三个"session_start fallback 恢复"用例**正确用了** `mkdtemp(join(tmpdir(), "pt-manual-*"))` + 预创建 `.pt/manuals/`，但它们只读 fixture、不写。写路径的两个用例漏了隔离——文件头注释（L12）声称"用 mkdtemp 隔离避免污染仓库"但实际只隔离了读路径，注释与代码不符。

## 影响范围

| 维度 | 影响 |
|---|---|
| LLM 对话 / 注入 | ✅ 不影响（manuals/ 不进 system prompt） |
| 发版产物 | ✅ 不影响（.pt/manuals/ gitignore，不发 npm） |
| 仓库卫生 | ⚠️ 每跑一次 verify +2 文件，无限堆积；`.pt/manuals/` 目录膨胀 |
| 开发体验 | ⚠️ ls / pt_status 看到一堆噪音；真实任务文档被淹没 |
| 测试可信度 | ⚠️ 注释声称隔离但实际未隔离，注释与代码不符 |

## 排查方法

1. `ls .pt/manuals/ | grep -E 'manual-track-test|cmd-test' | wc -l` — 残留计数（清理后为 0，跑一次 verify 后变 2）
2. `grep -l 'args: manual-track-test\|args: cmd-test' .pt/manuals/*.md` — 确认全部来自这两个 args
3. 抽查任一残留文件：`grep -c '\- \[x\]' <file>` = 0（未执行）+ 产物段为空
4. 看 `tests/verify/manual-track-integration.test.ts:88`（`ctx.cwd = process.cwd()`）+ L117/L230（未传 tempDir 给 ctx）

## 修复方向

### 方案 A（治本）：测试用 mkdtemp 隔离 cwd

改 `manual-track-integration.test.ts` 的两个写路径用例，把 `ctx.cwd` 指向 mkdtemp 临时目录：

```typescript
const tempDir = await mkdtemp(join(tmpdir(), "pt-manual-write-"));
tempDirs.push(tempDir);
await mkdir(join(tempDir, ".pt", "manuals"), { recursive: true });
m.ctx.cwd = tempDir;  // 覆盖 makePi 默认的 process.cwd()
```

**优点**：根因修复，测试不再污染仓库；与同文件 fallback 用例的隔离风格一致。
**风险**：低——只动测试，不改 src/；断言不变（path 仍匹配 `deliver-feature-\d+\.md`）。

### 方案 B（治标/兜底）：regression-verify 加 manuals 残留检查

在 `testing` domain 的 `### regression-verify` 段补一条"测试残留检查"步骤，覆盖 `.pt/manuals/`：

```
- step: 测试残留检查 — ls .pt/manuals/ 不应有 manual-track-test / cmd-test 等测试夹具名堆积（pt_manual 写真实 fs 的测试若未隔离 cwd 会污染仓库，见 issue pt-manual-test-residual）；发现即删
```

**优点**：兜底防护，即便某测试漏隔离也能在发版前发现。
**缺点**：治标不治本，仍依赖人工跑 regression-verify。

### 推荐方案 A + B 并行

A 治本（改测试隔离），B 兜底（加检查 step）。两者不冲突，应同时落地。

## 修复

### commit

`Phase X.Y: 修复 pt_manual 集成测试 cwd 隔离，消除 .pt/manuals/ 测试残留堆积（issue pt-manual-test-residual 方案 A）`

### 修复方式

改 `tests/verify/manual-track-integration.test.ts` 两个写路径用例——`pt_manual tool → 写 activeManual` 和 `/pt manual 命令 → 同 tool 路径`——用 mkdtemp 隔离 manual 写入路径：

```typescript
const tempDir = await mkdtemp(join(tmpdir(), "pt-manual-write-"));
tempDirs.push(tempDir);
await mkdir(join(tempDir, ".pt", "manuals"), { recursive: true });

const m = makePi();
installExtension(m.pi as never);
await sessionStart({ type: "session_start" }, m.ctx);
await switchCmd.handler("pt-dev", m.ctx);  // 关键：用真实 cwd 加载 profile

// 隔离 cwd：profile 已加载到全局 session，切 cwd 让 pt_manual 写入到 tempDir
m.ctx.cwd = tempDir;
```

**关键时序**：必须在 `switchCmd.handler("pt-dev", m.ctx)` **之后**才能切 cwd——因为 `switchProfile → transpileActive(ctx.cwd)` 从 cwd 读 `.pt/assets/profiles/`，切早了 profile 加载失败 → `buildManualDoc` 返回 "无激活 Profile" 错误 → `details.path` undefined。

### 验证方式

1. **单元测试**：`tests/verify/manual-track-integration.test.ts` 7 tests 全过（含两个写路径用例）
2. **回归**：所有 163 测试通过 + `tsc --noEmit` 干净
3. **端到端**：连续跑 `npm run verify` 三次，每次 `.pt/manuals/` 残留计数 = 0（修复前 = 2/次）
4. **残留清理**：2026-09-03 一次性清理历史堆积的 113 个 `manual-track-test` / `cmd-test` 残留（验证后 `ls .pt/manuals/ | wc -l` = 8 真实任务文档，无垃圾）

### 修复说明

**根因**：`manual-track-integration.test.ts:88` 硬编码 `ctx.cwd = process.cwd()`，且两个写路径用例未隔离 cwd。pt_manual 按 `ctx.cwd` 解析 `.pt/manuals/` 写入路径 → 文件落进真实仓库，时间戳命名不覆盖 → 每次跑 verify +2 文件无限堆积。

**根因修复**：profile 加载用真实 cwd（不动），仅在 profile 加载完成后切换 `m.ctx.cwd` 到 mkdtemp 临时目录——既保证 profile 资产可读，又让 pt_manual 写入隔离到 tempDir。同文件 fallback 用例（L181-227）的 mkdtemp 风格保持一致。

**边界纪律**：
- ✅ 不动 `src/`（pt_manual / buildManualDoc 行为正确，是测试未正确隔离）
- ✅ 只动测试代码 `tests/verify/manual-track-integration.test.ts`（+15 行 / -2 行）
- ✅ 复用已有的 `tempDirs` 数组 + afterEach `rm({ recursive: true })`（不引入新清理机制）
- ✅ afterEach 不变：失败路径已能正确清理 tempDir（之前 ENOTEMPTY 是因为 logger 写到 tempDir/.pt/logs/；现在 logger 在真实 cwd 下创建，tempDir 里无 logs 子目录）

### 修复日期

2026-09-03

## 关联

- **`tests/verify/manual-track-integration.test.ts:88`** — `ctx.cwd = process.cwd()` 硬编码（原根因）
- **`tests/verify/manual-track-integration.test.ts:95-155`** — `pt_manual tool` 写路径用例（修复后用 mkdtemp 隔离）
- **`tests/verify/manual-track-integration.test.ts:285-330`** — `/pt manual 命令` 写路径用例（修复后用 mkdtemp 隔离）
- **`tests/verify/manual-track-integration.test.ts:181-227`** — fallback 用例（修复参考的 mkdtemp 风格来源）
- **`.pt/assets/domains/testing.md`** — `### regression-verify` 残留检查步骤（方案 B 兜底已补）
- **issue `pt-full-duplicate-segment`** — 同为调试 / 卫生类问题，命名 / 模板可参考
