# Pt 借鉴 OXN 遗产清单

> **基线**：pt `@issac/pi-pt@0.1.0` Phase 9.9 v9 完整实现 / OXN `0.6.4-alpha.0`
> **分析日期**：2026-09-02
> **用途**：在 pt 已成为「异构知识上下文编译器」的架构基础上，盘点 OXN（OpenXenon）哪些遗产值得 pt 借鉴或拆分吸收，哪些不值得碰。
> **关联文档**：`pt-asset-layering.md`（v9 四层模型语义基准）、`pt-manual-instantiation.md`（Manual 实例化机制）、`pt-tech-debt-audit.md`（pt 自身技术债）

---

## 一、背景：pt 与 OXN 的架构定位关系

### 1.1 pt 是编译核心，OXN 是外设

pt 已落地 v9 四层模型（Domain → Blueprint → Profile → Context）+ 三段式编译链（parse → compile → render）+ 双适配器（SourceAdapter / AgentAdapter）。pt 的本质是**异构知识上下文编译器**——把外部知识源编译成 Agent 可消费的上下文。

OXN（OpenXenon）的 kr（Asset 域）和 fe（Work 域）在 pt 架构中的定位：

| OXN 部分 | 在 pt 架构中的定位 | 关系 |
|---|---|---|
| **kr**（Asset 域：Domain/Workflow/Stack/Blueprint CRUD） | pt 的一个知识源前端 | kr 产出的 `.openxenon/assets/*.md` 可被 pt 的 MD SourceAdapter 解析；kr 本质是 pt 未来 Channel 层的一种实现 |
| **fe**（Work 域：Work 编排 + Probe 验证） | pt Manual 的执行增强 | fe 的 Work 生命周期被 pt 的 Manual（FlowTemplate）替代——Manual 更轻量；但 fe 的 **Probe 验证机制**值得 pt 借鉴 |

### 1.2 为什么做这个遗产清单

pt 的 Manual 已能代替 OXN 的 Work（声明式手册 + Context Message 触发 + 持久化实例文档），Domain 已能定义输出结构。从灵活性与方便性上，pt 已能代替 OXN 的核心价值。

但 OXN 经过 34 RFC + 多版本迭代，沉淀了一些 pt 目前缺的机制——尤其是**验证执行对了**的能力。本清单盘点这些遗产，判断哪些值得 pt 借鉴。

### 1.3 方法论

- **基于实际代码查证**，不只看设计文档（OXN 设计文档与实现有偏差，如 Proof 已 RFC-0032 退役但代码残留 297 处）
- **按 pt 缺口对应**，不按 OXN 完整度——pt 已有的不借鉴，pt 缺的才评估
- **重写优先于搬代码**——OXN 代码耦合重（kernel/infra/verdict 链），直接搬会带债务

---

## 二、pt 现状缺口分析（基于实际代码查证）

### 2.1 pt 的 FlowStep 没有「验证执行对了」的字段

`src/schema.ts` 的 FlowStep 定义：

```typescript
export interface FlowStep {
  desc: string;              // 做什么
  dataSource?: ExternalRef;  // 从哪取数据
  rule?: string;             // 套哪条规则
  output?: string;           // 期望产出什么
}
```

**缺口**：没有 `observe`（验证参照）。Manual 声明了步骤，但无法验证 LLM 真的执行了且执行对了。pt 目前只能靠 LLM 自报执行结果。

### 2.2 pt 没有验证结果的概念

查证 `src/render/context-message.ts` / `src/render/system-prompt.ts`：无 `observe` / `verify` / `check` / `pass` / `fail` / `outcome` 概念。

**缺口**：Manual 步骤执行后，pt 不知道执行对不对，没有"验证通过/偏离/无法判定"的状态记录。

### 2.3 pt 没有 DAG / 依赖校验

查证 `src/` 全目录：无 `dag` / `depend` / `references` / `circular` / `acyclic` 概念。

**缺口**：Profile→Blueprint→Domain 三层引用完整性无校验。Profile 引用的 Blueprint / Domain 悬空时无检测（当前 `parse/index.ts` 只对 Profile→Blueprint 做 warn，不阻断）。pt 的引用图是星型三层（非 OXN 的 Domain→Domain 网状），无环风险——缺的是完整性校验。

### 2.4 pt 没有 Draft / 质量门机制

查证 `src/` 全目录：无 `draft` / `promote` / `skeleton` / `archive` / `evolve` 概念。

**缺口**：无 Draft / 质量门机制。但 pt 当前不产出知识材料（是编译器不是生产者），此缺口依赖 Channel 层实现——当前不适用，未来待定（见 §3.3）。

### 2.5 pt 已覆盖的能力（无缺口，不借鉴）

| 能力 | pt 实现 | OXN 对应 |
|---|---|---|
| 知识编译 | parse → compile → render 三段式 | OXN 无（OXN 不编译，只 CRUD） |
| 知识注入 | system_prompt + context_message | OXN 无（OXN 靠 skill + bash） |
| 知识组合 | Blueprint injectionPoints + Profile | Blueprint Boundaries + AssetMap scene |
| 手册触发 | `/manual:xxx` + `/<flow>` | OXN 无（OXN 走 Work create） |
| 多 Agent 后端 | AgentAdapter 抽象 | OXN 无（只绑 OXN CLI） |
| 多知识源前端 | SourceAdapter + Channel 预留 | OXN 无（只读 .openxenon/） |
| 缓存 | sourceHash + cache | PlanLock 5 hash（过度工程） |

---

## 三、OXN 遗产清单（按借鉴价值分 4 梯队）

### 第一梯队：值得 pt 直接借鉴的设计概念（低成本，非零代码）

#### 3.1 Operation-Probe 配对（OXN 最精妙的设计）

**OXN 实证**（`.openxenon/assets/blueprints/bug-fix-blueprint.md`）：

```markdown
### diagnose
- operate: [git-status]           ← 执行参照（做什么）
- observe: [fs-content-match]     ← 验证参照（怎么验证做了）
```

每个 slot 同时声明**执行参照**（Operation）和**验证参照**（Probe）。Operation 是 AI 跑的执行参照（动词原形：test/lint/build），Probe 是 OXN 跑的验证参照（结果态：test-pass/lint-check/ts-compiles）。

**pt 缺口**：FlowStep 只有 `desc` + `output`，没有 `observe`。

**借鉴方案**：给 FlowStep 加 `observe?: string[]` 字段：

```typescript
export interface FlowStep {
  desc: string;
  dataSource?: ExternalRef;
  rule?: string;
  output?: string;
  observe?: string[];        // 新增：验证参照（Probe 名，如 "fs-content-match"）
}
```

**成本**：schema 加字段本身零代码，但落地需同步改 3 处代码——parse 层（`domain-renderers.ts` 的 `collectSteps` 当前只解析 `- step:` 行返回 `string[]`，需改为返回 `FlowStep[]` 并解析 `- observe:` 行）、render 层（`context-message.ts` 的 `bindFlowTemplate` 当前只渲染 `s.desc`，需加 observe 渲染）、Manual 实例文档（`commands.ts` 的 `buildManualDoc` 是代码生成模板，加执行状态表需改代码）。详见执行文档 `pt-oxn-heritage-impl-p0.md`。

#### 3.2 ProbeOutcome 三态（COMPLETED / DEVIATED / INCONCLUSIVE）

**OXN 实证**（`packages/engine/src/kernel/verdicts/verdict.ts`）：

```typescript
outcome: passed ? 'COMPLETED' : 'DEVIATED'
// INCONCLUSIVE 由 strategy 主动返（如 manual assessment）
```

三态语义：
- **COMPLETED**：执行符合预期
- **DEVIATED**：偏离预期（不是失败，是偏了，仍可继续）
- **INCONCLUSIVE**：无法判定（如人工评估）

**pt 缺口**：没有验证结果概念。

**借鉴方案**：pt 的 `pt_manual` tool 创建的手册实例文档（`.pt/manuals/*.md`）加执行状态字段（三态枚举），记录每步 observe 结果。

**成本**：类型定义零代码（schema.ts 加枚举 + interface），但 Manual 实例文档的执行状态表需改 `commands.ts` 的 `buildManualDoc`（代码生成模板，非文档约定）。比 OXN 的 verdict 子系统轻得多——实测 OXN `verdict.ts` 1019 行 + `catalog.ts` 1000 行 + `extraction.ts` 25 行 = **2044 行**（strategy 注册表 + judge 链 + catalog 元数据），pt 只需要三态枚举 + 记录，不需要 OXN 的 strategy 模式。详见执行文档 `pt-oxn-heritage-impl-p0.md`。

#### 3.3 Draft → Promote 情态分离

**OXN 实证**（`packages/engine/src/Draft/promote-dispatch.ts`）：

AI 不能直接建 Asset，走 Draft（描述性情态）→ 人工审核 → Promote（定义性情态）。Draft 是 Asset 的前置状态，与 Asset 情态分离。

**pt 缺口**：无 Draft / 质量门机制。但 pt 当前不产出知识材料（是编译器不是生产者），此缺口依赖 Channel 层实现——当前不适用。

**借鉴方案**：**当前不适用**。pt 是编译器（parse→compile→render），不产出新知识材料——知识材料由人写进 `.pt/assets/`。Draft→Promote 的质量门依赖 Channel 层（AI 自动产出知识材料的通道），而 Channel 层在 pt v9 中是「预留不实现」（`schema.ts:15`）。此项应等 Channel 层实现时再评估，当前降级为「未来待定」。

> 注：OXN 的 Draft 模块实测 1586 行（index 417 + promote-dispatch 457 + promote 357 + retarget 166 + skeleton 189）——pt 若未来实现 Channel 层，用文件系统 + git mv 即可实现等价语义，无需移植这套重型状态机。

---

### 第二梯队：值得拆分作为 pt 扩展的机制（中代码成本，重写不搬）

#### 3.4 Probe 策略子集（挑 7 个通用验证工具，重写）

**OXN 实证**：33 个 Probe 策略，总 4508 行代码（`packages/engine/src/infra/probes/*.ts`）。大部分是 OXN 特定的（asset-migrate-check / doc-boundary / stale-draft-check 等），但有几个是**通用验证工具**：

| Probe | 代码量 | 通用性 | pt 用途 |
|---|---|---|---|
| `fs-content-match` | ~100 行 | ✅ 通用 | 验证文件含某符号（Manual 步骤"改了 X"的验证） |
| `fs-exists` / `fs-not-exists` | ~80 行 | ✅ 通用 | 验证文件存在/消失（Manual 步骤"创建了 X"/"删了 X"） |
| `lint-check` | ~100 行 | ✅ 通用 | 验证代码 lint 通过 |
| `ts-compiles` | ~140 行 | ✅ 通用 | 验证 TS 编译通过 |
| `test-pass` | ~100 行 | ✅ 通用 | 验证测试通过 |
| `git-status-clean` | ~80 行 | ✅ 通用 | 验证 git 工作树干净 |
| `file-hash` | ~80 行 | ✅ 通用 | 验证文件内容 hash（产物指纹） |

**拆分方式**：**重写不搬代码**。OXN 的 Probe 耦合了 verdict.ts / kernel / ProbeContext，直接搬会带一堆依赖。pt 只需要：
- 抽 7 个通用验证工具的**策略逻辑**（实测 OXN 这 8 个文件总 511 行：fs-match 59 / fs-exists 22 / fs-not-exists 31 / lint-check 74 / ts-compiles 142 / test-pass 92 / git-status-clean 19 / file-hash 72）
- 作为 pt 的 `src/verify/` 模块（Manual observe 的实现库）
- 重写后总代码量 ~500 行（与 OXN 同量级，但去掉 ProbeContext / verdict 依赖后更精简）

**依赖核验**（重写可行性确认）：每个 probe 的 import 仅 3 类——`@openxenon/engine/infra/filesystem`（node fs 薄封装）、`shell-exec` / `git-clean`（child_process 包装）、`ProbeContextBase`（纯类型）。重写时用 `node:fs` + `bash` tool 即可，无策略链依赖。

**为什么重写**：
- OXN Probe 走 `execute-probe.ts` → strategy 注册表 → verdict.ts judge 链（实测 2044 行），pt 不需要这套
- pt 的 verify 只需要：纯函数 `(cwd, params) => ProbeOutcome`，直接调 bash + 解析结果
- OXN 的 ProbeContext / InterferenceFlag / ProbeStatsStore 对 pt 是过度工程

#### 3.5 references DAG 校验核心逻辑

**OXN 实证**（`packages/engine/src/Asset/dag-validator.ts` + `kernel/processors/dag.ts`）：校验知识材料间依赖完整性（无环、无 self-ref、bare name 强制 parent kind）。

> 注：OXN 有两个相关文件——`Asset/internal/reference-checker.ts`（215 行，做**反向引用索引**，用于 archive/delete 前查被谁引用）和 `Asset/dag-validator.ts`（做**无环/自环/孤儿校验**）。本借鉴项针对后者。

**pt 缺口**：Profile→Blueprint→Domain 三层引用完整性无校验。pt 的引用图是 Profile 引用 Blueprint（`profile.blueprint`）、Blueprint 引用 Domain（`injectionPoints[].domains[]`）、Profile 直接选 Domain（`profile.domains[]`）——并非 OXN 的 Domain→Domain references。当前 `parse/index.ts` 只对 Profile→Blueprint 做了存在性校验（`findBlueprint` 失败时 warn），Blueprint→Domain 和 Profile→Domain 的悬空引用无校验。

**拆分方式**：OXN 的 dag-validator 核心逻辑约 100 行（环检测 + bare name 解析），可作为 pt 的 Channel 校验工具。比 OXN 的 check-asset-structure.ts（971 行）轻得多——pt 只需要 DAG 校验，不需要 OXN 的 H2 白名单守门。

**成本**：~100 行，重写。

---

### 第三梯队：概念可参考但 pt 已有等价（不值得搬）

| OXN 遗产 | pt 已有等价 | 结论 |
|---|---|---|
| AssetMap scene 路由 | Profile + Blueprint injectionPoints | pt 更优（Profile 用户面 vs scene 导航） |
| Blueprint Boundaries | Blueprint injectionPoints + Modules | pt 更优（target + mode 更灵活） |
| PlanLock / context hash | sourceHash + cache | pt 已实现，且更轻 |
| Asset 5 类收敛枚举 | Domain type 标签（term/workflow/stack/扩展） | pt 更灵活（开放扩展 vs 收敛枚举） |
| 版本号中性原则 | package.json 版本管理 | pt 自身不需要 |
| Stack Tool.operations | pt Stack Domain 的 Scene 段 | pt 已有等价 |
| Work 生命周期（create→run→submit） | Manual 实例化 + 持久化文档 | pt Manual 更轻量 |

---

### 第四梯队：不值得借鉴（太重 / 已过时 / 债务）

| 遗产 | 状态 | 不借鉴原因 |
|---|---|---|
| Proof / proof-compiler / insight/ | 297 处残留（58 文件），RFC-0032 已退役 | 已死代码，不要碰 |
| md-bridge（26 文件） | 1 call site，几乎死 | 已被 md-pipeline 替代 |
| oxl dead dirs（contracts/executor/evaluator/flattener/unpacker/loader/schemas/helpers/generator 9 目录） | 18 处外部 import（多为 md-pipeline/scope 等存活子目录；9 目录内部互引为主） | 核心死代码，部分子目录仍活 |
| 93 deprecated markers | 债务 | 搬过来就是搬债 |
| PlanLock 5 hash | 过度工程 | pt 的 sourceHash 已够 |
| check-asset-structure.ts（971 行） | OXN 特定 schema 守门 | pt 的 schema 不同，不需要 |
| IAPError 三轨 / CliInputError | OXN CLI 特定 | pt 是 Pi extension，错误走 Pi |
| Langium config | 残留 | v0.7.0 cutoff 未执行 |
| birth-cert.ts | 整文件标 RFC-0033 retired | 已退役 |

---

## 四、借鉴方案：pt 最小可行集成

### 4.1 优先级排序

| 优先级 | 借鉴项 | 成本 | 价值 |
|---|---|---|---|
| **P0** | FlowStep 加 `observe` 字段 + parse/render 改造 | schema 零代码 + parse/render ~50 行改动 | Manual 升级为可验证手册 |
| **P0** | ProbeOutcome 三态枚举 + Manual 实例文档状态表 | schema 零代码 + buildManualDoc ~30 行改动 | 执行结果可记录 |
| **P1** | `src/verify/` 模块（7 个通用 Probe 重写） | ~500 行重写 | observe 字段有实现库支撑 |
| **P2** | Profile→Blueprint→Domain 引用完整性校验 | ~100 行重写 | 悬空引用检测 |
| **未来** | Draft → Promote（依赖 Channel 层） | 待定（Channel 层未实现） | AI 产出质量门（当前不适用） |

### 4.2 P0 落地：FlowStep + ProbeOutcome

**FlowStep 加 observe**（`src/schema.ts`）：

```typescript
export interface FlowStep {
  desc: string;
  dataSource?: ExternalRef;
  rule?: string;
  output?: string;
  observe?: string[];        // P0 新增：验证参照（Probe 名）
}
```

**ProbeOutcome 三态**（`src/schema.ts` 新增）：

```typescript
export type ProbeOutcome = "COMPLETED" | "DEVIATED" | "INCONCLUSIVE";

export interface StepResult {
  stepName: string;
  outcome: ProbeOutcome;
  message?: string;
  actual?: string;
}
```

**Manual 实例文档**（`.pt/manuals/*.md`）加执行状态区：

```markdown
## 执行状态
| Step | Outcome | Message |
|---|---|---|
| diagnose | COMPLETED | 定位到 src/foo.ts:42 |
| fix | DEVIATED | 改了但 lint 报 warning |
| verify | INCONCLUSIVE | 测试需人工确认 |
```

> **实现改动清单**（非零代码——详见执行文档 `pt-oxn-heritage-impl-p0.md`）：
> - `src/schema.ts`：加 `FlowStep.observe?: string[]` + `ProbeOutcome` 枚举 + `StepResult` interface
> - `src/parse/domain-renderers.ts`：`collectSteps` 返回值从 `string[]` 改为 `FlowStep[]`，解析 `- observe:` 行（紧随 `- step:` 行）
> - `src/render/context-message.ts`：`bindFlowTemplate` 渲染步骤时输出 observe 提示
> - `src/commands.ts`：`buildManualDoc` 生成执行状态表（代码生成模板，非文档约定）

### 4.3 P1 落地：verify/ 模块

```
src/verify/
  index.ts              # 注册表 + runVerify(name, params) → ProbeOutcome
  fs-content-match.ts   # ~80 行
  fs-exists.ts          # ~50 行
  fs-not-exists.ts      # ~50 行
  lint-check.ts         # ~80 行
  ts-compiles.ts        # ~80 行
  test-pass.ts          # ~80 行
  git-status-clean.ts   # ~50 行
  file-hash.ts          # ~50 行
```

每个 verify 函数签名统一：`async (cwd: string, params: Record<string, string>) => Promise<ProbeOutcome>`。纯函数，不依赖 OXN 的 kernel/infra/verdict 链。

### 4.4 P2 落地：DAG 校验 + Draft

**引用完整性校验**（`src/verify/ref-check.ts` ~100 行）：扫 Profile→Blueprint→Domain 三层引用，检测悬空引用（Profile 引用的 Blueprint 不存在 / Blueprint 引用的 Domain 不存在 / Profile 直接选的 Domain 不存在）。pt 的引用图是三层星型结构（非 OXN 的 Domain→Domain 网状），无环风险——校验重点是完整性而非无环。

**Draft → Promote**：**当前不适用**（依赖 Channel 层，Channel 预留不实现）。等 pt 未来实现 Channel 层（AI 自动产出知识材料）时再评估。

---

## 五、kr/fe 拆分价值的重新评估

基于本遗产清单，kr/fe 作为独立包拆分的价值重新评估：

| 包 | 原定位 | 重新定位 | 拆分价值 |
|---|---|---|---|
| **kr** | 知识材料 CRUD（create/validate/archive/evolve） | pt Channel 的一种实现 | **低**——pt 的 MD SourceAdapter 已能解析知识源；kr 的 Asset CRUD 太重，pt 用文件系统 + git 即可管理 |
| **fe** | Work 编排 + Probe 验证 | Manual 的验证增强 | **中**——fe 的 Work 生命周期被 Manual 替代，但 **Probe 验证机制值得拆出**作为 pt 的 verify/ 模块 |

### 5.1 kr 不值得单独拆包的理由

1. **pt 的 MD adapter 已覆盖知识源解析**——kr 的核心价值（Asset CRUD）在 pt 里用文件系统 + git 替代
2. **kr 的 Asset 守门（check-asset-structure.ts 971 行）是 OXN 特定 schema 守门**——pt 的 schema 不同，不需要
3. **kr 的 PlanLock 5 hash 是过度工程**——pt 的 sourceHash 已够
4. **kr 的 references DAG 校验**——值得拆，但只需 ~100 行核心逻辑，不值得为这 100 行建一个包

### 5.2 fe 的 Probe 值得拆，但不值得建 fe 包

1. **fe 的 Work 生命周期被 Manual 替代**——Manual 更轻量（声明式 + Context Message 触发）
2. **fe 的 Probe 验证机制值得拆**——但只需 7 个通用策略 ~500 行，作为 pt 的 `verify/` 模块更合适
3. **fe 的 ProbeOutcome 三态值得借鉴**——但只需枚举 + 记录，不需要 OXN 的 verdict 子系统（实测 2044 行）

**结论**：kr/fe 作为独立包拆分的价值都不高。真正值得从 OXN 拆出的是 **Probe 验证机制**（fe 域里最有价值的部分），而且要重写不要搬代码，作为 pt 的 `verify/` 模块。kr 的「知识源归一化」思路已被 pt 的 SourceAdapter + Channel 预留覆盖，不需要单独拆包。

---

## 六、结论与下一步

### 6.1 核心结论

pt 已成为异构知识上下文编译器，架构上已超越 OXN。OXN 34 RFC + 多版本迭代沉淀的遗产中，对 pt 真正有价值的只有 **3 个设计概念 + 2 个机制拆分**：

```
设计概念（零成本）:
  1. Operation-Probe 配对 → FlowStep 加 observe 字段
  2. ProbeOutcome 三态 → Manual 实例加执行状态
  3. Draft→Promote 情态分离 → Channel 加质量门

机制拆分（中成本，重写不搬）:
  4. 7 个通用 Probe 策略 → pt verify/ 模块（~500 行）
  5. references DAG 校验 → pt Channel 校验工具（~100 行）
```

### 6.2 OXN 遗产的全景

```
pt 已超越 OXN 的部分（不需要继承）:
  ✓ 知识编译（parse→compile→render 三段式）
  ✓ 知识注入（system_prompt + context_message）
  ✓ 知识组合（Blueprint injectionPoints + Profile）
  ✓ 手册触发（/manual:xxx + /flow xxx）
  ✓ 多 Agent 后端（AgentAdapter 抽象）
  ✓ 多知识源前端（SourceAdapter 抽象，Channel 预留）

OXN 值得 pt 借鉴的遗产（3 设计 + 2 拆分）:
  设计概念（零成本）: Operation-Probe 配对 / ProbeOutcome 三态 / Draft→Promote
  机制拆分（中成本）: 7 个通用 Probe / DAG 校验

OXN 不值得借鉴的部分:
  ✗ Proof/md-bridge/oxl dead dirs（死代码 + 债务）
  ✗ Work 生命周期（被 Manual 替代）
  ✗ Asset 5 类守门 / PlanLock 5 hash（过度工程）
  ✗ OXN CLI 错误契约（pt 不需要）
```

### 6.3 下一步

1. **P0**（零成本，立即可做）：FlowStep 加 `observe` 字段 + ProbeOutcome 三态枚举 + Manual 实例文档状态区
2. **P1**（~500 行重写）：`src/verify/` 模块，7 个通用 Probe 策略
3. **P2**（~100 行 + 目录约定）：DAG 校验 + Draft→Promote

这三步把 OXN 最有价值的遗产（Operation-Probe 配对 + 三态验证 + 质量门）吸收进 pt，不需要拆 kr/fe 两个包。pt 的 Manual 从「声明式手册」升级为「可验证手册」，同时保持 pt 的轻量架构。

---

## 附录：查证证据索引

### pt 代码查证

| 查证项 | 文件 | 证据 |
|---|---|---|
| FlowStep 无 observe | `src/schema.ts:57-66` | 只有 desc/dataSource/rule/output |
| 无验证结果概念 | `src/render/*.ts` | grep observe/verify/check/outcome 零命中 |
| 无 DAG 校验 | `src/` 全目录 | grep dag/depend/references/circular 零命中 |
| 无 Draft 机制 | `src/` 全目录 | grep draft/promote/skeleton 零命中 |
| Channel 预留 | `src/schema.ts:15,239` | 「Channel 保留为未来 Connector，预留层不实现」 |
| AgentAdapter 抽象 | `src/agent/registry.ts` | pi 注册，预留 codex/opencode |
| SourceAdapter 抽象 | `src/transpile.ts` | sourceAdapters 数组，预留 yamlAdapter/dbAdapter |

### OXN 代码查证

| 查证项 | 文件 | 证据 |
|---|---|---|
| Operation-Probe 配对 | `.openxenon/assets/blueprints/bug-fix-blueprint.md` | operate + observe 双字段 |
| ProbeOutcome 三态 | `packages/engine/src/kernel/contracts/probe-port.ts:28` | `outcome: 'COMPLETED' \| 'DEVIATED' \| 'INCONCLUSIVE'`（verdict.ts 1019 行 + catalog.ts 1000 行 = strategy 注册表实现） |
| Probe 策略数 | `packages/engine/src/infra/probes/*.ts` | 33 个，4508 行 |
| Draft→Promote | `packages/engine/src/Draft/promote-dispatch.ts` | 情态分离实现 |
| references DAG | `packages/engine/src/Asset/dag-validator.ts` + `kernel/processors/dag.ts` | DAG 校验（无环/自环/孤儿）；另有 `Asset/internal/reference-checker.ts` 215 行做反向引用索引 |
| Asset 守门规模 | `scripts/check-asset-structure.ts` | 971 行 |
| Proof 残留 | RFC-0032 声称 purge 但 297 处残留（58 文件） | insight/ 4 文件零 import |
| md-bridge | `oxl/md-bridge` 目录，46 处 grep 命中 | 几乎死 |
| oxl dead dirs | contracts/executor/evaluator 等 9 目录 | 18 处外部 import（多为 md-pipeline/scope 存活；9 目录内部互引为主） |
