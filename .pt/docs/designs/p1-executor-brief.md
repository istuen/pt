# P1 执行者简报：transpile 简化 + index 拆分

> **基线 commit**：`9019972`（refactor: P0 去噪去重...）— HEAD 起点
> **任务来源**：`pt-code-quality-plan.md` §P1（5 项任务）+ §8.2 三处调整
> **目标**：消除 transpile 死复杂度 + 拆 index.ts God Module
> **约束**：v9 四层语义不动；每 commit 必过 `typecheck` + `verify`(124 tests) + `lint`(0 error)
> **产出**：3 commit（按依赖链分层）

---

## ⚠️ 验收硬指标校准（HEAD 9019972 现状）

| 指标 | 简报原文 | 实际 | P1 范围可达性 |
|---|---|---|---|
| `transpile.ts` | < 120 行 | **183 行** | ✅（P1.1 简化可达 110-130） |
| `index.ts` | < 300 行 | **849 行** | ❌（P1.1-P1.5 估 500-600，仍超 300） |

**偏差决策**：放宽到 `index.ts < 500`（实际值待 P1.5 后测量）。若仍 > 500，再决策是否加 P1.6 进一步拆 session handler 实现。

### 行数下不来分析

| 步骤 | 抽出代码 | 预计减 |
|---|---|---|
| P1.3 抽 api-bridge | toAgentAPI + agentApiCache WeakMap | -45 |
| P1.4 抽 profile-persist | PT_PROFILE_ENTRY + MinimalSessionManager + 2 functions | -50 |
| P1.5 仅留注册+handler 调度 | session handler 实现不外移 | 0 |
| **合计** | | **-95** |
| **预计终态** | | **~750 行**（实际估 500-600） |

---

## 任务清单

按 P1.1 → P1.5 顺序执行。

### P1.1 简化 transpile.ts 为单源线性

- **位置**：`src/transpile.ts:62-184`（`loadAndTranspile` 主体）
- **依据**：`pt-code-quality-plan.md` §8.2 调整 3
- **动作**：
  1. 删多 bundle 循环（`for (const bundle of bundles)` + 5 个 `lastXxx` 累积变量）
  2. 改单源：依次调 `sourceAdapters`，取第一个成功的 bundle（YAGNI 多源合并）
  3. 保留 `sourceAdapters` 数组 + `SourceAdapter` 接口
  4. 删 `EMPTY_BP` / `EMPTY_PROFILE` / `EMPTY_CTX`（不再需要 fallback；抛错替代）
  5. `bundles.length === 0` → 抛 `Error`（P1.2 联动）
  6. `bundles: [bundle]` 仍返 SchemaBundle[]（index.ts:786 `r.bundles[0]` 依赖）
- **下游兼容**：
  - `session.cachedBundles = result.bundles` (index.ts:267) ✅
  - `r.bundles[0]` (index.ts:786) ✅
  - `result.cacheHit` / `result.segment` / `result.blueprint` / `result.domains` / `result.activeProfile` / `result.profile` 字段全部保留 ✅
- **完成判定**：
  - `grep -n "lastBlueprint\|lastDomains\|lastProfile\|lastActiveProfile\|lastContext" src/transpile.ts` = 0
  - `wc -l src/transpile.ts` ≤ 130 行
  - 124 tests 全过（重点：switch-injection 4 + persist-profile 13）

### P1.2 bundles 抛错

- **位置**：`src/transpile.ts`（P1.1 同步实现）
- **依据**：`pt-code-quality-plan.md` P1.2 行
- **动作**：
  1. 所有 adapter 失败（无成功 bundle）→ `throw new Error("transpile: no adapter succeeded for profile <name>")`
  2. 抛错由 index.ts:286 `catch (e) { ... throw e; }` 兜底
- **完成判定**：
  - 现有 124 tests 中无 "no bundles" 路径测试 → 不需新增
  - typecheck/verify/lint 全过

### P1.3 抽 src/agent/api-bridge.ts

- **位置**：
  - `src/index.ts:804` `agentApiCache` WeakMap
  - `src/index.ts:812` `toAgentAPI` 函数
- **依据**：`pt-code-quality-plan.md` §8.2 调整 2
- **动作**：
  1. 新建 `src/agent/api-bridge.ts`，含 `agentApiCache` + `toAgentAPI`
  2. `src/index.ts` 删上述实现，改 `import { toAgentAPI } from "./agent/api-bridge.js"`
  3. 复用 index.ts 现有的 `AgentAPI` 类型 import
- **完成判定**：
  - `grep -rn "toAgentAPI\|agentApiCache" src/` 只在 `src/agent/api-bridge.ts`
  - 124 tests 全过

### P1.4 抽 src/profile-persist.ts

- **位置**：
  - `src/index.ts:65` `PT_PROFILE_ENTRY`
  - `src/index.ts:72` `MinimalSessionManager` interface
  - `src/index.ts:75` `readProfileFromSession`
  - `src/index.ts:99` `persistProfileToSession`
- **依据**：`pt-code-quality-plan.md` §8.2 调整 2
- **动作**：
  1. 新建 `src/profile-persist.ts`，含上述 4 个符号
  2. `src/index.ts` 删上述实现，改 `import { readProfileFromSession, persistProfileToSession } from "./profile-persist.js"`
  3. 保留 `PT_PROFILE_ENTRY` 与 `MinimalSessionManager` 的可访问性（不导出则仅 profile-persist 内部用，调用方通过函数签名接收）
- **完成判定**：
  - `grep -rn "PT_PROFILE_ENTRY\|MinimalSessionManager\|readProfileFromSession\|persistProfileToSession" src/index.ts` = 0
  - 124 tests 全过

### P1.5 index.ts 简化

- **位置**：`src/index.ts` 整体
- **依据**：`pt-code-quality-plan.md` P1.5 行
- **动作**：
  1. P1.3+P1.4 完成后，index.ts 主体已减 ~95 行
  2. **不**主动改 session_start / session_shutdown / before_agent_start 实现（超出 P1 范围）
  3. **不**主动改 switchProfile / transpileActive 编排函数（保留现状）
- **完成判定**：
  - `wc -l src/index.ts` 较 849 行显著下降
  - 实测行数（用户接受放宽到 < 500）

---

## 3 commit 拆分

按 code-quality-plan "commit 建议" + 依赖链：

### Commit 1: P1.1 + P1.2（transpile 简化）

- `src/transpile.ts` 重写
- message: `refactor: P1 transpile simplify (single-bundle linear + throw on no bundles)`

### Commit 2: P1.3（抽 api-bridge）

- 新建 `src/agent/api-bridge.ts`
- 改 `src/index.ts` import
- message: `refactor: P1 extract api-bridge (toAgentAPI + WeakMap)`

### Commit 3: P1.4 + P1.5（抽 profile-persist）

- 新建 `src/profile-persist.ts`
- 改 `src/index.ts` import
- message: `refactor: P1 extract profile-persist (read/write/PT_PROFILE_ENTRY/MinimalSessionManager)`

---

## 边界纪律

- **不动**：parse / compile / render / schema 主体（只动 transpile + index 拆分）
- **不动**：P0 抽出的 diagnostics.ts / s / sArr / isRecord
- **不动**：v9 四层语义（Domain/Blueprint/Profile/Context）
- **不**主动改 session_start / session_shutdown / before_agent_start 实现
- **不**引入 `src/contract/` 目录（§8.1 调整 1 是未来 P1.6+ 范围，不在 P1）
- **不**碰 commands.ts / log.ts / agent/pi-adapter.ts / agent/registry.ts
- **不**改 P0 修复的 au.pt-context 行为
- **不**改 settings 读取双读逻辑

---

## 验证循环（每 commit 后必跑）

```bash
npm run typecheck   # tsc --noEmit，必须零输出
npm run verify      # vitest，必须 124 tests passed
npm run lint        # biome check，必须 0 error
```

**任一失败则修到过，不跳过不绕过。** `switch-injection.test`（4 用例）和 `persist-profile.test`（13 用例）是 P1 的关键回归门。

---

## 完成判定（全部满足）

- [ ] `wc -l src/transpile.ts` < 130 行
- [ ] `wc -l src/index.ts` 较 849 行显著下降
- [ ] `grep -rn "lastBlueprint\|lastDomains\|lastProfile\|lastActiveProfile\|lastContext" src/transpile.ts` = 0
- [ ] `grep -rn "toAgentAPI\|agentApiCache" src/index.ts` = 0（应在 api-bridge.ts）
- [ ] `grep -rn "PT_PROFILE_ENTRY\|MinimalSessionManager" src/index.ts` = 0（应在 profile-persist.ts）
- [ ] `npm run typecheck` 零输出
- [ ] `npm run verify` 124 passed
- [ ] `npm run lint` 0 error
- [ ] 3 commit 按序落地
