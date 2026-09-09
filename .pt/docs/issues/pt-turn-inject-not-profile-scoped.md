---
type: issue
name: pt-turn-inject-not-profile-scoped
status: resolved
severity: medium
created: 2026-09-09
updated: 2026-09-09
resolved: 2026-09-09
domain: pt-dev
related-issues: []
---

# Turn Inject（/manual:xxx + /<flow-name>）未按 Profile scope 过滤——角色隔离失效

## 现象

激活**不含 pt-quality** 的 Profile（如 `pt-design`，其 `domains: [user-info, agent-info, product-design, workflow/asset-workflow, pt-collab]`），输入 `/manual:pt-quality` **仍能触发**——返回 pt-quality 的 Rules 规范清单。

预期：pt-design 未引用 pt-quality，`/manual:pt-quality` 应返回 null（passthrough，不注入手册内容），与 `/pt flows` 列表（已按 Profile 过滤、不含 pt-quality）的行为一致。

同理 `/<flow-name>`（如 `/feature-lifecycle`）在未引用对应 workflow domain 的 Profile 下也能触发。

## 根因

Turn Inject 路径（`renderTurnInject`）拿到的 `domains` 是 **`bundle.domains` 全集**（项目 + builtin 合并去重），未按 Profile 引用范围过滤。数据流：

```
transpile.ts:loadAndTranspile
  return { ..., domains: bundle.domains }          ← 全集
    ↓
index.ts:130   s.cachedDomains = result.domains    ← 全集存进 session
index.ts:139   adapter.setAgentContext(ctx, blueprint, result.domains)
    ↓
pi-adapter.ts:58   this.domains = domains          ← 全集存进 adapter 实例
pi-adapter.ts:176  renderTurnInject(this.ctx, this.blueprint, this.domains, event.text)
                                                    ↑ 全集，未过滤
```

对比 `/pt flows`（`commands.ts:flowsText`）已用 `filterDomainsByProfile(domains, profile)` 预过滤后传给 `listManuals`——所以 `/pt flows` 列表正确不含 pt-quality。**两条 turn 路径（触发 vs 列表）过滤策略不一致**。

### 深层根因：`参考手册`聚合组编译产物未被 turn 路径消费

`compile/agent-context.ts:compileAgentContext` 产出的 `ctx.modules["参考手册"]` 是按 Profile 的"参考手册"聚合组配置（`ProfileGroup.modules` = [Rules, Flows, Checklists] + `ProfileGroup.domains` 追加）聚合后的产物。但 `renderTurnInject` 和 `PiAdapter.listManuals` **都不读 `ctx.modules`**，而是从 `domains` 全集现场用 `renderDomainManual` / 直接遍历 `d.modules[MOD_FLOWS]` 渲染。

后果：Profile 的"参考手册"聚合组 `### Modules` 选择**只影响缓存文件 `.pt/cache/agent-contexts/*.md` 的可观测性，不影响 turn 触发行为**。若未来某 Profile 想只暴露 Rules 不暴露 Flows（从 `### Modules` 删 Flows），turn 触发仍会找到 Flows 段渲染——配置不生效。

`src/schema.ts:378-382` 的 `AgentAdapter.listManuals` JSDoc 已明确承认这是已知历史简化：

> v9 当前实现（pi-adapter.ts:listManuals）按"全集"处理——这是历史简化，v10+ 应改

## 影响范围

| 维度 | 影响 |
|---|---|
| **角色隔离承诺** | 受损。`project-analysis` domain 的 `role-isolation` 场景明确承诺"4 profile 共享同一 Blueprint + 同一 Domain 集合，差异全在 ### Modules 段——真正的隔离"。但 turn 触发不认 Modules，隔离在 turn 面被打破。 |
| **LLM 上下文** | 激活 pt-design 时 LLM 可通过 `/manual:pt-quality` 拉入 pt-dev 专属的 9 条代码规范，与 pt-design（架构/设计角色）无关，污染上下文。 |
| **触发索引可信度** | "触发索引"聚合组（session 注入，告诉 LLM 有什么手册）已按 Profile 过滤；但 `/manual:xxx` 实际触发不按 Profile 过滤——索引与触发不一致，LLM 可能被索引误导以为某手册不可用，实际却可触发。 |
| **配置可观测性** | 用户改 Profile 的"参考手册"### Modules 期望控制 turn 暴露面，实际无效（只改缓存文件外观）。违反"配置即行为"原则。 |

当前 4 profile 的"参考手册"modules 都是 `[Rules, Flows, Checklists]`（modules 维度无差异），所以问题 A（domain 维度未过滤）是当前可复现的 bug，问题 B（modules 维度未消费）是未来隐患。

## 排查方法

1. 激活 pt-design：`/pt-profile pt-design`
2. 查 `/pt flows`——列表不含 pt-quality（`filterDomainsByProfile` 已过滤）✅
3. 输入 `/manual:pt-quality`——**返回 pt-quality 的 9 条规范清单**（预期应 passthrough 返回 null）❌
4. 读 `src/agent/pi-adapter.ts:176` 确认 `renderTurnInject(this.ctx, this.blueprint, this.domains, event.text)` 的 `this.domains` 来源
5. 追 `src/index.ts:139` `setAgentContext(..., result.domains)` → `src/transpile.ts` `domains: bundle.domains`（全集）
6. 对比 `src/commands.ts:flowsText` 第 73-76 行：`listManuals` 调用前已 `filterDomainsByProfile` 预过滤——确认两条 turn 路径策略不一致

## 修复方向

### 阶段 1（必须，解决当前 bug）：turn 路径按 Profile domain 维度过滤

让 `renderTurnInject` 用 `filterDomainsByProfile(domains, profile)` 预过滤，与 `/pt flows` 对齐。

改动点：
- `AgentAdapter.setAgentContext` / `registerInject` 签名加 `profile: Profile` 参数（或在 `index.ts` 调用 `setAgentContext` 时就把过滤后的 domains 传进去——更小改动）
- `PiAdapter` 内部存 `this.profile`
- `renderTurnInject` 签名加 `profile` 参数，内部调 `filterDomainsByProfile`
- `commands.ts:flowsText` 不再单独预过滤（下沉到 adapter / render 统一处理，消除两处过滤逻辑漂移风险）
- `listManuals` 签名去掉对调用方预过滤的依赖（adapter 内部用 `this.profile` 自行过滤）

**最小改动版**（不动 Adapter 接口）：`index.ts:139` 调 `setAgentContext` 时传 `filterDomainsByProfile(result.domains, result.profile)` 而非 `result.domains`。但这只修 domain 维度，不修 modules 维度（阶段 2），且 `listManuals` 仍依赖调用方预过滤。

### 阶段 2（建议，未来防护）：turn 路径消费"参考手册"聚合组 modules 白名单

让 `renderTurnInject` / `listManuals` 严格按 Profile "参考手册"聚合组的 `ProfileGroup.modules` 决定渲染哪些段：
- `/manual:<domain>` 只渲染 modules 声明的段（如 modules=[Rules] 则只渲染 Rules，不渲染 Flows/Checklists）
- `/<flow-name>` 只在 modules 含 Flows 时才查找 FlowTemplate
- `listManuals` 同理

需 `renderDomainManual` 接收 modules 白名单参数，调整 Flows > Rules > Checklists 的优先级查找为"白名单内按优先级"。

### 测试更新

- `tests/verify/phase9.test.ts` 第 12 节（/manual:xxx 触发）：当前用 `ptDevBundle.domains`（全集）调 `renderTurnInject`——需改为过滤后的 domains 或传 profile。加反向用例：pt-design 激活时 `/manual:pt-quality` 返 null。
- `tests/verify/flows.test.ts`：`listManuals` 预过滤逻辑下沉后，测试内联的 `b.domains.filter(...)` 可删（或保留验证 adapter 内部过滤）。
- 新增用例：Profile "参考手册" modules 不含 Flows 时，`/<flow-name>` 返 null（阶段 2 验证）。

## 关联

- `src/schema.ts:378-389` — `AgentAdapter.listManuals` JSDoc（承认"全集"历史简化，v10+ 应改）
- `src/render/turn-inject.ts:38` — `renderTurnInject` 签名（`_ctx` 带下划线未使用，不读 `ctx.modules`）
- `src/agent/pi-adapter.ts:176,206` — input handler + listManuals 的 domains 来源
- `src/commands.ts:22` — `filterDomainsByProfile`（已存在，/pt flows 已用）
- `src/transpile.ts:54` — `TranspileResult.profile`（已返回，未传给 adapter）
- `src/builtin/assets/domains/project-analysis.md` `role-isolation` 场景 — 角色隔离承诺（turn 面被打破）

## 修复

**修复日期**: 2026-09-09
**验证方式**:
- `npm run typecheck`（tsc --noEmit）通过
- `npm run verify`（vitest + biome）205 测试全过，含新增反向用例"pt-design /manual:pt-quality 返 null"
- 端到端 tsx 脚本验证：pt-design 激活时 /manual:pt-quality 返 null（修复前返非 null）；阶段 2 modules 白名单——删 Flows 段后 /feature-lifecycle 返 null

**改动文件**:
- `src/schema.ts` — `filterDomainsByProfile` 从 commands.ts 挪入；`AgentAdapter.setAgentContext/registerInject` 加 profile 参数；listManuals JSDoc 更新
- `src/render/turn-inject.ts` — `renderTurnInject` 加 profile 参数；新增 `turnGroupModules`/`modsAllowsSection` 辅助；`renderDomainManual`/`findFlowInBlueprint` 消费 modules 白名单（阶段 2）
- `src/agent/pi-adapter.ts` — 持有 `this.profile`；input handler + listManuals 内部 `filterDomainsByProfile` 自过滤
- `src/commands.ts` — 删本地 `filterDomainsByProfile`（import 自 schema）；`flowsText` 删预过滤；`buildManualDoc` 传 profile
- `src/index.ts` — `transpileActive`/`registerInjectionIfReady` 传 profile 给 adapter
- `tests/verify/phase9.test.ts` — renderTurnInject 调用加 profile；新增 pt-design 反向用例
- `tests/verify/flows.test.ts` — 删测试内联预过滤，改用 setAgentContext 存 profile
