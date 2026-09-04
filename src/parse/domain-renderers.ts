// src/parse/domain-renderers.ts — Domain H2 段解析注册表（pt-quality #3）
//
// Phase 10：parse 扩展用注册表，不用 switch-case（与 compile 的 moduleRenderers 一致）。
//   - 双层注册表：Record<H2段名, Record<type, fn>>
//   - 加新 (h2Name × type) 组合 = 调 registerDomainSectionRenderer 加一行 + 函数
//
// 替换 parse/domain.ts 中的 switch-case 主逻辑。switch-case 仅留兜底 default fallback。

import { s, sArr, type Item } from "./shared.js";
import type { FlowStep } from "../schema.js";

/** 单个 H2 段内容解析器。 */
export type DomainSectionParser = (items: Item[], sectionRaw: string) => unknown;

/** 注册表：H2段名 × Domain type → parser。 */
const domainSectionRenderers: Record<string, Record<string, DomainSectionParser>> = {
  // H2="Scene"
  Scene: {
    term: (items) =>
      items.map((it) => {
        const desc = s(it.fields.desc) || s(it.fields.description) || s(it.fields.role) || "";
        // v9.2 扩展：保留作者写在 Scene 段的附加信息（fields / purpose / rule）
        // 之前这些字段在 parse 阶段被静默丢弃，扩展后进入 IR 让 compile 渲染
        const fields = sArr(it.fields.fields);
        const note = s(it.fields.purpose) || s(it.fields.rule);
        const term: { name: string; desc: string; fields?: string[]; note?: string } = {
          name: it.name,
          desc,
        };
        if (fields.length > 0) term.fields = fields;
        if (note) term.note = note;
        return term;
      }),
    workflow: (items) => ({
      externals: items.map((it) => ({
        name: it.name,
        path: s(it.fields.path) || "",
        desc: s(it.fields.desc) || s(it.fields.description) || s(it.fields.role) || "",
      })),
    }),
    stack: (items) =>
      items.map((it) => {
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
    term: (items) =>
      items.map((it) => {
        const itemsArr = sArr(it.fields.items);
        const check =
          s(it.fields.check) ||
          s(it.fields.desc) ||
          s(it.fields.value) ||
          s(it.fields.description) ||
          "";
        if (itemsArr.length > 0) {
          return { name: it.name, slot: "global", type: "ban", check, items: itemsArr };
        }
        return { name: it.name, slot: "global", type: "invariant", check };
      }),
    workflow: (items, sectionRaw) =>
      items.map((item) => {
        const tpl: Record<string, unknown> = {
          name: item.name,
          argumentHint: s(item.fields["argument-hint"]) || undefined,
          intent: s(item.fields.intent),
          steps: collectSteps(item.name, sectionRaw),
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
  parser: DomainSectionParser
): void {
  if (!domainSectionRenderers[h2Name]) domainSectionRenderers[h2Name] = {};
  domainSectionRenderers[h2Name][type] = parser;
}

/** 取 (h2Name × type) 的 parser。未注册返 undefined（调用方走 fallback）。 */
export function getDomainSectionParser(
  h2Name: string,
  type: string
): DomainSectionParser | undefined {
  return domainSectionRenderers[h2Name]?.[type];
}

// ==================== shared 辅助 ====================

function collectSteps(itemName: string, sectionRaw: string): FlowStep[] {
  const lines = sectionRaw.split(/\r?\n/);
  const steps: FlowStep[] = [];
  let inItem = false;
  let cur: FlowStep | null = null;
  for (const line of lines) {
    const h3 = line.match(/^###\s+(.+)$/);
    if (h3) {
      if (inItem) break;
      if (h3[1].trim() === itemName) inItem = true;
      continue;
    }
    if (!inItem) continue;
    const stepMatch = line.match(/^\s*-\s+step\s*:\s*(.+)$/);
    if (stepMatch) {
      if (cur) steps.push(cur);
      cur = { desc: stepMatch[1].trim() };
      continue;
    }
    const observeMatch = line.match(/^\s*-\s+observe\s*:\s*(.+)$/);
    if (observeMatch && cur) {
      const val = observeMatch[1].trim();
      // 支持 [a, b] 数组格式 和 单值格式
      const arrMatch = val.match(/^\[(.*)\]$/);
      if (arrMatch) {
        cur.observe = arrMatch[1]
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s !== "");
      } else {
        cur.observe = [val];
      }
    }
  }
  if (cur) steps.push(cur);
  return steps;
}
