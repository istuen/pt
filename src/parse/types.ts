// src/parse/types.ts — OXN adapter 内部类型
//
// 这些类型是 OXN MD 解析的中间表示，不进 Pt 核心。
// Pt 核心只认 schema.ts 的 SchemaBundle。
// 一个 asset (OXN MD) → 一个 Asset；一个段落 → 一个 Section；一个 H3 子项 → 一个 Item。
//
// Phase 7.1: 从 frontend/oxn/types.ts 迁入。

/**
 * OXN 内部 asset kind（Phase 5 拓展）：
 *   - v3 原四种：domain / workflow / stack / blueprint
 *   - v6 新增：
 *       - "term"    = Domain type=term（概念/公理）
 *       - "scene"   = Struct kind=scene（静态结构 → System Prompt）
 *       - "manual"  = Struct kind=blueprint（动态结构 → Manual）
 *
 * Adapter 读 OXN asset 后根据 kind 走不同解析路径。
 * 注意：v3 "domain" 与 v6 "term" 在概念上是同一层（业务领域资产），
 *       为了兼容同时出现（v3 资产用 entity=domain，v6 用 type=term）。
 */
export type AssetKind = "domain" | "workflow" | "stack" | "blueprint" | "term" | "scene" | "manual";

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
  /** 文件名去后缀 */
  name: string;
  frontmatter: Record<string, unknown>;
  /** frontmatter 之后的 markdown */
  body: string;
  /** H2 段名（统一首字母大写，如 "Terms"）→ 段内容 */
  sections: Record<string, Section>;
}

/** Blueprint 的 Boundaries（slot DAG） */
export interface Boundary {
  slot: string;
  operate: string[];
  deps: string[];
  desc: string;
}

/** Blueprint 的 Use 段引用的其它 asset */
export interface BlueprintRefs {
  domain: string;
  workflow: string;
  stack: string;
}

/** Externals 声明（domain/workflow/stack 都有，blueprint 没有） */
export interface External {
  assetKind: AssetKind;
  assetName: string;
  /** "./data/keyword-stats.xlsx" */
  path: string;
  /** 可选工具名 */
  name?: string;
}