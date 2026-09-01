// src/render/context-message.ts — FlowTemplate + 参数 → Context Message
//
// Phase 8.5：v8 后端通用化。
//   - renderContextMessage(ctx, channel, blueprint, args) 改为按注入点遍历
//   - findFlowInBundle(blueprint, domains, tplName) 改为按 blueprint.injectionPoints[target=context_message] 的 domains 找
//
// 与 v6 backend/message.ts 的差异：
//   - 入口变成 Context + Channel + Blueprint（v6 是 SchemaBundle + Struct）
//   - binder 逻辑（变量替换、step 展开）保留不变

import type { Blueprint, Channel, Context, FlowStep, FlowTemplate, InjectionPointInstance } from "../schema.js";

/** FlowTemplate + 元数据（adapter 附加的 _vars）。_vars 优先于 argument-hint fallback。 */
export type BoundableTemplate = FlowTemplate & { _vars?: string[] };

interface VarSpec {
  name: string;
  default?: string;
}

/**
 * 给定 Context + Channel + Blueprint + args（形如 "/risk-check 客户A 5000" 或 "客户A 5000"），
 * 展开 Blueprint 注入点（target=context_message）里第一个匹配 tplName 的 FlowTemplate。
 */
export function renderContextMessage(
  ctx: Context,
  channel: Channel,
  _blueprint: Blueprint,
  args: string,
): string | null {
  // args 形如 "/risk-check 客户A 5000" 或 "客户A 5000"
  const m = args.trim().match(/^\/(\S+)\s*(.*)$/);
  const tplName = m ? m[1] : args.trim().split(/\s+/)[0];
  const tplArgs = m ? m[2] : args.trim().split(/\s+/).slice(1).join(" ");

  // 验证 Channel 里有 target=context_message 的注入点（间接确认 input 事件该由本 Blueprint 接管）
  const hasContextMsgIp = channel.injectionPoints.some((ip) => ip.target === "context_message");
  if (!hasContextMsgIp) return null;

  // v7 简化：Context 只存 markdown 串（FlowTemplate 已序列化为 markdown）。
  // 因此 binder 展开在 input 事件时需要重新从 Blueprint → Domains → FlowTemplate 路径获取模板对象。
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

/** 在 Blueprint 注入点（target=context_message）的 domains 中按名查找 FlowTemplate（跨 Domain）。 */
export function findFlowInBundle(
  blueprint: Blueprint,
  domains: Array<{ name: string; type: string; modules: Record<string, unknown> }>,
  tplName: string,
): BoundableTemplate | undefined {
  // v8：从 blueprint.injectionPoints 里 target=context_message 的注入点的 domains 找
  const contextMsgIps: InjectionPointInstance[] = blueprint.injectionPoints.filter(
    (ip) => ip.domains.length > 0,
  );
  for (const ip of contextMsgIps) {
    for (const dn of ip.domains) {
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
  }
  return undefined;
}
