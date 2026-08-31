// src/parse/shared.ts — 通用 MD 词法+语法（domain/channel/blueprint 共享）
//
// Phase 7.3：从原 src/parse/{parser,types}.ts 抽公共部分。
//   - Domain/Channel/Blueprint adapter 都按 H2 段解析，H3 子项 → Item。
//   - 共享 frontmatter 解析、H2 段切分、H3 项解析、scalar 值解析。
//   - 共享 Asset/Section/Item 类型。

import { readFile } from "node:fs/promises";

// ==================== 类型（OXN 中间表示，Pt 核心不见） ====================

/** OXN 内部 asset kind（v7 沿用 v6 的扩展名空间）。
 *  - "domain"    : Content Domain（v7 内容层）
 *  - "channel"   : Channel（v7 结构层）
 *  - "blueprint" : Blueprint（v7 配置层）
 *  - "term" / "workflow" / "stack" / "glossary" : Domain type 标签（frontmatter.type）
 *  - "scene" / "manual" : v6 Struct kind 兼容（v7 资产迁移期残留） */
export type AssetKind =
  | "domain" | "channel" | "blueprint"
  | "term" | "workflow" | "stack" | "glossary"
  | "scene" | "manual";

export interface Item {
  /** H3 标题（如 "文章"、"select-topic"） */
  name: string;
  /** "- key: value" / "- key: [a, b]" / "- key: { ... }" 字段。
   *  值可以是 string / string[] / 嵌套对象（YAML 子集）；consumer 用 typeof 收窄。 */
  fields: Record<string, unknown>;
}

export interface Section {
  /** "## Terms" 原文 */
  heading: string;
  /** 段内 markdown（含 H3 子项） */
  raw: string;
  /** H3 子项解析结果 */
  items: Item[];
}

export interface Asset {
  kind: AssetKind;
  /** 文件名去后缀（v7 例："project-dev.channel" / "pt-blueprint"） */
  name: string;
  frontmatter: Record<string, unknown>;
  /** frontmatter 之后的 markdown */
  body: string;
  /** H2 段名（首字母大写）→ 段内容 */
  sections: Record<string, Section>;
}

// ==================== 词法/语法（共享） ====================

/** 读 asset 文件并解析 frontmatter + H2 段。 */
export async function readAsset(path: string): Promise<Asset> {
  const raw = await readFile(path, "utf8");
  const { fm, body } = parseFrontmatter(raw);

  // 从文件路径末尾推 name（无后缀）
  const fileName = path.split("/").pop() ?? "";
  const name = fileName.replace(/\.[^.]+$/, "");

  // kind 推断优先级：frontmatter.kind → frontmatter.type → frontmatter.entity → H2 推断
  let kind: AssetKind | undefined;
  if (typeof fm.kind === "string") {
    kind = fm.kind as AssetKind;
  } else if (typeof fm.type === "string") {
    kind = fm.type as AssetKind;
  } else if (typeof fm.entity === "string") {
    kind = fm.entity as AssetKind;
  } else {
    kind = inferKind(body);
  }

  const sectionsArr = splitSections(body);
  const sections: Record<string, Section> = {};
  for (const sec of sectionsArr) {
    const key = sec.heading.replace(/^#+\s*/, "").trim();
    sections[key] = { heading: sec.heading, raw: sec.raw, items: parseItems(sec.raw) };
  }

  return { kind, name, frontmatter: fm, body, sections };
}

/** 解析 frontmatter --- ... --- 块（简易：key: value / key: [a, b] / key: { ... }） */
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

/** 解析 scalar 值：string / string[] / 嵌套对象（YAML 子集）。
 *  嵌套值通过 parseScalar 递归解析，支持任意深度。 */
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

function parseInlineObject(s: string): Record<string, unknown> {
  const inner = s.slice(1, -1).trim();
  if (!inner) return {};
  const out: Record<string, unknown> = {};
  for (const part of splitTopLevel(inner, ",")) {
    const kv = part.match(/^\s*([a-zA-Z_][\w-]*)\s*:\s*(.+)$/);
    if (kv) out[kv[1]] = parseScalar(kv[2].trim());
  }
  return out;
}

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
 *  - 无 H3，整段就是 list → 顶层 `- key: value` 直接作为 items
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

// ==================== 字段取值辅助（共享） ====================

/** 把 unknown 收窄为 string（数组则 join）。无值 → ""。 */
export function s(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string").join(", ");
  return "";
}

/** 把 unknown 收窄为 string[]（单值包成 1-数组）。无值 → []。 */
export function sArr(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  if (typeof v === "string" && v) return [v];
  return [];
}

/** frontmatter 没 entity/type/kind 时，按 H2 段名推断 asset kind。 */
function inferKind(body: string): AssetKind {
  if (/^##\s+Channel\b/m.test(body) && /^##\s+Domains\b/m.test(body)) return "blueprint";
  if (/^##\s+Modules\b/m.test(body) && /^##\s+Layout\b/m.test(body)) return "channel";
  if (/^##\s+Slots\b/m.test(body)) return "workflow";
  if (/^##\s+Tools\b/m.test(body)) return "stack";
  if (/^##\s+Boundaries\b/m.test(body)) return "blueprint";
  return "domain";
}