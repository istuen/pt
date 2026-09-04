// src/parse/domain-renderers.ts — Domain H2 段解析注册表（pt-quality #3）
//
// Phase term-P9.3：注册表从二维（h2Name × type）降为一维（h2Name）。
//   - Type 字段已删除——H2 段名 = schema 选择器（一个 H2 段一个 schema）
//   - 加新 H2 段名 = 调 registerDomainSectionRenderer 加一行 + parser 函数
//
// 替换 parse/domain.ts 中的 switch-case 主逻辑。switch-case 仅留兜底 default fallback。

import { s, sArr, type Item } from "./shared.js";
import type { FlowStep } from "../schema.js";

/** 单个 H2 段内容解析器。 */
export type DomainSectionParser = (items: Item[], sectionRaw: string) => unknown;

/** 注册表：H2段名 → parser。Phase term-P9.3：删 type 维度。 */
const domainSectionRenderers: Record<string, DomainSectionParser> = {
  // H2="Scene"（Phase term-P9.1：统一为 Term[]）
  Scene: (items) =>
    items.map((it) => {
      const desc = s(it.fields.desc) || s(it.fields.description) || s(it.fields.role) || "";
      const path = s(it.fields.path);
      const fields = sArr(it.fields.fields);
      const note = s(it.fields.purpose) || s(it.fields.rule);
      const term: { name: string; desc?: string; fields?: string[]; note?: string; path?: string } =
        {
          name: it.name,
        };
      if (desc) term.desc = desc;
      if (path) term.path = path;
      if (fields.length > 0) term.fields = fields;
      if (note) term.note = note;
      return term;
    }),
  // H2="Rules"（Phase term-P9.2：从 Manual.term 拆出）—— Rule[]
  Rules: (items) =>
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
  // H2="Flows"（Phase term-P9.2：从 Manual.workflow 拆出）—— FlowTemplate[]
  Flows: (items, sectionRaw) =>
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
  // H2="Checklists"（Phase term-P9.2：新增）—— Checklist[]
  Checklists: (items) =>
    items.map((it) => ({
      name: it.name,
      items: sArr(it.fields.items),
    })),
};

/** 加新 H2 段名 = 调 registerDomainSectionRenderer 加一行注册 + 一个 parser 函数。
 *  Phase term-P9.3：删 type 参数。 */
export function registerDomainSectionRenderer(h2Name: string, parser: DomainSectionParser): void {
  domainSectionRenderers[h2Name] = parser;
}

/** 取 H2段名 的 parser。未注册返 undefined（调用方走 fallback）。Phase term-P9.3：删 type 参数。 */
export function getDomainSectionParser(h2Name: string): DomainSectionParser | undefined {
  return domainSectionRenderers[h2Name];
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
