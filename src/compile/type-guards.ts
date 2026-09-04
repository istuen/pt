// src/compile/type-guards.ts — Domain.modules 内容类型守卫（pt-quality #1）
//
// Domain.modules 的 H2 段内容是 unknown（type hole），消费者用 type guard 收窄，
// 不用 as 断言。type guard 集中管理，新增内容类型加一个 isXxxArray。
//
// 与 schema.ts 的区别：schema.ts 定义契约（Term/Rule/FlowTemplate 等结构），
// type-guards.ts 定义运行时收窄（"这个 unknown 是不是 Term[]?"）。

import type { ExternalRef, FlowTemplate, Rule, Term, ToolRef } from "../schema.js";

// ==================== 通用守卫 ====================

/** unknown 是否为数组。 */
export function isArray(x: unknown): x is unknown[] {
  return Array.isArray(x);
}

/** unknown 是否为非空数组。 */
export function isNonEmptyArray<T>(x: unknown): x is T[] {
  return Array.isArray(x) && x.length > 0;
}

/** unknown 是否为索引签名对象（非数组的 object）。 */
export function isRecord(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

// ==================== Term[] 守卫 ====================

/** 校验元素是否具备 Term 最小形状（{ name: string }）。
 *  v9.2：Term 加可选 fields/note 后仍只检查 name（最小形状），不强制 desc——
 *  这样 parse 阶段产出的 Term 即使 desc 为空也过关，renderer 走 `else lines.push("- name")` 分支。
 *  fields/note 是可选，向后兼容旧 IR。 */
function isTermLike(x: unknown): x is Term {
  return !!x && typeof x === "object" && typeof (x as { name?: unknown }).name === "string";
}

/** unknown 是否为 Term[]。 */
export function isTermArray(x: unknown): x is Term[] {
  return Array.isArray(x) && x.every(isTermLike);
}

// ==================== Rule[] 守卫 ====================

/** 校验元素是否具备 Rule 最小形状（{ type: "ban"|"invariant", check: string }）。 */
function isRuleLike(x: unknown): x is Rule {
  if (!x || typeof x !== "object") return false;
  const r = x as { type?: unknown; check?: unknown };
  return (r.type === "ban" || r.type === "invariant") && typeof r.check === "string";
}

/** unknown 是否为 Rule[]。 */
export function isRuleArray(x: unknown): x is Rule[] {
  return Array.isArray(x) && x.every(isRuleLike);
}

// ==================== FlowTemplate[] 守卫 ====================

/** 校验元素是否具备 FlowTemplate 最小形状（{ name, intent, steps[] }）。 */
export function isFlowTemplateLike(x: unknown): x is FlowTemplate {
  if (!x || typeof x !== "object") return false;
  const t = x as { name?: unknown; intent?: unknown; steps?: unknown };
  return typeof t.name === "string" && typeof t.intent === "string" && Array.isArray(t.steps);
}

/** unknown 是否为 FlowTemplate[]。 */
export function isFlowTemplateArray(x: unknown): x is FlowTemplate[] {
  return Array.isArray(x) && x.every(isFlowTemplateLike);
}

// ==================== Trigger 项[] 守卫 ====================

/** Trigger 段形态：H3 项数组（每项 { name, desc?, hint? }）。
 *  v9 新增——Trigger 段是索引段，H3 + desc/hint 列表。 */
function isTriggerItemLike(x: unknown): x is { name: string; desc?: string; hint?: string } {
  if (!x || typeof x !== "object") return false;
  const t = x as { name?: unknown; desc?: unknown; hint?: unknown };
  return (
    typeof t.name === "string" &&
    (t.desc === undefined || typeof t.desc === "string") &&
    (t.hint === undefined || typeof t.hint === "string")
  );
}

/** unknown 是否为 Trigger 项[]。 */
export function isTriggerItemArray(
  x: unknown
): x is Array<{ name: string; desc?: string; hint?: string }> {
  return Array.isArray(x) && x.every(isTriggerItemLike);
}

// ==================== ExternalRef[] 守卫 ====================

function isExternalRefLike(x: unknown): x is ExternalRef {
  if (!x || typeof x !== "object") return false;
  const r = x as { name?: unknown; path?: unknown };
  return typeof r.name === "string" && typeof r.path === "string";
}

export function isExternalRefArray(x: unknown): x is ExternalRef[] {
  return Array.isArray(x) && x.every(isExternalRefLike);
}

// ==================== ToolRef[] 守卫 ====================

function isToolRefLike(x: unknown): x is ToolRef {
  if (!x || typeof x !== "object") return false;
  const t = x as { name?: unknown };
  return typeof t.name === "string";
}

export function isToolRefArray(x: unknown): x is ToolRef[] {
  return Array.isArray(x) && x.every(isToolRefLike);
}

// ==================== workflow Scene 对象守卫 ====================

/** workflow-Domain 的 ## Scene 段：{ externals?: ExternalRef[] }。 */
export function isWorkflowScene(x: unknown): x is { externals?: ExternalRef[] } {
  if (!x || typeof x !== "object") return false;
  const s = x as { externals?: unknown };
  if (s.externals === undefined) return true;
  return isExternalRefArray(s.externals);
}

// ==================== 通用 fallback 守卫（带 name 字段的项） ====================

/** 通用 fallback 形态：H3 + name + desc 列表项（用于未注册 type 的聚合段输出）。 */
export function isNamedItemArray(x: unknown): x is Array<{ name: string; desc?: string }> {
  if (!Array.isArray(x)) return false;
  return x.every((it) => {
    if (!it || typeof it !== "object") return false;
    const t = it as { name?: unknown; desc?: unknown };
    return typeof t.name === "string" && (t.desc === undefined || typeof t.desc === "string");
  });
}
