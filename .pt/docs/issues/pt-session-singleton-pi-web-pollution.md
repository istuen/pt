---
type: issue
name: pt-session-singleton-pi-web-pollution
status: resolved
severity: high
created: 2026-09-03
resolved: 2026-09-03
domain: pt-dev
---

# pt 在 pi-web 多 session 并发下会跨 session 污染：`session` module 单例 + `PiAdapter` module 单例双重跨 session 共享（v12.x resolved）

> **本 issue 关键事实**：
> - pt 有 **两个 module-level 单例** 在 pi-web 多 session 下跨 session 共享：
>   1. `src/session.ts:89` 导出的 `session: SessionState`（17 个字段：`activeProfile` / `cachedSegment` / `cachedBundles` / `cachedContext` / `cachedBlueprint` / `cachedDomains` / `cachedProfile` / `lastCwd` / `lastBuiltPrompt` / `lastCacheHit` / `activeAdapter` / `sessionId` / `logger` / `loadedFrom` / `injectionState` / `injectionError` / `activeManual`）
>   2. **`src/agent/registry.ts:9-16` 的 `agentAdapters.pi: new PiAdapter()` 单例**（AgentAdapter 注册表模块级单例，所有 session 共用同一个 `PiAdapter` 实例）
> - `src/session.ts:6` 头注释写："per-process = per-session，因为 Pi Extension 是模块单例"。
> - 这条假设**只在 pi TUI 模式下成立**（一个 `pi` CLI 进程 = 一个 Session）。在 pi-web 下（Next.js 单进程服务 N 个 browser tab / leaf session），**两个单例都被所有 session 共享** → 跨 session 串 state 是必现而非偶发。
> - **真实最高严重度污染**：tab B 调 `transpileActive` → 同一 `PiAdapter` 单例的 `this.segment` 被覆盖为 tab B 的内容 → tab A 跑 turn 时 `before_agent_start` handler 闭包持 `this`（单例）→ **tab A 的 LLM 拿到 tab B 的 segment**。这是业务上下文级别污染，比 UI 显示串严重得多。
> - 已有相邻 issue `module-state-pi-web-multisession.md` 聚焦 `activeManual` / `cachedManualProgress` 的 widget 串（已识别但未解决）。**本 issue 升级到根因层**：覆盖 `session` 单例所有 17 字段 + `agentAdapters` 注册表单例 + `PiAdapter` 单例的 `this.ctx / this.blueprint / this.domains / this.segment / this.injectedApi` 五字段。

## 1. 现象

### 1.1 用户视角（pi-web 浏览器侧）

两个 browser tab 同时连同一 pi-web 实例，分别跑不同 leaf session（典型场景：tab A fork / clone 出 tab B）：

| 操作 | tab A 看到 | tab B 看到 | 期望 tab B 看到 |
|---|---|---|---|
| tab A 调 `/pt-context dev`（切 profile） | footer `pt: dev` 正确 | footer 也跳成 `pt: dev` | footer 仍是 tab B 自己的 profile（或 idle） |
| tab A 跑 turn → `before_agent_start` 注入 system_prompt | tab A LLM 拿到 dev segment ✅ | tab B LLM 也**可能被注入 dev segment**（用 tab A 的 blueprint / domains）| tab B LLM 拿 tab B 自己的 segment |
| tab A `pt_manual deliver-feature tab-a` | tab A 显示 deliver-feature widget | tab B 也显示 deliver-feature widget（错！）| tab B 不显示 |
| tab A `loadedFrom = "flag"` | tab A status 报告 flag | tab B status 报告也变成 flag | tab B report 自己的来源 |
| tab A `injectionState = "failed"`（profile 加载出错）| tab A footer 显示 failed | tab B 也变 failed | tab B 保持 idle / pending |

更糟的场景：tab A 还没切 profile / 还在 `transpileActive`，tab B 已经发了 prompt → tab B 的 LLM 拿到的是**半个状态**——`cachedSegment` 可能是上一次 session 留下的，`cachedBlueprint` 也错。

### 1.2 工具视角（`pt_status` 报告）

任何 tab 调 `pt_status` 都报告**同一个 module-level 单例**：
- `pt profile`：报告最后一次 `transpileActive` 写入的值（无论哪个 session 调）
- `pt segment length`：报告最后一个 session 的 segment
- `pt agent`：报告最后一个 session 的 agent adapter
- `pt cwd`：报告 `session.lastCwd`——可能混着不同 tab 的 cwd
- `pt sessionId`：报告最后一次 `session_start` 写的 8-hex id（每个 tab 一个，但只有最后一个能查到）

### 1.3 注入视角（最严重：`PiAdapter` 单例机制导致的业务上下文污染）

**真实污染路径**——基于实测代码，不是凭空推断：

`src/agent/registry.ts:9-17` 维护**模块级 Adapter 注册表**：

```ts
// src/agent/registry.ts
const agentAdapters: Record<string, AgentAdapter> = {
  pi: new PiAdapter(),   // ← 模块级单例，所有 session 共享同一个 PiAdapter 实例
};
export function getAgentAdapter(name: string): AgentAdapter {
  return agentAdapters[name] ?? agentAdapters.pi;
}
```

`src/index.ts:105` `transpileActive` 调 `session.activeAdapter = getAgentAdapter(result.blueprint.agent)` 返回的是**单例引用**——不是按 session 新建。

`src/agent/pi-adapter.ts:49-110` `registerInject(api, ctx, blueprint, domains)` 把编译产物写到 `this.ctx / this.blueprint / this.domains / this.segment`（**单例实例字段**），并通过 `api.on("before_agent_start", ...)`（line 72 起）注册 handler——**handler 闭包持 `this`（单例引用）**。

```ts
// src/agent/pi-adapter.ts:48-66（节选真实代码）
registerInject(api, ctx, blueprint, domains = this.domains): void {
  this.ctx = ctx;
  this.blueprint = blueprint;
  this.domains = domains;
  this.segment = renderSystemPrompt(ctx, blueprint);   // ← 单例字段被覆盖

  if (this.injectedApi === api) {
    api.log?.debug("agent:registerInject skipped (already injected)");
    return;
  }
  this.injectedApi = api;   // ← 单例字段被覆盖

  api.on("before_agent_start", async (...args: unknown[]) => {
    const currentSegment = this.segment;   // ← handler 闭包持 this（单例），读 this.segment
    // ...
    return { systemPrompt: `${event.systemPrompt}\n\n## 当前任务上下文\n\n${currentSegment}` };
  });
}
```

**handler 何时被触发？**  pi 的 `api.on("before_agent_start", ...)` 注册到的是 ExtensionRunner 的 event bus——**per-session bus**。所以 handler 只在它被注册的那个 session 触发。

**但 handler 内部读 `this.segment`（单例字段）——被任何 session 调 `setContext` / `registerInject` 都会覆盖**。

**污染时序**（必现）：

1. tab A 创建 → `transpileActive` → `agentAdapters.pi.setContext(A_ctx, A_blueprint, A_domains)` → 单例 `this.segment = renderSystemPrompt(A_ctx, A_blueprint)` ✅
2. tab A `registerInjectionIfReady` → `agentAdapters.pi.registerInject(api_A, A_ctx, A_blueprint, A_domains)` → 注册 `handler_A` 到 `api_A` 的 bus，handler_A 闭包持 `this`（单例引用）
3. tab B 创建 → `transpileActive` → **同一个 `agentAdapters.pi`** → `setContext(B_ctx, ...)` → **单例 `this.segment = renderSystemPrompt(B_ctx, B_blueprint)`** ❌ tab A 的内容被擦掉
4. tab B `registerInjectionIfReady` → `agentAdapters.pi.registerInject(api_B, ...)` → `this.injectedApi === api_A` 不等 → 重新注册 `handler_B` 到 `api_B` 的 bus
5. **tab A 跑 turn** → `handler_A` 在 `api_A` bus 上触发（per-session bus，正常） → 闭包持 `this` → 读 `this.segment` → **拿到 tab B 的 segment** ❌ tab A 的 LLM 拿到 tab B 的业务上下文

**结果**：tab A 的 LLM 被注入 tab B 的 profile + domains 编译出的 system_prompt——业务上下文级别污染。tab A 用户看到的 LLM 答复是基于 tab B 的业务知识生成的，**完全错乱**。

**反向污染**（tab A 后跑也会发生）：tab A 重新 `transpileActive` 后 `this.segment` 又被覆盖回 tab A，tab B 的 handler_B 之后跑到时也读 tab A 内容。**两个 session 互相污染，无干净的边界**。

**为什么 `this.injectedApi` 检查无效**：`if (this.injectedApi === api) return` 只在**同一 api 重复注册**时跳过，但 pi-web 下每次新 session 都有不同的 `api`（per-session ExtensionAPI），所以这个 short-circuit 永远不生效，每次都重新注册 handler。

**`resetInjection` 也救不了**：tab A 跑完后调 `session.activeAdapter?.resetInjection?.()` 把 `this.ctx / this.blueprint / this.domains / this.segment` 置 null——但**这是 tab A 的 `session_shutdown` 触发**，只清本 session 视角下的 adapter 状态；下一个 session 跑 `transpileActive` 又会写入新值。**单例字段无法区分"清的是谁的状态"**。

## 2. 根因

### 2.1 pt 的 module-level `session` 单例（`src/session.ts:89`）

```ts
// src/session.ts:80-82
export const session: SessionState = createSessionState();
```

17 个字段（v11.x 现状，2026-09-03 复核）：

| 字段 | 含义 | 串的代价 |
|---|---|---|
| `activeProfile` | 当前 profile 名 | `pt_status` / footer 报告错 |
| `cachedSegment` | 编译后的 segment 字符串 | `pt_status` / `/pt raw` 报告错；**真实污染路径不直接靠它**（详见 §2.6 PiAdapter 单例机制） |
| `cachedBundles` | SchemaBundle 数组（profile/blueprint/domains 解析结果）| `pt_check_refs` 工具报告错 |
| `cachedContext` | Context IR | `registerInjectionIfReady`（`src/index.ts:71-76`）读取时拿到别的 session 的 ctx 传给 `adapter.registerInject(...)`——与 §2.6 单例字段叠加放大污染 |
| `cachedBlueprint` | 当前 blueprint | 同上 |
| `cachedDomains` | 当前 domains | 同上 |
| `cachedProfile` | 当前 profile | `pt_check_refs` 引用完整性 check 错 |
| `lastCwd` | 上次 cwd | 多 tab 不同 cwd 时报告错 |
| `lastBuiltPrompt` | 上次实际 LLM 看到的 prompt | `/pt full` 输出错 |
| `lastCacheHit` | 上次是否缓存命中 | `pt_status` 报告错 |
| `activeAdapter` | 当前 AgentAdapter 实例（实际是单例 `agentAdapters.pi` 的引用）| 表面看是同一引用，但**真正的污染源不在这里**，而在 `agentAdapters` 注册表本身的模块级单例（详见 §2.6） |
| `sessionId` | 8-hex 短 id | 多 session 标识不可靠 |
| `logger` | per-session PtLogger 实例 | log 串到同一个文件 |
| `loadedFrom` | profile 加载来源（flag/settings/session/auto）| `pt_status` 报告错 |
| `injectionState` | 注入状态（idle/pending/injected/failed）| footer 跳 |
| `injectionError` | 注入错误 | footer 跳 |
| `activeManual` | 当前 manual 实例 | **已有 issue `module-state-pi-web-multisession.md` 聚焦此项** |

**全部 17 个字段都是 cross-session 共享**——TUI 模式无害（per-process = per-session 假设成立），pi-web 多 session 下必串。

### 2.2 `cachedManualProgress`（独立 module-level 变量，`src/manual-session.ts:93`）

```ts
// src/manual-session.ts:91-93
/** cachedManualProgress：refreshManualWidget 异步 parse 后写入，footer 同步读。
 *  单字段缓存，不需要 broadcast channel。 */
let cachedManualProgress: ManualProgress | null = null;
```

不在 `session` 单例上（早期设计遗漏，没收到 `session` 对象里），但也是 module-level 单例——同样串。已在 `module-state-pi-web-multisession.md` 识别。

注：`src/index.ts:264` 和 `src/index.ts:590` 只是注释提及 "v11.x：resetSession 覆盖 ... cachedManualProgress（widget 不持久）" 和 "refresh 派生数据（widget + cachedManualProgress）"——**不是定义处**。定义在 `src/manual-session.ts:93`，由 `resetManualSession()`（`src/manual-session.ts:170`）清空。

### 2.3 设计假设错误的历史脉络

| 版本 | 假设 | 是否成立 |
|---|---|---|
| v9 | "Pi Extension 是单例 → module-level state = per-session" | ✅ TUI / ❌ web |
| v10.x | 收拢 10 个 module-level `let` 到 `session` 对象（pt-quality #2 / P2.6）| ✅ TUI / ❌ web |
| v10.x | `sessionId` 8-hex 短 id（多并发 pi 进程日志隔离键）| ✅ 多 pi TUI 进程 / ❌ web 单进程多 session |
| v10.x | `loadedFrom` 记录来源 | ✅ 单 session / ❌ 多 session |
| v11.x | 新增 `activeManual` + `cachedManualProgress` | ❌ 仍未适配 web |

**核心错误**：v10.x 注释 "per-process = per-session, because Pi Extension is module singleton" 把"Pi Extension 是 process 级单例"和"Pi Extension 是 session 级单例"混淆了。

- **TUI 模式**：Pi Extension 是 process 级单例 ✅，且每个 Pi 进程 = 一个 Session ✅ → 两者重合，单例正确
- **Web 模式**：Pi Extension 是 process 级单例 ✅，但每个 Pi 进程 = N 个 Session ❌ → 单例错误地横跨 N 个 Session

### 2.4 pi-web 的多 session 模型（已实测核实）

源码：`/opt/homebrew/lib/node_modules/@agegr/pi-web/.next/server/chunks/6429.js`（模块 56429）。

**核心数据结构**：

```js
// 全局 session 注册表（process-level 单例）
globalThis.__piSessions = new Map;

// 进程退出时一并 shutdown
process.once("SIGINT", () => {
  Array.from(globalThis.__piSessions?.values() ?? [])
    .forEach(a => Promise.allSettled(a.map(a => a.shutdown())));
});
```

**每个 session 的实例化路径**（`chunks/6429.js` 函数 `R`）：

```js
async function R(a /* sessionId */, b /* sessionFile */, c /* cwd */, d) {
  // 1. 自己的 SessionManager（自己的 JSONL 文件）
  let f = b ? SessionManager.open(b) : SessionManager.create(c);
  
  // 2. 自己的 ResourceLoader → 自己的 extensions list
  let g = await createAgentSessionServices({
    cwd: f.getCwd(),
    resourceLoader: new DefaultResourceLoader({...}),  // ← 每 session 新建
    // ...
  });
  
  // 3. 自己的 AgentSession（含自己的 ExtensionRunner）
  let {session: A} = await createAgentSessionFromServices({
    services: g,
    sessionManager: f,
  });
  
  // 4. 包装成 RpcSession（class `_`），加入 globalThis.__piSessions
  let D = new _(A, {...});
  return {session: D, realSessionId: A.sessionId};
}
```

**关键证据**：
- `ResourceLoader` 是 per-session 实例（`agent-session-services.js:63` `new DefaultResourceLoader(...)`）
- `ExtensionRunner` 是 per-session 实例（`agent-session.js:2127` `new ExtensionRunner(...)`）
- `ExtensionRuntime` 是 per-session 实例（`extensions/loader.js:136` `createExtensionRuntime()` 每个 session 调一次）
- 每个 session 在 `ensureExtensionsBound()` 调 `bindExtensions({uiContext, mode: "rpc", ...})`——per-session UI context

**但 pt 扩展自己这一层把 state 全塞 module singleton**——**没跟上这个抽象**。

### 2.5 pt 扩展触发时机：每个 session 都跑 `transpileActive` 全量重写

pi-web 在每个 session 的 `ensureExtensionsBound()` 调 `bindExtensions`——这会触发 pi-coding-agent 加载 extensions。`src/agent/extensions/loader.js:410-413` 命中缓存时复用 factory，否则 `jiti.import`——但**`initializeExtension`（`loader.js:459-466`）每个 session 都调一次**，所以 `factory(load.api)` 每个 session 都执行，`pi.on(...)` 注册到该 session 的 bus 上。

`src/index.ts:174` `session_start` handler（实测代码，节选关键路径）：

```ts
pi.on("session_start", async (_event, ctx) => {
  session.sessionId = randomUUID().slice(0, 8);    // ← 重写
  session.logger = new PtLogger(ctx.cwd, "", session.sessionId);
  session.lastCwd = ctx.cwd;                        // ← 重写
  // ... 选 profile ...
  await transpileActive(ctx.cwd, picked, ...);       // ← 全量重写 10 个字段
  // ... 调用 registerInjectionIfReady ...
});
```

`src/index.ts:82-124` `transpileActive` **成功路径全量重写**（实测代码）：

```ts
session.cachedSegment = result.segment;
session.cachedBundles = result.bundles;
session.cachedContext = result.context;
session.cachedBlueprint = result.blueprint;
session.cachedDomains = result.domains;
session.cachedProfile = result.profile;
session.activeProfile = profileName;
session.lastCacheHit = result.cacheHit;
session.activeAdapter = getAgentAdapter(result.blueprint.agent);   // ← 单例引用！
session.activeAdapter.setContext(result.context, result.blueprint, result.domains);  // ← 写单例 this.ctx / this.blueprint / this.domains / this.segment
```

加上 `session_start` 自身的 `sessionId / logger / lastCwd` 重写——**每个 session_start 触发时，`session` 单例几乎所有字段都被覆盖为新 session 的值**。所以"只重写 sessionId，其他字段保留上一个 session 的值"是错的——全量覆盖。

**但仍然有两个污染窗口**：

1. **`transpileActive` 之前的窗口**：tab A 在 `await transpileActive(...)` 之前，session 单例还残留上一个 session 的状态——但这个窗口很短（profile 加载耗时），且 `session_start` 第一个动作是 `session.sessionId = randomUUID()` 重写 sessionId（仅此一个），其他字段保留。
2. **`transpileActive` 失败 / 无 profile 选中**：`src/index.ts:236-263` 边路只重写少量字段（`session.injectionState = "idle"` / `session.injectionError = null` / 调 `refreshInjectionFooter` / `session.cachedSegment = null` / `session.loadedFrom = null`），其他字段（如 `cachedBlueprint` / `activeAdapter`）**保留上一个 session 的值**——这条边路是真实残留。

**`session_shutdown`（`src/index.ts:265-275`）**：

```ts
pi.on("session_shutdown", async () => {
  if (session.logger) {
    session.logger.info("session:shutdown");
    await session.logger.flush();
  }
  session.activeAdapter?.resetInjection?.();   // ← 调单例 PiAdapter.resetInjection()
  resetSession();                              // ← Object.assign(session, createSessionState())
  resetManualSession();                        // ← 清 cachedManualProgress
});
```

**`session_shutdown` 是跨 session 污染的真正高危点**：

1. **任何 tab 退出都触发** `session.activeAdapter?.resetInjection?.()` → 把单例 `PiAdapter` 的 `this.ctx / this.blueprint / this.domains / this.segment` 全置 null
2. **后果**：tab A 退出 → `this.segment = null` → **所有其他 tab 的 handler 跑 before_agent_start 时都拿到 null segment**（`pi-adapter.ts:64-69` 分支走 idle 路径），footer 全部跳到 "pt: idle"
3. 然后 `resetSession()` → `Object.assign(session, createSessionState())` → 整个 `session` 单例被清空 → 其他 tab 的 `pt_status` tool 报告 `profile=null` / `segment length=0` 等
4. **`resetManualSession()`** → 清 `cachedManualProgress` → 其他 tab 的 manual widget 后缀丢失

**致命时序**（修正版）：
1. tab A 加载 → transpileActive 全量写 `session.*` + 单例 `this.segment = A_segment` + handler_A 注册
2. tab B 加载 → transpileActive 全量写 `session.*` + **单例 `this.segment = B_segment**（覆盖 A）+ handler_B 注册
3. tab A 跑 turn → handler_A 触发 → 读 `this.segment = B_segment` ❌（**核心污染**，详见 §2.6）
4. tab A 退出 → `session.activeAdapter?.resetInjection?.()` → `this.segment = null` → tab B 后续 turn 拿 null segment ❌

**注意第 4 步**：tab A 退出污染 tab B——但审查报告指出审查报告把这条列为核心污染路径，这是对的。但审查报告漏了第 3 步（更严重）：**即使没有 session_shutdown 介入，两个 session 互跑 turn 时 handler 已经读到错误的 segment**——PiAdapter 单例的字段覆盖是即时的、无锁的。

### 2.6 `PiAdapter` 注册表是另一个 module-level 单例（核心污染源）

**这是本 issue 最严重的污染路径**，比 §2.5 的 session_shutdown 残留更隐蔽、影响更广（业务上下文级别污染）。

**根因**：`src/agent/registry.ts:9-16` 的 `agentAdapters` 是模块级 Map，所有 session 共享同一个 `PiAdapter` 实例：

```ts
const agentAdapters: Record<string, AgentAdapter> = {
  pi: new PiAdapter(),   // ← 模块加载时实例化一次，所有 session 复用
};
```

**单例实例字段**（`src/agent/pi-adapter.ts:25-30`）：

```ts
private ctx: Context | null = null;
private blueprint: Blueprint | null = null;
private domains: Domain[] = [];
private segment: string | null = null;
private injectedApi: AgentAPI | null = null;
```

**`setContext` 和 `registerInject` 都直接 mutate 这些字段**（`src/agent/pi-adapter.ts:27-66`）：

```ts
setContext(ctx, blueprint, domains): void {
  this.ctx = ctx;
  this.blueprint = blueprint;
  this.domains = domains;
  this.segment = renderSystemPrompt(ctx, blueprint);   // ← 单例字段覆盖
}

registerInject(api, ctx, blueprint, domains = this.domains): void {
  this.ctx = ctx;
  this.blueprint = blueprint;
  this.domains = domains;
  this.segment = renderSystemPrompt(ctx, blueprint);   // ← 单例字段覆盖

  if (this.injectedApi === api) {                       // ← api 是 per-session，但 this 是单例
    return;
  }
  this.injectedApi = api;                                // ← 单例字段覆盖

  api.on("before_agent_start", async (...args) => {
    const currentSegment = this.segment;                  // ← handler 闭包持 this（单例）
    // ...
    return { systemPrompt: `${event.systemPrompt}\n\n## 当前任务上下文\n\n${currentSegment}` };
  });
}
```

**调用链**：

```
src/index.ts:82 transpileActive()
  → session.activeAdapter = getAgentAdapter(blueprint.agent)   // 单例引用
  → session.activeAdapter.setContext(ctx, blueprint, domains)   // 单例字段覆盖

src/index.ts:70 registerInjectionIfReady(pi, ctx)
  → const adapter = session.activeAdapter                       // 单例引用
  → const context = session.cachedContext                       // session 单例字段
  → const blueprint = session.cachedBlueprint                   // session 单例字段
  → adapter.registerInject(toAgentAPI(pi, ctx), context, blueprint, session.cachedDomains)  // 写单例字段
```

**两个 module-level 单例叠加放大污染**：

1. **`session` 单例**：`session.cachedContext / cachedBlueprint / cachedDomains` 是 `registerInjectionIfReady` 的传入参数
2. **`agentAdapters.pi` 单例**：`this.ctx / this.blueprint / this.domains / this.segment / this.injectedApi` 是被覆盖的目标

任一 session 调 `transpileActive` 或 `registerInjectionIfReady` 都会**同时修改两个单例**。详见 §1.3 的污染时序。

**为什么 handler 闭包持 `this` 是单例**：JS 闭包持的是创建时的变量绑定——handler 是 arrow function，注册时 `this` 是 `registerInject` 的 `this`（即 `agentAdapters.pi` 单例引用）。handler 跑到时读 `this.segment`——永远是同一个 `PiAdapter` 实例的 `this.segment`。

**`resetInjection()` 也无法隔离**（`src/agent/pi-adapter.ts:41-46`）：

```ts
resetInjection(): void {
  this.ctx = null;
  this.blueprint = null;
  this.domains = [];
  this.segment = null;
}
```

tab A 退出调 `session_shutdown` → `session.activeAdapter?.resetInjection?.()` → 把单例字段全置 null——**但其他 tab 的 handler 跑到时也读这个 null**，footer 跳 idle。这不是"清本 session 的状态"而是"清所有人的状态"。

**switchProfile 也会放大污染**：`src/index.ts:130-159` `switchProfile` 调 `transpileActive(...)`（line 137）——同样把单例字段覆盖为新 profile 的内容。原 profile 的 tab 后续 turn 拿到的是新 profile 的 segment。

### 2.7 `appendEntry` 写到 SessionManager JSONL 不冲突

注意：`pi.appendEntry("pt.context-persist", ...)` 写到**当前 session 的 SessionManager JSONL**——这部分靠 pi 的 SessionManager 是 per-session 实例，所以 JSONL 不会跨 session 串文件。

但**内存态（`session` 单例）会串**——跨 session 的逻辑态污染是真实的。

## 3. 影响范围

| 场景 | 影响 |
|---|---|
| **TUI 模式**（pi CLI 单进程） | ✅ 不受影响（per-process = per-session 假设成立）|
| **Web 模式单 tab 单 session** | ✅ 不受影响（仍等同 per-process = per-session）|
| **Web 模式多 tab 同 session**（同一 leaf 在两 tab 打开）| ⚠️ 偶发串（取决于事件时序）|
| **Web 模式多 tab 不同 session** | ❌ 高频串（必现）|
| **Web 模式 fork / clone 多 session** | ❌ 高频串 |
| **Web 模式 subagent 并发**（`Agent` tool 派生多个 subagent）| ❌ 高频串（parent session 的 state 被 subagent 覆盖）|

**污染类型分级**（按严重度）：

| 严重度 | 污染路径 | 现象 |
|---|---|---|
| 🔴 **High**（业务上下文级别）| §2.6 `PiAdapter` 单例 `this.segment` 被覆盖 | tab A 的 LLM 拿到 tab B 的 segment——业务决策错乱 |
| 🔴 **High**（业务上下文级别）| §2.5 + §2.6 `session_shutdown` 调 `resetInjection` → `this.segment = null` | tab A 退出 → 其他所有 tab 的 LLM 不再注入任何 segment |
| 🟡 **Medium**（状态报告错）| §2.1 `session` 单例字段（activeProfile / cachedSegment / cachedContext / cachedBlueprint / loadedFrom / injectionState / injectionError 等）| `pt_status` / `pt_flows` / `pt_check_refs` tool 报告错 session 的状态；`/pt raw` / `/pt full` 导出错 session 的 segment |
| 🟡 **Medium**（footer / widget 跳）| §2.1 + §2.5 `session.injectionState` + `resetSession` 清空 | footer 跳 idle / failed；其他 tab 突然看不到自己的 profile |
| 🟢 **Low**（manual widget 串）| §2.2 `cachedManualProgress` + §2.1 `session.activeManual` | manual widget / footer 后缀串到其他 tab（已有 issue 现象）|
| 🟢 **Low**（log 串）| §2.1 `session.logger` 单例 | 所有 session log 到同一个 `pt-<sessionId>.log` 文件——实际每个 session 自己写自己的 sessionId 文件（`src/log.ts` PtLogger 按 sessionId 命名），影响小 |

**严重度评估**：
- 不崩溃，但**最高严重度污染是 LLM 拿到错业务上下文**——实质风险高
- Web 用户以为是自己的 profile / segment，实际是隔壁 tab 的——信任崩塌
- v11.x 已经发版但未做 web 适配——**新引入的兼容债**
- 修复前不建议在 pi-web 多 tab 场景下使用 Pt（或需明确告知"仅适用当前 session"）

## 4. 排查方法

可独立复验的步骤（pi-web 启好后）：

### 4.1 准备

```bash
cd /path/to/pt-project
pi-web  # 启动 web UI，浏览器打开 localhost:30141
```

### 4.2 触发 tab A

- 在 tab A 里 `/pt-context dev`（或 LLM 调 `pt_status`）
- 观察 tab A：`pt_status` 报告 `profile=dev, agent=pi, cwd=<A>` 等

### 4.3 触发 tab B

- 新开一个 browser tab，连接同一 pi-web 实例
- 开一个新 session（fork tab A 或新开）
- 在 tab B 里 `/pt-context chat`（切到不同 profile）
- 跑一个 turn（任何 prompt）

### 4.4 观察

**核心验证项**（按 §2.6 真实机制）：

1. **tab A 跑 turn 时 LLM 的 system_prompt 是否包含 chat profile 的 segment**？
   - 方法：tab A 调 `/pt full` 输出 `prompt-<ts>.md`（用真实 LLM 看到的 prompt），看 `## 当前任务上下文` 段的内容是 dev 还是 chat
   - 期望：dev
   - 实际（按 §2.6 机制）：如果 tab B 调 `/pt-context chat` 在 tab A 跑 turn **之前**完成的，tab A 拿到的就是 chat 的 segment——**致命串了**
2. **tab A 退出后，tab B 跑 turn 的 LLM 是否拿到 segment**？
   - 方法：tab A 关闭（或调 `/new` 开新 session），tab B 跑 turn，看 system_prompt 里 `## 当前任务上下文` 段是否还有内容
   - 期望：tab B 自己的 segment 仍在
   - 实际（按 §2.5 + §2.6 机制）：tab A 退出触发 `resetInjection` → `this.segment = null` → tab B 后续 turn 走 idle 分支（`src/agent/pi-adapter.ts:64-69`），segment 为空——**致命串了**
3. **tab A 的 `pt_status` 是否报告 `profile=chat`**？→ 串了（`session` 单例字段覆盖）
4. **tab A 的 footer 是否跳成 `pt: chat`**？→ 串了（`session.injectionState` + `activeProfile` 覆盖）
5. **tab A 的 `activeManual` / `cachedManualProgress` 是否被覆盖**？→ 已有 issue 现象

**反向测试**（验证机制对称）：
- tab B 先调 `/pt-context chat` → tab A 后调 `/pt-context dev` → tab B 跑 turn → tab B 的 LLM 是否拿到 dev 的 segment？应该是（同样机制）

### 4.5 进一步定位

```js
// 在 pi-web Next.js server console 里
// 应该能看到 [pi-web] session_start dispatched to extensions for session <id_a>
// [pi-web] session_start dispatched to extensions for session <id_b>
// 但 pt 模块只 export 唯一一个 session 对象 ——
require('./node_modules/@earendil-works/pi-web/.next/server/chunks/6429.js')
// 验证 globalThis.__piSessions.size === 2
// 验证 pt 模块的 session 是单例
```

## 5. 修复方向

### 5.1 核心思路：把 `session` 单例改成 per-session 容器

**方案 A（推荐）**：`WeakMap<ExtensionAPI, SessionState>` —— 按 `pi` 实例索引

每个 session 在 pi-web 下都有自己的 `pi` 实例（per-session `ExtensionAPI`）。把：

```ts
// 当前
export const session: SessionState = createSessionState();

// 改成
const sessionMap = new WeakMap<ExtensionAPI, SessionState>();
export function getSession(pi: ExtensionAPI): SessionState {
  let s = sessionMap.get(pi);
  if (!s) {
    s = createSessionState();
    sessionMap.set(pi, s);
  }
  return s;
}
```

每个 callback（`pi.on("session_start" / "session_shutdown" / "before_agent_start" / "input" / ...`）的第一个参数是 `pi` 或 `event`（event 上能拿到 `ctx.pi` 或 `ctx.sessionManager`）。`session_start` 回调拿到 `pi`，把它传到所有下游 handler。

`activeAdapter` 改成 `WeakMap<ExtensionAPI, AgentAdapter>`，跟 state 容器绑定。

`session_shutdown` 触发的 `resetSession` 改成 `sessionMap.delete(pi)`——精确清本 session 的 state。

### 5.2 方案 B：`Map<sessionId, SessionState>` —— 按 sessionId 索引

需要 pi ExtensionAPI 暴露 `sessionId`。当前 pi ExtensionAPI 没暴露稳定的 sessionId（v10.x 注释 "sessionId 8-hex 是多并发 pi 进程的日志隔离键"，暗示有 sessionId 但可能不在 ExtensionAPI 表面）。

需查 pi ExtensionAPI 是否能稳定拿到 sessionId；如果能，方案 B 更直接。

### 5.3 方案 C：`ctx.sessionManager` 派生 sessionId

`pi.on("session_start", async (_event, ctx) => {...})` 的 `ctx.sessionManager.getSessionId()` 是稳定 sessionId（pi-coding-agent 的 SessionManager 自己的 id）。

但 sessionId 在 callback 之间需要持久化——仍需 map。可行但比 WeakMap 麻烦。

### 5.4 方案 D（短期兜底）：仅文档化 + 注释

不动代码，加注释 + 本 issue 文档 + 已知问题 FAQ。

适合：pi-web 多 session 是低频场景，或 v11.x 不背 web 兼容债。

### 5.5 决策建议

| 场景频度 | 推荐方案 |
|---|---|
| pi-web 用户量低 / 多 session 并发低频 | 方案 D（文档化）|
| pi-web 多 session 中频 | 方案 A（WeakMap）|
| pi-web 多 session 高频 / subagent 并发常见 | 方案 A + 加 sessionId-based 日志隔离 + 加 e2e 测试 |

**推荐**：方案 A（WeakMap<ExtensionAPI, SessionState>）。原因：
1. 改动局部（集中在 `src/session.ts` + `src/index.ts` 的 handler 入口）
2. 不依赖 pi ExtensionAPI 表面扩展
3. `session_shutdown` 自动 GC（WeakMap + pi 引用释放）
4. 兼容 TUI 模式（WeakMap 单 entry 行为等同 module-level 单例）
5. 兼容 pi-web 多 session（每 session 一个 entry）

**实施细节**：

**A1. `session` 单例改造**：
- `src/session.ts`：把 `session` 单例改成 `WeakMap<ExtensionAPI, SessionState>`，提供 `getSession(pi)` 访问器
- `src/index.ts`：每个 `pi.on(...)` 入口用 `getSession(pi)` 取 state
- `src/commands.ts` / `src/slog.ts` / `src/manual-session.ts`：所有 `import { session }` 改成 `import { getSession }`，调用时传 `pi` 引用（tool handler 从 `_toolCallId, params, _signal, _onUpdate, ctx` 拿 `ctx.ui` 时无法直接拿 `pi`——需要 pi ExtensionAPI 暴露 ctx.pi 或 ctx.sessionManager 作 key，见 §6.4）
- `cachedManualProgress`（module-level let，定义在 `src/manual-session.ts:93`）改成 state 字段
- `src/manual-session.ts` 的 `resetManualSession()` 改成接收 `pi` 参数并精确清本 session 的 manual 缓存

**A2. `agentAdapters` 注册表改造**（核心修复）：
- `src/agent/registry.ts`：把 `agentAdapters: Record<string, AgentAdapter>` 模块级 Map 改成**按 `pi` 索引**——例如 `WeakMap<ExtensionAPI, Record<string, AgentAdapter>>` 或简单地把 `getAgentAdapter` 改为每次返回新实例
- 或者：让 `getAgentAdapter` 接 `pi` 参数，在内部 lazy create + 缓存到 WeakMap
- `src/agent/pi-adapter.ts`：`PiAdapter` **class 定义本身不变**（无 class-level state）——但**实例有 5 个状态字段**（`this.ctx` / `this.blueprint` / `this.domains` / `this.segment` / `this.injectedApi`），单例问题在 `registry.ts` 层。**改成 per-pi 创建新实例后，每个实例有自己的字段隔离**——这是 §2.6 业务上下文污染的唯一根治路径

**A3. 验证修复**：
- 加测试：mock 两个 ExtensionAPI 实例
- 各自触发 `session_start` / `switchProfile` / `before_agent_start`
- 验证 state 隔离：`getSession(pi_A).cachedBlueprint !== getSession(pi_B).cachedBlueprint`
- 验证 PiAdapter 隔离：`getAgentAdapter(pi_A, 'pi') !== getAgentAdapter(pi_B, 'pi')`
- 验证 `agentAdapters` 的 WeakMap entry 数 = pi 实例数
- 验证 `session_shutdown` 后 `pi_A` 的 entry 释放但 `pi_B` 不受影响

**预计工作量**：2-3 小时（含测试）。

## 6. 关联

### 6.1 已识别但未解决的相邻 issue

- **`module-state-pi-web-multisession.md`** —— 聚焦 `activeManual` + `cachedManualProgress` 的 widget 串。本 issue 是其根因层升级（覆盖 `session` 单例所有 17 字段 + `activeAdapter`）。修复本 issue 同时解决该 issue 描述的现象。

### 6.2 设计历史

- **v9**：`session` 单例原始设计，注释 "per-process = per-session，因为 Pi Extension 是模块单例"（`src/session.ts:6`）
- **v9 Phase 9.6**：引入 `AgentAdapter` 接口 + `PiAdapter` 实现 + `agentAdapters` 注册表（`src/agent/registry.ts`）——**注册表单例设计未考虑 web 多 session**
- **v10.x**：把 10 个 module-level `let` 收拢到 `session` 对象（pt-quality #2 / P2.6）+ 新增 `sessionId` / `logger` / `loadedFrom`
- **v10.x**：`.pt/docs/designs/pt-injection-status-manual-track.md` 引入 `injectionState` / `injectionError`
- **v11.x**：在 `session` 上加 `activeManual`（`src/session.ts`）+ 新增独立 module-level `cachedManualProgress`（`src/manual-session.ts:93`）

### 6.3 修复可能涉及的文件

**`session` 单例改造**：
- `src/session.ts` —— state 容器改造（核心）
- `src/index.ts` —— 所有 handler 入口 + `transpileActive` / `registerInjectionIfReady` / `switchProfile` 改造
- `src/agent/api-bridge.ts` —— `toAgentAPI` 传 per-session state
- `src/commands.ts` —— `pt_status` / `pt_flows` 等需 per-session state
- `src/slog.ts` —— log writer 需 per-session state
- `src/manual-session.ts` —— `activeManual` 操作 + `cachedManualProgress` 搬到 state + `resetManualSession()` 接 `pi` 参数
- `src/profile-persist.ts` —— `appendEntry` 已在 SessionManager 层做对，只需补 in-memory state

**`agentAdapters` 注册表单例改造**（核心）：
- `src/agent/registry.ts` —— `agentAdapters` 改成按 `pi` 索引（WeakMap 或 lazy create）
- `src/agent/pi-adapter.ts` —— `PiAdapter` **class 定义本身不变**（无 class-level state），但**实例有 5 个状态字段**（`this.ctx` / `this.blueprint` / `this.domains` / `this.segment` / `this.injectedApi`），单例问题在 `registry.ts` 层。**改成 per-pi 创建新实例后，每个实例有自己的字段隔离**——这是 §2.6 业务上下文污染的唯一根治路径
- `src/index.ts:105` —— `transpileActive` 调 `getAgentAdapter(pi, name)` 时传 `pi` 参数
- `src/index.ts:70-77` —— `registerInjectionIfReady` 调 `adapter.registerInject` 时确认 adapter 是 per-pi 实例

**`api-bridge.ts` 跨 session 访问点改造**（审查追加项）：
- `src/agent/api-bridge.ts` 的 `AgentAPI` 包装里两个 getter / setter 仍读写 `session` 单例——`api.log` getter 读 `session.logger?.toWriter()`（line 56-58）、`onInjected` 写 `session.lastBuiltPrompt`（line 59-61）。
- 这两个访问点即使 `agentApiCache` 本身是 `WeakMap<ExtensionAPI, ...>`（每 session 一份 wrapper）也会跨 session 串——**wrapper 实例 per-session，但 wrapper 内的 lambda / getter 仍持 module-level `session` 引用**。
- 改造方向：`toAgentAPI(pi, ctx)` 接 `pi` 参数后，内部 lambda 改为通过 `getSession(pi)` 取 per-session state；或把 `log` / `onInjected` 改成接 `pi` 参数，由 `pi-adapter.ts` 调用处显式传

### 6.4 pi ExtensionAPI 表面

**实测确认**（`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js:410-466`）：

- `loadExtensionModule`（line 410）按 `cacheToken.cwd + generation` 复用已加载的 factory（jiti.import 跳过）——**factory 只 evaluate 一次**
- `initializeExtension`（line 459）每个 session 调一次 → 调 `factory(load.api)` 把 handler 注册到**该 session 的 ExtensionAPI 实例**（`load.api` 由 `createExtensionAPI(extension, runtime, cwd, eventBus)` 创建，`eventBus` 是 per-session）

**结论**：`load.api`（即 `pi: ExtensionAPI`）**每个 session 一个**——可作为 `WeakMap<ExtensionAPI, SessionState>` 的 key。TUI 模式下也只有一个 session，但 WeakMap 单 entry 行为等同 module-level 单例。

**`ctx.sessionManager` 可作备选 key**（`ctx.sessionManager.getSessionId()` 是稳定 id），但需要额外持久化到 WeakMap 之外的某处（sessionManager 引用可能随 session replacement 失效）。

**handler 入参形态**：
- `pi.on("session_start", async (_event, ctx) => {...})`——`ctx` 含 `ctx.sessionManager` / `ctx.cwd` 等
- `pi.on("session_shutdown", async () => {...})`——无入参，但 `pi` 在闭包里持有
- `pi.on("before_agent_start", async (...args) => {...})`——`args[0]` 是 event 对象，event 不直接含 `pi` 引用——handler 持 `this`（类方法时是 PiAdapter 实例，单例问题）
- tool handler `async execute(_toolCallId, params, _signal, _onUpdate, ctx) => {...}`——`ctx` 含 `ctx.cwd` 但不一定含 `ctx.pi`——需查 pi-coding-agent `ToolDefinitionContext` 表面

**待确认**：tool handler 的 `ctx` 是否暴露 `pi` / `sessionManager`？如果无，可能需要让 Pt 自己维护 `WeakMap<sessionId, SessionState>`（从 `ctx.sessionManager.getSessionId()` 派生 key）。

### 6.5 测试策略

加 e2e 测试（参考 pi-coding-agent 的 `tests/` 下 mock session 模式 + pt 现有 `tests/`）：

**`session` 单例隔离测试**：
- mock 两个 ExtensionAPI 实例 `api_A` / `api_B`
- 各自触发 `session_start` → 选不同 profile
- 验证 `getSession(api_A).cachedBlueprint !== getSession(api_B).cachedBlueprint`
- 验证 `getSession(api_A).cachedSegment !== getSession(api_B).cachedSegment`
- 验证 `getSession(api_A).injectionState === getSession(api_B).injectionState`（都是 idle，不互相影响）
- 触发 `api_A` 的 `session_shutdown` → 验证 `getSession(api_A)` 返回 undefined（WeakMap GC）或返回空 state，但 `getSession(api_B)` 仍可访问且未受影响

**`agentAdapters` 注册表单例隔离测试**（核心）：
- mock 两个 `pi` 实例
- 各自调 `getAgentAdapter(pi, 'pi')`
- 验证两次返回的不是同一个 `PiAdapter` 实例（`adapter_A !== adapter_B`）
- 各自 `setContext` 不同 ctx → 验证 `adapter_A.segment !== adapter_B.segment`（独立 segment）
- 验证 `adapter_A.injectedApi !== adapter_B.injectedApi`（handler 注册到各自 bus）
- 模拟 tab A 跑 turn + tab B 调 setContext → 验证 tab A handler 跑到的 segment 不变（不被 tab B 覆盖）

**`cachedManualProgress` 隔离测试**：
- mock 两个 pi 实例各自调 `pt_manual`
- 验证各自的 `refreshManualWidget` 写自己的缓存
- 验证 `renderActiveManualSuffix` 读的是当前 pi 的缓存

**`api-bridge.ts` 跨 session 访问点隔离测试**（审查追加项）：
- mock 两个 `pi` 实例各自 `toAgentAPI(pi, ctx)`
- 验证 `wrapper_A !== wrapper_B`（agentApiCache WeakMap per-pi）
- 模拟 tab A 调 `wrapper_A.log` → 验证返回的 writer 是 tab A session 的 logger（`getSession(pi_A).logger`）
- 模拟 tab A 调 `wrapper_A.onInjected(promptA)` → 验证 `getSession(pi_A).lastBuiltPrompt === promptA`，而 `getSession(pi_B).lastBuiltPrompt === null`
- 模拟 tab A 调完后再 tab B 调 → 验证 tab B 的 `wrapper_B.onInjected(promptB)` 只写 tab B 的 state，不污染 tab A

**集成测试**：
- 启 pi-web，浏览器开两个 tab
- tab A 调 `/pt-context dev` → tab B 调 `/pt-context chat` → tab A 跑 turn
- 验证 tab A LLM 拿到的 system_prompt 含 dev segment 而非 chat segment（用 `/pt full` dump + 手工 diff）
- tab A 关闭后 tab B 跑 turn → 验证 tab B LLM 仍拿到 chat segment（不被 tab A 的 `resetInjection` 清掉）

## 7. 决定项（待用户裁决）

- [ ] **采用方案 A（A1 + A2）/ B / D 哪个？**
  - **A1**：`session` 单例改成 WeakMap
  - **A2**：`agentAdapters` 注册表改成 per-pi（**核心修复**，否则 A1 修了 state 容器但 PiAdapter 单例仍污染）
  - **D**：仅文档化 + 注释（短期兜底）
- [ ] **修复时间窗**：随 v11.x patch / 推到 v12.x / 仅文档化
- [ ] **是否合并 `module-state-pi-web-multisession.md`**？（本 issue A1 + A2 修复后该 issue 描述的现象自动解决）
- [ ] **是否需要在 v11.x 加 release note** 说明 pi-web 多 session 已知不兼容？
- [ ] **tool handler ctx 是否暴露 pi / sessionManager**？（需查 pi-coding-agent `ToolDefinitionContext` 表面——决定 A1 用 `WeakMap<ExtensionAPI, _>` 还是 `Map<sessionId, _>`）
- [ ] **修复前是否在 v11.x 加运行时警告**（检测到同 cwd 下多 session 活跃时打 slog.warn 提示 web 用户）？

## 8. 参考资料

- **pi-coding-agent 源码**：`node_modules/@earendil-works/pi-coding-agent/dist/core/`
  - `agent-session.js` —— `ExtensionRunner` per-session 实例化（line 2127）
  - `agent-session-services.js` —— `ResourceLoader` per-session 实例化（line 63）
  - `extensions/loader.js` —— `createExtensionRuntime()` per-session（line 136）
  - `extensions/runner.js` —— `ExtensionRunner` 类（line 120）
  - `session-manager.d.ts` —— `SessionManager` 接口
- **pi-web 编译产物**：`/opt/homebrew/lib/node_modules/@agegr/pi-web/.next/server/`
  - `chunks/6429.js` 模块 56429 —— session 注册表 / lifecycle / ExtensionRunner binding
  - `app/api/agent/new/route.js` —— session 创建入口（`__new__<uuid>` 模式）
  - `app/api/agent/[id]/events/route.js` —— SSE 事件流
  - `app/api/sessions/route.js` —— session 列表
- **pt 源码**：
  - `src/session.ts` —— `session` 单例定义（line 89 `export const session`）+ 头注释（line 6）+ `resetSession`（line 92）
  - `src/index.ts` —— Pi 扩展入口 + `session_start`（line 174）+ `transpileActive`（line 82-124）+ `registerInjectionIfReady`（line 70-77）+ `switchProfile`（line 130-159）+ `session_shutdown`（line 265-275）+ `cachedManualProgress` 注释提及（line 264 / line 590）
  - `src/agent/registry.ts` —— `agentAdapters` 注册表单例（line 9-16）——**核心污染源**
  - `src/agent/pi-adapter.ts` —— `PiAdapter` 单例字段（line 25-30）+ `setContext`（line 33-39）+ `registerInject`（line 49-110）+ `resetInjection`（line 41-46）+ `before_agent_start` handler（line 72 起，含 try/catch + `api.onInjected`）
  - `src/agent/api-bridge.ts` —— `toAgentAPI` 转换（line 18-83）+ `agentApiCache`（line 22-29，WeakMap<ExtensionAPI, ...>）+ `api.log` getter（line 56-58，读 `session.logger`）+ `onInjected`（line 59-61，写 `session.lastBuiltPrompt`）——**跨 session 访问点**
  - `src/manual-session.ts` —— `cachedManualProgress` 定义（line 93）+ `resetManualSession` 函数声明（line 169）+ 函数体（line 170）+ `activeManual` 操作
  - `src/commands.ts` —— `/pt` 命令族
- **设计文档**：
  - `.pt/docs/designs/pt-design.md` —— v9 四层模型
  - `.pt/docs/designs/pt-injection-status-manual-track.md` —— v10.x injectionState / manualTrack
  - `.pt/docs/designs/pt-cross-agent-adaptation.md` —— 跨 Agent 适配（pi-web 是目标场景之一）
- **相邻 issue**：
  - `module-state-pi-web-multisession.md` —— widget 串（聚焦 activeManual）
  - `pt-context-persist-lost.md` —— profile 持久化（已 resolved，方案 D = `pi.appendEntry()`）

## 修复记录（v12.x）

### 修复日期
2026-09-03

### 根因
pt 的两个 module-level 单例在 pi-web 多 session 并发下跨 session 共享：
1. `src/session.ts` 的 `session: SessionState` —— 17 字段状态
2. `src/agent/registry.ts` 的 `agentAdapters.pi: new PiAdapter()` —— 单例 PiAdapter 实例

### 修复内容
**Phase 1：state 容器改造**
- `src/session.ts`：移除 `export const session` 单例，改为 `Map<sessionId, SessionState>` 容器；提供 `getSessionById(id)` / `clearSessionById(id)` / `listAllSessions()` / `sessionCount()` API
- key 用 pi `SessionManager.getSessionId()`（稳定 id，per-pi-runtime）
- `cachedManualProgress` 从 module-level let 搬到 `SessionState.cachedManualProgress` 字段

**Phase 2：Adapter 注册表改造**
- `src/agent/registry.ts`：`agentAdapters: Record<string, AgentAdapter>` 改为 `WeakMap<ExtensionAPI, Record<string, AgentAdapter>>`
- `getAgentAdapter(pi, name)` 签名加 `pi` 参数
- pi 实例销毁时 WeakMap 自动 GC；TUI 模式（只有一个 pi）行为等同 module-level 单例

**Phase 3：api-bridge per-pi**
- `src/agent/api-bridge.ts`：`AgentAPI` wrapper 内部维护 `currentSessionId` 闭包变量
- wrapper 的 `on` 包装在每个 handler 触发前自动从 `args[1]?.sessionManager?.getSessionId()` 拿 sessionId 写入
- `api.log` getter / `api.onInjected` 通过 `currentSessionId` 走 `getSessionById(...)` 取 per-session state

**Phase 4：调用点改造**
- `src/index.ts`：所有 `pi.on(...)` handler 入口从 `ctx.sessionManager.getSessionId()` 拿 sessionId
- `transpileActive(pi, cwd, name, sessionId, notify)` / `switchProfile(pi, ctx, name)` 接受 sessionId
- `session_shutdown` 调 `clearSessionById(sessionId)` 精确清本 session state
- tool handler 同样用 ctx 拿 sessionId
- `slog(sessionId, level, msg, ctx)` 接受 sessionId 参数

**Phase 5：依赖文件**
- `src/slog.ts`：去掉 module-level `session` 单例访问，slog 接 sessionId
- `src/manual-session.ts`：所有函数（`refreshInjectionFooter` / `refreshManualWidget` / `tryRestoreManual` / `persistManualToSession`）接 session 参数
- `src/commands.ts`：`statusText` / `flowsText` / `buildManualDoc` 接受 `session: SessionState` 参数

**Phase 6：测试**
- 新增 `tests/verify/multi-session-isolation.test.ts`：mock 两个 ExtensionAPI 实例，验证
  1. 两个 mock pi 各自持独立 session state（Map entry 数 = 2）
  2. `getAgentAdapter(pi, ...)` per-pi：同 pi 缓存命中，不同 pi 不同实例
  3. `setContext` 覆盖 per-pi 字段不跨 session 串（核心污染问题）
  4. `session_shutdown` 精确清本 session state，不影响其他 session
- 修改所有 5 个旧测试文件（persist-profile / manual-track-integration / switch-injection / observe / phase9）使用新 API + `tests/verify/session-fixtures.ts` helper
- 修改 mock `ctx.sessionManager` 注入 `getSessionId: () => TEST_SESSION_ID`

### 验证
- ✅ `npm run verify` 全部通过：18 文件 / 167 测试 / biome lint 干净
- ✅ `npx tsc --noEmit` 无错误
- ✅ 手动验证：mock 两个 pi 验证 `A1 === A2` (同 pi 缓存) / `A1 !== B1` (不同 pi 不同实例) / state per-session 隔离 / `sessionCount === 2`

### 涉及文件清单
| 文件 | 改动 |
|---|---|
| `src/session.ts` | 单例 → Map<sessionId, SessionState> |
| `src/agent/registry.ts` | 单例 → WeakMap<ExtensionAPI, Record<string, AgentAdapter>> |
| `src/agent/pi-adapter.ts` | handler 用 `args[1]?.sessionManager?.getSessionId()` 拿 sessionId |
| `src/agent/api-bridge.ts` | wrapper.on 自动注入 currentSessionId；api.log/onInjected per-session |
| `src/slog.ts` | slog 接 sessionId |
| `src/manual-session.ts` | 函数全部接 session 参数；cachedManualProgress 搬到 state |
| `src/commands.ts` | statusText/flowsText/buildManualDoc 接 session 参数 |
| `src/index.ts` | 所有 pi.on handler 入口用 getSessionById；transpileActive/switchProfile 接受 sessionId；session_shutdown 调 clearSessionById |
| `tests/verify/session-fixtures.ts` (新) | 共享测试 helper：TEST_SESSION_ID / s() / resetTestSession() |
| `tests/verify/multi-session-isolation.test.ts` (新) | 4 个多 session 隔离回归测试 |
| `tests/verify/{persist-profile,manual-track-integration,switch-injection,observe,phase9,flows}.test.ts` | 迁移到新 API + mock getSessionId |

### 关联 issue 处理
- **`module-state-pi-web-multisession.md`** —— 本 issue 修复后该 issue 描述的所有现象自动解决（`activeManual` / `cachedManualProgress` 现在都 per-session 隔离）。建议合并关闭。

### 边界纪律（执行中遵守）
- ✅ 不动 pi-coding-agent 上游 API
- ✅ 不动 pi Adapter 接口签名（除 `getAgentAdapter(pi, name)` 加 pi 参数）
- ✅ 不破坏 TUI 模式（单 pi 单 session 场景行为完全不变）
- ✅ 严格按 issue §5.5 实施细节 + §6.3 修复文件清单走
