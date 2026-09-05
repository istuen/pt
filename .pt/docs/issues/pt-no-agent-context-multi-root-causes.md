---
type: issue
name: pt-no-agent-context-multi-root-causes
status: in-progress
severity: medium
created: 2026-09-04
updated: 2026-09-04
domain: pt-dev
sub-issues: [pt-no-agent-context-reset-session-state, pt-no-agent-context-prune-orphan-caches, pt-no-agent-context-profile-h2-sections]
related-issues: [pt-dist-src-desync]
---

# "pt context 变成无 Context" 的多层根因（**P1 改名已落地，残留 3 根因待修**）

> **场景**：在 session "Pt 术语定型：Context→AgentContext 改名与心智模型重构" 期间反复出现 "无 Context" 现象。不是单一 bug，而是 4 层根因叠加。**P1 改名已完成（commit `0455a47`）**，根因 1 修复；根因 2/3/4 残留，issue 保持 open。
>
> **2026-09-04 更新**：commit `0455a47 Phase term-P1: Context IR → AgentContext rename` 已落地。验证：`grep -rn "interface Context\b\|cachedContext" src/` 0 命中；`grep -rn "AgentContext\|cachedAgentContext" src/` ~10 命中。但 `.pt/cache/contexts/` 旧目录未删、`pruneOrphanCaches` 未实现、catch 路径漏清未补、Profile H2 段仍空——3 根因残留。
>
> **2026-09-04 拆分**：本 issue 为**父 issue**。3 根因残留拆为 3 个 sub-issue 各自跑 issue-lifecycle。排查时新发现 `dist/` 与 `src/` 不同步（独立 issue，不在父范围）。本父 issue status 改 `in-progress`，等所有 sub-issue resolved 才 closed。

## 现象

用户在 Pi session 里使用 `pt-dev` profile 时，以下场景反复出现"无 Context"主观感受：

| 场景 | 现象 |
|---|---|
| `/pt status` | `pt profile: (未激活)` 或 `pt segment length: 0 chars` |
| `/pt flows` | 返回"无激活 Profile，先用 /pt-context <name> 激活" |
| `/pt manual xxx` | 返回"未找到手册: xxx"（实际 Profile 已加载） |
| `/pt full` | 警告"无 cachedSegment（未加载 Profile）"（实际刚刚 transpile 成功） |
| 切 Profile 后 | 新 Profile 的注入点内容没出现，但旧 Profile 的手册列表还在 |
| 删除 Profile.md 后 | 旧 context 缓存仍能被 loadContext 命中（孤儿缓存） |

**共同特征**：报错词面 "无 Context / 未加载 / 无激活 Profile" 与用户实际操作不完全对齐——经常是 stale state 导致"看起来无 Context"，但底层 cachedContext 字段还指向旧值。

## 根因（4 层叠加）

### 根因 1：术语撞名——"Context" 一词三义（心智层）**【已修复 P1，commit `0455a47`】**

**原始证据**：改名前 `src/schema.ts:175` 的 `interface Context`（Pt 产物 IR）与 `src/constants.ts:87` 的 `TARGET_CONTEXT_MESSAGE = "context_message"`（Pi API 名）共享词根。在 LLM 视角：

- `cachedContext` 字段 = "Pt 的产物层 IR"（改名目标）
- `context_message` target = "Pi 的 input 事件注入位置"（Pi API）
- Pi runtime `context` = "对话 messages 数组"（Pi 内部）

三者用同一个英文词表达不同概念，LLM 在小上下文窗口里无法可靠区分——LLM 误判 cachedContext 是 Pi 的 context → 调试 `no Context` 时方向跑偏。

**`pt-terminology.md §3.2` 已确诊**："原名撞 Pi 的 context_message（不同概念同名）"。

**修复**：P1 改名 `Context → AgentContext`（schema + ~130 处引用 + cache 后缀 + 缓存目录），改名后"Agent Context（Pt 产物） / context_message（Pi 注入位置） / conversation context（Pi 运行时）"三者泾渭分明。

**修复后验证（2026-09-04）**：

| 检查项 | 命令 | 结果 |
|---|---|---|
| 旧名清零 | `grep -rn "interface Context\b\|cachedContext\b" src/` | 0 命中 ✅ |
| 新名落地 | `grep -rn "interface AgentContext\|cachedAgentContext" src/` | ~10 命中（schema/session/index/commands/cache）✅ |
| Schema | `src/schema.ts:247` | `export interface AgentContext` ✅ |
| Session | `src/session.ts:63,93` | `cachedAgentContext: AgentContext \| null` ✅ |
| Cache 后缀 | `src/render/cache.ts:27` | `${ctx.name}.agent-context.md` ✅ |
| Cache 目录 | `.pt/cache/agent-contexts/` | 已建（2026-09-04 `ls` 可见）✅ |
| builtin 资产 | `src/builtin/assets/domains/authoring.md` | 已用新路径 `.pt/cache/agent-contexts/` ✅ |

**修复完整度**：✅ 根因 1 完全修复，P1 使命完成。

### 根因 2：孤儿缓存——Profile 与 cache 文件不对齐（数据层）**【未修，P1.5 待办】**

**原始证据**（2026-09-04 重构前）：`ls .pt/cache/contexts/` vs `ls .pt/assets/profiles/`：

```
.pt/cache/contexts/                .pt/assets/profiles/
├── pt-chat.context.md  ←───?     ├── pt-chat.profile.md
├── pt.context.md       ←──孤儿!  └── pt-dev.profile.md
└── pt-dev.context.md   ←────────  (无 pt.profile.md)
```

**最新状态**（2026-09-04 重构后，commit `0455a47` 后）：

```
.pt/cache/
├── contexts/                    ← 旧目录，未删（死代码但占空间）
│   ├── pt-chat.context.md
│   └── pt-dev.context.md
└── agent-contexts/              ← 新目录，P1 改名后写入
    └── pt-dev.agent-context.md
```

**新风险**：P1 改名后双目录并存——新代码只写 `agent-contexts/`，旧 `contexts/` 文件无读取路径但物理残留。`.pt/cache/contexts/` 路径常量从代码里搜不到 grep 命中（仅 schema 注释里残留），但目录本身没删。

**机制**（未变）：
- `src/render/cache.ts:34-49` `loadContext()` 只校验 hash 是否匹配当前 sourceHash，不校验 Profile 是否仍存在
- Profile 被删除/改名后，cache 文件不会被自动清理
- 后续 session_start fallback 链命中已删除的 Profile 名（如 settings.json 还引用）→ `mdAdapter.load` 抛错 → cachedAgentContext 保持 null → "无 Agent Context"

**影响**：cache miss/hit 行为不可预测，调试者无法判断"为什么缓存没生效"。P1 改名后旧目录成新历史包袱。

**当前 0 防护**：`loadContext()` 与 `mdAdapter.load()` 无交叉校验——cache 文件存在 ≠ Profile 资产存在。`pruneOrphanCaches` grep 0 命中——**完全未实现**。

### 根因 3：失败路径漏清——stale state 残留（行为层）

**证据 1**：`src/index.ts:208-218` session_start catch 块：

```ts
} catch (e) {
  ctx.ui.notify(`Pt 加载失败：${errMsg(e)}`, "error");
  s.injectionState = "failed";
  s.injectionError = errMsg(e);
  refreshInjectionFooter(ctx.ui, s);
  s.cachedSegment = null;         // ← 清
  s.cachedBundles = null;         // ← 清
  s.loadedFrom = null;            // ← 清
  // ← 漏清：cachedContext / cachedBlueprint / cachedDomains / cachedProfile
  s.logger?.error("session:start failed", { err: errMsg(e) });
  await tryRestoreManual(ctx, s);
}
```

只清 3 个字段，剩余 4 个 `cachedContext/cachedBlueprint/cachedDomains/cachedProfile` 保留旧值。

**证据 2**：`src/index.ts:103-129` `transpileActive` catch 块：

```ts
} catch (e) {
  slog(sessionId, "error", "transpileActive:failed", { ... });
  throw e;   // ← 直接抛，没清任何 cached 字段
}
```

调用方（`src/index.ts:148` `switchProfile`）catch 后只 notify 用户，不重置 state。

**后果链**：
1. transpileActive 失败 → cachedContext 保留上一次成功的旧值
2. 用户调 `/pt flows` → `src/commands.ts:69` `if (!session.cachedContext || !session.cachedBlueprint) return "无激活 Profile..."` 检查通过（因为旧值非空）
3. `flowsText` 用旧 Context + 旧 cachedBundles 调 `listManuals` → 返回旧 Profile 的手册列表
4. 用户看到"当前 Profile 没手册 / Context 没更新"，实际是新 Profile 根本没加载成功，错误被 stale state 吞掉

**结论**：stale state 让"失败"伪装成"Profile 无内容"，错误诊断方向跑偏 90 度。

**最新残留证据**（2026-09-04 grep 结果）：

```ts
// src/index.ts:140-145（transpileActive catch）
} catch (e) {
  slog(sessionId, "error", "transpileActive:failed", { ... });
  throw e; // ← 直接抛，cachedAgentContext 等 4 字段不重置
}

// src/index.ts:296-298（session_start catch）
} catch (e) {
  ...
  s.logger?.error("session:start failed", { err: errMsg(e) });
  // ← 仍只清 segment/bundles/loadedFrom，cachedAgentContext/cachedBlueprint/cachedDomains/cachedProfile 残留
  await tryRestoreManual(ctx, s);
}

// src/session.ts：grep "resetSession" 仅命中注释（"resetSession 覆盖 ..."）
//                实际函数 grep 0 命中——未抽公共 reset 函数
```

**修复方向调整**：原建议抽 `resetSessionState(s)` 公共函数仍然适用。但 grep 显示 `session.ts` 只有 `clearSessionById`（session_shutdown 用）和 `clearAllSessions`（测试用）——`resetSessionState` 是缺失函数。

### 根因 4：Profile 资产可视化缺失——H2 注入点段为空（资产层）**【未修，P2+ 低优】**

**最新证据**（2026-09-04 重构后）——`.pt/assets/profiles/pt-dev.profile.md` 全文未变：

```markdown
---
name: pt-dev
blueprint: dev-knowledge
domains: [me, product-design, dev-workflow, issue-workflow, testing-workflow, release-workflow, asset-workflow, deployment, pt-quality, pt-collab]
---

# pt-dev (profile)
```

只有 H1 标题，无任何 H2 段。`pt-chat.profile.md` 同问题。builtin `pt.profile.md` 同问题（已确认存在）。

**机制**（未变）：
- `src/parse/profile.ts`（重构后行号可能偏移）遍历 `asset.sections`（H2 段字典）push injectionPoints
- 无 H2 段 → `injectionPoints: []`（数组长度 0）
- `src/compile/context.ts` 遍历 `profile.injectionPoints` 找不到任何实例化
- 实际靠 `resolveDomains` 的全局 `profile.domains` 兜底分发

**影响**：
- 用户改 Profile 时看不到自己配置了哪些注入点 → 误以为没生效
- 调试"无 Agent Context"时，资产层无法定位配置入口（profile 文件里啥都没有）
- 与 `pt-terminology.md §3.4` "命令名实相符"原则不一致——Profile 配置面缺关键可视维度

## 影响范围

| 维度 | 影响 | 严重度 |
|---|---|---|
| LLM 实际对话 | 不影响（注入路径在成功加载后正常） | ✅ 无 |
| 用户调试体验 | stale state + 孤儿 cache + 术语混淆 → 排查方向跑偏 | ⚠️ medium |
| 改 P1 改名成功率 | 已落地（commit `0455a47`）；stale state 仍残留（`cachedAgentContext` 同问题） | ✅ P1 已修 |
| 资产可维护性 | Profile.md 无注入点段 → 配置不可见 | ⚠️ low |
| 自动化（pt_check_refs 等） | 不影响（ref check 在加载阶段，stale state 在失败阶段） | ✅ 无 |

## 排查方法（可独立复验）

### 复现根因 2（孤儿缓存）

```bash
# 1. 看当前 Profile 资产
ls /Users/issac/pro/pt/.pt/assets/profiles/

# 2. 看当前 context 缓存
ls /Users/issac/pro/pt/.pt/cache/contexts/

# 3. 对比：缓存里的 *.context.md 是否都有对应的 *.profile.md
# 预期：当前应有 1 个孤儿（pt.context.md vs 无 pt.profile.md）
for ctx in /Users/issac/pro/pt/.pt/cache/contexts/*.context.md; do
  name=$(basename "$ctx" .context.md)
  if [ ! -f "/Users/issac/pro/pt/.pt/assets/profiles/${name}.profile.md" ]; then
    echo "孤儿缓存: $name"
  fi
done
```

### 复现根因 3（stale state）

```bash
# 1. 启动 pi session，激活 pt-dev（transpile 成功）
# 2. 手动改坏 dev-knowledge.blueprint.md（加个无效 target）
# 3. /pt-context pt-dev → switchProfile 调 transpileActive 失败 → throw
# 4. /pt flows → 应返回旧 Profile 的手册列表（stale state），而非"无激活 Profile"
# 5. 期望（修复后）：/pt flows 返回"transpile 失败，请检查日志"
```

### 复现根因 4（H2 段为空）

```bash
# 1. 读 pt-dev.profile.md
cat /Users/issac/pro/pt/.pt/assets/profiles/pt-dev.profile.md

# 2. 应只见 H1，无 H2 → injectionPoints = []
grep -E "^## " /Users/issac/pro/pt/.pt/assets/profiles/pt-dev.profile.md
# 预期：无输出（H2 段为空）

# 3. 启动 pi，调 pt_status，看 "pt profile" 是否能从 YAML 看到注入点配置
#    现状：statusText (src/commands.ts:34) 只输出 profile 名，不输出 injectionPoints 数量
```

### 复现根因 1（术语撞名）

```bash
# 在 LLM context 里同时出现 cachedContext 和 context_message，
# 观察 LLM 是否混淆两个概念
grep -n "cachedContext\|context_message\|TARGET_CONTEXT" /Users/issac/pro/pt/src/*.ts | head
# 期望：看到 3 类不同概念共享词根
```

## 修复方向

### 根因 1（P1 改名，in scope）**【✅ 已完成】**

按 `pt-terminology.md §7.1 改动清单` 执行：
- `interface Context` → `AgentContext`（schema.ts + 全 src/ 引用，~130 处）✅
- `cachedContext` → `cachedAgentContext` ✅
- 产物后缀 `.context.md` → `.agent-context.md` ✅
- 缓存目录 `.pt/cache/contexts/` → `.pt/cache/agent-contexts/` ✅
- 命令文案 / 报错文案同步 ✅（P2 同步完成于 commit `588d2e1`）

**commit**：`0455a47 Phase term-P1: Context IR → AgentContext rename`
**验证**：见「根因 1」段末尾的「修复后验证（2026-09-04）」表。

### 根因 2（新开 issue 或同期修）

**方案 A（推荐）**：transpile 加载阶段比对 cache 文件名 vs bundle.profiles，自动清孤儿。
- 位置：`src/transpile.ts` `loadAndTranspile` 末尾，加 `pruneOrphanCaches(bundle.profiles, compilation.cacheDir)`
- 实现：列出 `cacheDir/*.agent-context.md`（改名后），对每个文件检查 `name` 是否在 `bundle.profiles.map(p => p.name)` 内，不在则 unlink + log

**方案 B**：加 `/pt cache:prune` 工具子命令，手动触发清理。

**方案 C**：`loadContext()` 内做交叉校验（查 profile 是否存在），不存在返 null（fail-open）。

**推荐 A**：自动化无感，与 P1 改名同步部署。

### 根因 3（建议同期修，不然后患大）

**方案**：把 session_start catch + transpileActive catch 的清理补全到 7 个字段（`cachedSegment/cachedBundles/cachedAgentContext/cachedBlueprint/cachedDomains/cachedProfile/activeAdapter`），或抽 `resetSessionState(s: SessionState)` 公共函数复用。

**位置**（P1 改名后行号，2026-09-04 grep）：
- `src/index.ts:296-298` session_start catch
- `src/index.ts:140-145` transpileActive catch
- `src/index.ts:152-158` switchProfile catch

**抽公共函数**（`src/session.ts`）：

```ts
export function resetSessionState(s: SessionState): void {
  s.cachedSegment = null;
  s.cachedBundles = null;
  s.cachedAgentContext = null;  // ← 新增（P1 改名后字段名）
  s.cachedBlueprint = null;     // ← 新增
  s.cachedDomains = [];         // ← 新增
  s.cachedProfile = null;       // ← 新增
  s.activeAdapter = null;       // ← 新增（连带清 adapter）
  s.lastCacheHit = false;
  s.injectionState = "idle";
  s.injectionError = null;
  // 不清：sessionId / logger / lastCwd / activeProfile / loadedFrom / activeManual（生命周期不同）
}
```

**风险评估**：低——catch 路径本就应清干净，stale state 是历史 bug 而非预期行为。

### 根因 4（资产范本，可后续优化）

**方案**：Profile.md 范本统一加 `## <注入点名>` 段（即使无追加 domains），让注入点配置可视化。

**示例（修复后）**：

```markdown
---
name: pt-dev
blueprint: dev-knowledge
domains: [me, product-design, dev-workflow, ...]
---

# pt-dev (profile)

## 会话知识
<!-- 此注入点用全局 domains，无追加；保留段让配置可见 -->

## 参考手册
<!-- 同上 -->
```

**优先级**：低。可在 P5 Manual 模板/实例拆分同期做，或作为 dev-knowledge Domain 排查手册的引子。

### 修复节奏建议（2026-09-04 拆分为 sub-issue）

| 阶段 | 范围 | sub-issue | 依赖 |
|---|---|---|---|
| ✅ P1 | Context → AgentContext 改名（根因 1） | — | commit `0455a47` |
| **P1.5 高** | 根因 3 resetSessionState + 补全 3 catch | [`pt-no-agent-context-reset-session-state`](pt-no-agent-context-reset-session-state.md) | P1 命名落地 |
| **P1.5 中** | 根因 2 pruneOrphanCaches + 清旧 contexts/ | [`pt-no-agent-context-prune-orphan-caches`](pt-no-agent-context-prune-orphan-caches.md) | P1 命名落地 |
| **P2+ 低** | 根因 4 Profile.md H2 段范本 | [`pt-no-agent-context-profile-h2-sections`](pt-no-agent-context-profile-h2-sections.md) | — |
| **独立 P1.5 中** | dist/ 与 src/ 不同步（排查时新发现） | [`pt-dist-src-desync`](pt-dist-src-desync.md) | — |

**父 issue 状态流转**：`open` → `in-progress`（已改）→ 等所有 sub-issue resolved → `resolved` → closed。

## 关联

- **`.pt/docs/designs/pt-terminology.md`** §3.2（Context→AgentContext 改名决策）、§7（改动清单）、§3.4（/pt-context→/pt-profile）
- **`.pt/docs/designs/pt-asset-layering.md`** §0（待按 Context-first 倒推叙事重写，P3）
- **`.pt/docs/designs/pt-context-first-narrative.md`**（倒推叙事样板）
- **`src/schema.ts:247`** —— `interface AgentContext` IR 定义（P1 改名后位置）
- **`src/constants.ts:87`** —— `TARGET_CONTEXT_MESSAGE` Pi API 常量（保留，与 AgentContext 区分）
- **`src/session.ts:63-93`** —— `cachedAgentContext` 等 7 个 cached 字段声明 + 默认值（P1 改名后行号）
- **`src/index.ts:140-145`** —— `transpileActive` catch 漏清（P1 改名后行号）
- **`src/index.ts:296-298`** —— session_start catch 漏清（P1 改名后行号）
- **`src/index.ts:152-158`** —— `switchProfile` catch 漏清（P1 改名后行号）
- **`src/commands.ts:69-83`** —— `flowsText` 检查 cachedAgentContext 但依赖 stale-safe
- **`src/parse/profile.ts:30-36`** —— injectionPoints 解析依赖 H2 段
- **`src/render/cache.ts:34-49`** —— `loadContext` 无交叉校验（注：内部仍引用 `${name}.context.md` 旧命名的注释残留，实际写入已是 `.agent-context.md`）
- **`.pt/cache/contexts/pt-chat.context.md`** + **`.pt/cache/contexts/pt-dev.context.md`** —— 重构后旧目录未清（双目录并存）
- **`.pt/cache/agent-contexts/pt-dev.agent-context.md`** —— P1 改名后新目录的产物
- **`.pt/assets/profiles/pt-dev.profile.md`** —— 实测无 H2 注入点段
- **`.pt/docs/issues/pt-context-persist-lost.md`** —— 同类（activeProfile 状态丢失/恢复）
- **`.pt/docs/issues/pt-full-duplicate-segment.md`** —— 同类（调试输出与实际状态不一致）
- **`.pt/docs/issues/pt-session-singleton-pi-web-pollution.md`** —— 同类（session state 多源问题，v12.x 修复）
- **`.pt/docs/issues/pt-no-agent-context-reset-session-state.md`** —— sub-issue（根因 3，P1.5 高）
- **`.pt/docs/issues/pt-no-agent-context-prune-orphan-caches.md`** —— sub-issue（根因 2，P1.5 中）
- **`.pt/docs/issues/pt-no-agent-context-profile-h2-sections.md`** —— sub-issue（根因 4，P2+ 低）
- **`.pt/docs/issues/pt-dist-src-desync.md`** —— 独立 issue（排查时新发现）

## 修复日志

### ✅ 已修复

#### 根因 1：术语撞名（commit `0455a47`）

- commit：`0455a47 Phase term-P1: Context IR → AgentContext rename`
- 后续 commit：`588d2e1 Phase term-P2: /pt-context → /pt-profile rename (backward compat)`
- 验证（2026-09-04 grep）：
  - `grep -rn "interface Context\b\|cachedContext\b" src/` → 0 命中 ✅
  - `grep -rn "interface AgentContext\|cachedAgentContext" src/` → ~10 命中 ✅
  - `ls .pt/cache/agent-contexts/` → 存在并有产物 ✅
- 边界纪律：未动 PiAdapter / Pi 上游 API；只改 Pt 内部命名
- 修复日期：2026-09-04 之前（具体见 commit）

### ⏳ 待修复（3 根因残留 → 已拆 sub-issue）

- [ ] **根因 3** → [`pt-no-agent-context-reset-session-state`](pt-no-agent-context-reset-session-state.md)（sub-issue，P1.5 高）
- [ ] **根因 2** → [`pt-no-agent-context-prune-orphan-caches`](pt-no-agent-context-prune-orphan-caches.md)（sub-issue，P1.5 中）
- [ ] **根因 4** → [`pt-no-agent-context-profile-h2-sections`](pt-no-agent-context-profile-h2-sections.md)（sub-issue，P2+ 低）

### 🔗 相关独立 issue

- [ ] **[`pt-dist-src-desync`](pt-dist-src-desync.md)**（排查时新发现，开发基础设施层，不在父 issue 范围）
