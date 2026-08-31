// src/render/message.ts — SchemaBundle + Blueprint struct → Manual 实例（v6）
//
// Phase 5 重写：Manual 渲染不再吃裸 FlowTemplate，而是按 Blueprint struct 的 refs 摊平
// workflow-Domain.## Blueprint 的所有 FlowTemplate，逐个用 bindFlowTemplate 展开。
//
// v3 bindFlowTemplate 函数本体保留（变量绑定逻辑不变），仅 caller 改成 v6 形态。
//
// Phase 7.1: 从 backend/message.ts 迁入，import 路径改为相对 src/。

import type {
  Domain,
  FlowStep,
  FlowTemplate,
  SchemaBundle,
  Struct,
} from "../schema.js";

/** FlowTemplate + 元数据（OXN adapter 附加）。_vars 优先于 argument-hint fallback。 */
export type BoundableTemplate = FlowTemplate & { _vars?: string[] };

interface VarSpec {
  name: string;
  default?: string;
}

/**
 * 把 FlowTemplate 模板 + 用户参数 展开为完整手册 markdown（v3 逻辑不变）。
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
  tpl.steps.forEach((s, i) => {
    lines.push(`${i + 1}. ${replaceVars(s.desc, bound)}`);
  });

  return lines.join("\n");
}

/**
 * v6: 给定 SchemaBundle + Blueprint struct + 参数 args，
 * 摊平该 Blueprint struct 引用的所有 workflow-Domain.## Blueprint 的 FlowTemplate，
 * 按模板名匹配 args 对应的模板，binder 展开为 Manual。
 */
export function generateManual(
  bundle: SchemaBundle,
  manualStruct: Struct,
  args: string,
): string | null {
  // args 形如 "/risk-check 客户A 5000" 或 "客户A 5000"
  const m = args.trim().match(/^\/(\S+)\s*(.*)$/);
  const tplName = m ? m[1] : args.trim().split(/\s+/)[0];
  const tplArgs = m ? m[2] : args.trim().split(/\s+/).slice(1).join(" ");

  const domainByName = new Map(bundle.domains.map((d) => [d.name, d]));
  const refDomains: Domain[] = manualStruct.refs
    .map((n) => domainByName.get(n))
    .filter((d): d is Domain => !!d);

  // 找第一个匹配 tplName 的 FlowTemplate（跨 refDomains）
  for (const d of refDomains) {
    if (d.type !== "workflow") continue;
    const tpls = (d.blueprint as FlowTemplate[] | undefined) ?? [];
    const hit = tpls.find((t) => t.name === tplName);
    if (hit) {
      const bt: BoundableTemplate = hit as FlowTemplate & { _vars?: string[] };
      const vars = (bt as { vars?: unknown }).vars;
      if (Array.isArray(vars)) {
        const strs = vars.filter((x): x is string => typeof x === "string");
        if (strs.length > 0) bt._vars = strs;
      }
      return bindFlowTemplate(bt, tplArgs);
    }
  }
  return null;
}

// ==================== 内部辅助（v3 同款，保留） ====================

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

// ==================== 兼容 v3：findFlow 的替身 ====================

/** 在 SchemaBundle 中按名查找 FlowTemplate。v3 旧代码用此风格，保留兼容入口。 */
export function findFlowInBundle(bundle: SchemaBundle, tplName: string): BoundableTemplate | undefined {
  for (const d of bundle.domains) {
    if (d.type !== "workflow") continue;
    const tpls = (d.blueprint as FlowTemplate[] | undefined) ?? [];
    const hit = tpls.find((t) => t.name === tplName);
    if (hit) {
      const bt = hit as FlowTemplate & { _vars?: string[] };
      const vars = (bt as { vars?: unknown }).vars;
      if (Array.isArray(vars)) {
        const strs = vars.filter((x): x is string => typeof x === "string");
        if (strs.length > 0) bt._vars = strs;
      }
      return bt;
    }
  }
  return undefined;
}

// 用 FlowStep 类型以避免 unused import（保留）
void (null as unknown as FlowStep);