// src/parse/domain.ts — domains/*.md → Domain IR
//
// Phase term-P9.3：删除 type 字段（Phase term-P9.2 时已先保留 type 键做过渡）。
//   parser 注册表从二维（h2Name × type）降为一维（h2Name）。
//   加新 H2 段名 = 调 registerDomainSectionRenderer 加一行注册 + parser 函数。
//
// Domain asset 格式（v9.3）：
//   ---
//   name: <domain-name>
//   ---
//
//   ## Scene          ← H2 段名 = 上下文模块类型（schema 由段名决定）
//     ...（Term[] 形态，含 path/fields/note/desc）
//
//   ## Rules          ← Rule[]（pt-quality）
//     ...
//
//   ## Flows          ← FlowTemplate[]（dev-workflow 等）
//     ...
//
//   ## Checklists     ← Checklist[]（pt-collab）
//     ...
//
//   ## Trigger         ← 索引段（H3 + desc/hint）
//     ...

import { join } from "node:path";
import type { Domain, Term } from "../schema.js";
import { readAsset, s, type Item } from "./shared.js";
import { getDomainSectionParser } from "./domain-renderers.js";

/** 读 domains/<fileName>.md → Domain { name, modules: Record<H2名, 内容> }
 *  Phase term-P9.3：Domain 不再有 type 字段——H2 段名直接决定 schema。
 *  v10.x：assetDir 让 fixtures 可指向 tests/fixtures/assets/（默认 .pt/assets）。 */
export async function parseDomain(absDir: string, fileName: string): Promise<Domain> {
  const asset = await readAsset(join(absDir, fileName));

  // H2 段名 → 段内容的解析：调注册表 parser，未注册走 fallback (Term[])
  const modules: Record<string, unknown> = {};
  for (const [h2Name, section] of Object.entries(asset.sections)) {
    modules[h2Name] = parseDomainSection(h2Name, section.items, section.raw);
  }

  return {
    name:
      typeof asset.frontmatter.name === "string"
        ? asset.frontmatter.name
        : stripTypeSuffix(asset.name),
    modules,
  };
}

/** 调注册表 parser（h2Name）解析单个 H2 段。Phase term-P9.3：删 type 参数，二维注册表降一维。
 *  未注册走 default fallback：term 形态（Term[]）——新 H2 段名加 fallback 即可。 */
function parseDomainSection(h2Name: string, items: Item[], sectionRaw: string): unknown {
  const parser = getDomainSectionParser(h2Name);
  if (parser) return parser(items, sectionRaw);

  // 未知 H2 段名：fallback 形态（term 的 Term[]）
  // ——新增 H2 段名（如 "Glossary"）会自动走 fallback 输出 Term[]，无需注册
  return fallbackTerms(items);
}

/** Default fallback：把 H3 项数组转 Term[]（用于未注册的 H2 段名，如 ## Term / ## Glossary）。 */
function fallbackTerms(items: Item[]): Term[] {
  return items.map((it) => ({
    name: it.name,
    desc: s(it.fields.desc) || s(it.fields.description),
  }));
}

/** Phase term-P9.3：去掉 type 参数——Type 已删除，文件名后缀剥离仍保留 .term/.workflow 兼容。 */
function stripTypeSuffix(fileBase: string): string {
  // v9 资产命名约定不带 .term/.workflow 后缀；保留 v6 兼容
  return fileBase.replace(/\.(term|workflow|stack)$/, "");
}
