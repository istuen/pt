# Pt 代码质量阶段改进方案

> **基线**：commit `db25b60`（fix: inject context after manual profile switch）
> **日期**：2026-09-02
> **审计范围**：`src/` 全部 30 文件 / 3752 行 + `tests/` 6 文件 / 76 用例 + `.pt/docs/issues/`
> **前置文档**：`pt-tech-debt-audit.md`（T1–T13 已基本清完，本方案是其后继）
> **用途**：执行者按 P0→P1→P2→P3 四阶段推进，每阶段独立可验收、互不阻塞

---

## 0. 基线快照

| 维度 | 现值 | 备注 |
|---|---|---|
| 源码 | 30 文件 / 3752 行 | `src/` 全 TS |
| 最大文件 | `index.ts` 578 行 | Pi 集成层，偏胖（God Module） |
| 测试 | 6 文件 / 76 用例全过 | 全部端到端 via `loadAndTranspile`，无单元测试 |
| `as` 断言 | 25 处 | ~15 处属合法（type guard 内部 / `JSON.parse` / 错误对象收窄），真实问题 ≤6 |
| `switch` | 3 处 | 均为 renderer 内 `switch(d.type)`，modName 已走注册表 |
| `console.*` | 4 处 | 均为 3 通道 fallback 末位兜底（log→notify→console），合规 |
| 原 tech-debt T1–T13 | 11/13 已清 | T12（by-injection-point 缓存）有意预留；其余完成 |
| pt-quality 10 条 | 10/10 落地 | T13 措辞修正 + `biome-guarded` 新增（Biome 守护层） |
| Biome 守护 | 0 error / 41 warn+info | `biome.json` 已建立（双引号/分号/2 空格/行宽 100，organizeImports off）；41 项作为 P2 清单输入 |

**结论**：v9 四层模型已贯通，pt-quality 10 条规范基本落地。当前债已从"规范违反"转向"结构整洁度"——重复、死代码、入口层膨胀、测试覆盖单薄。本方案聚焦结构整洁度，不涉及 v9 语义变更。

**Biome 守护层已建立**（`biome.json` + `lint`/`lint:fix`/`format` 脚本）：0 error，41 项 warning/info 作为 P2 类型安全清理的精确输入清单。Biome 交叉验证了手工审计——`renderGlobalRules`（`compile/context.ts:269`）+ `findFlow`（`index.ts:183`）两个死代码被 biome 精确切中；`noNonNullAssertion` 21 处与手工标的 `as` 断言 ≤6 真实问题高度重叠。剩余 41 项分布：`noNonNullAssertion` 21 / `useTemplate` 7 / `useLiteralKeys` 5 / `noUnusedImports` 4 / `noUnusedVariables` 3（含 2 死代码）/ `noUnusedFunctionParameters` 1。

---

## 1. 按模块深度分析

### 1.1 `schema.ts`（358 行）— IR 契约层 ✅ 健康

**职责**：v9 四层 IR（Domain/Blueprint/Profile/Context）+ 注入点配置 + AgentAdapter/SourceAdapter 接口。

**现状**：契约清晰，注释即文档，`findBlueprint/findProfile` 辅助到位。`Domain.modules: Record<string, unknown>` 是有意 type hole（换 H2 开放性），由 `compile/type-guards.ts` 收窄——设计自洽。

**残留**：
- `BoundaryNode` 接口注释明示"v9 不再使用，留作未来扩展参考"——纯预留类型，无消费者。
- `InjectionTarget = "system_prompt" | "context_message" | string` —— `| string` 让联合失去收窄意义，但符合"扩展点开放"意图，可接受。

**改进**：无需动，作为契约锚点保持稳定。

---

### 1.2 `parse/`（4 文件，576 行）— 前端：MD → IR

**职责**：`shared.ts`（词法/语法共享）+ `domain.ts`/`blueprint.ts`/`profile.ts`（三类资产解析）+ `domain-renderers.ts`（H2×type 双层注册表）+ `index.ts`（mdAdapter + 目录枚举）。

**现状**：T3/T7 已落地——`mdAdapter` 命名正确，parse 注册表与 compile 的 `moduleRenderers` 对称。`extractBareListUnderH3` 等 shared 辅助函数健壮，兼容多种历史写法。

**问题**：
- **重复辅助函数**：`s()`/`sArr()` 在 `shared.ts:234`（导出）、`domain.ts:63`、`domain-renderers.ts:73` 各定义一份——后两者应直接 import shared 的导出。
- **frontmatter 解析是手写 YAML 子集**（`parseScalar`/`parseInlineObject`/`splitTopLevel`）：不支持多行字符串、注释、缩进块。当前资产够用，但任意资产作者写复杂 YAML 会静默丢字段。这是设计边界，非 bug——但应在文档明示"frontmatter 仅支持单行 KV + 内联 `[a,b]` / `{k:v}`"。
- `AssetKind` 联合残留 `"channel"`/`"scene"`/`"manual"`/`"glossary"` 等历史值，注释标了兼容用意，但 `inferKindFromFrontmatter` 的 `validKinds` 列表与之绑定——历史包袱集中在此。

**改进方向**：抽 `s`/`sArr` 到 shared 唯一来源；`AssetKind` 历史值单独标 `@deprecated` 注释或收窄为 `"domain"|"blueprint"|"profile"` + type 字段。

---

### 1.3 `compile/`（3 文件，460 行）— 中端：IR → IR 变换

**职责**：`context.ts`（compileContext 主循环 + `moduleRenderers` 注册表 + sourceHash）+ `type-guards.ts`（运行时收窄）+ `index.ts`（re-export）。

**现状**：T4/T6 落地——type guard 集中管理，renderer 用 guard 不用裸 `as`。`dispatchInjectionPoint` 按 modName 驱动，`registerModuleRenderer` 扩展点干净。`stableStringify` + FNV-1a hash 实现稳定。

**问题**：
- **3 处 `switch(d.type)`** 残留在 `renderSceneModule`/`renderManualModule`/`renderDomainManual`——modName 已注册表化，但 modName 内的 by-type 分发仍是 switch。与 parse 的双层注册表（h2Name × type）不对称。可接受（每 switch 仅 3 case），但若追求一致性可再注册表化。
- **死代码**：`renderGlobalRules()`（context.ts:269）自注释"不在主路径调用，留作未来 registerModuleRenderer 复用"——无调用点。要么接入，要么删除（YAGNI）。
- **hash 强度**：FNV-1a 32-bit + 长度后缀，碰撞空间 ~4.3B。单项目资产量远不到，可接受；但 `sourceHash` 是缓存失效唯一依据，若未来多项目共享 cacheDir 需注意。注释已标"足够用于缓存标识"，决策明确。
- `isRecord()` 在 context.ts:306 与 config.ts:33 重复定义。

**改进方向**：删 `renderGlobalRules`；抽 `isRecord` 到 shared/schema；switch→注册表化作为可选优化（非必须）。

---

### 1.4 `render/`（4 文件，361 行）— 后端：IR → 产物字符串

**职责**：`system-prompt.ts`（聚合 system_prompt 注入点）+ `context-message.ts`（/manual 与 /flow 触发展开）+ `cache.ts`（Context 序列化/反序列化 + hash 校验）+ `index.ts`。

**现状**：`renderSystemPrompt` 极简（21 行）。`bindFlowTemplate` 的 `{{var}}` 占位 + `argumentHint` 解析逻辑完整。cache 的 round-trip + hash mismatch 降级正确。

**问题**：
- **`context-message.ts:203` 双重 cast**：`(bt as unknown as { vars?: unknown }).vars` —— legacy `_vars` 兼容 hack。`BoundableTemplate` 已在类型层定义 `_vars?`，这行可改为直接读 `bt._vars`（type guard `isFlowTemplateArray` 已保证形状）。
- **`renderDomainManual` 与 `renderManualModule` 格式逻辑重复**：两者都按 `d.type` switch 输出 workflow→FlowTemplate 列表 / term→Rule 列表，格式化代码几乎一致。应抽公共 `formatManualBody(d, content)`。
- **`by-injection-point` 缓存未实现**（cache.ts:20-22 TODO）——P4 有意预留，但 `saveContext`/`loadContext` 里 `if (split === "by-injection-point")` 是空分支，配置了静默 fallback。应在分支里 `console.warn` 或走 `compilation.split` 严格校验，避免用户配了不知道。
- **`deserializeContext` 的 H2 切分**用 `exec` + 手动算 start/end 偏移，逻辑略脆（依赖 `## name` 后换行）。可改为复用 `shared.ts` 的 `splitSections`——但 render 层不应依赖 parse 层（三段式隔离）。可在 render 内独立一个小工具，或接受现状。

**改进方向**：消双重 cast；抽 manual 格式化公共函数；by-injection-point 分支加显式 warn。

---

### 1.5 `agent/`（3 文件，196 行）— Agent 适配层 ✅ 健康

**职责**：`pi-adapter.ts`（PiAdapter：before_agent_start + input 事件封装）+ `registry.ts`（按名取 adapter）+ `index.ts`。

**现状**：T9 落地——`AgentAPI` 有 `ui?`/`log?`/`onInjected?`，PiAdapter 的 try/catch 走 `api.log.error` + `api.ui.notify`，不再 swallow。`injectedApi` 去重防止重复注册 handler（switch-injection.test 覆盖）。

**问题**：
- 两个 type guard（`isSystemPromptEvent`/`isInputEvent`）用 `as { systemPrompt?: unknown }` 收窄——这是 type guard 的惯用法，合法。
- `listManuals` 注释"用全集 domains 简化"——与 `renderContextMessage` 一致，但 `commands.ts` 的 `flowsText` 会先 `filterDomainsByProfile` 再传给 `listManuals`，两处 domain 作用域语义不同（一处全集、一处过滤）。目前结果一致（因为 filter 后仍是 workflow Domain 子集），但语义耦合不清晰。

**改进方向**：明确 `listManuals` 的 domains 参数契约（"已按 Profile 过滤"还是"全集"），在 JSDoc 标注。

---

### 1.6 `transpile.ts`（180 行）— 编排层 ⚠️ 过度设计

**职责**：三段式链路 `parse → compile → cache → render`，产出 `TranspileResult`。

**现状与问题**（本文件是结构问题最集中处）：
- **多 bundle 循环是死复杂度**：`sourceAdapters` 数组只有 1 个 adapter（`mdAdapter`），`bundles.length` 恒为 0 或 1。但 `loadAndTranspile` 用 `for (const bundle of bundles)` + 6 个 `lastXxx` 累积变量（`lastContext`/`lastBlueprint`/`lastDomains`/`lastProfile`/`lastActiveProfile` + `anyHit`）模拟多源合并——**当前现实是单源**。这段 ~70 行循环对单 adapter 场景是纯过拟合，且 `lastXxx` 模式让"多 bundle 如何合并 segment"的语义模糊（现在是"后者覆盖前者"，未定义）。
- **`EMPTY_BP`/`EMPTY_PROFILE`/`EMPTY_CTX`** 三个空对象只在 fallback 路径用——而 fallback 只在 `bundles.length===0`（即 mdAdapter 抛错且无内建资产）时触发，极罕见。空 Blueprint（`agent: AGENT_PI`）流出到 `session.activeAdapter = getAgentAdapter("")` 会 fallback 到 pi，看似安全，但 `session.cachedBlueprint` 存一个 `name: ""` 的空对象会让 `statusText` 显示混乱。
- **重复 `reportWarn`/`reportError`/`errMsg`**：与 `parse/index.ts` 完全相同的 3 通道 fallback，定义 2 份。

**改进方向**（高价值）：
1. 抽 `reportWarn`/`reportError`/`errMsg` 到独立 `src/diagnostics.ts`（或 `log.ts` 扩展），parse + transpile 共用。
2. 简化 `loadAndTranspile`：承认单 adapter 现实，写成"load 单 bundle → compile → cache → render"线性流程；保留 `sourceAdapters` 数组但去掉 `lastXxx` 累积，多 bundle 合并语义真正需要时再设计（YAGNI）。
3. fallback 路径：`bundles.length===0` 时直接抛 `Error("no adapter produced bundles")` 让上层 catch，不要返回空 `TranspileResult`——空对象污染 session 状态。

---

### 1.7 `index.ts`（578 行）— Pi 扩展入口 ⚠️ God Module

**职责**：flag/command/tool 注册 + session_start/shutdown/turn 事件处理 + switchProfile + transpileActive + toAgentAPI + profile 持久化（read/persist）+ `_debugActive` + `findFlow`。

**问题**：
- **死代码 2 处**：
  - `findFlow()`（index.ts:177）——无任何调用点（pt_manual 走 `buildManualDoc`→`findFlowInBlueprint` 直连）。且函数体内 `b.blueprints.find((x) => x.name === b.blueprints[0]?.name)` 是 no-op（等价 `b.blueprints[0]`），逻辑混乱。
  - `_debugActive()`（index.ts:564）——export 但无外部消费者，注释"未来可挂 /pt status"，而 `statusText()` 已覆盖等价信息。
- **职责膨胀**：578 行混合 4 类关注点——(a) Pi 注册声明、(b) session 生命周期 handler、(c) AgentAPI 桥接（`toAgentAPI` + WeakMap cache）、(d) profile 持久化（`readProfileFromSession`/`persistProfileToSession` + `PT_PROFILE_ENTRY` 常量 + `MinimalSessionManager` 类型）。
- **事件参数 `as unknown as { reason?... }` × 3**（turn_start/turn_end/tool_call/tool_result）：Pi 事件 args 是 `unknown[]`，当前用双重 cast 提字段。可定义 `PiTurnEndEvent`/`PiToolCallEvent` 本地接口收窄。
- `toAgentAPI` 的 WeakMap + `setContext` 闭包更新 `currentCtx` —— 正确（保证同 runtime 复用同 wrapper），但逻辑密度高，值得抽成独立 `src/agent/api-bridge.ts`。

**改进方向**（中价值）：
1. 删 `findFlow` + `_debugActive`（或给 `_debugActive` 加 `@internal` 并真正挂到某处）。
2. 拆分：`src/entry/`（注册声明）+ `src/lifecycle/`（session handlers）+ `src/agent/api-bridge.ts`（toAgentAPI）+ profile 持久化并入 `src/config.ts` 或新建 `src/profile-persist.ts`。
3. 定义 Pi 事件本地接口替代双重 cast。

---

### 1.8 支撑层：`session.ts` / `config.ts` / `constants.ts` / `log.ts`

**`session.ts`（67 行）✅**：T11 落地，单例 state + `resetSession`，`loadedFrom` 可观测性字段清晰。

**`config.ts`（70 行）✅**：`listProfiles` 合并项目+内建语义与 `mdAdapter` 一致（有注释说明 why）。`isRecord` 与 compile 重复（小问题）。

**`constants.ts`（91 行）✅**：T1 落地，路径 + 段名 + target + agent 名集中。注释明确"注入点名不该常量化"——T13 措辞修正完成。

**`log.ts`（173 行）✅**：per-session PtLogger，串行写链，`tail`/`clear`/`list` 静态方法支持 `/pt logs`。`console.error("[pt-log] write failed")` 是 logger 自身失败兜底，合理。

**横切**：`isRecord` 重复（config + compile）；`errMsg` 重复 3 处（index + parse + transpile）。

---

### 1.9 `verify/`（9 文件，~200 行）— Probe 实现库 ✅ 健康

**职责**：`index.ts`（注册表 + runVerify）+ 8 个 probe 实现。

**现状**：注册表干净，`runVerify` try/catch 降级 INCONCLUSIVE。`as { stderr?: Uint8Array }` × 3 是错误对象收窄，合法。

**改进**：8 个 probe 的 `catch (e)` 块几乎一致（Buffer from stderr），可抽 `readStderr(e)` 辅助。小优化。

---

### 1.10 `commands.ts`（145 行）— 命令/工具共享内核 ✅ 良好

**现状**：command + tool 双注册共享纯函数内核（statusText/flowsText/buildManualDoc），设计文档化。`filterDomainsByProfile` 纯函数。

**问题**：
- `buildManualDoc` 里 `(t as { name?: string }).name`（commands.ts:93）——可用 `isFlowTemplateLike` 收窄。
- `flowsText` 用 `session.cachedBundles[0]` 取第一个 bundle——隐含单 bundle 假设（与 transpile 的多 bundle 设计矛盾，进一步印证多 bundle 是死路径）。

---

## 2. 横切问题汇总

| # | 问题 | 证据 | 影响 |
|---|---|---|---|
| X1 | **辅助函数重复** | `errMsg`×3、`reportWarn/Error`×2、`s/sArr`×3、`isRecord`×2 | 维护负担，改一处忘另一处 |
| X2 | **死代码** | `findFlow`、`_debugActive`、`renderGlobalRules` | 认知噪音，读者误以为有效路径 |
| X3 | **transpile 多 bundle 死复杂度** | 单 adapter 但写多 bundle 循环 + 6 个 lastXxx | 语义模糊，`bundles[0]` 假设散落 |
| X4 | **index.ts 膨胀** | 578 行混合 4 类关注点 | 难定位、难测试 |
| X5 | **测试覆盖单薄** | 76 用例全端到端，parse/compile/render/cache/log 无单元测试 | 改动连锁失败，无法隔离定位 |
| X6 | **legacy cast 残留** | `context-message.ts:203` 双重 cast、`commands.ts:93`、index 事件 cast ×3 | 类型安全最后一公里 |
| X7 | **`au.` 前缀历史遗留** | open issue：`au.pt-context` settings 键 | 用户配置名不一致 |

---

## 3. 阶段改进方案

按"低风险高收益先做 + 依赖关系排序"分四阶段。每阶段独立可验收，互不阻塞。

### 阶段 P0 — 去噪与去重（无行为变更，纯整洁）

**目标**：消除死代码与重复，降低后续改动的认知负担。零行为风险。

| 项 | 动作 | 文件 | 验收 |
|---|---|---|---|
| P0.1 | 删 `findFlow`（无调用 + 逻辑错误） | index.ts | `grep findFlow src/` = 0 |
| P0.2 | 删或挂载 `_debugActive` | index.ts | 无悬空 export |
| P0.3 | 删 `renderGlobalRules`（无调用） | compile/context.ts | `grep renderGlobalRules` = 0 |
| P0.4 | 抽 `errMsg`/`reportWarn`/`reportError` 到 `src/diagnostics.ts` | 新文件 + parse/transpile/index | 3 处定义→1 处 |
| P0.5 | 抽 `s`/`sArr` 唯一来源（import shared） | domain.ts、domain-renderers.ts | 3 处→1 处 |
| P0.6 | 抽 `isRecord` 到 shared 或 schema | config.ts、compile/context.ts | 2 处→1 处 |
| P0.7 | 修 `au.pt-context` → `pt.context`（兼容读旧键） | index.ts、config.ts | issue `au-prefix-tech-debt` 关闭 |

**验收**：`npm run typecheck` + `npm run verify`（76 tests）全过；grep 指标下降。

**commit 建议**：单个 commit `refactor: P0 去噪去重（死代码 + 重复辅助函数 + au 前缀）`。

---

### 阶段 P1 — transpile 简化 + index 拆分（结构重构）

**目标**：消除死复杂度，拆 God Module。依赖 P0（诊断函数已集中）。

| 项 | 动作 | 依赖 |
|---|---|---|
| P1.1 | `loadAndTranspile` 改线性单 bundle 流程，删 `lastXxx` 累积；保留 `sourceAdapters` 数组但简化合并语义 | P0.4 |
| P1.2 | `bundles.length===0` 时抛错而非返空 TranspileResult | P1.1 |
| P1.3 | 拆 `index.ts`：抽 `src/agent/api-bridge.ts`（toAgentAPI + WeakMap） | — |
| P1.4 | 抽 profile 持久化到 `src/profile-persist.ts`（readProfileFromSession/persistProfileToSession/PT_PROFILE_ENTRY/MinimalSessionManager） | — |
| P1.5 | index.ts 仅留注册声明 + session 生命周期 handler 调度 | P1.3/P1.4 |

**验收**：
- `index.ts` < 300 行
- `transpile.ts` < 120 行
- `switch-injection.test` + `persist-profile.test` 全过（行为不变）
- 所有 76 tests 全过

**commit 建议**：分 2–3 个 commit（先 transpile 简化，再 index 拆 api-bridge，再拆 profile-persist）。

---

### 阶段 P2 — 类型安全最后一公里 + 测试补强

**目标**：清 legacy cast，补单元测试隔离各层。依赖 P1（结构已稳）。

| 项 | 动作 |
|---|---|
| P2.1 | 消 `context-message.ts:203` 双重 cast：直接读 `bt._vars`（guard 已保证形状） |
| P2.2 | `commands.ts:93` 用 `isFlowTemplateLike` 收窄 |
| P2.3 | 定义 Pi 事件本地接口（`PiTurnEndEvent` 等），消 index ×3 双重 cast |
| P2.4 | 补 `parse/` 单元测试：直接喂 MD 字符串测 domain/blueprint/profile parser（不走 loadAndTranspile） |
| P2.5 | 补 `compile/context.ts` 单元测试：mock Profile+Blueprint+Domains 测 compileContext + sourceHash 稳定性 |
| P2.6 | 补 `render/cache.ts` round-trip 测试：save→load 命中、hash mismatch 降级、损坏文件返 null |
| P2.7 | 补 `log.ts` PtLogger 测试：write 链顺序、tail 解析、clear |

**验收**：
- 真实 `as` 问题数 ≤2
- 测试用例数 → 120+
- parse/compile/render/cache/log 各有独立测试文件

**commit 建议**：cast 清理 1 个 commit；测试补强按模块分多个 commit。

---

### 阶段 P3 — 可选优化与一致性（非必须）

**目标**：追求极致一致性与扩展性预留。不阻塞主线，按需推进。

| 项 | 动作 | 取舍 |
|---|---|---|
| P3.1 | compile 的 3 处 `switch(d.type)` 改双层注册表（与 parse 对称） | 可选——switch 3 case 可读性好，收益边际 |
| P3.2 | `by-injection-point` 缓存实现 or 删分支标 `@deprecated` | 看是否有多注入点独立缓存需求 |
| P3.3 | frontmatter 解析替换为真 YAML 库（如 `yaml`） | 重量级，仅当资产复杂度超出单行 KV 才做 |
| P3.4 | `AssetKind` 历史值清理（`channel`/`scene`/`manual`/`glossary`） | 需确认无历史资产依赖 |
| P3.5 | `verify/` 抽 `readStderr(e)` 公共辅助 | 微优化 |
| P3.6 | `renderDomainManual` 与 `renderManualModule` 格式逻辑抽公共 `formatManualBody` | 消重复 |
| P3.7 | `listManuals` 的 domains 参数契约 JSDoc 标注 | 消语义歧义 |

---

### 阶段 P4 — 发布形态演进：dev（src）→ 发布（dist）

**目标**：把 dev 形态（src/.ts）演进为发布形态（dist/.js），使 Pt 能作为多 agent 扩展发布。依赖 P1–P3 结构稳定。详见 §10。

| 项 | 动作 | 依赖 |
|---|---|---|
| P4.1 | 新增 `tsconfig.build.json`（emit + declaration + outDir: dist） | P1–P3 |
| P4.2 | `package.json` 改 files/main/types/pi.extensions + 加 build/prepublishOnly | P4.1 |
| P4.3 | build 脚本加 builtin 资产复制步骤 | P4.2 |
| P4.4 | 验证 pi 加载 `./dist/index.js` + 76 tests 全过 | P4.3 |

**验收**：`npm run build` 产出 `dist/index.js` + `dist/index.d.ts` + `dist/builtin/assets/*.md`；pi 加载 dist 扩展功能与 src 一致。

---

## 4. 度量基线与目标

| 指标 | 当前 | P0 后 | P1 后 | P2 后 |
|---|---|---|---|---|
| `index.ts` 行数 | 578 | ~560 | <300 | <300 |
| `transpile.ts` 行数 | 180 | 180 | <120 | <120 |
| 死代码函数 | 3 | 0 | 0 | 0 |
| 重复辅助函数定义点 | 10（errMsg×3 + rW×2 + rE×2 + s×2 + sArr×2，加 isRecord×2 共 12） | 0 | 0 | 0 |
| 真实 `as` 问题 | ~6 | ~6 | ~6 | ≤2 |
| 单元测试文件（parse/compile/render/cache/log） | 0 | 0 | 0 | 5 |
| 总测试用例 | 76 | 76 | 76 | 120+ |
| `au.` 前缀 | 1 issue open | closed | closed | closed |

---

## 5. 执行顺序建议

**立即可做（P0）**：纯去噪去重，零行为风险，一次 commit 即可，基线回退成本最低。建议先做。

**次优（P1）**：transpile 简化 + index 拆分是结构收益最大项，但需小心 `switch-injection.test` 与 `persist-profile.test` 两个行为测试守护。建议分 2–3 个 commit（先 transpile，再 index 拆分）。

**补强（P2）**：测试补强应在 P1 结构稳定后做——否则单元测试会随重构失效。cast 清理可与之并行。

**按需（P3）**：留给后续迭代，不阻塞主线。

---

## 6. 风险与守护

- **行为守护**：P0/P1 每步后必跑 `npm run typecheck` + `npm run verify`（76 tests），不跳过不绕过。`switch-injection.test`（4 用例）和 `persist-profile.test`（13 用例）是 P1 的关键回归门。
- **资产改动**：P0.7（`au.` → `pt.`）涉及 settings 键名，需保留旧键兼容读取（读 `pt.context` 失败 fallback 读 `au.pt-context`），避免破坏现有用户配置。
- **回退策略**：每阶段一个 commit，`git revert` 即可整体回退。

---

## 7. npm 包与 src 模块结构深度分析

> 本节是 §1 模块分析的深化，回答"发布形态 / 依赖图 / 资产合并"三个问题，为 P1 结构重构提供依据。

### 7.1 npm 包发布形态

```
@issac/pi-pt@0.1.0
files: ["src"]              ← 发布整个 src/ 目录（含 builtin 资产 .md）
pi.extensions: ["./src/index.ts"]   ← Pi 直接吃 .ts（jiti 运行时转译），不编译
type: "module" / ESM
peerDependencies: pi-ai / pi-coding-agent / typebox（都是 *，由宿主 pi 提供）
devDependencies: tsx / typescript / vitest（不发布）
```

**关键事实**：

1. **不编译，直接发 .ts**。pi-coding-agent 的 extension loader（`dist/core/extensions/loader.js`）用 `createJiti` + `jiti.import(extensionPath)` 运行时转译 .ts——jiti 是 pi 的 dependency（`jiti: 2.7.0`），**宿主 pi 自带 TS 加载能力，用户无需装 tsx**。所以 `src/` 既是源码也是发布产物，**没有 dist 中间层**。
2. **`files: ["src"]` 把 builtin 资产也打包发布**。`src/builtin/assets/*.md`（3 domain + 1 blueprint + 1 profile）随 npm 包分发给所有安装者。这是 v9 "内建资产跨项目复用"的载体。
3. **`.pi/settings.json` 的 `packages: [".."]`** 指向父目录——当前是 dev 模式（包目录 = 项目目录）。发布后用户通过 `pi install @issac/pi-pt` 安装，pi 从 `node_modules/@issac/pi-pt/src/index.ts` 加载。
4. **peerDependencies 用 `*`**——不锁版本，宿主 pi 升级可能破坏兼容。当前只用了 `ExtensionAPI` / `ExtensionContext` / `ExtensionCommandContext` / `CONFIG_DIR_NAME` / `withFileMutationQueue` 这几个稳定 API，风险可控但应标注版本下限。

### 7.2 发布形态：当前 dev（src/.ts）→ 最终发布（dist/.js）

**结论翻转**：当前 `files: ["src"]` + `pi.extensions: ["./src/index.ts"]` 是 **dev 形态**，不是最终发布形态。最终应走向 `dist/.js` + `dist/.d.ts`，与 pi 自身的发布模式一致。

#### 7.2.1 pi 自身的双轨模式（证据）

pi-coding-agent 自己就是 dev 用 src、发布用 dist：
- `package.json`: `main: "./dist/index.js"`, `types: "./dist/index.d.ts"`, `files: ["dist", ...]`（**不发布 src**）
- `dist/config.js` 注释明示：`For Node.js (dist/): dist/modes/...` vs `For tsx (src/): src/modes/...`
- pi 开发时用 tsx 跑 `src/*.ts`，发布时用 `dist/*.js`

**Pt 应跟此模式一致**：当前 dev 阶段发 src/.ts（pi 用 jiti 加载），未来发布阶段发 dist/.js。

#### 7.2.2 pi 完全支持加载 dist 扩展

pi 的 extension loader（`dist/core/extensions/loader.js`）同时支持 .ts 和 .js：
- `isExtensionFile(name)`: `name.endsWith(".ts") || name.endsWith(".js")`
- `resolveExtensionEntries`: 读 `package.json` 的 `pi.extensions` 字段声明的路径（可以是 `./dist/index.js`）
- `jiti.import(extensionPath)`: jiti 既能加载 .ts（运行时转译）也能加载 .js（直接 native import）

所以 `pi.extensions: ["./dist/index.js"]` 完全可行——pi 加载 dist/.js 不走 TS 转译，启动更快。

#### 7.2.3 非 pi agent 场景（AgentAdapter 目标）

v9 的 `AgentAdapter` 抽象层（`schema.ts`）设计目标就是多 agent：
- `PiAdapter` 是当前唯一实现（封装 pi 的 `before_agent_start` + `input` 事件）
- 未来可加 `CodexAdapter` / `OpenCodeAdapter`（`agent/registry.ts` 已预留）

其他 agent（Codex/OpenCode/...）**不会用 pi 的 jiti 加载扩展**——它们有自己的扩展机制，通常只吃标准 ESM `.js`。Pt 要作为多 agent 扩展发布，**必须提供 dist/.js**。

这就是 dist 的核心必要性：AgentAdapter 抽象让 Pt 的编译内核（parse/compile/render）与 agent 注入解耦，但**扩展加载机制仍受目标 agent 约束**——pi 能吃 .ts，其他 agent 不能。

#### 7.2.4 何时引入 dist

| 阶段 | 形态 | 理由 |
|---|---|---|
| 当前 dev（P0–P3） | `src/.ts` + `noEmit` | 结构重构期，源码即产物，pi 用 jiti 加载，改完即跑 |
| 发布（P4） | `dist/.js` + `.d.ts` | 结构稳定后，加 build 步骤，发编译产物，兼容多 agent |

**不在 P0–P3 引入 dist 的理由**：结构重构期源码频繁变动，加 build 步骤增加 CI 复杂度；pi 用 jiti 加载 .ts 让 dev 反馈环最短（改 .ts 即生效，无需编译）。**P4 发布阶段再引入 dist**（详见 §10）。

### 7.3 src 模块依赖图（从 import 分析得出）

按依赖方向分层（箭头 = "依赖"）：

```
┌─────────────────────────────────────────────────────────────┐
│ 层 0 契约（零依赖，所有人依赖它）                           │
│   schema.ts ← constants.ts ← log.ts                         │
│   （schema/constants/log 互不依赖 src 内其他模块）           │
├─────────────────────────────────────────────────────────────┤
│ 层 1 parse 前端（只依赖层 0 + 自身）                         │
│   parse/shared.ts        ← 零依赖                            │
│   parse/domain.ts        ← shared + domain-renderers + 0    │
│   parse/blueprint.ts     ← shared + 0                        │
│   parse/profile.ts       ← shared + 0                        │
│   parse/domain-renderers ← shared + 0                        │
│   parse/index.ts         ← 上述全部 + 0                      │
├─────────────────────────────────────────────────────────────┤
│ 层 2 compile 中端（只依赖层 0）                              │
│   compile/type-guards.ts ← schema                            │
│   compile/context.ts     ← type-guards + schema + constants  │
├─────────────────────────────────────────────────────────────┤
│ 层 3 render 后端（只依赖层 0 + 层 2 的 type-guards）         │
│   render/system-prompt.ts ← schema                           │
│   render/cache.ts         ← schema                           │
│   render/context-message.ts ← schema + constants +          │
│         compile/type-guards  ⚠️ （render 依赖 compile）      │
├─────────────────────────────────────────────────────────────┤
│ 层 4 agent 适配（依赖层 0 + 层 2 + 层 3）                    │
│   agent/pi-adapter.ts ← schema + constants +                │
│         compile/type-guards + render/context-message +      │
│         render/system-prompt                                 │
├─────────────────────────────────────────────────────────────┤
│ 层 5 编排（依赖层 1+2+3）                                   │
│   transpile.ts ← parse/index + compile/context +            │
│         render/cache + render/system-prompt + 0              │
├─────────────────────────────────────────────────────────────┤
│ 层 6 支撑                                                    │
│   config.ts ← constants  （isRecord 重复）                   │
│   session.ts ← schema + log                                  │
│   commands.ts ← constants + render/context-message +        │
│         session + schema                                     │
├─────────────────────────────────────────────────────────────┤
│ 层 7 入口（依赖全部）                                       │
│   index.ts ← constants + agent + config + log +              │
│         render/context-message + session + commands +        │
│         transpile + schema                                   │
├─────────────────────────────────────────────────────────────┤
│ 层 8 verify（独立子系统，只依赖 schema）                     │
│   verify/*.ts ← schema （8 个 probe）                        │
│   verify/index.ts ← 8 个 probe                               │
└─────────────────────────────────────────────────────────────┘
```

### 7.4 三个结构性发现

**发现 A：依赖方向整体健康，但有 1 处逆向**。`render/context-message.ts` 依赖 `compile/type-guards.ts`——后端依赖中端。原因是 type-guards 被当作"运行时收窄工具库"共用，但它物理位置在 compile/ 下。**type-guards 应该是层 0.5（契约层的一部分），不是 compile 的私产**。它被 render 和 agent 都依赖，放 compile/ 是历史遗留（T4 时就近放的）。这是 §8 顶层架构调整的核心依据之一。

**发现 B：transpile 是唯一的多源编排点，但被设计成单源**。`sourceAdapters: [mdAdapter]` 单元素数组 + 多 bundle 循环 = 死复杂度（已在 §1.6 标注）。但从架构看，`SourceAdapter` 接口本身是对的——问题在实现层过拟合。接口保留，实现简化。

**发现 C：builtin 资产与项目资产完全解耦，靠同名 blueprint 合并**。builtin 有 3 个独有 domain（authoring/usage/project-analysis），项目有 11 个独有 domain，两者无重叠；唯一共享是同名 `dev-knowledge.blueprint.md`（内容逐字节相同）。`dedupByName` 项目优先覆盖 builtin。这个设计干净——**builtin 是"开箱即用的通用 Pt 知识"，项目是"业务特定知识"，两者通过 Blueprint 结构复用**。

**但有一个隐患**：builtin 的 `dev-knowledge.blueprint.md` 与项目的完全相同，如果 builtin 版本升级（加新注入点/改 mode），项目同名文件会覆盖它，用户拿不到 builtin 的升级。**Blueprint 不该 dedup，应该项目引用 builtin（不自己重写）**，或者 builtin blueprint 用不同名让项目 profile 引用。详见 §9.4。

---

## 8. 顶层架构目标

> 本节是 P1 阶段（transpile 简化 + index 拆分）的目标架构依据。不推翻 v9 四层模型，只在模块边界上做三处调整。

### 8.1 目标依赖图

```
┌──────────────────────────────────────────────────────────────┐
│ 契约层 src/contract/  （零依赖，稳定锚）                      │
│   schema.ts         IR 定义 + SourceAdapter/AgentAdapter 接口  │
│   constants.ts      路径/段名/target/agent 名                 │
│   type-guards.ts    ← 从 compile/ 迁入（被多层共用，不该属中端）│
│   diagnostics.ts    ← 新增：errMsg/reportWarn/reportError 公共 │
├──────────────────────────────────────────────────────────────┤
│ 基础设施 src/runtime/  （零业务依赖）                         │
│   log.ts            PtLogger                                   │
│   session.ts        SessionState 单例                          │
│   config.ts         settings 读取 + profile 探测               │
├──────────────────────────────────────────────────────────────┤
│ 三段式 src/parse/ src/compile/ src/render/  （保持，边界收紧） │
│   parse/      ← 只依赖 contract/                               │
│   compile/    ← 只依赖 contract/ （不再私藏 type-guards）      │
│   render/     ← 只依赖 contract/ （不再依赖 compile/）         │
├──────────────────────────────────────────────────────────────┤
│ 编排 src/transpile.ts  （简化为单源线性）                     │
│   ← 依赖 parse + compile + render + contract                   │
├──────────────────────────────────────────────────────────────┤
│ Agent 适配 src/agent/  （依赖 contract + render）              │
│   pi-adapter.ts / registry.ts / api-bridge.ts ← 从 index 抽出  │
├──────────────────────────────────────────────────────────────┤
│ Pi 入口 src/index.ts  （只做注册声明 + 生命周期调度）          │
│   ← 依赖 agent + transpile + runtime + commands               │
│   profile-persist.ts ← 从 index 抽出                           │
├──────────────────────────────────────────────────────────────┤
│ verify/  （独立子系统，保持）                                  │
│   ← 只依赖 contract/                                           │
├──────────────────────────────────────────────────────────────┤
│ commands.ts  （命令/工具共享内核，保持）                       │
│ builtin/assets/  （随包发布的通用资产，保持）                  │
└──────────────────────────────────────────────────────────────┘
```

### 8.2 三处核心调整

**调整 1：抽出 `src/contract/` 契约层（含 type-guards 迁移）**

把 `schema.ts` + `constants.ts` + `type-guards.ts` + 新增 `diagnostics.ts` 收拢到 `src/contract/`。理由：
- `type-guards.ts` 被 compile/render/agent 三层共用，放 compile/ 是"中端私藏公共工具"——物理位置误导架构语义（§7.4 发现 A）。
- `diagnostics.ts`（errMsg/reportWarn/reportError）当前重复 3 处，该与 schema 同级（它是"错误报告契约"）。
- 契约层是"所有人依赖、不依赖任何人"的稳定锚，独立目录让依赖关系可视化。

**调整 2：拆 `index.ts` God Module**

`index.ts` 578 行混 4 类关注点，拆为：
- `src/agent/api-bridge.ts` —— `toAgentAPI` + WeakMap（Pi ExtensionAPI → AgentAPI 桥接）
- `src/profile-persist.ts` —— `readProfileFromSession` / `persistProfileToSession` / `PT_PROFILE_ENTRY` / `MinimalSessionManager`（session JSONL 持久化）
- `src/index.ts` 瘦身到 < 300 行，只剩：flag/command/tool 注册声明 + session_start/shutdown/turn handler 调度 + switchProfile/transpileActive 两个编排函数。

**调整 3：简化 `transpile.ts` 为单源线性**

承认 `sourceAdapters` 当前只有 mdAdapter，去掉多 bundle 循环 + 6 个 `lastXxx`。保留 `SourceAdapter` 接口和 `sourceAdapters` 数组（扩展点不删），但 `loadAndTranspile` 改成：
```
load 单 bundle（取第一个成功的 adapter）
  → findProfile → findBlueprint → compileContext
  → cache.load? 命中用缓存 : cache.save
  → renderSystemPrompt
  → 返回 TranspileResult
```
多源合并语义真正需要时再设计（YAGNI，但要明确：未来加 yamlAdapter 时，合并策略是 "union domains" 还是 "后者覆盖"？这需要单独设计，不是现在能预见的）。

### 8.3 明确不做的事（边界）

- **不改 v9 四层语义**（Domain/Blueprint/Profile/Context 不动）。
- **当前阶段（P0–P3）不引入 dist**——dev 形态发 src/.ts，pi 用 jiti 加载，反馈环最短。dist 在 P4 发布阶段引入（详见 §7.2.4 + §10）。
- **不拆成 monorepo**——3752 行单包足够，子包拆分是发布优化，当前无需求。
- **不把 builtin 资产外移**——`src/builtin/assets/` 随包发布是对的（跨项目复用 dev-knowledge 结构）。P4 引入 dist 时 builtin 资产随 dist 一起复制（.md 不编译）。

---

## 9. Domain 配合修改清单

> src 模块结构变动会触发几个 Domain 资产同步修改。按 v9 "代码路径常量在 constants.ts，资产 directory-layout 场景是声明式 spec" 的约定，改代码路径常量必须同步改 asset-workflow Domain。

### 9.1 必须修改：`asset-workflow` Domain

**`directory-layout` 场景**当前明示引用 `src/constants.ts`：
> 改布局就改本场景——当前代码路径常量在 src/constants.ts 需手动同步

架构调整若把 `constants.ts` 迁到 `src/contract/`，该场景的引用必须同步改为 `src/contract/constants.ts`。否则资产与代码不一致，破坏"声明式 spec"的可信度。

**`verify-loop` 场景**当前写"vitest 34 tests"（实际已 76），需同步数字。建议改为不写死数字（"跑 `npm run verify` 全过"），避免每次加测试都改资产。

**`asset-types` 场景**描述了 Domain/Blueprint/Profile 三类资产，不含 src 模块路径，不需改。

### 9.2 架构落地后修改：`pt-quality` Domain

pt-quality 的 9 条 invariant 是代码规范契约。架构调整引入新规范需求，但 **不宜在架构落地前改**（T13 措辞修正刚完成，频繁变动不利稳定）。建议 P1 落地后补 1–2 条新 invariant：

- 候选 A：`contract-layer-purity` —— "type-guards 属契约层，不放中端；diagnostics 与 schema 同级"。
- 候选 B：`entry-layer-purity` —— "入口层只做注册声明 + 生命周期调度，不混桥接/持久化/编排逻辑"。

现有 9 条不变：`parse-extension-registry`（parse/compile 注册表设计保持）、`modules-type-safety`（type-guards 迁位置不改用法）等。

### 9.3 评估后决定：`product-design` / `me` Domain

- `product-design` 的 `three-segment-architecture` / `renderer-registry` 等 Scene 项描述的是**架构概念**（parse/compile/render 三段），架构调整不改变三段式，只调整 type-guards 归属——概念层无需改。
- `me` 的 `pt-goal` / `collab-mode` 是协作偏好，与代码结构无关，不动。

### 9.4 builtin 资产去重（架构隐患修复）

`src/builtin/assets/blueprints/dev-knowledge.blueprint.md` 与项目 `.pt/assets/blueprints/dev-knowledge.blueprint.md` 逐字节相同——项目覆盖 builtin，用户拿不到 builtin 升级。两个方案：

- **方案 A（推荐）**：删除项目的 `.pt/assets/blueprints/dev-knowledge.blueprint.md`，让项目 profile 直接引用 builtin 的。项目只保留 domain/profile，builtin 提供 blueprint 结构。builtin blueprint 升级自动生效。
- **方案 B**：builtin blueprint 改名（如 `_base.blueprint.md`），项目用自己的 `dev-knowledge` 引用 `_base` 或重写。复杂，不推荐。

方案 A 需要改 `asset-workflow` 的 `asset-types` 场景（明确"Blueprint 可只由 builtin 提供，项目不重写"）。

### 9.5 不需要修改的 Domain

`me` / `pt-collab` / `requirements` / `development` / `testing` / `deployment` / `ci-cd` / `issues` —— 这些是业务/流程知识，与 src 模块结构无关。

---

## 10. 发布形态演进：dev（src）→ 发布（dist）

> 本节规划 P4 发布阶段：把 dev 形态（src/.ts）演进为发布形态（dist/.js），使 Pt 能作为多 agent 扩展发布。

### 10.1 目标发布形态

**dev 形态（当前，P0–P3）**：
```jsonc
// package.json（当前）
{
  "files": ["src"],
  "pi": { "extensions": ["./src/index.ts"] },
  // 无 main / types / build 脚本
}
// tsconfig.json：noEmit: true
```

**发布形态（P4 目标）**：
```jsonc
// package.json（目标）
{
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "files": ["dist"],
  "pi": { "extensions": ["./dist/index.js"] },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "prepublishOnly": "npm run build && npm run verify",
    // typecheck / verify 保持
  }
}
// tsconfig.build.json：noEmit: false, declaration: true, outDir: "dist"
// .gitignore 加 dist/（产物不入 git）
```

### 10.2 关键配置变更

| 项 | dev（当前） | 发布（P4） | 说明 |
|---|---|---|---|
| `tsconfig` | `noEmit: true` | 新增 `tsconfig.build.json`（`noEmit: false`, `declaration: true`, `outDir: "dist"`） | dev 的 noEmit 保留（typecheck 用）；build 用独立 tsconfig |
| `package.json.files` | `["src"]` | `["dist"]` | 不发布 src（源码在 git） |
| `package.json.main` | 无 | `"./dist/index.js"` | 非 pi 宿主 import 入口 |
| `package.json.types` | 无 | `"./dist/index.d.ts"` | TS 消费者类型入口 |
| `package.json.pi.extensions` | `["./src/index.ts"]` | `["./dist/index.js"]` | pi 加载入口 |
| `package.json.scripts.build` | 无 | `"tsc -p tsconfig.build.json"` | 编译步骤 |
| `.gitignore` | 已排除 `*.js`/`dist/` | 保持 | dist 产物不入 git |

### 10.3 builtin 资产处理

`constants.ts` 用 `import.meta.url` 定位 builtin：
```typescript
const SRC_DIR = dirname(fileURLToPath(import.meta.url));
export const BUILTIN_ASSETS_DIR = join(SRC_DIR, "builtin", "assets");
```

dev 形态下 `import.meta.url` 指向 `src/index.ts`，找 `src/builtin/assets/`（存在）。发布形态下 `import.meta.url` 指向 `dist/index.js`，需找 `dist/builtin/assets/`——但 builtin 是 .md 文件，tsc 不编译 .md，`dist/builtin/` 不存在。

**方案**：build 脚本加复制步骤：
```jsonc
"build": "tsc -p tsconfig.build.json && cp -r src/builtin/assets dist/builtin/assets"
```
（跨平台用 `cpy-cli` 或 Node 脚本替代 `cp -r`）

这样 `constants.ts` 不动，`BUILTIN_ASSETS_DIR` 在 dist 里也能找到 builtin 资产。

### 10.4 P4 执行清单

| 项 | 动作 | 依赖 |
|---|---|---|
| P4.1 | 新增 `tsconfig.build.json`（emit + declaration + outDir: dist） | P1–P3 结构稳定 |
| P4.2 | `package.json` 改 files/main/types/pi.extensions + 加 build/prepublishOnly 脚本 | P4.1 |
| P4.3 | build 脚本加 builtin 资产复制步骤 | P4.2 |
| P4.4 | `.gitignore` 加 `dist/`（已排除，确认） | — |
| P4.5 | 验证：`npm run build` 产出 dist/ + dist/builtin/assets/ | P4.3 |
| P4.6 | 验证：pi 加载 `./dist/index.js` 成功（改 .pi/settings 或临时测） | P4.5 |
| P4.7 | 验证：`npm run verify` 在 dist 形态下全过 | P4.6 |

**验收**：`npm run build` 无错；`dist/index.js` + `dist/index.d.ts` + `dist/builtin/assets/*.md` 齐全；pi 加载 dist 扩展功能与 src 一致；76 tests 全过。

### 10.5 P4 不做的事

- **不发独立子包**（如 `@issac/pi-pt-core` 拆 IR/parse/compile）——当前无独立库化需求，单包 dist 够用。
- **不做 tree-shaking / bundle 优化**——pi 扩展是 Node ESM，tsc 直出即可，无需 esbuild/rollup。
- **不锁 peerDependencies 版本**——保持 `*`，由宿主提供（pi 升级时再评估兼容性）。

---

## 附录：审计数据快照（基线 db25b60）

```
src/ 30 文件 3752 行
  index.ts        578  ← God Module
  schema.ts       358
  parse/shared.ts 353
  compile/context 317
  render/context- 211
  transpile.ts    180  ← 死复杂度
  agent/pi-adapt   176
  log.ts           173
  commands.ts      145
  compile/type-g   140
  parse/blueprint  114
  render/cache     117
  parse/domain-ren 118
  parse/index      156
  ...

as 断言 25 处（真实问题 ≤6）
switch 3 处（renderer 内 by-type，可接受）
console.* 4 处（3 通道 fallback 末位，合规）
死代码函数 3（findFlow / _debugActive / renderGlobalRules）
重复辅助 12 定义点（errMsg×3 + reportWarn×2 + reportError×2 + s×2 + sArr×2 + isRecord×2）
测试 6 文件 76 用例（全端到端，无单元测试）
```
