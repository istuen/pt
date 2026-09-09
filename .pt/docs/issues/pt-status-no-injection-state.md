---
type: issue
name: pt-status-no-injection-state
status: resolved
severity: medium
created: 2026-09-09
resolved: 2026-09-09
resolved-by: pt-status-no-injection-state-fix
domain: pt-dev
---

# pt statusText 不输出 injectionState + profile 缺 ### Modules 时无告警

## 现象

用户在 pi-web 下报告：切换 profile 后，footer 一直显示 `pt: <profile> idle`，多次对话不变化。

诊断日志（`~/client/yishenglong/.pt/logs/pt-01a084f3-9753-7191-b9df-62b29ad78842.log`）：

```json
{"msg":"transpile:compile done","ctx":{"profileName":"ysl-developer","moduleCount":3}}
{"msg":"transpile:cache hit","ctx":{"agentContextName":"ysl-developer"}}
{"msg":"transpile:done","ctx":{"profileName":"ysl-developer","segmentLen":0,"cacheHit":true}}
{"msg":"command:switchProfile inject","ctx":{"profileName":"ysl-developer","injected":true}}
```

注意 `segmentLen: 0`——profile 编译产物为空 segment，但 switchProfile 仍标 `injected: true`、footer 一直写 idle。

切换前的 `guide` profile（内建默认）正常：`segmentLen: 9765`。

## 根因

### 主因：profile 缺 `### Modules` 段

`~/client/yishenglong/.pt/assets/profiles/ysl-developer.profile.md`：

```markdown
## 会话背景
### Domains
- ysl-company
- fastener-industry
- screw-products
```

v9.1+ 引入 `### Modules` 作为 modName 选择机制（来源从 Blueprint.modules 迁到 ProfileGroup.modules）。`### Domains` 只追加到本聚合组的 domain 列表，**不再触发任何内容填充**。

编译流程（`src/compile/agent-context.ts:148`）：

```ts
return allNames
  .map((n) => domainByName.get(n))
  .filter((d): d is Domain => !!d)
  .filter((d) => mods.some((m) => d.modules[m.section] !== undefined));
//                                    ↑ mods = profileGroup.modules
//                                    ↑ ysl-developer 没填 → []
//                                    ↑ 空 mods 过滤所有 domain → []
```

下游 `dispatchGroup` 遍历空 mods → 0 content → `renderSessionInject` 输出空字符串。

`before_agent_start` 命中 `if (!currentSegment)`（src/agent/pi-adapter.ts:124）→ state = `idle`。

### 次因：cache 放大 bug

`transpile:cache hit` + `segmentLen: 0` 缓存到 `.pt/cache/agent-contexts/ysl-developer.*.agent-context.md`。  
只要 profile 文件没改 mtime / 内容，cache 命中，segmentLen 永远是 0。`resetSessionState` 不清 `lastCacheHit` 和 `lastBuiltPrompt`，进一步混淆可观测性。

### 放大因：statusText 不暴露 injectionState

`src/commands.ts:20 statusText` 输出 8 行：

```
pt profile | loadedFrom | agent | domains/blueprints/profiles/flows
| segment length | cache hit | last built prompt | cwd
```

**完全没输出 `injectionState`**——用户（包括报告者本人）只能从 Pi TUI / pi-web footer 推断状态，无法从 status 工具直接看到 idle/pending/injected/failed 四态。

## 影响

1. 任何 v9.1+ 项目本地 profile **未填 `### Modules`** 都会触发此 bug（一旦切换进去，footer 永远 idle，但 `injected: true` 误导）
2. ysl-* 6 个 profile（developer / manager / erp-consultant / mes-builder / ai-architect / ysl）当前全都受影响（除 guide 内建）
3. 用户无法在 `/pt status` 中直接诊断——必须看 footer 才能发现
4. 缓存命中空 segment 让"删缓存重试"成为非显然的修复路径

## 修复方案

### 修复 1：`commands.ts statusText` 加 `injectionState` 输出

最小可观测性补强。`/pt status` 直接暴露 4 态，不再依赖 footer。

### 修复 2：`agent-context.ts compileAgentContext` 缺填告警升级

当前（src/compile/agent-context.ts:84）只在 `profileGroup.modules.length === 0` 时写 `log.debug`——不 notify 用户、不 console 兜底可见。改为 `reportWarn`（log → notify → console 三通道），让用户**首次切换就看到告警**。

### 修复 3：`transpile.ts` 空 segment 告警

`renderSessionInject` 后 `segment.length === 0` 时 `reportWarn`——明确告知"profile 编译产物为空，注入永远 idle"。覆盖 `modules` 配错但 sourceHash 又命中缓存的边界场景。

### 修复 4：profile 资产修复（ysl-* 6 个）

每个 ysl-* profile 的 `## 会话背景` 段加 `### Modules`：

```markdown
## 会话背景
### Domains
- ysl-company      # 或对应 domain 列表
### Modules
- Scene
- AgentRole        # 视 domain 实际段名而定
```

具体 modName 需根据每个 profile 引用的 domain 的 H2 段名确定。

## 验收

1. `/pt status` 输出含 `pt state: <idle|pending|injected|failed>` 行
2. 切换到缺 `### Modules` 的 profile → 弹通知告警（不再静默失败）
3. 修完 ysl-* 6 个 profile 后，切换到任一 ysl-* profile → `segmentLen > 0`，footer 变 `ok`
4. `tests/verify/persist-profile.test.ts` 加 `injectionState` 输出断言

## 验收结果（2026-09-09）

1. ✅ `src/commands.ts statusText` 加 `pt state:` 行（修复 1）
2. ✅ `src/compile/agent-context.ts` `profileGroup.modules.length === 0` 升级为 `reportWarn`（修复 2）
3. ✅ `src/transpile.ts` `segment.length === 0` 升级为 `reportWarn`（修复 3）
4. ✅ ysl-* 6 个 profile 加 `### Modules: [Scene]`，segmentLen 6320~18537
5. ✅ `tests/verify/persist-profile.test.ts` +5 injectionState 测试，210/210 pass
6. ✅ 端到端验证：ysl-developer 切换前 trigger 告警，切换后 segmentLen > 0 + 告警消失

## 后续

本 issue 只覆盖「单 profile 运行时检测」。**存量项目主动发现 + 升级引导**是另一个 meta 问题，跟踪在 `pt-asset-migration-visibility.md`（Layer 2 启动体检 + Layer 3 `/pt check` 命令 + Layer 5 迁移文档 + footer 颜色变化）。

## 相关

- 上游：v9.1 modules-to-profile 迁移（`docs/designs/modules-to-profile.md`）
- 历史：v11.x `pt-injection-status-manual-track`（4 态自报机制）
- ysl 项目 6 个 profile 同步修复清单见 manual instance `.pt/manuals/modify-asset-procedure-1788937986480.md`
