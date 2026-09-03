---
type: issue
name: pt-full-duplicate-segment
status: resolved
severity: low
created: 2026-09-03
updated: 2026-09-03
resolved: 2026-09-03
domain: pt-dev
---

# `/pt full` 输出的 prompt 文件里 segment 重复 2 次

## 现象

跑 `/pt full` 后，生成的 `.pt/cache/fulls/prompt-<ts>.md` 文件里 `## 当前任务上下文` 段出现 2 次（即完整 segment 内容被写了 2 份）。

实测样例（`.pt/cache/fulls/prompt-1788398405502.md`，6825 chars segment）：

```
[Pi 通用 system prompt]

## 当前任务上下文
[AgentRole + ysl-company Scene + fastener-industry Scene + screw-products Scene]

## 当前任务上下文        ← 重复
[AgentRole + ysl-company Scene + fastener-industry Scene + screw-products Scene]
```

文件总长度比预期（base + 1×segment）多了约 6825 chars。

## 根因

`src/index.ts:440-446`（`/pt full` 子命令 handler）：

```typescript
if (sub === "full") {
  const base = ctx.getSystemPrompt();                                              // ①
  const full = session.cachedSegment
    ? base + "\n\n## 当前任务上下文\n\n" + session.cachedSegment                  // ② 又拼
    : base;
```

`ctx.getSystemPrompt()` 拿到的 `base` **已经**被 PiAdapter 的 `before_agent_start` handler 注入过一次 segment（含 `## 当前任务上下文` 段），见 `src/agent/pi-adapter.ts:65-70`：

```typescript
const final = event.systemPrompt + "\n\n## 当前任务上下文\n\n" + currentSegment;
```

所以 `/pt full` 又手动拼一份 → 重复。

## 影响范围

| 场景 | 行为 | 影响 |
|---|---|---|
| **LLM 实际对话** | 每 turn 由 `before_agent_start` 注入一次 segment | ✅ 正常（不重复） |
| **`/pt full` 调试输出** | 文件里 segment 重复 2 次 | ⚠️ 误导开发者（看真实长度 / 调试内容会算错） |
| **`/pt full` 长度统计** | `full.length` 包含 2 份 segment | ⚠️ 体积翻倍（约 13.6 KB vs 实际 6.8 KB） |
| **`lastBuiltPrompt` 上报** | 不影响（PiAdapter `onInjected` 不走 `/pt full`） | ✅ 不影响 |

**核心结论**：不影响 LLM 实际对话——只是调试输出的"账面"长度虚高。

## 排查方法

1. 跑 `/pt full`
2. 读 `.pt/cache/fulls/prompt-<ts>.md`
3. `grep -c "## 当前任务上下文" <file>` — 应出现 2 次（确认重复）
4. 对比 `pt_status` 的 `segment length` 字段 — 若文件里 segment 部分字符数 ≈ `segment length × 2`，确认重复
5. 看 `pt_status` 的 `last built prompt` — 应有记录（PiAdapter `onInjected` 上报）

## 修复方向

### 方案 A（推荐）：去掉 `/pt full` 里的手动拼接

最简——`/pt full` 直接输出 `ctx.getSystemPrompt()` 拿到的 base（已含 segment）。

```typescript
if (sub === "full") {
  const full = ctx.getSystemPrompt();  // 已含 segment，无需再拼
  // ... 后续 mkdir/writeFile/notify 不变 ...
}
```

**优点**：
- 改动最小（2 行替换）
- 语义对齐——`/pt full` = "给我看 LLM 实际收到的完整 prompt"，base 已含 segment
- `/pt raw` 单独命令（`src/index.ts:432-438`）保留作为 raw segment 调试入口，互不重叠

**缺点**：
- 如果 PiAdapter 在某些情况下**没**注入（罕见 race，如 registerInject 之前调 `/pt full`），`/pt full` 会缺 segment
- 但 PiAdapter 注册发生在 `session_start`（`src/index.ts:201-204`），`/pt full` 是 session 内命令，正常情况下 registerInject 已完成

### 方案 B：在 PiAdapter 注入时打 marker，`/pt full` 检测去重

```typescript
// pi-adapter.ts:67 注入时加 marker
const MARKER = "<!-- pt:segment-injected -->";
const final = event.systemPrompt + "\n\n## 当前任务上下文\n\n" + currentSegment + "\n" + MARKER;

// index.ts:440 /pt full 检测 marker
const base = ctx.getSystemPrompt();
const full = base.includes(MARKER)
  ? base
  : base + "\n\n## 当前任务上下文\n\n" + session.cachedSegment;
```

**优点**：
- 健壮（处理 PiAdapter 没注入的边界）
- marker 注释对 LLM 透明（HTML 注释语法）

**缺点**：
- 增加 marker 噪音（虽然 LLM 看不到）
- 改动点比方案 A 多（2 个文件 vs 1 个文件）

### 方案 C：完全去掉 `/pt full` 命令

既然 `before_agent_start` 已经在每轮注入，且 `session.lastBuiltPrompt` 已有完整 systemPrompt 记录，`/pt full` 命令本身的价值就小了。可以让 `lastBuiltPrompt` 自动写到 `.pt/cache/fulls/`（按 session id），`/pt full` 仅做手动触发器。

**优点**：消除重复源头。

**缺点**：破坏性变更（命令语义改变），不推荐作为修复方案，仅作长期重构参考。

### 推荐方案 A

简洁胜过复杂。PiAdapter 注入机制稳定，方案 A 适用当前 99% 场景。如未来发现 race 再叠加方案 B。

## 关联

- **`src/index.ts:440-446`** —— `/pt full` handler 拼接逻辑（修复点）
- **`src/agent/pi-adapter.ts:65-70`** —— `before_agent_start` 注入逻辑（已正确）
- **`src/index.ts:432-438`** —— `/pt raw` 单独输出 raw segment（保留作为 segment 调试入口）
- **`.pt/cache/fulls/prompt-1788398405502.md`** —— 实测样例，确认重复（6825 chars × 2）
- **`src/index.ts:67`** —— `onInjected` 回调记录 `lastBuiltPrompt`（独立通道，不重复）
- **issue `pt-context-persist-lost`** —— 同为调试 / 持久化类问题，命名 / 模板可参考

## 修复

### commit

`fix: /pt full duplicate segment after first prompt turn (uses lastBuiltPrompt as canonical source)`

### 验证方式

1. **单元测试**：`tests/verify/issue-pt-full-duplicate-segment.test.ts`（8 tests，全过）
   - 覆盖三种状态组合：lastBuiltPrompt null × cachedSegment 有/无、lastBuiltPrompt 非 null × cachedSegment 有/无
   - 关键断言：第一轮之后产出只含 1 个 `## 当前任务上下文` header（修复前 2 个）
2. **回归**：所有 84 测试通过 + `tsc --noEmit` 干净
3. **端到端**：手动跑 pi session 中 `/pt full` 三次（profile 加载后 / 第一轮 prompt 后 / profile 切换后）应分别看到 1× / 1× / 1× segment（此前实测：1× / 2× / 2×）

### 修复说明

**根因**：`/pt full` 与 PiAdapter `before_agent_start` 各有一份"base + header + segment"拼接逻辑，通过 `ctx.getSystemPrompt()`（=`agent.state.systemPrompt`）隐式耦合。第一轮之后 PiAdapter 已写入拼接结果，`/pt full` 再拼一次 → 2×。

**根因修复**：把 `lastBuiltPrompt`（由 PiAdapter `onInjected` 回调写入）作 canonical source。`/pt full` 直接读取，不再自己拼接。第一轮之前的 fallback：模拟下次注入（保留旧版"看不到 turn 时也能用 /pt full"语义）。

**边界纪律**：
- ✅ 不动 PiAdapter（PiAdapter 行为正确，不重复注入）
- ✅ 不动 Pi 上游 API（`getSystemPrompt` 语义不变）
- ✅ 只动 `src/commands.ts`（新增 `buildFullPrompt`）+ `src/index.ts`（调用新函数，-5/+11 行）+ `tests/verify/issue-pt-full-duplicate-segment.test.ts`（新增测试）

### 修复日期

2026-09-03