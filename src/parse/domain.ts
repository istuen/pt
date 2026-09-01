// src/parse/domain.ts — domains/*.md → Domain IR
//
// Phase 10：parse 扩展用注册表（pt-quality #3）。
//   - 调 getDomainSectionParser(h2Name, type) 拿 parser（domain-renderers.ts 注册表）
//   - 注册表未命中走 default fallback（term 形态 Term[]）
//   - 加新 (h2Name × type) 组合 = 调 registerDomainSectionRenderer 加一行，不动主循环
//
// Domain asset 格式（v9）：
//   ---
//   type: <term|workflow|stack|扩展>
//   name: <domain-name>
//   ---
//
//   ## Scene          ← H2 段名 = 上下文模块类型
//     ...（按 type 决定段内格式：term→Term[]、workflow→{externals}、stack→ToolRef[]）
//
//   ## Manual         ← 第二模块（如 workflow-Domain 的 steps）
//     ...
//
//   ## Trigger         ← v9 新增：索引段（H3 + desc/hint）
//     ...

import { join } from "node:path";
import { DOMAINS_DIR } from "../constants.js";
import type { Domain, Term } from "../schema.js";
import { readAsset, type Item } from "./shared.js";
import { getDomainSectionParser } from "./domain-renderers.js";

/** 读 domains/<fileName>.md → Domain { name, type, modules: Record<H2名, 内容> } */
export async function parseDomain(cwd: string, fileName: string): Promise<Domain> {
  const asset = await readAsset(join(cwd, DOMAINS_DIR, fileName));
  const type = typeof asset.frontmatter.type === "string" ? asset.frontmatter.type : "term";

  // H2 段名 → 段内容的解析：调注册表 parser，未注册走 fallback (Term[])
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

/** 调注册表 parser（h2Name × type）解析单个 H2 段。
 *  未注册走 default fallback：term 形态（Term[]）——新 H2 段名加 fallback 即可。 */
function parseDomainSection(h2Name: string, items: Item[], sectionRaw: string, type: string): unknown {
  const parser = getDomainSectionParser(h2Name, type);
  if (parser) return parser(items, sectionRaw);

  // 未知 (h2Name × type) 组合：fallback 形态（term 的 Term[]）
  // ——新增 H2 段名（如 "Glossary"）会自动走 fallback 输出 Term[]，无需注册
  return fallbackTerms(items);
}

/** Default fallback：把 H3 项数组转 Term[]（用于未注册的 H2 段名，如 ## Term / ## Glossary）。 */
function fallbackTerms(items: Item[]): Term[] {
  return items.map((it) => ({ name: it.name, desc: s(it.fields.desc) || s(it.fields.description) }));
}

function s(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string").join(", ");
  return "";
}

function stripTypeSuffix(fileBase: string, _type: string): string {
  // v9 资产命名约定不带 .term/.workflow 后缀；保留 v6 兼容
  return fileBase.replace(/\.(term|workflow|stack)$/, "");
}