// src/parse/domain.ts — domains/*.md → Domain IR
//
// Phase 7.3：parse 拆分。Domain 适配器按 type 分发解析各 H2 段，H2 名开放。
//
// Domain asset 格式（v7）：
//   ---
//   type: <term|workflow|stack|扩展>
//   name: <domain-name>
//   ---
//
//   ## Scene          ← H2 段名 = 上下文模块类型（Pt 核心按名读段，不硬编码）
//     ...（按 type 决定段内格式：term→Term[]、workflow→ExternalRef[]、stack→ToolRef[]）
//
//   ## Manual         ← 第二模块（如 workflow-Domain 的 steps）
//     ...
//
//   ## Term           ← 内部模块（不直接注入，可被其他模块引用）
//     ...

import { join } from "node:path";
import { DOMAINS_DIR } from "../constants.js";
import type { Domain, ExternalRef, FlowStep, FlowTemplate, Rule, Term, ToolRef } from "../schema.js";
import { readAsset, s, sArr, type Item } from "./shared.js";

/** 读 domains/<fileName>.md → Domain { name, type, modules: Record<H2名, 内容> } */
export async function parseDomain(cwd: string, fileName: string): Promise<Domain> {
  const asset = await readAsset(join(cwd, DOMAINS_DIR, fileName));
  const type = typeof asset.frontmatter.type === "string" ? asset.frontmatter.type : "term";

  // H2 段名 → 段内容的解析：按 type 分发；未知 type 走通用 fallback（term 形态）。
  const modules: Record<string, unknown> = {};
  for (const [h2Name, section] of Object.entries(asset.sections)) {
    modules[h2Name] = parseDomainSection(h2Name, section.items, section.raw, type);
  }

  return {
    name: typeof asset.frontmatter.name === "string" ? asset.frontmatter.name : stripTypeSuffix(asset.name, type),
    type,
    modules,
  };
}

/** 按 type 分发解析单个 H2 段内容。 */
function parseDomainSection(h2Name: string, items: Item[], sectionRaw: string, type: string): unknown {
  // 通用按 H2 段名约定的内容类型（与 §0.1 / §0.4 表对应）：
  //   - "Scene"  ：term→Term[] / workflow→{externals: ExternalRef[]} / stack→ToolRef[]
  //   - "Manual" ：term→Rule[] / workflow→FlowTemplate[] / stack→空
  //   - 其他 H2 段（如 "Term"）：term→Term[]（fallback 形态）
  switch (h2Name) {
    case "Scene":
      switch (type) {
        case "term":
          return toTerms(items);
        case "workflow":
          return { externals: toExternals(items) };
        case "stack":
          return toTools(items);
        default:
          // 未知 type / 扩展 type 走 fallback：term 形态（Term[]）
          return toTerms(items);
      }
    case "Manual":
      switch (type) {
        case "term":
          return toRules(items);
        case "workflow":
          return toFlowTemplates(items, sectionRaw);
        case "stack":
          return [];
        default:
          return toRules(items);
      }
    default:
      // 其他 H2 段（"Term"、"Term2"、"Glossary" 等）：fallback term 形态
      return toTerms(items);
  }
}

// ==================== 字段映射辅助（OXN Item → Schema 子结构） ====================

function toTerms(items: Item[]): Term[] {
  return items.map((it) => ({ name: it.name, desc: s(it.fields.desc) || s(it.fields.description) }));
}

function toRules(items: Item[]): Rule[] {
  const rules: Rule[] = [];
  for (const it of items) {
    const itemsArr = sArr(it.fields.items);
    const desc = s(it.fields.desc) || s(it.fields.value) || s(it.fields.description);
    const check = desc || it.name;
    if (itemsArr.length > 0) {
      rules.push({ slot: "global", type: "ban", check, items: itemsArr });
    } else {
      rules.push({ slot: "global", type: "invariant", check });
    }
  }
  return rules;
}

function toExternals(items: Item[]): ExternalRef[] {
  return items.map((it) => ({ name: it.name, path: s(it.fields.path) }));
}

function toTools(items: Item[]): ToolRef[] {
  return items.map((it) => {
    const role = s(it.fields.role);
    const ops = sArr(it.fields.operations);
    const ref: ToolRef = { name: it.name };
    if (role) ref.role = role;
    if (ops.length > 0) ref.operations = ops;
    return ref;
  });
}

function toFlowTemplates(items: Item[], sectionRaw: string): FlowTemplate[] {
  return items.map((item) => {
    const steps = collectSteps(item.name, sectionRaw);
    const tpl: FlowTemplate = {
      name: item.name,
      argumentHint: s(item.fields["argument-hint"]) || undefined,
      intent: s(item.fields.intent),
      steps: steps.map<FlowStep>((desc) => ({ desc })),
      externals: [],
    };
    const vars = sArr(item.fields.vars);
    if (vars.length > 0) {
      // _vars 字段是 render 层附加的，不是 schema 字段——透传不收窄
      Object.assign(tpl, { _vars: vars });
    }
    return tpl;
  });
}

/** 从 sectionRaw 提取指定 H3 名下的所有 - step: 行 */
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

function stripTypeSuffix(fileBase: string, _type: string): string {
  // v7 资产命名约定不带 .term/.workflow 后缀；保留 v6 兼容
  return fileBase.replace(/\.(term|workflow|stack)$/, "");
}