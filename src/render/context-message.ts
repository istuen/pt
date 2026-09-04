// src/render/context-message.ts — FlowTemplate + 参数 → Context Message
//
// Phase 9.5：v9 后端通用化。
//   - renderContextMessage(ctx, blueprint, domains, args) 修复死代码——实现 /manual:xxx 触发
//   - findFlowInBlueprint(blueprint, domains, tplName) — 替代 v8 findFlowInBundle
//
// /manual:<domain-name> 触发：从 Blueprint 的 context_message 注入点引用的 Domain 里查 Manual 段
// /<flow-name> <args> 触发：展开 workflow-Domain 的 FlowTemplate（v8 逻辑保留）
//
// Tech Debt T6: 全用 type guard 收窄，不用 as 断言（pt-quality #1）
// Tech Debt T2: 用 constants 模块名常量（pt-quality #5）

import { MOD_MANUAL } from "../constants.js";
import { isFlowTemplateArray } from "../compile/type-guards.js";
import { formatManualBody } from "../compile/format-manual-body.js";
import type { AgentContext, Blueprint, Domain, FlowStep, FlowTemplate } from "../schema.js";

/** FlowTemplate + 元数据（adapter 附加的 _vars）。_vars 优先于 argument-hint fallback。 */
export type BoundableTemplate = FlowTemplate & { _vars?: string[] };

interface VarSpec {
  name: string;
  default?: string;
}

/**
 * 给定 Context + Blueprint + Domains + args（形如 "/manual:pt-quality" 或 "/risk-check 客户A 5000"），
 * 展开目标 Domain 的 Manual 段内容或 FlowTemplate。
 *
 * v9 触发：
 *   - /manual:<domain-name>：注入该 Domain 的 Manual 段内容（term→Rule checklist / workflow→FlowTemplate 列表）
 *   - /<flow-name> <args>：展开 workflow-Domain 的 FlowTemplate（v8 逻辑保留）
 */
export function renderContextMessage(
  _ctx: AgentContext,
  blueprint: Blueprint,
  domains: Domain[],
  args: string
): string | null {
  const m = args.trim().match(/^\/(\S+)\s*(.*)$/);
  if (!m) return null;
  const [, name, rest] = m;

  // /manual:<domain-name> 触发（v9 新增）—— name 可能是 "manual:pt-quality"
  if (name.startsWith("manual:")) {
    const domainName = name.slice("manual:".length).trim();
    const d = domains.find((x) => x.name === domainName);
    if (!d) return null;
    const manual = d.modules[MOD_MANUAL];
    if (manual === undefined) return null;
    return renderDomainManual(d, manual);
  }

  // /manual <domain-name> 触发——空格分隔形式
  if (name === "manual") {
    const domainName = rest.trim();
    const d = domains.find((x) => x.name === domainName);
    if (!d) return null;
    const manual = d.modules[MOD_MANUAL];
    if (manual === undefined) return null;
    return renderDomainManual(d, manual);
  }

  // /<flow-name> <args> 触发（v8 逻辑保留）
  const tpl = findFlowInBlueprint(blueprint, domains, name);
  if (!tpl) return null;
  return bindFlowTemplate(tpl, rest);
}

/**
 * 渲染 Domain 的 Manual 段内容（term→Rule checklist / workflow→FlowTemplate 列表）。
 *  P3.6：列表渲染逻辑抽到 formatManualBody（与 renderManualModule 共享）。 */
function renderDomainManual(d: Domain, content: unknown): string | null {
  if (d.type !== "term" && d.type !== "workflow") return null;
  if (Array.isArray(content) && content.length === 0) return null;

  const body = formatManualBody(d, content);
  if (!body) return null;

  const sectionTitle = d.type === "workflow" ? "## 可用手册" : "## 规范清单";
  return `# /manual:${d.name}\n\n${sectionTitle}\n\n${body}`.trimEnd();
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

/** 在 Blueprint 注入点（target=context_message）的引用域中按名查找 FlowTemplate（跨 Domain）。
 *  v9：renderContextMessage 拿不到 Profile（Profile 在 transpile 内被消费），
 *       所以这里直接遍历传入的 domains 全集找 workflow-type Domain 的 FlowTemplate。 */
export function findFlowInBlueprint(
  blueprint: Blueprint,
  domains: Array<{ name: string; type: string; modules: Record<string, unknown> }>,
  tplName: string
): BoundableTemplate | undefined {
  // 验证 Blueprint 里有 target=context_message 的注入点（间接确认 input 事件该由本实例覆盖接管）
  const hasContextMsgIp = blueprint.injectionPoints.some((ip) => ip.target === "context_message");
  if (!hasContextMsgIp) return undefined;

  for (const d of domains) {
    if (d.type !== "workflow") continue;
    const manual = d.modules[MOD_MANUAL];
    if (!isFlowTemplateArray(manual)) continue;
    const hit = manual.find((t) => t.name === tplName);
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
