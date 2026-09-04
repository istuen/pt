// src/parse/shared.ts — 通用 MD 词法+语法（domain/blueprint/profile 共享）
//
// Phase 7.3：从原 src/parse/{parser,types}.ts 抽公共部分。
//   - Domain/Blueprint/Profile adapter 都按 H2 段解析，H3 子项 → Item。
//   - 共享 frontmatter 解析、H2 段切分、H3 项解析、scalar 值解析。
//   - 共享 Asset/Section/Item 类型。
//
// Phase 9.3：v9 适配 — Channel 删除（Channel 留作未来 Connector），inferKind 用 frontmatter 字段。
//   AssetKind 去除 "channel"——但保留 type 值以防历史资源解析时遗留错误。

import { readFile } from "node:fs/promises";

// ==================== 类型（OXN 中间表示，Pt 核心不见） ====================

/** MD 资产内部 kind（v9 适配）。
 *  - "domain"    : Content Domain（v7/v9 内容层）
 *  - "blueprint" : Blueprint（v7 配置层 / v9 结构层）
 *  - "profile"   : Profile（v9 配置层，新增）
 *  - "term" / "workflow" / "glossary" : Domain type 标签（frontmatter.type，P9 删 stack 死类型后残留的历史枚举值）
 *  - "scene" / "manual" : v6 Struct kind 兼容（v7 资产迁移期残留）
 *
 *  v9 删除了 "channel"（Channel 留作未来 Connector，本版本不实现）——不再出现在 kind 联合中。
 *  如解析到历史资源带 channel 段，frontmatter.kind 可 指 配 "channel"（保留为字符串兜底）。 */
export type AssetKind =
  | "domain"
  | "blueprint"
  | "profile"
  | "term"
  | "workflow"
  | "glossary"
  | "scene"
  | "manual"
  // 兜底：v8 channel 历史资源可能含 frontmatter.kind: "channel"
  | "channel";

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
  /** 文件名去后缀（v7/v8 例："project-dev.channel" / "pt-blueprint"） */
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

  // Phase term-P9.3：type 字段已删——kind 推断逻辑仅保留为兼容（无 caller 实际使用）。
  //   资产加载走目录路由（src/parse/index.ts loadAllDomains / loadAllBlueprints / loadAllProfiles），
  //   不依赖 readAsset 的 kind 字段。
  const kind: AssetKind = "domain"; // 默认值——保留 AssetKind 联合类型以备未来扩展

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
 *  - 无 H3，整段就是 list → 顶层 `- key: value` / `- name` 直接作为 items
 *
 *  顶层 list 支持两种行形态：
 *    - `- key: value` → { name: "key", fields: { key: value } }
 *    - `- name`       → { name: "name", fields: {} }（裸名列表，例 ## Modules 段）
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

  // 无 H3：顶层 list 直接当 items（支持 `- key: value` 和 `- name` 两种行）
  const items: Item[] = [];
  for (const line of lines) {
    const fv = line.match(/^\s*-\s+([a-zA-Z_][\w-]*)\s*:\s*(.+)$/);
    if (fv) {
      items.push({
        name: fv[1],
        fields: { [fv[1]]: parseScalar(fv[2].trim()) },
      });
      continue;
    }
    const bare = line.match(/^\s*-\s+(.+?)\s*$/);
    if (bare) {
      items.push({ name: bare[1].trim(), fields: {} });
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

/** 从一个 H2 段里取某个字段的标量值（兼容裸值 / 顶层 list `- key: value` / H3 项 fields.key）。
 *  用途：Channel 注入点 H2 下读 target/mode，Blueprint ## Compilation 下读 cache-dir/split。 */
export function extractFieldValue(section: Section | undefined, key: string): string {
  if (!section) return "";

  // 1. 顶层 list 行：`- target: session`
  for (const item of section.items) {
    const v = item.fields[key];
    if (v !== undefined) {
      const sv = s(v);
      if (sv) return sv;
    }
  }

  // 2. 裸值段（## H2 后第一行非空文本）—— 取第一个匹配 `key: value` 的行
  for (const line of section.raw.split(/\r?\n/)) {
    const m = line.match(new RegExp(`^\\s*${key}\\s*:\\s*(.+?)\\s*$`));
    if (m) {
      return s(parseScalar(m[1].trim()));
    }
  }

  return "";
}

/** 同 extractBareListUnderH3(section, "Modules") 的别名（Channel 用）。 */
export function extractModulesList(section: Section | undefined): string[] {
  return extractBareListUnderH3(section, "Modules");
}

/** 同 extractBareListUnderH3(section, "Domains") 的别名（Blueprint 用）。 */
export function extractDomainsList(section: Section | undefined): string[] {
  return extractBareListUnderH3(section, "Domains");
}

/** 从一个 H2 段下取指定 H3 名下的所有裸名列表项（`- name`）。
 *  用途：Channel `## 会话知识` → `### Modules` 列 Domain H2 段名；
 *        Blueprint `## 会话知识` → `### Domains` 列参与本注入点的 Domain 名。
 *
 *  行为：扫描 section.raw，找到 `### <h3Name>` 行后收集紧随其后的 `- name` 行
 *        （无 `key: value`），遇下一个 H3 或段尾终止。
 *
 *  兼容：若 H3 项的 fields.modules / fields.refs 是数组（旧写法），也支持。 */
export function extractBareListUnderH3(section: Section | undefined, h3Name: string): string[] {
  if (!section) return [];

  // 兼容路径：若 fields 里有数组字段（旧写法 `### Modules` 下用 `- modules: [Scene]` 等）
  const item = section.items.find((it) => it.name === h3Name);
  if (item) {
    const arr = item.fields.modules ?? item.fields.refs;
    if (Array.isArray(arr)) {
      const strs = arr.filter((x): x is string => typeof x === "string");
      if (strs.length > 0) return strs;
    }
  }

  // 主路径：扫 raw text 找 H3 + 后随的 `- name` 行
  const lines = section.raw.split(/\r?\n/);
  const out: string[] = [];
  let inTarget = false;
  for (const line of lines) {
    const h3 = line.match(/^###\s+(.+)$/);
    if (h3) {
      const name = h3[1].trim();
      inTarget = name === h3Name;
      continue;
    }
    if (!inTarget) continue;
    // 裸名行：`- Scene` / `- pt-architecture`（无冒号或冒号后无值）
    const bare = line.match(/^\s*-\s+([^\s:]+)\s*$/);
    if (bare) {
      out.push(bare[1].trim());
      continue;
    }
    // H4 段也终止（子嵌套不展开）
    if (/^#+\s/.test(line)) break;
  }
  return out;
}

// Phase term-P9.5：删除 inferKind / inferKindFromFrontmatter 死代码。
//   Type 字段删除（P9.3）+ Blueprint 转 YAML（P4.5）后，asset kind 推断链路（frontmatter
//   type/agent + H2 Slots/Tools/Compilation 识别）全部失去作用——资产加载按目录路由
//   （src/parse/index.ts loadAllDomains/Blueprints/Profiles），不依赖 readAsset 的 kind 字段。
//   AssetKind 联合类型保留（供未来扩展），具体推断函数清理。
//   Channel 已删除，Domain 走通用 term 形态。 */
