// src/parse/parser.ts — OXN asset markdown → Asset
// 纯字符串处理，无依赖。OXN adapter 内部用，Pt 核心不见。
//
// Phase 7.1: 从 frontend/oxn/parser.ts 迁入，import 路径改为相对 src/。

import { readFile } from "node:fs/promises";
import type { Asset, AssetKind, Boundary, BlueprintRefs, External, Item, Section } from "./types.js";

/** 读 OXN asset 文件并解析 */
export async function readAsset(path: string): Promise<Asset> {
  const raw = await readFile(path, "utf8");
  const { fm, body } = parseFrontmatter(raw);

  // 从文件路径末尾推 name（无后缀）。Phase 5 拓展：
  //   - article.scene.md → name="article.scene"
  //   - article.manual.md → name="article.manual"
  // 调用方负责 split。
  const fileName = path.split("/").pop() ?? "";
  const name = fileName.replace(/\.[^.]+$/, "");

  // kind 优先从 frontmatter 读：v6 引入 type（Domain）与 kind（Struct）作为权威标签，
  // entity 仅作为 v3 兼容路径。推断逻辑保留为最后 fallback。
  let kind: AssetKind | undefined;
  if (typeof fm.kind === "string") {
    // v6 Struct: kind="scene" | "blueprint"。为便于 OXN 层统一表达，映射为同名 kind。
    kind = fm.kind as AssetKind;
  } else if (typeof fm.type === "string") {
    // v6 Domain: type="term" | "workflow" | "stack"。映射为 OXN kind。
    kind = fm.type as AssetKind;
  } else if (typeof fm.entity === "string") {
    // v3 兼容。
    kind = fm.entity as AssetKind;
  } else {
    kind = inferKind(body);
  }

  const sectionsArr = splitSections(body);
  const sections: Record<string, Section> = {};
  for (const sec of sectionsArr) {
    // 归一化 key：去 `## ` 前缀，去前后空格
    const key = sec.heading.replace(/^#+\s*/, "").trim();
    const items = parseItems(sec.raw);
    sections[key] = { heading: sec.heading, raw: sec.raw, items };
  }

  return { kind, name, frontmatter: fm, body, sections };
}

/** 解析 frontmatter --- ... --- 块（简易：只处理 key: value 与 key: [a, b]） */
export function parseFrontmatter(text: string): {
  fm: Record<string, unknown>;
  body: string;
} {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { fm: {}, body: text };
  const fm: Record<string, unknown> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([a-zA-Z_][\w-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    const val = kv[2].trim();
    fm[key] = parseScalar(val);
  }
  return { fm, body: m[2] };
}

/** 解析 scalar 值：返回 string / string[] / 嵌套对象（YAML 子集）。
 *  支持：[a, b] / { key: value, ... } / "quoted" / unquoted
 *  嵌套值通过 parseScalar 递归解析，所以支持任意嵌套深度。 */
function parseScalar(val: string): unknown {
  if (!val) return "";
  // [a, b]
  const arrMatch = val.match(/^\[(.*)\]$/);
  if (arrMatch) {
    return arrMatch[1]
      .split(",")
      .map((s) => unquote(s.trim()))
      .filter((s) => s !== "");
  }
  // { key: value, ... }  → 嵌套对象
  if (/^\{.*\}$/.test(val.trim())) {
    return parseInlineObject(val.trim());
  }
  return unquote(val);
}

/** 解析内联对象 { key: value, ... }。值仍是 scalar 字符串，由 parseScalar 递归解析。 */
function parseInlineObject(s: string): Record<string, unknown> {
  const inner = s.slice(1, -1).trim();
  if (!inner) return {};
  const out: Record<string, unknown> = {};
  // 简单分割：按逗号切（不支持值含逗号的复杂情况——YAML inline object 子集够用）
  for (const part of splitTopLevel(inner, ",")) {
    const kv = part.match(/^\s*([a-zA-Z_][\w-]*)\s*:\s*(.+)$/);
    if (kv) out[kv[1]] = parseScalar(kv[2].trim());
  }
  return out;
}

/** 按分隔符切分字符串，但忽略 {} [] 内部的分隔符。 */
function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let buf = "";
  for (const ch of s) {
    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") depth--;
    if (ch === sep && depth === 0) {
      out.push(buf);
      buf = "";
    } else {
      buf += ch;
    }
  }
  if (buf.trim()) out.push(buf);
  return out;
}

function unquote(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

/** 按 `## ` 切 H2 段。H1 `# ` 不在此处理（asset 一般只有 1 个 H1 当标题） */
export function splitSections(body: string): Array<{ heading: string; raw: string }> {
  const lines = body.split(/\r?\n/);
  const sections: Array<{ heading: string; raw: string }> = [];
  let cur: { heading: string; lines: string[] } | null = null;

  for (const line of lines) {
    const h2 = line.match(/^##\s+(.+)$/);
    if (h2) {
      if (cur) sections.push({ heading: cur.heading, raw: cur.lines.join("\n") });
      cur = { heading: line.trim(), lines: [] };
    } else if (cur) {
      cur.lines.push(line);
    }
  }
  if (cur) sections.push({ heading: cur.heading, raw: cur.lines.join("\n") });
  return sections;
}

/** 把段内 markdown 解析成 Item[]：
 *  - 有 H3 (`### name`) → 每个 H3 是一个 item，下属 `- key: value` 是 fields
 *  - 无 H3，整段就是 list → 顶层 `- key: value` 直接作为 items（name=key, fields={key: value}）
 */
export function parseItems(sectionRaw: string): Item[] {
  const lines = sectionRaw.split(/\r?\n/);
  const hasH3 = lines.some((l) => /^###\s+/.test(l));

  if (hasH3) {
    const items: Item[] = [];
    let cur: Item | null = null;
    for (const line of lines) {
      const h3 = line.match(/^###\s+(.+)$/);
      if (h3) {
        if (cur) items.push(cur);
        cur = { name: h3[1].trim(), fields: {} };
      } else if (cur) {
        const fv = line.match(/^\s*-\s+([a-zA-Z_][\w-]*)\s*:\s*(.+)$/);
        if (fv) cur.fields[fv[1]] = parseScalar(fv[2].trim());
      }
    }
    if (cur) items.push(cur);
    return items;
  }

  // 无 H3：顶层 list 直接当 items
  const items: Item[] = [];
  for (const line of lines) {
    const fv = line.match(/^\s*-\s+([a-zA-Z_][\w-]*)\s*:\s*(.+)$/);
    if (fv) {
      items.push({
        name: fv[1],
        fields: { [fv[1]]: parseScalar(fv[2].trim()) },
      });
    }
  }
  return items;
}

/** 从 Blueprint 的 `## Use` 段读 refs */
export function parseBlueprintRefs(asset: Asset): BlueprintRefs | null {
  const use = asset.sections["Use"];
  if (!use) return null;
  const out: Partial<BlueprintRefs> = {};
  for (const item of use.items) {
    if (item.name === "domain" || item.name === "workflow" || item.name === "stack") {
      const v = item.fields[item.name];
      if (typeof v === "string") out[item.name] = v;
    }
  }
  if (!out.domain || !out.workflow || !out.stack) return null;
  return out as BlueprintRefs;
}

/** 从 Blueprint 的 `## Boundaries` 段读 slot DAG */
export function parseBoundaries(asset: Asset): Boundary[] {
  const sec = asset.sections["Boundaries"];
  if (!sec) return [];
  const out: Boundary[] = [];
  for (const item of sec.items) {
    out.push({
      slot: item.name,
      operate: toStrArr(item.fields.operate),
      deps: toStrArr(item.fields.deps),
      desc: typeof item.fields.desc === "string" ? item.fields.desc : "",
    });
  }
  return out;
}

/** 从 asset 的 `## Externals` 段读 externals */
export function extractExternals(asset: Asset): External[] {
  const sec = asset.sections["Externals"];
  if (!sec) return [];
  const out: External[] = [];
  for (const item of sec.items) {
    const path = typeof item.fields.path === "string" ? item.fields.path : "";
    if (!path) continue;
    const name = typeof item.fields.name === "string" ? item.fields.name : undefined;
    out.push({
      assetKind: asset.kind,
      assetName: asset.name,
      path,
      name,
    });
  }
  return out;
}

function toStrArr(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  if (typeof v === "string") return v ? [v] : [];
  return [];
}

/** frontmatter 没 entity/type/kind 时，按 H2 段名推断 asset kind。Phase 5 仍保留 v3 fallback。 */
function inferKind(body: string): AssetKind {
  if (/^##\s+Use\b/m.test(body) && /^##\s+Boundaries\b/m.test(body)) return "blueprint";
  if (/^##\s+Slots\b/m.test(body)) return "workflow";
  if (/^##\s+Tools\b/m.test(body)) return "stack";
  return "domain";
}