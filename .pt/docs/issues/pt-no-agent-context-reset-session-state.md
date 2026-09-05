---
type: issue
name: pt-no-agent-context-reset-session-state
status: open
severity: medium
created: 2026-09-04
updated: 2026-09-04
domain: pt-dev
parent-issue: pt-no-agent-context-multi-root-causes
---

# 根因 3 修复：抽 resetSessionState() 公共函数 + 补全 3 处 catch

> **父 issue**：`pt-no-agent-context-multi-root-causes`（**P1 改名后残留 3 根因**——本 issue 是根因 3 的修复 sub-issue）
> **优先级**：**P1.5 高**——不修后续 stale state 排查极难，stale `cachedAgentContext` 会让错误诊断方向跑偏 90 度
> **范围**：代码层（src/session.ts + src/index.ts）

## 现象

transpile 失败时 `session.cachedAgentContext` 等 4 个 cached 字段残留旧值，导致后续 `/pt flows`、`/pt manual` 命令误以为有 Profile，返回旧 Profile 的手册列表或旧 cachedSegment，掩盖真实失败原因。

详细分析见父 issue `pt-no-agent-context-multi-root-causes` 的「根因 3」段。

## 根因

`src/index.ts:140-145`（transpileActive catch）+ `:296-298`（session_start catch）+ `:152-158`（switchProfile catch）三个 catch 块只重置部分字段：

| 字段 | session_start catch 清？ | transpileActive catch 清？ | switchProfile catch 清？ |
|---|---|---|---|
| `cachedSegment` | ✅ | ❌（throw） | ❌（notify） |
| `cachedBundles` | ✅ | ❌ | ❌ |
| `cachedAgentContext` | ❌ **残留** | ❌ **残留** | ❌ **残留** |
| `cachedBlueprint` | ❌ **残留** | ❌ **残留** | ❌ **残留** |
| `cachedDomains` | ❌ **残留** | ❌ **残留** | ❌ **残留** |
| `cachedProfile` | ❌ **残留** | ❌ **残留** | ❌ **残留** |
| `activeAdapter` | ❌ **残留** | ❌ **残留** | ❌ **残留** |

`src/session.ts` 现有的 `clearSessionById`（session_shutdown 用）和 `clearAllSessions`（测试用）都是针对整个 session 清空，**不适合 catch 路径的细粒度重置**。

## 影响范围

| 维度 | 影响 |
|---|---|
| LLM 实际对话 | 不影响（成功加载后注入路径正常） |
| 调试体验 | stale state 让失败伪装成"Profile 无内容"，排查方向跑偏 |
| 跨 session 隔离 | 不影响（v12.x 已修 per-session Map）|
| 自动化 | 不影响（ref check 在加载阶段） |

## 排查方法（可独立复验）

```bash
# 1. 启动 pi session，激活 pt-dev（transpile 成功，sessionState 各字段非空）

# 2. 手动改坏 dev-knowledge.blueprint.yaml（加个无效 target: invalid_value）
#    实际改 .pt/assets/blueprints/dev-knowledge.blueprint.yaml
echo "  - name: 会话知识\n    target: INVALID_VALUE" > .pt/assets/blueprints/dev-knowledge.blueprint.yaml

# 3. 触发 switchProfile 让 transpileActive 失败
#    （通过 pi 调 /pt-profile pt-dev）
/ - 5. 期望（修复前）：/pt flows 返回旧 Profile 的手册列表（stale state）
#    期望（修复后）：/pt flows 返回"transpile 失败，请检查日志"
```

## 修复方向

### 方案 A：抽 `resetSessionState(s)` 公共函数（推荐）

在 `src/session.ts` 加公共函数：

```ts
export function resetSessionState(s: SessionState): void {
  s.cachedSegment = null;
  s.cachedBundles = null;
  s.cachedAgentContext = null;  // P1 改名
  s.cachedBlueprint = null;
  s.cachedDomains = [];
  s.cachedProfile = null;
  s.activeAdapter?.resetInjection?.();
  s.activeAdapter = null;
  s.lastCacheHit = false;
  s.injectionState = "idle";
  s.injectionError = null;
  // 不清：sessionId / logger / lastCwd / activeProfile / loadedFrom / activeManual（生命周期不同）
}
```

3 处 catch 改为调 `resetSessionState(s)` + notify 用户。

### 方案 B：逐字段重置（不推荐）

3 处 catch 各写一遍 7 字段重置——重复代码 + 易遗漏字段 + 与方案 A 等价但更差。

### 推荐 A

简洁 + 集中 + 一处改全处生效。

## 验收标准

- [ ] `npm run typecheck` 通过
- [ ] `npm run verify` 全测试通过
- [ ] 新增单元测试：`tests/verify/issue-pt-no-agent-context-reset-session-state.test.ts`
  - 覆盖 3 处 catch（transpileActive / session_start / switchProfile）
  - 关键断言：catch 后 `cachedAgentContext / cachedBlueprint / cachedDomains / cachedProfile / activeAdapter` 全 null
- [ ] 手动改坏 Blueprint 后 `/pt flows` 不返回旧手册列表
- [ ] 手动改坏 Blueprint 后 `/pt-profile <other>` 切正常 profile 可恢复
- [ ] 父 issue 关联段同步更新（指向本 issue + commit hash）

## 关联

- **`.pt/docs/issues/pt-no-agent-context-multi-root-causes.md`** —— 父 issue（根因 3 段）
- **`src/session.ts`** —— `resetSessionState()` 新增位置
- **`src/index.ts:140-145`** —— transpileActive catch 修复点
- **`src/index.ts:296-298`** —— session_start catch 修复点
- **`src/index.ts:152-158`** —— switchProfile catch 修复点
- **`.pt/docs/issues/pt-context-persist-lost.md`** —— 同类（activeProfile 状态）
- **`.pt/docs/issues/pt-session-singleton-pi-web-pollution.md`** —— 同类（per-session state）

## 修复日志

<!-- 待 commit 后填 -->