---
type: issue
name: module-state-pi-web-multisession
status: resolved
severity: medium
created: 2025-09-03
resolved: 2026-09-03
resolved-by: pt-session-singleton-pi-web-pollution
domain: pt-dev
---

# pt 模块级 session state 在 pi-web 多 session 并发下会串

## 现象

pi-web 是 Next.js 多 session 架构（同一 Node.js 进程服务多个 browser tab / session）。
当用户在两个 tab 同时打开：

- tab A 调用 `pt_manual deliver-feature tab-a`
- tab B 同时跑别的 session（无关 manual）

期望：tab A 显示 "manual: deliver-feature N/N"，tab B 不显示 manual widget。
实际：tab B 也可能显示 tab A 的 widget；或两 tab footer 互跳（cachedManualProgress 互相覆盖）。

更具体：

- 两个 tab 跑同一项目但不同 leaf session（fork / clone 出来）：widget 错乱最明显
- 两个 tab 跑不同项目（不同 cwd）：appendEntry 写到不同 JSONL 不冲突，但模块级 `session.activeManual` 串了，导致 widget 仍显示错项目的手册

## 根因

pt 的所有可变状态都是 Node.js 模块级单例：

```ts
// src/session.ts:43-49
export const session: SessionState = createSessionState();

// src/index.ts:227
let cachedManualProgress: import("./manual-track.js").ManualProgress | null = null;
```

而这两个全局对象：

- 假设 "per-process = per-session"（`src/session.ts` 头注释："Pi Extension 是模块单例"）
- 设计时只考虑了 TUI 模式（`pi` CLI 单进程 = 单 session）

v10.x 把状态从 10 个模块级 `let` 收拢到 `session` 对象（`src/session.ts`），
v11.x 在 `session` 上加 `activeManual` + 新增 `cachedManualProgress`（`src/index.ts`）。
两版设计都默认单进程单 session，没考虑过 pi-web 的多 session 模型。

**TUI 模式**：✅ 设计正确（per-process = per-session）

**Web 模式**（pi-web Next.js）：❌ 多 browser tab / 多 leaf session 共享同一 Node.js 进程里的同一份 `session` 对象和 `cachedManualProgress` 变量

具体串状态的路径：

1. tab A 的 `before_agent_start` 写 `session.injectionState = "injected"` → 立刻覆盖 tab B 的状态
2. tab A 的 `pt_manual` 写 `session.activeManual = {...}` → 立刻覆盖 tab B 的 activeManual
3. `cachedManualProgress` 被 `refreshManualWidget` 更新 → 立刻覆盖另一 tab 的 footer 后缀
4. `appendEntry` 写到 tab A 的 session JSONL → 这部分不冲突（按 sessionFile 分文件），但 in-memory 状态串

## 影响

- **TUI 模式**：✅ 不受影响（设计正确）
- **Web 模式单 tab 单 session**：✅ 不受影响（仍等同 per-process = per-session）
- **Web 模式多 tab 同 session**（同一个 leaf session 在两 tab 打开）：⚠️ 偶发串（取决于事件时序）
- **Web 模式多 tab 不同 session**：❌ 高频串（必现）

严重度评估：

- 功能不崩溃，只是显示错乱 → 不阻塞 v11.x 发版
- Web 用户看到的状态可能误导（以为在跟踪一个实际不属于自己的 manual）→ 误判风险
- 实际场景下多 session 并发是不是常态？看 pi-web 用户习惯（待观察）

## 排查方法

可独立复验的步骤（pi-web 启好后）：

1. **准备**：
   ```bash
   cd /path/to/pt-project
   pi-web  # 启动 web UI，浏览器打开
   ```

2. **触发 tab A**：
   - 在 tab A 里 `pt_manual deliver-feature tab-a`（用 LLM tool 或 `/pt manual`）
   - 观察：tab A footer 显示 `pt: pt-dev ok · manual: deliver-feature N/N`
   - 观察：tab A editor 上方 widget 显示 tab A 的 manual

3. **触发 tab B**：
   - 新开一个 browser tab，连接同一 pi-web 实例
   - 开一个新 session（fork tab A 的 session 出来，或新开一个）
   - 跑一个 turn（任何 prompt）
   - **观察**：tab B 的 footer 是否串了 "manual: deliver-feature N/N" 字样？
   - **观察**：tab B 的 widget 是否也显示 tab A 的 manual？

4. **期望**：tab B 不应显示 tab A 的 manual
5. **实际**：很可能串了

进一步定位（开 dev tools）：

```js
// 在 pi-web Next.js 的 server side console 里
// 应该能看到多个 [pi-web] session_start dispatched to extensions for session <id>
// 但 pt 模块只 export 唯一一个 session 对象
```

## 修复方向

**核心问题**：pt 状态没有按 sessionId 隔离。

**方案 A（短期兜底）**：issue 文档 + 注释（本次只观察）

- 在 `src/session.ts` 头注释加一行警告："module-level state assumes per-process=per-session; pi-web multi-session may conflict"
- 不动代码，等真实用户反馈决定是否修

**方案 B（中期重构）**：把状态从 module-level 移到 ExtensionAPI per-session

需要 pi-coding-agent 支持 `ctx.sessionId` 或在 `pi.on(...)` 回调里能拿到 sessionFile（当前 `session_start` 回调的 ctx 没暴露 sessionId）。可能的路径：

1. 在 `pi.on("session_start")` 时缓存 `ctx.sessionManager` 提供的 session 标识
2. 按 sessionId 维护 `Map<sessionId, SessionState>`
3. `before_agent_start` 触发时根据当前 sessionId 取对应的 state

需要先验证 pi 扩展 API 是否能稳定拿到 sessionId。如果能，方案 B 是正解。

**方案 C（备选）**：每个 session 独立 setWidget key

利用 `ctx.ui.setWidget` 的 key 隔离性——key 里加 sessionId 前缀（`pt-manual-${sessionId}`）。
但 footer 是 `setStatus("pt", ...)`，key 是固定的，不能按 session 区分。
除非给每个 session 调 `setStatus("pt-${sessionId}", ...)`——但 status 的 key 通常有上限。
所以方案 C 不彻底解决 footer 串。

**观察指标**（决定是否需要修）：

- pi-web 用户量起来后，是否有 "manual widget 显示错乱 / footer 跳" 的反馈
- pi-web 多 session 并发是不是高频场景（看 subagent / fork / clone 使用频率）

如果 0 反馈或场景低频，方案 A 即可（注释 + 文档记录即可）。如果有反馈，上方案 B。

## 关联

- **v10.x 设计**：`src/session.ts` 头注释 "per-process = per-session, because Pi Extension is module singleton"
- **v11.x 设计**：`src/manual-track.ts` + `src/index.ts:227` `cachedManualProgress` 沿用 v10.x 假设
- **pi-web 架构**：`.next/server/app/page.js` + `class _` 每个 session 实例独立 widget/status map，但 pt 这层把状态全塞 module singleton
- **相关 issue**：
  - `manual-switch-no-injection.md`（TUI 模式 single-session 问题，不冲突）
  - `pt-context-persist-lost.md`（profile 持久化问题，不冲突但同属 v10.x 设计假设未适配 web）
- **修复可能涉及**：
  - `src/session.ts`（state 容器改造）
  - `src/index.ts`（`cachedManualProgress` 改造）
  - `src/agent/pi-adapter.ts`（before_agent_start 回调需要 sessionId）
  - pi ExtensionAPI 是否暴露 sessionId（需查 pi 文档）

## 修复记录（v12.x，被 pt-session-singleton-pi-web-pollution 顺手解决）

### 修复日期
2026-09-03

### 解决方式
**本 issue 描述的现象（`activeManual` / `cachedManualProgress` / widget 串）是 `session` module-level 单例污染的子集**。根因 issue `pt-session-singleton-pi-web-pollution` v12.x 修复时已把 `activeManual` 改 per-session 字段（搬到 `SessionState.activeManual`），`cachedManualProgress` 改 per-session 字段（搬到 `SessionState.cachedManualProgress`），整个 `session` 单例改 `Map<sessionId, SessionState>`。所以本 issue 描述的所有 widget 串现象自动消失。

### 验证
- `npm run verify` 全过：18 文件 / 167 测试
- `tests/verify/multi-session-isolation.test.ts` 第 4 个测试明确验证：`session_shutdown` 精确清本 session state，不影响其他 session

### 涉及 commit
随 `pt-session-singleton-pi-web-pollution` v12.x 修复一起提交
