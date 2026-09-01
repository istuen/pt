# Pt 技术债清单 + pt-quality 规范执行审计

> **基线**：commit `86b5327`（Phase 9.9 v9 完整实现）
> **审计日期**：2026-09-02
> **审计范围**：`src/` 全部代码 + `package.json` + `tests/`
> **用途**：执行者按本清单逐项处理，每项标 [ ] 待办 / [x] 已清

---

## 一、pt-quality 9 条规范执行审计

逐条检查 v9 代码对 pt-quality Domain 9 条 invariant 的执行情况。

### 1. modules-type-safety

> **规范**：`Domain.modules 读取必须用 type guard，不用 as 断言`
> **状态**：❌ **违反（严重）**

**证据**：
- `Domain.modules: Record<string, unknown>`（schema.ts:155）—— type hole，读出来都是 `unknown`
- 全库 27 处 `as` 断言读 modules 内容：
  - `src/compile/context.ts` 9 处（如 `content as Array<{ name: string; desc: string }>`）
  - `src/render/context-message.ts` 5 处（如 `content as Array<FlowTemplateLite>`）
  - `src/agent/pi-adapter.ts` 4 处（如 `manual as Array<{ name: string; argumentHint?: string }>`）
  - `src/parse/blueprint.ts` 9 处（frontmatter 值收窄）
  - `src/index.ts` 3 处（`d.modules["Manual"] as unknown[]`）

**根因**：Domain 的 H2 段内容是 `unknown`，消费者（compile/render/agent）各自 `as` 断言——没有 type guard 函数。

**修复方向**：
- 新增 `src/compile/type-guards.ts`：`isTermArray(x): x is Term[]` / `isRuleArray(x): x is Rule[]` / `isFlowTemplateArray(x): x is FlowTemplate[]` 等
- 各 renderer 用 type guard 收窄，不用 `as`
- 或：parse 阶段就给 Domain.modules 标类型（`Record<string, Term[] | Rule[] | FlowTemplate[] | ...>`，但牺牲 H2 开放性）

---

### 2. no-duplicate-type

> **规范**：`禁止重复定义相似类型，用 Pick/Partial 从 schema 派生`
> **状态**：❌ **违反**

**证据**：
- `FlowTemplateLite` 重复定义 2 处：
  - `src/compile/context.ts:33` — `{ name: string; argumentHint?: string }`
  - `src/render/context-message.ts:101` — 完全相同
- `RuleLite` 在 `src/render/context-message.ts:106` 重复 Rule 的部分字段
- `BoundableTemplate = FlowTemplate & { _vars?: string[] }` 在 `render/context-message.ts:13` + `parse/domain.ts:125` 各用一次 `as FlowTemplate & { _vars?: string[] }`

**修复方向**：
- `FlowTemplateLite` 应从 `FlowTemplate` 派生：`type FlowTemplateLite = Pick<FlowTemplate, "name" | "argumentHint">`
- `RuleLite` 应从 `Rule` 派生：`type RuleLite = Pick<Rule, "type" | "check" | "items">`
- 集中到 `src/schema.ts` 或新建 `src/types-lite.ts`

---

### 3. parse-extension-registry

> **规范**：`parse 扩展用注册表，不用 switch-case（与 compile 的 moduleRenderers 一致）`
> **状态**：❌ **违反**

**证据**：
- `src/parse/domain.ts:48` — `switch (h2Name)` + `switch (type)` 嵌套 switch-case
  ```typescript
  switch (h2Name) {
    case "Scene":
      switch (type) {
        case "term": return toTerms(items);
        case "workflow": return { externals: toExternals(items) };
        ...
      }
    case "Manual":
      switch (type) { ... }
  }
  ```
- compile 已经用 `moduleRenderers[modName]` 注册表（v9 改了），但 parse 还是 switch-case——不一致

**修复方向**：
- 新增 `parse/domain-renderers.ts`：`Record<h2Name × type, (items, raw) => unknown>` 注册表
- 或：`Record<h2Name, Record<type, fn>>` 双层注册表
- `registerDomainSectionRenderer(h2Name, type, fn)` 扩展接口

---

### 4. path-constant

> **规范**：`资产/缓存路径必须用常量集中管理（如 CACHE_DIR），不散落硬编码`
> **状态**：❌ **违反**

**证据**：路径字面量散落 10 处：
- `src/parse/index.ts:63,68,73` — `.pt/assets/domains` / `.pt/assets/blueprints` / `.pt/assets/profiles`
- `src/parse/domain.ts:26` — `.pt/assets/domains`
- `src/parse/blueprint.ts:52` — `.pt/assets/blueprints`
- `src/parse/profile.ts:32` — `.pt/assets/profiles`
- `src/parse/blueprint.ts:99,101` + `src/transpile.ts:37` — `.pt/contexts/cache/`（默认值重复 3 处）
- `src/index.ts:148` + `src/config.ts:4,31` — `.pt/assets/profiles`（提示文案 + 注释）

**修复方向**：
- 新增 `src/constants.ts`：
  ```typescript
  export const ASSETS_DIR = ".pt/assets";
  export const DOMAINS_DIR = `${ASSETS_DIR}/domains`;
  export const BLUEPRINTS_DIR = `${ASSETS_DIR}/blueprints`;
  export const PROFILES_DIR = `${ASSETS_DIR}/profiles`;
  export const CACHE_DIR = ".pt/contexts/cache";
  export const RAW_DIR = ".pt/raws";
  export const FULL_DIR = ".pt/fulls";
  ```
- 全库 import 这些常量，不用字面量

---

### 5. module-name-constant

> **规范**：`模块名 会话知识/参考手册 必须用常量，不散落字符串字面量`
> **状态**：❌ **违反**

**证据**：模块名字面量 `"Scene"` / `"Manual"` / `"Trigger"` 散落 6 处（非注释非 case）：
- `src/render/context-message.ts:43,53,197` — `d.modules["Manual"]`
- `src/agent/pi-adapter.ts:74` — `d.modules["Manual"]`
- `src/index.ts:174,258` — `d.modules["Manual"]`

**注意**：compile/context.ts 的 `moduleRenderers` 注册表用 modName 作 key（`Scene`/`Trigger`/`Manual`），但 renderer 内部按 type 分发时也硬编码了 `"Scene"` / `"Manual"`（在 `case "Scene":` 等）。

**修复方向**：
- 新增 `src/constants.ts`：
  ```typescript
  export const MOD_SCENE = "Scene";
  export const MOD_TRIGGER = "Trigger";
  export const MOD_MANUAL = "Manual";
  export const MOD_TERM = "Term";
  ```
- 全库 import，`d.modules[MOD_MANUAL]` 替代 `d.modules["Manual"]`
- **注意**：这条规范里的"会话知识/参考手册"是注入点名（Blueprint H2，人类自定义），不该常量化——规范措辞有歧义，实际应常量化的是 Domain H2 段名（Scene/Trigger/Manual/Term）。建议更新 pt-quality 规范措辞。

---

### 6. naming-consistency

> **规范**：`代码命名与架构语义一致（adapter 不叫 oxnAdapter，应叫 mdAdapter）`
> **状态**：❌ **违反**

**证据**：
- `src/parse/index.ts:16` — `export const oxnAdapter` + `name: "oxn"`
- `src/transpile.ts:12,42` — `import { oxnAdapter }` + `oxnAdapter` in sourceAdapters
- `AssetKind` type 残留 `"channel"`（shared.ts:23）—— v9 Channel 已删除，但 type 还保留
- 注释残留 `domain/channel/blueprint 共享`（shared.ts:1）

**修复方向**：
- `oxnAdapter` → `mdAdapter`（适配的是 MD 格式，不是 OXN——OXN 是历史名）
- `name: "oxn"` → `name: "md"`
- `AssetKind` 删 `"channel"`（或注释标"v9 删除，保留仅为历史资源兼容"）
- 注释更新

---

### 7. npm-scripts

> **规范**：`package.json 必须有 typecheck/verify 脚本入口`
> **状态**：❌ **违反**

**证据**：
- `package.json` 无 `scripts` 段
- 当前靠手动 `npx tsc --noEmit` + `npx tsx tests/verify/verify-phase9.ts`

**修复方向**：
```json
"scripts": {
  "typecheck": "tsc --noEmit",
  "verify": "tsx tests/verify/verify-phase9.ts && tsx tests/verify/verify-flows.ts",
  "verify:phase9": "tsx tests/verify/verify-phase9.ts",
  "verify:flows": "tsx tests/verify/verify-flows.ts"
}
```
- 装开发依赖：`tsx`（当前用 `npx tsx`，应固化）

---

### 8. test-framework

> **规范**：`验证脚本用断言框架（vitest），不用 console.log + 人工看 ✅`
> **状态**：❌ **违反**

**证据**：
- `tests/verify/verify-phase9.ts` 用自定义 `check()` 函数 + `console.log("✅"/"❌")`
- `tests/verify/verify-flows.ts` 用 `console.log` 直接输出
- 无 vitest 安装（`node_modules/.bin/vitest` 不存在）
- `package.json` 无 vitest 依赖

**修复方向**：
- 装 `vitest` 开发依赖
- `tests/verify/verify-phase9.ts` → `tests/verify/phase9.test.ts`，用 `describe/it/expect`
- `tests/verify/verify-flows.ts` → `tests/verify/flows.test.ts`
- 保留 `verify-phase9.ts` 作 CLI 入口（可选，调用 vitest runner）

---

### 9. error-via-notify

> **规范**：`生产错误用 ctx.ui.notify，不用 console.error`
> **状态**：⚠️ **部分违反**

**证据**：
- `src/index.ts` 已全用 `ctx.ui.notify`（✅ 合规）
- `src/parse/index.ts:89` — `console.error("[pt] parse ${dir}/${f} failed:", e)`
- `src/transpile.ts:52` — `console.error("[pt] adapter ${a.name} failed:", e)`
- `src/parse/index.ts:48` + `src/transpile.ts:85` — `console.warn`

**根因**：parse/ 和 transpile/ 没有 `ctx`（Pi ExtensionCommandContext），只有 cwd——拿不到 `ctx.ui.notify`。

**修复方向**：
- 选项 A：把错误收集到 Result 对象（`{ ok: true } | { ok: false, errors: string[] }`），让 index.ts 统一 notify
- 选项 B：给 SourceAdapter.load 加 `onError` 回调参数，index.ts 传入 `(msg) => ctx.ui.notify(msg, "error")`
- 选项 C：AgentAPI 接口加 `notify` 方法，PiAdapter 封装——但 parse/transpile 不该依赖 AgentAdapter

**推荐**：选项 A——Result 对象最干净，parse/transpile 不依赖 UI 层。

---

## pt-quality 审计汇总

| # | 规范 | 状态 | 违反程度 | 修复量 |
|---|---|---|---|---|
| 1 | modules-type-safety | ❌ 违反 | 严重（27 处 as） | 大（新增 type-guards.ts + 全库改） |
| 2 | no-duplicate-type | ❌ 违反 | 中（3 处重复） | 小（Pick 派生） |
| 3 | parse-extension-registry | ❌ 违反 | 中（domain.ts switch） | 中（新增注册表） |
| 4 | path-constant | ❌ 违反 | 中（10 处散落） | 小（新增 constants.ts + 替换） |
| 5 | module-name-constant | ❌ 违反 | 中（6 处散落） | 小（constants.ts + 替换） |
| 6 | naming-consistency | ❌ 违反 | 小（oxnAdapter） | 小（改名） |
| 7 | npm-scripts | ❌ 违反 | 小（无 scripts） | 小（加 scripts 段） |
| 8 | test-framework | ❌ 违反 | 中（无 vitest） | 中（装 vitest + 改测试） |
| 9 | error-via-notify | ⚠️ 部分违反 | 小（4 处 console） | 中（Result 对象改造） |

**结论**：9 条规范全部违反或部分违反。pt-quality Domain 的规范是 v9 设计目标，但 v9 实现优先打通链路，规范执行留到 Phase 10。

---

## 二、技术债清单（11 项，P1-P4）

除 pt-quality 9 条外，还有架构级技术债。

### P1：高优先（影响正确性/扩展性）

#### P1.1 AgentAPI 缺 ui 能力

**问题**：`AgentAPI` 接口只有 `on/registerCommand/registerFlag/getFlag`，没有 `ui.notify`/`ui.setStatus`。PiAdapter 无法报错或设状态——`registerInject` 内的错误只能 silent fail。

**证据**：
- `src/schema.ts` AgentAPI 无 ui 方法
- `src/agent/pi-adapter.ts` 无 notify 调用（grep 为空）
- `src/index.ts:110` — `pi as unknown as AgentAPI` 强转（Pi ExtensionAPI 比 AgentAPI 多很多方法，强转后 PiAdapter 只用 AgentAPI 子集）

**修复方向**：
- AgentAPI 加 `ui?: { notify(msg, level): void; setStatus(name, text): void }`（可选，adapter 按需用）
- 或：AgentAdapter 接口加 `onError?: (msg: string) => void`，index.ts 传入 notify 回调

#### P1.2 by-injection-point 缓存未实现

**问题**：`Blueprint.compilation.split = "by-injection-point"` 是 v8/v9 设计的缓存拆分策略，但 `src/render/cache.ts:20-22` 是 TODO 空实现——配置了也不拆，fallback 到 single-file。

**证据**：
- `src/render/cache.ts:20` — `if (compilation.split === "by-injection-point") { // TODO }`
- 当前所有 Blueprint 都配 `split: single-file`，无人触发 TODO 路径

**修复方向**：
- 实现 saveContext 按注入点拆多文件：`<name>.<ipName>.context.md`
- 实现 loadContext 按注入点加载 + 各自校验 hash
- 或：如果短期不用，删 TODO + 在 schema 注释标"v9 不实现，预留"

#### P1.3 Domain.modules type hole

**问题**：`Domain.modules: Record<string, unknown>`——type hole，所有消费者 `as` 断言。这是 pt-quality #1 的根因，但也是架构级问题：H2 段开放性 vs 类型安全的矛盾。

**修复方向**：见 pt-quality #1 修复方向。可能需要设计 `DomainModule` 联合类型：
```typescript
type DomainModule = Term[] | Rule[] | FlowTemplate[] | { externals: ExternalRef[] } | ToolRef[] | unknown[];
```

---

### P2：中优先（影响可维护性）

#### P2.1 path 常量散落（pt-quality #4）

见 pt-quality #4。10 处路径字面量散落。

#### P2.2 模块名常量散落（pt-quality #5）

见 pt-quality #5。6 处模块名字面量散落。

#### P2.3 parse switch-case（pt-quality #3）

见 pt-quality #3。parse/domain.ts switch-case 与 compile 的注册表机制不一致。

#### P2.4 OXN 命名残留（pt-quality #6）

见 pt-quality #6。`oxnAdapter` 应改名 `mdAdapter`。`AssetKind` 残留 `"channel"`。

#### P2.5 重复类型（pt-quality #2）

见 pt-quality #2。`FlowTemplateLite` 重复定义 2 处。

#### P2.6 index.ts 10 个全局 let

**问题**：`src/index.ts` 有 10 个模块级 `let` 变量管理状态：
```typescript
let activeProfile, cachedSegment, cachedBundles, lastCwd, lastBuiltPrompt,
    lastCacheHit, activeAdapter, cachedContext, cachedBlueprint, cachedDomains;
```

**根因**：Pi Extension 是单例模块，全局 let 作 per-session 状态。但 10 个散落变量难维护。

**修复方向**：
- 收拢到 `const state = { activeProfile: null as ..., ... }` 单对象
- 或：封装 `SessionState` 类，index.ts 持有一个实例

---

### P3：低优先（影响开发体验）

#### P3.1 无测试框架（pt-quality #8）

见 pt-quality #8。verify 脚本用自定义 check + console.log。

#### P3.2 package.json 无 scripts（pt-quality #7）

见 pt-quality #7。无 `scripts` 段。

#### P3.3 console.error（pt-quality #9）

见 pt-quality #9。parse/transpile 4 处 console.error/warn。

---

### P4：预留/有意

#### P4.1 by-injection-point 缓存（P1.2）

如果决定短期不实现，降为 P4（预留）。

#### P4.2 Channel Connector 预留

**状态**：v9 §0 设计的 Channel（Domain 连接外部知识源的 Connector）未实现——有意预留，不是债。

#### P4.3 单 SourceAdapter（MVP）

**状态**：只有 `oxnAdapter`（MD 格式）——有意 MVP，加新 SourceAdapter 是扩展，不是债。

---

## 三、执行优先级建议

按依赖关系排序（先基础设施，后上层改造）：

### 第一批：基础设施（无依赖，并行可做）

- [ ] **T1**：新增 `src/constants.ts`（path + module 名常量）—— P2.1 + P2.2
- [ ] **T2**：`package.json` 加 scripts 段 + 装 tsx 开发依赖 —— P3.2
- [ ] **T3**：`oxnAdapter` → `mdAdapter` 改名 + AssetKind 清理 —— P2.4

### 第二批：类型安全（依赖 T1）

- [ ] **T4**：新增 `src/compile/type-guards.ts`（isTermArray/isRuleArray/isFlowTemplateArray）—— P1.3 + pt-quality #1
- [ ] **T5**：重复类型用 Pick 派生（FlowTemplateLite/RuleLite）—— P2.5 + pt-quality #2
- [ ] **T6**：全库 `as` 断言改 type guard（compile/render/agent/index）—— pt-quality #1

### 第三批：parse 注册表（依赖 T4）

- [ ] **T7**：parse/domain.ts switch-case 改注册表 —— P2.3 + pt-quality #3

### 第四批：错误处理（独立）

- [ ] **T8**：parse/transpile console.error 改 Result 对象 —— P3.3 + pt-quality #9
- [ ] **T9**：AgentAPI 加 ui 能力 或 onError 回调 —— P1.1

### 第五批：测试框架（依赖 T2）

- [ ] **T10**：装 vitest + verify 脚本改 .test.ts —— P3.1 + pt-quality #8

### 第六批：状态管理 + 缓存（独立）

- [ ] **T11**：index.ts 10 个全局 let 收拢为 SessionState —— P2.6
- [ ] **T12**：by-injection-point 缓存实现 or 删 TODO 标预留 —— P1.2

### 第七批：规范措辞修正

- [ ] **T13**：pt-quality Domain #5 措辞修正（"会话知识/参考手册"是注入点名不该常量化，应改为"Scene/Trigger/Manual 等 Domain H2 段名用常量"）

---

## 四、验收清单

每项处理完后，执行者跑：

- [ ] `npm run typecheck`（T2 后）通过
- [ ] `npm run verify`（T2 后）全过
- [ ] `grep -rn " as " src/ | wc -l` 数量下降（T6 后应 < 5）
- [ ] `grep -rn '\.pt/assets\|\.pt/contexts' src/ | grep -v constants` 为 0（T1 后）
- [ ] `grep -rn '"Scene"\|"Manual"\|"Trigger"' src/ | grep -v constants` 为 0（T1 后）
- [ ] `grep -rn "oxnAdapter\|oxn" src/` 为 0（T3 后）
- [ ] `grep -rn "console\.error\|console\.warn" src/` 为 0（T8 后）
- [ ] pt-quality 9 条规范逐条复查通过（T13 后措辞修正）

---

## 附录：审计数据快照

| 指标 | 当前值 | 目标值 |
|---|---|---|
| `as` 断言数 | 27 | < 5 |
| 路径字面量散落 | 10 | 0（全进 constants.ts） |
| 模块名字面量散落 | 6 | 0（全进 constants.ts） |
| 重复类型定义 | 3（FlowTemplateLite×2 + RuleLite×1） | 0（Pick 派生） |
| console.error/warn | 4 | 0 |
| 全局 let | 10 | 1（SessionState 对象）or 0 |
| switch-case in parse | 2（domain.ts） | 0（注册表） |
| package.json scripts | 无 | typecheck + verify |
| 测试框架 | 自定义 check | vitest |
| pt-quality 规范执行 | 0/9 | 9/9 |
