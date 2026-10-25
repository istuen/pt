// src/verify/trigger-desc-quality.ts — Trigger desc 写法体检（issue pt-trigger-relevance-signal §八.3）
//
// 背景（issue §七之二 / §七之三）：
//   desc 是**触发决策的输入本身**（决策在 SessionContext 层发生，Agent 此刻只拿到 desc/hint/anti，
//   规则正文要到决策之后才注入）——所以 desc 写成"领域介绍"等于把"该查吗"推回 Agent 的语义匹配。
//
//   实测（issue §七，G1 任务，n=181 交错 A/B）：
//     领域边界式 desc（"改 Pt 代码时参考；含 9 条技术规范"）→ 查阅率 16.4%
//     任务类别式 desc（"改 schema 契约 / 增删字段或类型 …前，先查规范（…）"）→ 98.4%
//     效应 82pp，Fisher p<0.0001
//
//   ⚠️ 收窄（issue §7.8.4.3）：**效应来自「desc 的词与任务描述的词是否对齐」**——
//   任务不属 desc 覆盖的类别 → 效应为 0（issue §7.8.1 G2：三种写法全 100%）。
//   → 体检不能只看"是不是任务类别式"，还要看"**任务词是否具体到能对上**"。
//
// 本模块做**纯静态启发式**检查（无 LLM 参与），4 条可机械判定的规则：
//
//   1. desc-domain-boundary（warning）—— desc 是"领域边界式"形态
//      判据：首个分句形如「X 参考 / 索引 / 手册 / 指南 / 配置」且全句无任务信号词
//      （任务信号 = "时参考 / 时触发 / 时调用 / 时先查 / 前，先查 / 前查 / 前先查" 等）
//
//   2. desc-task-signal-weak（warning）—— desc 声称是任务类别式，但**任务词过泛**
//      判据：desc 含任务信号，但**没有点名本 Domain 的任何 Scene / Rules / Flows / Checklists 项**
//      → 命中信号只有一个宽泛短语（"改 Pt 代码"），灰区任务对不上（issue §7.8.4.3 的新审查项）
//
//   3. desc-rule-name-drift（info）—— desc 点名的规则名在 Domain 里不存在
//      判据：desc 的括号内枚举项（如「（modules-type-safety、…）」）里，
//      有名字**不匹配**本 Domain 任何 H3 项名 → 写进 desc 的信号是死的
//
//   4. desc-length-over（info）—— desc 超长（任务书 trigger-desc-cost-and-regression 步骤 2）
//      判据：desc 字符数 > DESC_LENGTH_BUDGET（预算值，依据见常量注释）
//      → 长度不是正确性问题是风格问题：info 级只提示不硬截断；超出 ≠ 错，是"该精简了"
//
// 边界纪律：
//   - **只检测 + 报告，不改资产**（与 asset-health 其它规则一致；修复走作者手改）
//   - **启发式，非判据**：命中 = 值得看一眼；不命中 ≠ 一定好（避免假阴性的误导）
//   - 不引入新依赖（只用已有 IR）

import type { Domain } from "../schema.js";
import { MOD_CHECKLISTS, MOD_FLOWS, MOD_RULES, MOD_SCENE, MOD_TRIGGER } from "../constants.js";
import { isTriggerItemArray } from "../compile/type-guards.js";

/** 体检发现的问题。 */
export interface TriggerDescIssue {
  /** 规则 id。 */
  rule:
    | "desc-domain-boundary"
    | "desc-task-signal-weak"
    | "desc-rule-name-drift"
    | "desc-length-over";
  /** Domain 名。 */
  domainName: string;
  /** Trigger 项名。 */
  itemName: string;
  /** 人类可读描述。 */
  msg: string;
  /** 修复建议。 */
  hint?: string;
}

/** desc 长度预算（字符，含标点/英文——与 G4 实验变体同口径）。
 *
 *  依据（任务书 trigger-desc-cost-and-regression 步骤 1：先测成本再定预算）：
 *  - 成本侧：desc 逐字进 trigger-index，注入字符按 ~1:1 线性传导（G4 冒烟验证）
 *  - 效果侧：G3b V2（~100 字）为实测最优区间；任务词对齐才有效应，长度不叠加收益
 *  - 存量：现役 desc 最长 ~157 字（TASK max 152 / DOMAIN max 157）
 *  ⚠️ 暂定值 150——G4 正式数据（n=20/组）落地后复核并同步 authoring 手册预算段。
 */
export const DESC_LENGTH_BUDGET = 150;

/** 领域边界式 desc 的"领域介绍"形态——首个分句是"X 参考/索引/手册/指南/配置/方法/体系"。
 *  （对齐 issue §7.7.1 的机械判据） */
const DOMAIN_HEAD_PATTERN =
  /^[一-鿿A-Za-z0-9（）()·\- ]{0,24}(参考|索引|手册|指南|配置|方法|体系|能力索引)\s*[；;。]?\s*$/;

/** 任务信号词——desc 里出现这些才说明"写了什么时候该查"。 */
const TASK_SIGNAL_WORDS = [
  "时参考",
  "时触发",
  "时调用",
  "时先查",
  "时使用",
  "时用",
  "前，先查",
  "前先查",
  "前查",
  "先查",
  "时查",
  "前参考",
  "时提醒",
];

/** desc 首个分句（到 '；' / '。' / '，' 为止）。 */
function firstClause(desc: string): string {
  const m = desc.match(/^[^；;。，,]+/);
  return (m ? m[0] : desc).trim();
}

/** desc 是否含任务信号词。 */
function hasTaskSignal(desc: string): boolean {
  return TASK_SIGNAL_WORDS.some((w) => desc.includes(w));
}

/** desc 是否是"领域边界式"形态。 */
function looksDomainBoundary(desc: string): boolean {
  return DOMAIN_HEAD_PATTERN.test(firstClause(desc));
}

/** 从 desc 的括号枚举里抠出候选规则名。
 *  形态：改 schema 契约 … 前，先查规范（modules-type-safety、no-duplicate-type、…）
 *
 *  只认 **kebab-case** 名（`modules-type-safety`）——那是 Pt 的规则名惯例。
 *  CamelCase（`Domain` / `Blueprint` / `Profile`）是**概念名**不是规则名 → 不算引用，避免误报。 */
function extractNamedItems(desc: string): string[] {
  const out: string[] = [];
  // 全角 / 半角括号内的枚举
  for (const m of desc.matchAll(/[（(]([^（）()]*)[）)]/g)) {
    const inner = m[1];
    if (!inner) continue;
    for (const part of inner.split(/[、,，/]/)) {
      const t = part.trim();
      // 只留 kebab-case 标识符（至少一个连字符）——单驼峰/单词是概念名不是规则名
      if (!t) continue;
      if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)+$/.test(t)) continue;
      out.push(t);
    }
  }
  return out;
}

/** Domain 里所有可被 desc 点名的项名（Scene / Rules / Flows / Checklists 的 H3 名）。 */
function domainItemNames(domain: Domain): Set<string> {
  const names = new Set<string>();
  const modules = (domain.modules ?? {}) as Record<string, unknown>;
  for (const mod of [MOD_SCENE, MOD_RULES, MOD_FLOWS, MOD_CHECKLISTS]) {
    const arr = modules[mod];
    if (!Array.isArray(arr)) continue;
    for (const it of arr) {
      if (it && typeof it === "object" && typeof (it as { name?: unknown }).name === "string") {
        names.add((it as { name: string }).name);
      }
    }
  }
  return names;
}

/** Domain 里所有 Trigger 项。 */
function triggerItems(domain: Domain): Array<{ name: string; desc?: string }> {
  const modules = (domain.modules ?? {}) as Record<string, unknown>;
  const arr = modules[MOD_TRIGGER];
  if (!isTriggerItemArray(arr)) return [];
  return arr.map((t) => ({ name: t.name, desc: t.desc }));
}

/** 体检一个 Domain 的 Trigger desc。 */
export function checkTriggerDescQuality(domain: Domain): TriggerDescIssue[] {
  const issues: TriggerDescIssue[] = [];
  const items = triggerItems(domain);
  if (items.length === 0) return issues;

  const itemNames = domainItemNames(domain);

  for (const item of items) {
    const desc = (item.desc ?? "").trim();
    if (!desc) continue;

    // ---- 规则 4：超长（info，风格提示——独立于写法规则，超长 desc 也可能是好写法）----
    if (desc.length > DESC_LENGTH_BUDGET) {
      issues.push({
        rule: "desc-length-over",
        domainName: domain.name,
        itemName: item.name,
        msg: `Domain「${domain.name}」Trigger 项「${item.name}」的 desc 长 ${desc.length} 字（预算 ≤${DESC_LENGTH_BUDGET}）——超出不等于错，是该精简了：任务词对齐才有效应，长度不叠加收益，长 desc 稀释命中信号`,
        hint: `精简到预算内：保留任务类别词 + 点名 1-3 个代表项；背景/动机/领域介绍类内容移到 hint 或正文（不属于 desc）`,
      });
    }

    // ---- 规则 1：领域边界式 ----
    if (looksDomainBoundary(desc)) {
      issues.push({
        rule: "desc-domain-boundary",
        domainName: domain.name,
        itemName: item.name,
        msg: `Domain「${domain.name}」Trigger 项「${item.name}」的 desc 是领域边界式（"${firstClause(desc)}"）——只覆盖字面撞词场景，灰区任务几乎不触发（实测 16.4% vs 98.4%）`,
        hint: `改写成任务类别式：写"什么任务该查这本手册"（任务类别 + 命中信号），并点名代表项。形态：改 schema 契约 / 增删字段或类型 前，先查规范（项名、项名…）`,
      });
      continue; // 已是领域边界式，不再叠加规则 2
    }

    // ---- 规则 3：desc 点名的规则名不存在 ----
    const named = extractNamedItems(desc);
    const known = new Set(itemNames);
    const drifted = named.filter((n) => !known.has(n));
    if (drifted.length > 0) {
      issues.push({
        rule: "desc-rule-name-drift",
        domainName: domain.name,
        itemName: item.name,
        msg: `Domain「${domain.name}」Trigger 项「${item.name}」的 desc 点名了不存在的项：${drifted.join("、")}——写进 desc 的命中信号是死的（模型按这些名字去找会找不到）`,
        hint: `改为本 Domain 实际存在的项名（可用: ${[...itemNames].join("、") || "（无）"}）`,
      });
    }

    // ---- 规则 2：任务信号弱（没有点名任何本 Domain 的项）----
    if (hasTaskSignal(desc) && named.length === 0) {
      issues.push({
        rule: "desc-task-signal-weak",
        domainName: domain.name,
        itemName: item.name,
        msg: `Domain「${domain.name}」Trigger 项「${item.name}」的 desc 只有泛化任务词，没点名本 Domain 的任何项——命中信号只有一个宽泛短语，灰区任务对不上（实测：任务词与任务描述对齐时效应 82pp，不对齐时效应为 0）`,
        hint: `在 desc 末尾点名 1-3 个代表项（形态：…前，先查规范（项名、项名…））；可用: ${[...itemNames].slice(0, 8).join("、") || "（无）"}`,
      });
    }
  }

  return issues;
}
