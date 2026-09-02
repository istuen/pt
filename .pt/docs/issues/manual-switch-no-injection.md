---
type: issue
name: manual-switch-no-injection
status: resolved
severity: critical
created: 2026-09-02
updated: 2026-09-02
resolved: 2026-09-02
domain: pt-dev
---

# `/pt-context` 手动切换成功但「下一轮生效」从未生效：segment 没注入 system prompt

> **本 issue 关键事实**：
> - 用户手动 `/pt-context ysl` 后，`pt_status` 显示 `profile=ysl, segment length=5121, cache hit=yes`——看上去完美生效。
> - 但 LLM **始终拿不到 segment**——`last built prompt: (未跑过 turn)`，`before_agent_start` 钩子一次都没跑过。
> - 根因：`switchProfile`（`src/index.ts:136`）成功路径**没有**调 `registerInject`，只有 `session_start` 末尾会调。
> - 触发条件：项目里恰好有 ≥2 个 profile（项目 + 内建），导致 `detectSingleProfile` 返 null，`session_start` 走 fallback 全空、不调 `registerInject`——用户被迫用 `/pt-context` 命令——而这条命令本身有 bug。

## 1. 现象

### 1.1 用户视角
- 启动 pi，footer 显示 `pt: 无 context`
- 手动 `/pt-context ysl`，UI 弹通知「已切换到 ysl，下一轮生效（缓存命中）」
- footer 变为 `pt: ysl`
- **但 LLM 后续每轮答复都说"我是 MiniMax-M3，没有关于亿盛隆的特定上下文"——完全没有 ysl/紧固件/螺丝产品的知识**

### 1.2 工具视角
- `pt_status` 报告：
  ```
  pt profile: ysl
  pt loadedFrom: (none)
  pt agent: pi
  pt domains: 6, blueprints: 1, profiles: 2, flows: 7
  pt segment length: 5121 chars
  pt cache hit: yes
  pt last built prompt: (未跑过 turn)   ← 关键证据
  pt cwd: /Users/issac/client/yishenglong
  ```
- `pt_flows` 报告：能列出 7 条手册（`/manual:ysl-company` 等）——证明 segment 已编译、context_message 链路健康
- `.pt/cache/fulls/prompt-1788340758565.md` 文件里能看到完整 ysl segment（说明 `/pt full` 路径能写出完整 prompt）——但**这只是手动 dump 文件**，不是实际注入到 LLM 的 system prompt

### 1.3 日志视角
`.pt/logs/pt-8e80b111.log`（当前 session）按时间排序：

```
09:40:58  session:start                            { sessionId: 8e80b111 }
09:40:58  session:no profile picked                { auto: null }                    ← Bug A 触发点
09:41:01  command:switchProfile start              { profileName: ysl }
09:41:01  transpileActive:start                    { profileName: ysl }
09:41:01  transpile:parse done                      { domainCount: 6 }
09:41:01  transpile:cache hit                      { contextName: ysl }
09:41:01  transpile:done                           { segmentLen: 5121, cacheHit: true }
09:41:01  transpileActive:done                     { agent: pi, durationMs: 27 }
09:41:01  command:switchProfile done               { cacheHit: true }
09:41:16  turn:start
09:41:21  turn:end
09:41:21  turn:start
... (多轮 turn:start/turn/end，无 before_agent_start)
09:41:54  tool:call { name: pt_status }
09:41:54  tool:call { name: pt_flows }
```

**关键缺失**：从 09:41:01 切换成功到 09:42:06 当前 turn 的所有 turn 周期里，**0 条** `agent:before_agent_start` / `agent:input` / `agent:before_agent_start ok` 日志——`registerInject` 注册的钩子从未跑过。

对比预期：若 `session_start` 路径走通，应在 `session_start` 内 `transpileActive` 完成后立刻调 `registerInject`，后续每个 `turn:start` 之前都会有 `agent:before_agent_start ok` 日志（看 `src/agent/pi-adapter.ts:55`）。

## 2. 根因（两个 bug 复合）

### 2.1 Bug A — `detectSingleProfile` 在内建 profile 存在时永远 null

**代码**（`src/config.ts:41-70`）：

```typescript
export async function listProfiles(cwd: string): Promise<string[]> {
  const project = await listProfileNamesIn(join(cwd, PROFILES_DIR));
  const builtin = await listProfileNamesIn(join(BUILTIN_ASSETS_DIR, "profiles"));
  const projectNames = new Set(project);
  const merged = [...project, ...builtin.filter((n) => !projectNames.has(n))];
  return merged.sort();
}

export async function detectSingleProfile(cwd: string): Promise<string | null> {
  const all = await listProfiles(cwd);  // 项目 + 内建合并
  return all.length === 1 ? all[0] : null;
}
```

**问题**：
- 内建 `src/builtin/assets/profiles/pt.profile.md`（blueprint=dev-knowledge，domains=[project-analysis, usage, authoring]）——这是 pt 扩展**自己**的开发上下文，不该参与用户的 auto 决策。
- 一旦项目里有任意一个 profile，`listProfiles` 必返回 ≥2 项（项目 + 内建 `pt`），`detectSingleProfile` 必返 null。
- v10.x 落地后新增了 `fromSession`（session JSONL 持久化）作为 fallback 链第四源——但**首次启动** session JSONL 没记录，仍然兜不住。

**设计本意**（推断）：作者想让"项目只有 1 个 profile 时自动加载"，但没考虑内建 profile 是必现的。

### 2.2 Bug B（更关键）— `switchProfile` 不调 `registerInject`

**代码**（`src/index.ts:136-153`）：

```typescript
async function switchProfile(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  name: string,
): Promise<void> {
  slog("info", "command:switchProfile start", { profileName: name });
  try {
    await transpileActive(ctx.cwd, name, (msg, level) => ctx.ui.notify(msg, level));
    session.loadedFrom = null;  // 用户手动切换不属于 auto/flag/settings/session 任何源
    persistProfileToSession(pi, name);  // v10.x：session 持久化
    ctx.ui.setStatus("pt", `pt: ${name}`);
    const hint = session.lastCacheHit ? "（缓存命中）" : "（已重编译）";
    ctx.ui.notify(`已切换到 ${name}，下一轮生效 ${hint}`, "info");
    slog("info", "command:switchProfile done", { profileName: name, cacheHit: session.lastCacheHit });
  } catch (e) {
    ctx.ui.notify(`切换失败：${errMsg(e)}`, "error");
    slog("error", "command:switchProfile failed", { profileName: name, err: errMsg(e) });
  }
}
```

vs `session_start` 成功路径（`src/index.ts:217-219`）：

```typescript
await transpileActive(ctx.cwd, picked, (msg, level) => ctx.ui.notify(msg, level));
session.loadedFrom = pickedFrom;
persistProfileToSession(pi, picked);  // v10.x：把当前来源同步到 JSONL
// 注册 AgentAdapter 注入（封装 before_agent_start + input）
if (session.activeAdapter && session.cachedContext && session.cachedBlueprint) {
  session.activeAdapter.registerInject(toAgentAPI(pi, ctx), session.cachedContext, session.cachedBlueprint);
}
```

**差异**：
- `session_start` 在 transpile 完成后**显式**调 `registerInject`
- `switchProfile` **没有**这一步

**后果**：用户走 fallback 失败（Bug A）→ 手动 `/pt-context ysl` → `switchProfile` 跑通 → segment 编译进 `session.cachedSegment`（5121 字符）→ 但 `before_agent_start` 钩子从未被注册 → LLM 的 system prompt 里**永远不会**追加 `## 当前任务上下文\n\n<segment>`。

### 2.3 Bug 复合链

| 阶段 | Bug A 触发? | Bug B 触发? | 结果 |
|---|---|---|---|
| ① 首次启动，`auto=null`，settings/flag/session 全空，**用户没手动切换** | ✅ | ❌（没切换） | segment 不存在，footer `pt: 无 context`，**LLM 拿不到业务上下文** |
| ② 首次启动，用户**手动** `/pt-context ysl` | ✅ | ✅ | segment 编译但未注入，footer `pt: ysl`，**LLM 仍拿不到业务上下文**（最常见的"卡死"场景） |
| ③ 首次启动，恰好只有 1 个 profile（极少见） | ❌ | ❌ | session_start 走 auto 路径自动调 registerInject，**正常工作** |
| ④ 重启进程，session JSONL 有上次切换记录 | ❌ | ❌ | session_start 走 fromSession 路径自动调 registerInject，**正常工作** |

→ **绝大多数项目都走路径 ②**——只要项目里 `≥2` 个 profile（含内建 `pt`）+ 用户首次启动，LLM 就拿不到任何业务上下文。

## 3. 影响范围

| 维度 | 影响 |
|---|---|
| 用户体验 | footer 显示 `pt: ysl` 误导用户以为生效，实际 LLM 完全没拿到上下文 |
| LLM 能力 | 整个项目的 Domain 知识（Scene axioms、Trigger 索引、Manual 规则）失效，LLM 退化为无 Pt 状态 |
| 自动化工作流 | `deliver-feature` / `modify-schema` 等手册无法让 LLM 自主执行（缺 Trigger 索引） |
| 排查难度 | `pt_status` 看上去一切正常（profile=ysl, segment=5121, cache hit），只有 `last built prompt: (未跑过 turn)` 和日志里缺 `before_agent_start` 两处能看出来 |
| 现有测试 | `tests/verify/persist-profile.test.ts`（13 个）只覆盖 helper 逻辑 + statusText 渲染，**没有任何 e2e 测试覆盖「手动切换 → 下一轮 system prompt 实际包含 segment」** |

## 4. 排查方法（运维侧）

### 4.1 一秒判断当前 session 是否健康
```bash
# 0 条 → 不健康（Bug B 触发）
# ≥1 条 → 健康
grep "agent:before_agent_start ok" .pt/logs/pt-<sessionId>.log

# 或 pt_status 末尾字段
> /pt status
... | pt last built prompt: (未跑过 turn) ← 不健康
... | pt last built prompt: 12450 chars   ← 健康
```

### 4.2 立即自愈（不动代码）
`.pi/settings.json` 加 `au.pt-context`：

```json
{
  "packages": ["../pro/pt"],
  "au": { "pt-context": "ysl" }
}
```

→ `session_start` 的 `fromSettings` 命中，走 registerInject 路径，问题消失（绕开 Bug A + B）。

### 4.3 临时调试技巧
让 LLM 强制拿到 segment：
- `/pt raw` —— 把 segment 落到 `.pt/cache/raws/segment-<ts>.md`，确认内容正确
- `/pt full` —— 把完整 system prompt（基础 + segment）落到 `.pt/cache/fulls/prompt-<ts>.md`
- 注意：`/pt full` 写的是**预期**的 system prompt（基础 + segment），但**实际**发送给 LLM 的 system prompt 取决于 session_start 是否调过 registerInject

## 5. 修复方向

### 5.1 推荐方案：修 `switchProfile`（1 行代码 + 提 helper）

**核心修复**：把 `registerInject` 调用从 `session_start` 末尾提取成 helper，两处复用：

```typescript
// src/index.ts（新增 helper）
function registerInjectionIfReady(pi: ExtensionAPI, ctx: { ui: AgentAPI['ui'] }): boolean {
  if (session.activeAdapter && session.cachedContext && session.cachedBlueprint) {
    session.activeAdapter.registerInject(toAgentAPI(pi, ctx), session.cachedContext, session.cachedBlueprint);
    return true;
  }
  return false;
}
```

**改动 1**：`switchProfile` 内追加（在 `persistProfileToSession` 之前或之后均可）：

```typescript
async function switchProfile(pi, ctx, name) {
  try {
    await transpileActive(ctx.cwd, name, (msg, level) => ctx.ui.notify(msg, level));
    session.loadedFrom = null;
    persistProfileToSession(pi, name);

    // FIX: 切换成功后必须重新注册 before_agent_start 钩子
    const injected = registerInjectionIfReady(pi, ctx);
    slog("info", "command:switchProfile inject", { profileName: name, injected });

    ctx.ui.setStatus("pt", `pt: ${name}`);
    const hint = session.lastCacheHit ? "（缓存命中）" : "（已重编译）";
    ctx.ui.notify(`已切换到 ${name}，下一轮生效 ${hint}`, "info");
    slog("info", "command:switchProfile done", { profileName: name, cacheHit: session.lastCacheHit });
  } catch (e) { ... }
}
```

**改动 2**：`session_start` 内联那段也用 helper 替换（行为不变，去重）：

```typescript
// src/index.ts:215-220 替换为
await transpileActive(ctx.cwd, picked, (msg, level) => ctx.ui.notify(msg, level));
session.loadedFrom = pickedFrom;
persistProfileToSession(pi, picked);
registerInjectionIfReady(pi, ctx);  // 去重 + 复用 helper
ctx.ui.setStatus("pt", `pt: ${picked}`);
session.logger.info("session:profile loaded", { profileName: picked, loadedFrom: pickedFrom });
```

**风险**：
- Pi 扩展 `api.on()` 在已注册事件后**追加** handler，不会覆盖——重复调用 `registerInject` 会让每个 turn 跑多次 `before_agent_start`，把 segment 重复追加 N 次。
- **解决方案**：在 `PiAdapter` 内部加幂等 flag：

```typescript
// src/agent/pi-adapter.ts
export class PiAdapter implements AgentAdapter {
  private injected = false;  // 幂等保护

  registerInject(api: AgentAPI, ctx: Context, blueprint: Blueprint): void {
    if (this.injected) {
      api.log?.debug("agent:registerInject skipped (already injected)");
      return;
    }
    this.injected = true;
    // ... 现有 api.on("before_agent_start", ...) 和 api.on("input", ...) 不变
  }
}
```

### 5.2 推荐方案：修 `detectSingleProfile` 排除内建

```typescript
// src/config.ts:68
export async function detectSingleProfile(cwd: string): Promise<string | null> {
  // FIX: auto 探测只看项目 profile，不算内建（内建 pt 是扩展自身的 dev 上下文）
  const project = await listProfileNamesIn(join(cwd, PROFILES_DIR));
  return project.length === 1 ? project[0] : null;
}
```

→ 修完后，项目里恰好 1 个 profile（最常见情况）→ `session_start` auto 路径生效 → 不必走 `/pt-context` 命令 → Bug A 闭环。

### 5.3 不推荐方案

| 方案 | 理由 |
|---|---|
| 改 `transpileActive` 内部调 registerInject | Adapter 是抽象层，不该感知 Pi 的 `api.on`；保持 `setContext` / `registerInject` 分两步的清晰度 |
| 让 `/pt-context` 命令强制刷新整个 process | 太重，丢失 session 状态（用户中途切 profile 的常见诉求） |
| 删除内建 `pt` profile | 内建 profile 是 pt 扩展自身开发用的（`pt profile` 给自己），删掉 pt 自己的 docs/scripts 无法运行 |

### 5.4 测试覆盖（关键缺口）

现有 `tests/verify/persist-profile.test.ts`（13 个）只覆盖：
- `readProfileFromSession` 的 mock 行为
- `SessionState` 字段读写
- `statusText()` 字符串渲染

**没有任何 e2e 测试覆盖「`/pt-context` 切完后下个 turn 的 system prompt 含 segment」**。建议加：

```typescript
// tests/verify/switch-injection.test.ts（新文件）
- 测试 1：mock Adapter，调用 switchProfile 后断言 registerInject 被调一次
- 测试 2：mock 重复调用 switchProfile，断言 registerInject 被调 N 次 + Adapter.injected 幂等生效（不会重复注册 api.on）
- 测试 3：mock session_start auto=null 路径 + 后续 switchProfile，断言 before_agent_start handler 实际跑 + system prompt 含 segment
```

## 6. 验证 / 验收

### 6.1 自动化
```bash
npm run typecheck    # tsc --noEmit，无输出 = 过
npm run verify       # 现有 58 个测试 + 新增 3-5 个 e2e 测试，全过
```

### 6.2 端到端（手动）
按 §4.1 排查方法在修复后跑：

1. `cd /Users/issac/client/yishenglong && pi`（项目里只有 ysl 一个项目 profile + 内建 pt）
2. 期望 footer：`pt: ysl`（**修复前**：`pt: 无 context`）
3. 期望日志：`session:start` → `session:profile loaded { loadedFrom: "auto" }`（**修复前**：`session:no profile picked`）
4. 期望日志：后续每个 turn 前都有 `agent:before_agent_start ok { injectedLen: <systemPrompt>+5121 }`
5. LLM 提问"介绍亿盛隆"——应能基于 ysl context 给出准确介绍（**修复前**：完全不知道）

### 6.3 跨进程回归
- 切回 `pi -c` / `pi --session` / `/resume` / `/fork`：v10.x 已修，确保新修复不破坏 session JSONL 持久化路径
- 切回 `/new`：应清空 profile（新 session，无 pt entry）

## 7. 关联

- **issue: pt-context-persist-lost** —— v10.x 已修 session JSONL 持久化（方案 D），本 issue 是它的**续集**——持久化路径修了，但**手动切换路径**仍漏注册钩子
- **src/index.ts:136** `switchProfile`（缺 registerInject）
- **src/index.ts:217-219** `session_start` registerInject 调用
- **src/config.ts:68** `detectSingleProfile`（包含内建 profile）
- **src/agent/pi-adapter.ts:43-69** `registerInject` 实现 + 缺幂等保护
- **src/render/system-prompt.ts**（被 `setContext` 调，产出 segment）
- **tests/verify/persist-profile.test.ts**（覆盖 v10.x 但未覆盖本 issue）

## 8. 临时方案速查表（提交修复前用户自救用）

| 用户场景 | 临时方案 |
|---|---|
| 项目里有 1 个 profile，要 LLM 拿到上下文 | `.pi/settings.json` 加 `"au": { "pt-context": "<name>" }` |
| 项目里有多个 profile，要切到 X | 同上 + 写明 X |
| 不想动 settings.json，每次手动切 | 接受当前 bug：手动切换后 LLM 拿不到上下文，靠 `/pt full` dump 文件用 read tool 读 segment |
| 跑 deliver-feature 手册 | 必须在 `.pi/settings.json` 配 `au.pt-context`，否则 deliver-feature 无法给 LLM 注入手册所需 Trigger 索引 |

# 修复记录（v11）

## 改动

| 文件 | 修复内容 |
|---|---|
| `src/index.ts` | 提取 `registerInjectionIfReady`，`session_start` 与 `/pt-context` 成功后共用；同一 Pi runtime 复用稳定的 `AgentAPI` wrapper |
| `src/agent/pi-adapter.ts` | `registerInject` 按 `AgentAPI` 幂等；system prompt handler 每次读取最新 `this.segment`；新增 session context reset |
| `src/schema.ts` | `AgentAdapter.registerInject` 支持传入 `domains`；增加可选 `resetInjection` / `onInjected` 契约 |
| `src/config.ts` | auto 探测只统计项目级 Profile，内建 `pt` 仅保留在手动选择/补全列表 |
| `tests/verify/switch-injection.test.ts` | 覆盖首次无 Profile 后手动切换、A→B 动态 segment、重复 handler 防止、session reset、auto 策略 |

## 验证

```bash
npm run typecheck        # 通过
npm run verify           # 6 files / 76 tests passed
```

新增测试直接调用已注册的 `before_agent_start` / `input` handler，验证 A→B 后只出现 B 的 segment，且 handler 数量不增加。

## 备注

`pt last built prompt` 现在通过 `onInjected` 回调在成功执行 handler 后更新；`session_shutdown` 时由 `resetSession` 清空。