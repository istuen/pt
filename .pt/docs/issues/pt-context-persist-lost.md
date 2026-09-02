---
type: issue
name: pt-context-persist-lost
status: resolved
severity: high
created: 2025-09-02
updated: 2026-09-02
resolved: 2026-09-02
domain: pt-dev
---

> **v2 追加**：见末尾「二次排查（v2）」——实测确认根因（26/26 session 全部丢失）+ 推荐方案 D（`pi.appendEntry()`），优于原 A/B/C。（行号/计数已于 2026-09-02 对源码与最新日志复核修正）
>
> **v3 修复记录**：见末尾「修复记录（v3）」——按方案 D 落地，13 个新增单元测试 + typecheck + 现有 45 个测试全过。`status: resolved`。

# pt-context 选择未持久化，跨进程丢失

## 现象

Session 里已用 `/pt-context pt-dev` 切到 pt-dev（或 pt-chat），footer 显示 `pt: pt-dev`。**重启 pi 进程后**，footer 变 `pt: 无 context`，必须重新手动 `/pt-context pt-dev`。LLM 每次启动拿不到业务上下文。

## 根因

`session` 是模块级单例（`src/session.ts:47` `export const session`），进程内不丢，但**进程退出即失**。`session_start` 每次重新选 Profile，靠三源 fallback：

```
picked = flagVal ?? fromSettings ?? auto
```

| 源 | 代码 | 实际值（本项目） |
|---|---|---|
| flag (`--pt-context`) | `pi.getFlag("pt-context")` | `undefined`（未传 flag） |
| settings (`.pi/settings.json` 的 `au.pt-context`) | `readProjectSetting(ctx.cwd, "au.pt-context")` | `undefined`（settings.json 无此键） |
| auto（唯一 Profile 时返回） | `detectSingleProfile(cwd)` | `null`（项目有 2 个 profile：pt-dev/pt-chat，auto 只在唯一时返回） |

三源全空 → `picked = null` → `ctx.ui.setStatus("pt", "pt: 无 context")`（`src/index.ts:136`）。

## 影响范围

- **用户体验**：每次启动 pi 要手动 `/pt-context <name>`，体验差
- **LLM 上下文丢失**：每次启动 LLM 拿不到业务上下文（Scene axioms + Trigger 索引），退化成无 Pt 状态
- **deliver-feature 自动化受阻**：LLM 调 `pt_flows`/`pt_manual` 时若 session 未激活 Profile，返回"无激活 Profile"错误

## 排查方法

1. 看 pt-logs 的 `session:no profile picked` 条目（`src/index.ts:138` 已 log `{ flagVal, fromSettings, auto }`）——确认三源实际值
2. 确认 `.pi/settings.json` 是否有 `au.pt-context` 键
3. 确认 `.pt/assets/profiles/` profile 数量（>1 时 auto 不返回）

## 立即自愈（用户侧）

`.pi/settings.json` 加 `au.pt-context`：

```json
{
  "packages": [".."],
  "au": { "pt-context": "pt-dev" }
}
```

这样 `fromSettings` 命中，每次启动自动加载 pt-dev。

> **注**：`au.` 是 pt 自定义命名空间前缀（非 pi 规范，见 issue `au-prefix-tech-debt`）。pi 的 `settings.json` 是通用项目配置文件，pt 用 `readProjectSetting(cwd, "au.pt-context")` 读 dotted key。

## 修复方向（v10.x，待排期）

**方案**：pt 把 activeProfile 持久化到 `.pt/active-profile`（或 `.pt/state.json`），`session_start` 加第四源：

```
picked = flagVal ?? fromSettings ?? activeProfileFile ?? auto
```

`/pt-context` 切换时同步写文件。

### 风险

- **多并发 pi 进程写同一文件冲突**——两个 pi 进程同时切 profile，后写覆盖前写。缓解：写时带 pid + timestamp，读时取最近；或只读不写（由用户 `/pt-context` 显式落盘）
- **项目级 vs 用户级**——`.pt/active-profile` 是项目级（入 git？还是 .gitignore？）。若入 git，团队成员共享默认 profile；若 .gitignore，每人自定义。倾向 `.gitignore`（个人偏好不强制团队）

### 备选方案

- **A**：持久化到 `.pt/state.json`（与 cache 同目录，gitignore）
- **B**：持久化到 `.pi/settings.json` 的 `au.pt-context`（用户手动写或 `/pt-context` 自动写回）
- **C**：用 pi 的 `SettingsManager` API（若暴露给 extension）——需查 pi 文档确认

推荐 A（与 pt 资产同根，不污染 pi settings）。

## 关联

- **issue: au-prefix-tech-debt**——`au.` 前缀是历史遗留，该清理成 `pt.` 或直接 `pt-context`
- **.pt/docs/designs/pt-command-tool-dual-registration.md §2.4**——pt-context 不做 tool 的决策依据
- **src/index.ts:118-160**（session_start 加载逻辑）+ **src/session.ts:47**（session 单例）
- **src/config.ts:57**（detectSingleProfile 仅唯一时返回）

---

# 二次排查（v2）：实测确认 + 修复方案 D

> 在原 issue 基础上补：实测数据、Session 与进程关系澄清、官方持久化机制推荐。

## 1. 实测确认根因

### 1.1 日志统计（`.pt/logs/pt-*.log` 全部 26 个 session）

| 指标 | 值 |
|---|---|
| session 文件总数 | **26**（每个一个独立 Pi 进程，文件名 = `pt-<8hex sessionId>.log`） |
| `session:start` 总数 | **26** |
| `session:no profile picked` 总数 | **26**（**100% 命中**——每开一个 pi 进程必然走 fallback 全空分支） |
| 后续手动 `command:switchProfile` 次数 | **12**（约半数，余下半数是用户开进程后没走 pt 流程就退了） |

样例日志（`pt-4ef38947.log`，11:10 启动快照；glossary-test 删除前，见 §1.2 校验注）：

```
{"ts":"...","msg":"session:start","ctx":{"sessionId":"4ef38947"}}
{"ts":"...","msg":"session:no profile picked","ctx":{"sessionId":"4ef38947","auto":null}}
{"ts":"...","msg":"command:switchProfile start","ctx":{"profileName":"pt-dev"}}
```

→ 用户每次 `pi` 命令行调用 → 进程启动 → `session_start` 跑 fallback → 拿到 `null` → 立刻手动 `/pt-context pt-dev`。完全复现。

### 1.2 三源 fallback 的实测值（本项目）

| 源 | 代码 | 实测值 |
|---|---|---|
| flag | `pi.getFlag("pt-context")` | `undefined`（不传 `--pt-context`） |
| settings | `readProjectSetting(ctx.cwd, "au.pt-context")` | `undefined`（`.pi/settings.json` 只有 `{"packages":[".."]}`，无 `au.` 键） |
| auto | `detectSingleProfile(ctx.cwd)` | `null`（`.pt/assets/profiles/` 当前有 `pt-dev`/`pt-chat` 两个，`>1` 时 auto 故意返 null） |

→ 三源全空 → `picked = null` → `ctx.ui.setStatus("pt", "pt: 无 context")`。

> **校验注（2026-09-02）**：`glossary-test.profile.md` 曾存在，已于 commit `4a563ea`（2026-09-02 11:15）删除；样例 `pt-4ef38947`（11:10）跑在其删除前。transpile 日志里的 `profileCount:3` 含 builtin `pt` profile（`src/builtin/assets/profiles/pt.profile.md`），与 `detectSingleProfile` 扫描的 `.pt/assets/profiles/`（当前 2 个）无关——不影响 `auto=null` 结论。

## 2. 触发场景完整版

`session_start` 事件每个触发点都是「**新 Node 进程 = pt 模块单例重置**」。`SessionStartEvent.reason` 共 5 种（`dist/core/extensions/types.d.ts:416`）：

| 场景 | reason | activeProfile 行为 |
|---|---|---|
| 命令行 `pi`（全新 session） | `"startup"` | ❌ 丢失 |
| 命令行 `pi -c`（续最近） | `"resume"` | ❌ **仍然丢失**（session JSONL 持久化，但扩展 module-level 状态不持久化） |
| 命令行 `pi -r`（从列表选） | `"resume"` | ❌ 丢失 |
| 命令行 `pi --session <id>` | `"resume"` | ❌ 丢失 |
| 命令行 `pi --fork <id>` | `"fork"` | ❌ 丢失 |
| TUI `/new` | `"new"` | ❌ 丢失 |
| TUI `/resume` / `/fork` / `/clone` | `"resume"` / `"fork"` | ❌ 丢失 |
| Extension reload（settings 变更） | `"reload"` | ❌ 丢失 |

→ **除了 `--no-session`（ephemeral）模式，Pi 的「Session」≠「进程」。** Session 是 JSONL 文件（`~/.pi/agent/sessions/--<cwd>--/<ts>_<uuid>.jsonl`），跨多次 `pi` 命令行调用；进程是每次命令行调用都新建一个 Node 进程，模块级单例随进程退出清零。

**关键事实**：当前 JSONL 里 pi 自身持久化了 `model_change` / `thinking_level_change` / `pi-web:tool-selection`，但 pt 一条 entry 都没写过——`/pt-context` 只改了 `session.activeProfile` 内存态，没有落盘到 JSONL，所以下次进程启动完全找不到痕迹。

## 3. 关于两个潜在方向

### 3.1 「assets 更新后 cache 会变化」——与本 issue 正交，但需消除误解。**资产更新会导致 cache 失效重编译（这是设计行为），不会导致 profile 丢失。**

机制（`src/render/cache.ts:59` + `src/compile/context.ts:73`）：

```typescript
// loadContext：cache 文件存在但 sourceHash 不匹配 → 返 null → 重编译覆盖
if (cached.sourceHash !== expectedHash) return null;
```

`sourceHash` = `computeSourceHash(profile, blueprint, domains)`（FNV-1a + 长度）。任一变化：

- `.pt/assets/profiles/*.profile.md` 改 → hash 变
- `.pt/assets/blueprints/*.blueprint.md` 改 → hash 变
- `.pt/assets/domains/*.md` 改 → hash 变

→ 下次 `transpileActive` 走 `loadContext` 命中失败 → 重写 `.pt/cache/contexts/<name>.context.md`。日志里 `cacheHit: true/false` 字段就是它（实测：当前 25 个 session 几乎全是 `cacheHit: true`，因为 sourceHash 没变）。

**边界情况（值得记一笔）**：profile 源文件全删 + cache 文件还在 + 重启时 `listProfiles` 不返回它 → 旧 segment 还可能在内存中残留。这是另一类 issue，不在本 issue 范围内。

### 3.2 「Session 跟进程不是 1:1 绑定，Session 内可能切换 pi 进程」——**直觉完全正确**。

Pi 的 Session 模型：

```
~/.pi/agent/sessions/--<cwd>--/<timestamp>_<uuid>.jsonl  ← 同一 JSONL 可被多进程访问
```

本项目实测：
```
/Users/issac/.pi/agent/sessions/--Users-issac-pro-pt--/
  2026-09-02T01-09-17-276Z_01a05fa9-....jsonl  ← 进程 A 写
  2026-09-02T03-10-04-335Z_01a06018-....jsonl  ← 进程 B 续写（pi -c）
```

每次 `pi` 命令行调用 = 新进程；JSONL 文件 = 跨进程共享的 session 真身。**JSONL 持久化的是消息树，不是扩展 module-level 单例。** pt 的 `session.cachedSegment` 等内存态永远不跨进程。

## 4. 推荐方案 D（替代原方案 A/B/C）

### 4.1 原方案问题回顾

| 候选 | 方案 | 短板 |
|---|---|---|
| A | `.pt/state.json`（gitignore） | 多并发 pi 写竞争无锁；gitignore 范围歧义 |
| B | `.pi/settings.json` 的 `au.pt-context` | 污染 pi 命名空间（`au.` 前缀已是 tech debt）；项目级 vs 个人级两难 |
| C | pi 的 `SettingsManager` API | **不可行**——`SettingsManager` 不暴露给 `ExtensionAPI`（查 `dist/core/extensions/types.d.ts:894` `ExtensionAPI` 接口无此方法） |

### 4.2 方案 D：用 Pi 官方 `pi.appendEntry()`

`dist/core/extensions/types.d.ts:968`（`ExtensionAPI` 接口）：

```typescript
/** Append a custom entry to the session for state persistence (not sent to LLM). */
appendEntry<T = unknown>(customType: string, data?: T): void;
```

`docs/extensions.md:1453-1473` 官方示例：

```typescript
pi.appendEntry("my-state", { count: 42 });

pi.on("session_start", async (_event, ctx) => {
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type === "custom" && entry.customType === "my-state") {
      // entry.data 即 { count: 42 }
    }
  }
});
```

注意 `ctx.sessionManager: ReadonlySessionManager` 已在 `ExtensionContext` 里（`types.d.ts:219`），无需另传。

### 4.3 持久化边界（与 Pi Session 语义完美对齐）

| 操作 | activeProfile 保留？ | 合理性 |
|---|---|---|
| `pi -c` / `pi -r` / `pi --session <id>` | ✅ 保留 | 「继续对话」应继承 |
| `/resume` / TUI `/fork` / `/clone` | ✅ 保留（同 JSONL） | 同上 |
| `/new` | ❌ 不保留 | 「开新会话」应隔离 |
| `--no-session`（ephemeral） | ❌ 不持久化 | 用户明确说不留 session |
| 跨项目（不同 cwd） | ❌ 不保留 | 不同项目应隔离 |

→ 正是 pt-context 想要的「per-session profile」语义。

### 4.4 与其他方案对比

| 维度 | A: `.pt/state.json` | B: `.pi/settings.json` | **D: `pi.appendEntry()`** |
|---|---|---|---|
| 跨 `pi -c` 续 session | ✅ | ✅ | ✅ |
| 跨 `/new` 隔离 | ❌ 继承 | ❌ 继承 | ✅ 自动隔离（合理） |
| 跨 `/fork` `/clone` 独立 | ✅ 共享 | ✅ 共享 | ✅ 自动独立（合理） |
| 多并发进程写竞争 | ⚠️ 需自实现锁 | ⚠️ 需自实现锁 | ✅ Pi SessionManager 串行化 |
| Git 友好 | 需 gitignore | 入 git vs 个人级两难 | ✅ 天然不需 git（session 文件独立） |
| 污染 pi 命名空间 | 否 | 污染 `au.` 前缀 | 否（用 `pt:` 命名空间） |
| 与 Pi 规范对齐 | 自创 | 借用但 prefix 错 | ✅ 官方机制 |
| 实施成本 | 新文件 + 文件锁 | 改 settings.json + flush | ✅ 加 3 处改动即可 |

### 4.5 最小改动方案（src/index.ts 三处）

```typescript
// 1) 常量
const PT_PROFILE_ENTRY = "pt:active-profile";

// 2) session_start 加第四源（session JSONL > auto）
pi.on("session_start", async (_event, ctx) => {
  // ... 现有 sessionId/logger 初始化 ...
  const flagVal = ...;
  const fromSettings = ...;
  const auto = ...;

  // NEW：从 session JSONL 读上次保存的 profile
  let fromSession: string | undefined;
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type === "custom" && entry.customType === PT_PROFILE_ENTRY) {
      const data = entry.data as { profile?: string };
      if (data?.profile) fromSession = data.profile;
    }
  }

  // 优先级：flag > settings > session > auto（session 优先于 auto，避免误覆盖用户上次选择）
  const picked = flagVal ?? fromSettings ?? fromSession ?? auto;
  // ... 后续 transpileActive + ui.setStatus 不变 ...
});

// 3) 切换成功后写入 session entry
//    switchProfile 内部 transpileActive 完成后调：
_pi.appendEntry(PT_PROFILE_ENTRY, { profile: name });
//    session_start 自动加载路径也同上：picked 命中后 transpileActive 完成前/后写一次。
```

### 4.6 验证 / 排查

- 重启 pi 进程 → footer 应直接显示 `pt: pt-dev`（不再「无 context」）
- 看 JSONL：`~/.pi/agent/sessions/--<cwd>--/*.jsonl | grep "pt:active-profile"` 应能看到 `{"type":"custom","customType":"pt:active-profile","data":{"profile":"pt-dev"}}`
- 看 pt-logs：`session_start` 后应多一条 `session:profile loaded from session { profile: "pt-dev" }`（建议加 trace）
- `/pt status` 可选加 `loadedFrom: "flag"|"settings"|"session"|"auto"` 字段便于排查

## 5. 方案 D 之外的补充建议

1. **保留 B 方案作为 self-heal 入口**（issue 原方案）：用户首次启动、未手动选过 profile 时仍走 auto/single-profile 探测；settings 路径作为文档告知的「快速自愈」保留。
2. **Trace**：在 `session_start` 命中各源时记一条 info log，便于以后区分「自动恢复」 vs 「用户手动切换」。
3. **可观测性**：`/pt status` 增 `loadedFrom` 字段（flag/settings/session/auto），跟 v10.x 的日志体系对齐。
4. **不要碰 cache 目录结构**：cache 命中/失效与 profile 持久化完全正交，分清两件事。
5. **issue `au-prefix-tech-debt` 优先级**：方案 D 落地后 `au.` 前缀不再被新代码使用，清理窗口打开。

## 6. 关联

- **issue: au-prefix-tech-debt**——方案 D 用 `pt:` 命名空间，与该 issue 方向一致
- **docs/sessions.md + docs/session-format.md**——Pi Session 模型说明（v3 tree 结构）
- **docs/extensions.md:1453**——`pi.appendEntry()` 官方 API
- **dist/core/extensions/types.d.ts:968**——`ExtensionAPI.appendEntry` 签名
- **dist/core/extensions/types.d.ts:416**——`SessionStartEvent.reason` 5 种枚举
- **src/render/cache.ts:59** + **src/compile/context.ts:73**——cache 失效机制（与本 issue 正交）
- **dist/index.ts（pi 包内部 chunk-E5KXRMZK.js:1244）**——`_bindExtensionCore` 把 `appendEntry` 注入到 runner

---

# 修复记录（v3）：方案 D 落地

> 2026-09-02 实施。代码已合并到 src/，typecheck + 58 个 verify 测试全过。

## 1. 改动文件

| 文件 | 变更 |
|---|---|
| `src/session.ts` | + `ProfileLoadSource` type；+ `loadedFrom` 字段（`SessionState` + `createSessionState()`） |
| `src/index.ts` | + `PT_PROFILE_ENTRY` 常量；+ `readProfileFromSession()` helper；+ `persistProfileToSession()` helper；`session_start` fallback 链加第四源（session）；`switchProfile` 切成功后写 session；+ log entry `session:profile loaded` |
| `src/commands.ts` | `statusText()` 加 `pt loadedFrom: ...` 一行（可观测性） |
| `tests/verify/persist-profile.test.ts` | +13 个新测试（SessionState 字段、readProfileFromSession mock、statusText 渲染） |

## 2. fallback 优先级（src/index.ts:194-200）

```typescript
if (flagVal) { picked = flagVal; pickedFrom = "flag"; }
else if (fromSettings) { picked = fromSettings; pickedFrom = "settings"; }
else if (fromSession) { picked = fromSession; pickedFrom = "session"; }   // 新增
else if (auto) { picked = auto; pickedFrom = "auto"; }
else { picked = undefined; pickedFrom = null; }
```

→ flag > settings > session > auto。session 优先于 auto 避免抹除用户上次选择。

## 3. 写入时机（两条路径）

| 路径 | 触发 | 行为 |
|---|---|---|
| `session_start` 加载成功 | 进程启动 + transpile 成功 | `persistProfileToSession(pi, picked)` 写 JSONL（任意 source 都写——下次 fallback 优先走 session） |
| `switchProfile` | `/pt-context <name>` 或选择器 | `persistProfileToSession(pi, name)` 写 JSONL |
| `session_start` 无 profile | 三源全空 | 不写（避免污染） |

`session.loadedFrom` 在 `session_start` 末尾按 `setFrom` 赋值；用户手动切换时设 `null`（不属于 4 个自动 source）。

## 4. 验证

### 4.1 自动化

```bash
$ npm run typecheck
> tsc --noEmit
(无输出 = 过)

$ npm run verify
 RUN  v3.2.7 /Users/issac/pro/pt
 ✓ tests/verify/persist-profile.test.ts (13 tests) 3ms
 ✓ tests/verify/flows.test.ts (2 tests) 13ms
 ✓ tests/verify/phase9.test.ts (43 tests) 174ms
 Test Files  3 passed (3)
      Tests  58 passed (58)
```

### 4.2 端到端（手动，需真机 pi 进程）

按 issue v2 §4.6 列出的步骤：

1. `cd /Users/issac/pro/pt && pi`
2. 看 footer：应为 `pt: pt-dev`（不是「无 context」——修复前是「无 context」）
3. 看 JSONL：`grep "pt:active-profile" ~/.pi/agent/sessions/--Users-issac-pro-pt--/*.jsonl` 应看到 `{"type":"custom","customType":"pt:active-profile","data":{"profile":"pt-dev"}}`
4. 看 pt-logs：`tail ~/.pt/logs/pt-*.log | grep "session:profile loaded"` 应有 `{ profileName: "pt-dev", loadedFrom: "session" }`
5. `Ctrl+D` 退出 + `pi -c` 再入 → footer 应仍为 `pt: pt-dev`
6. `/pt status` 应输出 `pt loadedFrom: session`

## 5. 风险与回滚

- **风险 1：ephemeral mode（`pi --no-session`）`appendEntry` 行为未在源码层验证**。已用 try/catch 包裹 `persistProfileToSession`，失败仅 warn（不阻断）。如发现问题降级 → 加 typeof 检查已加，运行时仍抛则 slog warn。
- **风险 2：跨 fork/clone session 行为**。按 issue v2 §4.3 表格：fork/clone 是新 JSONL 文件，appendEntry 写到新文件（旧 session entry 不继承）——这是 Pi 设计行为，符合 per-session 语义。
- **风险 3：多并发 pi 进程写同一 session**。Pi SessionManager 串行化（chunk-E5KXRMZK.js:1244 `_bindExtensionCore`），appendEntry 在 _handleAgentEvent 回调里串行调用。无文件锁竞争问题（issue v2 原方案 A 的 B 和 C 风险在此不存在）。
- **回滚**：若发现严重问题，把 `session_start` 里的 `fromSession = readProfileFromSession(...)` 删掉、`persistProfileToSession(pi, picked)` 删掉、`switchProfile` 里 `persistProfileToSession(pi, name)` 删掉即可。`loadedFrom` 字段保留无副作用。

## 6. 关联

- **关联 issue 已转「可清理」**：`au-prefix-tech-debt`——方案 D 落地后 `au.` 前缀不再被新代码使用（所有持久化走 `pt:` namespace），`au.pt-context` 仅保留作 self-heal 入口；`au.` → `pt.` 重命名窗口已开。
- **新增文件 `tests/verify/persist-profile.test.ts`**——13 个单元测试覆盖 helper 逻辑 + SessionState 字段 + statusText 渲染。
- **未来可考虑**：helper 提到独立模块（如 `src/session-store.ts`），避免 index.ts 继续膨胀（当前 ~230 行）。
