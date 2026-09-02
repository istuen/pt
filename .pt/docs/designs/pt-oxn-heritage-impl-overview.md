# OXN 遗产借鉴执行文档（总览）

> **基线**：pt `@issac/pi-pt@0.1.0` Phase 9.9 v9
> **关联**：`pt-oxn-heritage.md`（遗产清单与采纳决策）
> **用途**：本文件是入口，详细执行规格在 P0/P1/P2 三个分文档。

---

## 文档索引

| 文档 | 内容 | 前置条件 |
|---|---|---|
| [`pt-oxn-heritage-impl-p0.md`](pt-oxn-heritage-impl-p0.md) | 可验证手册基础：observe 字段 + ProbeOutcome 三态 + Manual 实例文档状态表 | 无 |
| [`pt-oxn-heritage-impl-p1.md`](pt-oxn-heritage-impl-p1.md) | verify/ 模块：8 个通用 Probe + pt_verify tool | P0 完成 |
| [`pt-oxn-heritage-impl-p2.md`](pt-oxn-heritage-impl-p2.md) | 引用完整性校验：Profile→Blueprint→Domain 悬空引用检测 + pt_check_refs tool | 无（独立） |

---

## 依赖关系

```
P0（可验证手册基础）     ← observe 字段 + ProbeOutcome 三态 + Manual 实例文档状态表
  ↓ 依赖
P1（verify/ 模块）       ← observe 字段的实现库（8 个通用 Probe + pt_verify tool）

P2（引用完整性校验）     ← 独立（不依赖 P0/P1）
```

- **P0** 是基础：声明 observe（验证参照）+ 定义 ProbeOutcome 三态。单独交付的是「声明能力」——Manual 能说「这步要验证什么」，但还不能真的验证。
- **P1** 兑现承诺：实现 verify 函数库 + pt_verify tool。observe 字段有实现支撑，LLM 可调 pt_verify 验证步骤执行结果。
- **P2** 独立：不依赖 P0/P1，可并行或先行。

## 建议执行顺序

**P0 → P2 → P1**（P2 比 P1 轻量，先清掉小项；P1 必须在 P0 之后）

| 阶段 | 文档 | 改动量 | 预计工时 |
|---|---|---|---|
| P0 | impl-p0.md | 4 文件改 + 1 测试新建 | ~2h |
| P2 | impl-p2.md | 1 文件新建 + 1 文件改 + 1 测试新建 | ~1h |
| P1 | impl-p1.md | 9 文件新建 + 1 文件改 + 1 测试新建 | ~3h |

## 前置条件（通用）

- Node.js + tsx + vitest（项目已配）
- `npm run verify` 和 `tsc --noEmit` 在改动前通过（建立 baseline）
- 熟悉 pt 三段式架构：`parse`（MD→IR）→ `compile`（IR 聚合）→ `render`（IR→注入字符串）
- 熟悉 v9 四层模型：Domain（内容）→ Blueprint（结构）→ Profile（配置）→ Context（产物）

## 交付物总览

完成后 pt 新增：

| 能力 | 落点 | 来源 |
|---|---|---|
| 步骤声明验证参照 | `FlowStep.observe` 字段 | P0 |
| 验证结果三态 | `ProbeOutcomeKind` 枚举 | P0 |
| Manual 实例文档执行状态表 | `buildManualDoc` 生成 | P0 |
| 8 个通用验证函数 | `src/verify/*.ts` | P1 |
| LLM 可调验证工具 | `pt_verify` tool | P1 |
| 引用完整性检测 | `src/verify/ref-check.ts` | P2 |
| LLM 可调引用检查工具 | `pt_check_refs` tool | P2 |

## 验收（全局）

每个 P 完成后：
1. `tsc --noEmit` 通过
2. `npm run verify` 通过（含对应新测试）
3. git commit（消息格式：`feat: P{n} xxx`）

全部完成后：
- pt Manual 从「声明式手册」升级为「可验证手册」
- LLM 有 `pt_verify` 验证步骤执行结果 + `pt_check_refs` 检测资产引用完整性
- 不引入 OXN 的 strategy/verdict/kernel 链（全部重写为纯函数）
