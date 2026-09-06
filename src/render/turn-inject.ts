// src/render/turn-inject.ts — FlowTemplate + 参数 → Turn Inject
//
// Phase 9.5：v9 后端通用化。
//   - renderTurnInject(ctx, blueprint, domains, args) 修复死代码——实现 /manual:xxx 触发
//   - findFlowInBlueprint(blueprint, domains, tplName) — 替代 v8 findFlowInBundle
//
// /manual:<domain-name> 触发：从 Blueprint 的 turn 聚合组引用的 Domain 里查 Manual 段
// /<flow-name> <args> 触发：展开 Domain 的 FlowTemplate（v8 逻辑保留）
//
// Phase term-P4.3：renderContextMessage → renderTurnInject；inject 语义值 context_message → turn（Agent-agnostic 语义值）。
//   bindFlowTemplate / findFlowInBlueprint 函数名不改——它们是 FlowTemplate 操作，非注入位置概念。
//
// Tech Debt T6: 全用 type guard 收窄，不用 as 断言（pt-quality #1）
// Tech Debt T2: 用 constants 模块名常量（pt-quality #5）

import { MOD_CHECKLISTS, MOD_FLOWS, MOD_RULES } from "../constants.js";
import { isChecklistArray, isFlowTemplateArray, isRuleArray } from "../compile/type-guards.js";
import type { AgentContext, Blueprint, Domain, FlowStep, FlowTemplate } from "../schema.js";

/** FlowTemplate + 元数据（adapter 附加的 _vars）。_vars 优先于 argument-hint fallback。 */
export type BoundableTemplate = FlowTemplate & { _vars?: string[] };

interface VarSpec {
  name: string;
  default?: string;
}

/**
 * 给定 AgentContext + Blueprint + Domains + args（形如 "/manual:pt-quality" 或 "/risk-check 客户A 5000"），
 * 展开目标 Domain 的 Manual 段内容或 FlowTemplate。
 *
 * v9 触发：
 *   - /manual:<domain-name>：注入该 Domain 的 Manual 段内容（term→Rule checklist / workflow→FlowTemplate 列表）
 *   - /<flow-name> <args>：展开 workflow-Domain 的 FlowTemplate（v8 逻辑保留）
 *
 * Phase term-P4.3：AgentAdapter 内部把 Turn Inject 注入到 Agent 的 turn 级（Pi: input 事件 transform）。
 */
export function renderTurnInject(
  _ctx: AgentContext,
  blueprint: Blueprint,
  domains: Domain[],
  args: string
): string | null {
  const m = args.trim().match(/^\/(\S+)\s*(.*)$/);
  if (!m) return null;
  const [, name, rest] = m;

  // /manual:<domain-name> 触发（v9 新增）—— name 可能是 "manual:pt-quality"
  // Phase term-P9.2：Domain 不再有单一 Manual 段，而是 Rules/Flows/Checklists 三选一。
  //   顺序遍历找第一个非空段，返回对应渲染。
  if (name.startsWith("manual:")) {
    const domainName = name.slice("manual:".length).trim();
    const d = domains.find((x) => x.name === domainName);
    if (!d) return null;
    return renderDomainManual(d);
  }

  // /manual <domain-name> 触发——空格分隔形式
  if (name === "manual") {
    const domainName = rest.trim();
    const d = domains.find((x) => x.name === domainName);
    if (!d) return null;
    return renderDomainManual(d);
  }

  // /<flow-name> <args> 触发（v8 逻辑保留）
  const tpl = findFlowInBlueprint(blueprint, domains, name);
  if (!tpl) return null;
  return bindFlowTemplate(tpl, rest);
}

/**
 * 渲染 Domain 的"手册"段内容（Phase term-P9.2：从 Manual 拆三段）。
 *  - Rules → Rule checklist（"## 规范清单"）
 *  - Flows → FlowTemplate 列表（"## 可用手册"）
 *  - Checklists → Checklist 列表（"## 验收清单"）
 *  优先级：Flows > Rules > Checklists（workhorse 最常被查）。
 *  返回 null 表示该 Domain 没有任何手册段。 */
function renderDomainManual(d: Domain): string | null {
  const flows = d.modules[MOD_FLOWS];
  if (isFlowTemplateArray(flows)) {
    const lines: string[] = [];
    for (const t of flows) {
      const hint = t.argumentHint ? ` ${t.argumentHint}` : "";
      lines.push(`- ${t.name}${hint}: ${t.intent}`);
    }
    if (lines.length > 0) {
      return `# /manual:${d.name}\n\n## 可用手册\n\n${lines.join("\n")}`.trimEnd();
    }
  }

  const rules = d.modules[MOD_RULES];
  if (isRuleArray(rules)) {
    const lines: string[] = [];
    for (const r of rules) {
      if (r.type === "invariant") {
        if (r.check) lines.push(`- ${r.name}: ${r.check}`);
        else lines.push(`- ${r.name}`);
      } else if (r.type === "ban" && r.items && r.items.length > 0) {
        if (r.check) lines.push(`- ${r.name}: ${r.check} (${r.items.join(" / ")})`);
        else lines.push(`- ${r.name}: ${r.items.join(" / ")}`);
      }
    }
    if (lines.length > 0) {
      return `# /manual:${d.name}\n\n## 规范清单\n\n${lines.join("\n")}`.trimEnd();
    }
  }

  const checklists = d.modules[MOD_CHECKLISTS];
  if (isChecklistArray(checklists)) {
    const sections: string[] = [];
    for (const cl of checklists) {
      sections.push(`### ${cl.name}\n${cl.items.map((i) => `- ${i}`).join("\n")}`);
    }
    if (sections.length > 0) {
      return `# /manual:${d.name}\n\n## 验收清单\n\n${sections.join("\n\n")}`.trimEnd();
    }
  }

  return null;
}

/**
 * 把 FlowTemplate 模板 + 用户参数 展开为完整手册 markdown。
 * 错误 / 缺失变量 → 留为字面量（不抛异常）。
 */
export function bindFlowTemplate(tpl: BoundableTemplate, args: string): string {
  const tokens = args.trim() ? args.trim().split(/\s+/) : [];
  const varSpecs = parseVarSpecs(tpl._vars, tpl.argumentHint);

  const bound = new Map<string, string>();
  for (let i = 0; i < varSpecs.length; i++) {
    const spec = varSpecs[i];
    const token = tokens[i];
    if (token !== undefined) {
      bound.set(spec.name, token);
    } else if (spec.default !== undefined) {
      bound.set(spec.name, spec.default);
    }
  }

  const lines: string[] = [];
  lines.push(`# ${tpl.name}`);
  lines.push("");
  if (tpl.argumentHint) {
    lines.push(`_参数：${tpl.argumentHint}_`);
    lines.push("");
  }
  lines.push(`## 前提（Intent）`);
  lines.push(replaceVars(tpl.intent, bound));
  lines.push("");
  lines.push(`## 步骤`);
  tpl.steps.forEach((s: FlowStep, i: number) => {
    lines.push(`${i + 1}. ${replaceVars(s.desc, bound)}`);
    if (s.observe && s.observe.length > 0) {
      lines.push(`   - 验证参照：${s.observe.join(", ")}`);
    }
  });

  return lines.join("\n");
}

// ==================== 内部辅助 ====================

function parseVarSpecs(_vars: string[] | undefined, hint: string | undefined): VarSpec[] {
  if (_vars && _vars.length > 0) {
    return _vars.map(parseVarSpecName);
  }
  if (hint) {
    const matches = [...hint.matchAll(/<([^>]+)>/g)];
    return matches.map((m) => parseVarSpecName(m[1]));
  }
  return [];
}

function parseVarSpecName(raw: string): VarSpec {
  const trimmed = raw.trim();
  const idx = trimmed.indexOf("|");
  if (idx < 0) return { name: trimmed };
  const name = trimmed.slice(0, idx).trim();
  const defaultPart = trimmed.slice(idx + 1).trim();
  const defaultMatch = defaultPart.match(/^default\s*:\s*(.*)$/);
  if (defaultMatch) return { name, default: defaultMatch[1].trim() };
  return { name, default: defaultPart };
}

function replaceVars(text: string, bound: Map<string, string>): string {
  return text.replace(/\{\{([^}]+)\}\}/g, (match, inner: string) => {
    const spec = parseVarSpecName(inner);
    const v = bound.get(spec.name);
    if (v !== undefined) return v;
    if (spec.default !== undefined) return spec.default;
    return match;
  });
}

/** 在 Blueprint 聚合组（inject=turn）的引用域中按名查找 FlowTemplate（跨 Domain）。
 *  v9：renderTurnInject 拿不到 Profile（Profile 在 transpile 内被消费），
 *       所以这里直接遍历传入的 domains 全集找含 Flows 段的 Domain 的 FlowTemplate。
 *  Phase term-P4.3 + term-final：inject 语义值 turn（原 context_message → turn → 现聚合组 inject=turn）。 */
export function findFlowInBlueprint(
  blueprint: Blueprint,
  // Phase term-P9.3：type 字段删除——Domain 不再有 type 维度，按 H2 段名（这里是 ## Flows）识别 FlowTemplate
  domains: Array<{ name: string; modules: Record<string, unknown> }>,
  tplName: string
): BoundableTemplate | undefined {
  // 验证 Blueprint 里有 inject=turn 的聚合组（间接确认 input 事件该由本实例覆盖接管）
  const hasTurnGroup = blueprint.groups.some((g) => g.inject === "turn");
  if (!hasTurnGroup) return undefined;

  for (const d of domains) {
    // Phase term-P9.2：FlowTemplate 在 ## Flows 段（不分 type）。
    const flows = d.modules[MOD_FLOWS];
    if (!isFlowTemplateArray(flows)) continue;
    const hit = flows.find((t) => t.name === tplName);
    if (hit) {
      const bt: BoundableTemplate = { ...hit };
      // P2.1：v9 BoundableTemplate = FlowTemplate & { _vars? }，vars 字段 spread 不会产生
      // 原双重 cast (bt as unknown as { vars?: unknown }).vars 永远 undefined（dead code）。
      // 若未来需从 args 传 vars 进来，应在调用方 bindFlowTemplate 处理，不在此处 cast 补救。
      return bt;
    }
  }
  return undefined;
}
