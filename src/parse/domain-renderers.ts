// src/parse/domain-renderers.ts — Domain H2 段解析注册表（pt-quality #3）
//
// Phase 10：parse 扩展用注册表，不用 switch-case（与 compile 的 moduleRenderers 一致）。
//   - 双层注册表：Record<H2段名, Record<type, fn>>
//   - 加新 (h2Name × type) 组合 = 调 registerDomainSectionRenderer 加一行 + 函数
//
// 替换 parse/domain.ts 中的 switch-case 主逻辑。switch-case 仅留兜底 default fallback。

import type { Item } from "./shared.js";

/** 单个 H2 段内容解析器。 */
export type DomainSectionParser = (items: Item[], sectionRaw: string) => unknown;

/** 注册表：H2段名 × Domain type → parser。 */
const domainSectionRenderers: Record<string, Record<string, DomainSectionParser>> = {
  // H2="Scene"
  Scene: {
    term: (items) => items.map((it) => ({ name: it.name, desc: s(it.fields.desc) || s(it.fields.description) })),
    workflow: (items) => ({ externals: items.map((it) => ({ name: it.name, path: s(it.fields.path) })) }),
    stack: (items) => items.map((it) => {
      const role = s(it.fields.role);
      const ops = sArr(it.fields.operations);
      const ref: { name: string; role?: string; operations?: string[] } = { name: it.name };
      if (role) ref.role = role;
      if (ops.length > 0) ref.operations = ops;
      return ref;
    }),
  },
  // H2="Manual"
  Manual: {
    term: (items) => items.map((it) => {
      const itemsArr = sArr(it.fields.items);
      const desc = s(it.fields.desc) || s(it.fields.value) || s(it.fields.description);
      const check = desc || it.name;
      if (itemsArr.length > 0) {
        return { slot: "global", type: "ban", check, items: itemsArr };
      }
      return { slot: "global", type: "invariant", check };
    }),
    workflow: (items, sectionRaw) => items.map((item) => {
      const tpl: Record<string, unknown> = {
        name: item.name,
        argumentHint: s(item.fields["argument-hint"]) || undefined,
        intent: s(item.fields.intent),
        steps: collectSteps(item.name, sectionRaw).map((desc) => ({ desc })),
        externals: [],
      };
      const vars = sArr(item.fields.vars);
      if (vars.length > 0) tpl._vars = vars;
      return tpl;
    }),
    stack: () => [],
  },
};

/** 加新 (h2Name × type) 组合 = 调 registerDomainSectionRenderer 加一行注册 + 一个 parser 函数。 */
export function registerDomainSectionRenderer(
  h2Name: string,
  type: string,
  parser: DomainSectionParser,
): void {
  if (!domainSectionRenderers[h2Name]) domainSectionRenderers[h2Name] = {};
  domainSectionRenderers[h2Name][type] = parser;
}

/** 取 (h2Name × type) 的 parser。未注册返 undefined（调用方走 fallback）。 */
export function getDomainSectionParser(h2Name: string, type: string): DomainSectionParser | undefined {
  return domainSectionRenderers[h2Name]?.[type];
}

// ==================== shared 辅助 ====================

function s(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string").join(", ");
  return "";
}

function sArr(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  if (typeof v === "string" && v) return [v];
  return [];
}

function collectSteps(itemName: string, sectionRaw: string): string[] {
  const lines = sectionRaw.split(/\r?\n/);
  const steps: string[] = [];
  let inItem = false;
  for (const line of lines) {
    const h3 = line.match(/^###\s+(.+)$/);
    if (h3) {
      const name = h3[1].trim();
      if (inItem) break;
      if (name === itemName) inItem = true;
      continue;
    }
    if (!inItem) continue;
    const stepMatch = line.match(/^\s*-\s+step\s*:\s*(.+)$/);
    if (stepMatch) steps.push(stepMatch[1].trim());
  }
  return steps;
}