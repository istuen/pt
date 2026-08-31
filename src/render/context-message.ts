// src/render/context-message.ts — Context.## Manual → Context Message 字符串
//
// Phase 7.6：binder 展开 FlowTemplate。
// 输入：Context（modules["Manual"] 含 workflow-Domain 的 FlowTemplate 列表）+ Blueprint + 参数 args
// 输出：展开后的完整手册 markdown（注入 input 事件 transform）。
//
// 与 v6 backend/message.ts 的差异：
//   - 入口变成 Context + Blueprint（v6 是 SchemaBundle + Struct）
//   - binder 逻辑（变量替换、step 展开）保留不变

import type { Blueprint, Context, FlowStep, FlowTemplate } from "../schema.js";

/** FlowTemplate + 元数据（adapter 附加的 _vars）。_vars 优先于 argument-hint fallback。 */
export type BoundableTemplate = FlowTemplate & { _vars?: string[] };

interface VarSpec {
  name: string;
  default?: string;
}

/**
 * 给定 Context + Blueprint + args（形如 "/risk-check 客户A 5000" 或 "客户A 5000"），
 * 展开 Blueprint 引用 Domain 中的第一个匹配 tplName 的 FlowTemplate。
 */
export function renderContextMessage(ctx: Context, _blueprint: Blueprint, args: string): string | null {
  // args 形如 "/risk-check 客户A 5000" 或 "客户A 5000"
  const m = args.trim().match(/^\/(\S+)\s*(.*)$/);
  const tplName = m ? m[1] : args.trim().split(/\s+/)[0];
  const tplArgs = m ? m[2] : args.trim().split(/\s+/).slice(1).join(" ");

  // 遍历 ctx.modules["Manual"] 的内容，找 FlowTemplate
  // v7 简化：Context 只存 markdown 串（FlowTemplate 已序列化为 markdown）。
  // 因此 binder 展开在 input 事件时需要重新从 Blueprint → Domains → FlowTemplate 路径获取模板对象。
  //
  // 实际架构：bindFlowTemplate(template, args) 仍由 input handler 调，传 FlowTemplate 对象。
  // renderContextMessage 作为 render 层的 helper 不直接做 binder。
  // 这里导出 bindFlowTemplate 供 render/ 使用（保留 v6 的 binder 实现）。
  void tplName;
  void tplArgs;
  void ctx;
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

/** 在 Blueprint 引用的 Domain 中按名查找 FlowTemplate（跨 Domain）。 */
export function findFlowInBundle(
  blueprint: Blueprint,
  domains: Array<{ name: string; type: string; modules: Record<string, unknown> }>,
  tplName: string,
): BoundableTemplate | undefined {
  for (const dn of blueprint.domains) {
    const d = domains.find((x) => x.name === dn);
    if (!d || d.type !== "workflow") continue;
    const tpls = (d.modules["Manual"] as Array<FlowTemplate> | undefined) ?? [];
    const hit = tpls.find((t) => t.name === tplName);
    if (hit) {
      const bt = hit as FlowTemplate & { _vars?: string[] };
      // 兼容：args 里 vars 字段（如 frontmatter 残留）
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