// src/parse/adapter.ts — OXN MD → SchemaBundle (v6)
//
// Phase 5 重写 + Phase 5.5 清理：按 v6 语义读 OXN asset，SchemaBundle 只含 v6 canonical 字段。
//   - 每个 Domain 一个 md，type 决定 scene/blueprint 形状（term/workflow/stack）
//   - Scene struct / Blueprint struct 各独立 md，frontmatter.kind 区分
//
// Phase 7.1: 从 frontend/oxn/adapter.ts 迁入，import 路径改为相对 src/parse/。

import { join } from "node:path";
import type {
  BoundaryNode,
  Domain,
  ExternalRef,
  FlowStep,
  FlowTemplate,
  Rule,
  SchemaBundle,
  SourceAdapter,
  Struct,
  StructureLayout,
  Term,
  ToolRef,
} from "../schema.js";
import { parseBoundaries, readAsset } from "./parser.js";
import type { Asset, Item } from "./types.js";

const VALID_MODES: ReadonlyArray<StructureLayout["mode"]> = ["byDomain", "byType", "hybrid"];

// ==================== 字段取值辅助 ====================

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

// ==================== OXN → Schema 映射（v6 分 type 分发） ====================

/** term-Domain.## Scene → Term[] */
function toTerms(section: Asset["sections"][string] | undefined): Term[] {
  return (section?.items ?? []).map((it) => ({ name: it.name, desc: s(it.fields.desc) || s(it.fields.description) }));
}

/** term-Domain.## Blueprint → Rule[]（Bans + Invariants 都在此段，按 §0.4 表） */
function toRules(section: Asset["sections"][string] | undefined): Rule[] {
  const rules: Rule[] = [];
  for (const it of section?.items ?? []) {
    const items = sArr(it.fields.items);
    const desc = s(it.fields.desc) || s(it.fields.value) || s(it.fields.description);
    const check = desc || it.name;
    if (items.length > 0) {
      rules.push({ slot: "global", type: "ban", check, items });
    } else {
      rules.push({ slot: "global", type: "invariant", check });
    }
  }
  return rules;
}

/** workflow-Domain.## Scene → { externals: ExternalRef[] }
 *  §0.4：手册清单+数据源 = 数据源部分。手册清单由 backend 从 ## Blueprint 派生。 */
function toWorkflowScene(section: Asset["sections"][string] | undefined): { externals: ExternalRef[] } {
  return {
    externals: (section?.items ?? []).map((it) => ({
      name: it.name,
      path: s(it.fields.path),
    })),
  };
}

/** workflow-Domain.## Blueprint → FlowTemplate[]（按 H3 = 模板名）
 *  每个 H3 下：- argument-hint / - intent / - vars / 多个 - step: */
function toFlowTemplates(section: Asset["sections"][string] | undefined): FlowTemplate[] {
  if (!section) return [];
  return section.items.map((item) => {
    const steps = collectSteps(item.name, section.raw);
    const tpl: FlowTemplate = {
      name: item.name,
      argumentHint: s(item.fields["argument-hint"]) || undefined,
      intent: s(item.fields.intent),
      steps: steps.map<FlowStep>((desc) => ({ desc })),
      externals: [],
    };
    const vars = sArr(it_field(item, "vars"));
    if (vars.length > 0) (tpl as FlowTemplate & { _vars?: string[] })._vars = vars;
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

function it_field(item: Item, key: string): unknown {
  return item.fields[key];
}

/** stack-Domain.## Scene → ToolRef[] */
function toTools(section: Asset["sections"][string] | undefined): ToolRef[] {
  return (section?.items ?? []).map((it) => {
    const role = s(it.fields.role);
    const ops = sArr(it.fields.operations);
    const ref: ToolRef = { name: it.name };
    if (role) ref.role = role;
    if (ops.length > 0) ref.operations = ops;
    return ref;
  });
}

// ==================== Domain 装/拆 ====================

/** 读 Domain md，按 type 分发解析为 Domain { name, type, scene, blueprint } */
async function loadDomain(cwd: string, fileName: string): Promise<Domain> {
  const asset = await readAsset(join(cwd, ".openxenon/assets/domains", fileName));
  const type = typeof asset.frontmatter.type === "string" ? asset.frontmatter.type : asset.kind;

  switch (type) {
    case "term":
      return {
        name: asset.name,
        type: "term",
        scene: toTerms(asset.sections["Scene"]),
        blueprint: toRules(asset.sections["Blueprint"]),
      };
    case "workflow":
      return {
        name: asset.name,
        type: "workflow",
        scene: toWorkflowScene(asset.sections["Scene"]),
        blueprint: toFlowTemplates(asset.sections["Blueprint"]),
      };
    case "stack":
      return {
        name: asset.name,
        type: "stack",
        scene: toTools(asset.sections["Scene"]),
        blueprint: [],
      };
    default:
      // 未知 type 走通用 fallback：H3 items → Term[] / Rule[]。
      // 扩展性体现：新 type = 在 backend 注册 renderer，不动 adapter / schema / 主循环。
      // term/workflow/stack 走特化分支，保留语义类型价值。
      return {
        name: asset.name,
        type,
        scene: toTerms(asset.sections["Scene"]),
        blueprint: toRules(asset.sections["Blueprint"]),
      };
  }
}

// ==================== Struct 解析 ====================

async function loadStruct(cwd: string, fileName: string): Promise<Struct> {
  const asset = await readAsset(join(cwd, ".openxenon/assets/blueprints", fileName));
  const kind = typeof asset.frontmatter.kind === "string"
    ? (asset.frontmatter.kind as Struct["kind"])
    : (asset.kind === "scene" ? "scene" : asset.kind === "manual" ? "blueprint" : "scene");

  // refs: 优先 frontmatter.refs，其次 ## Use 段读列表（兼容扩展）
  let refs: string[] = [];
  if (Array.isArray(asset.frontmatter.refs)) {
    refs = (asset.frontmatter.refs as unknown[]).filter((x): x is string => typeof x === "string");
  } else {
    const use = asset.sections["Use"];
    if (use) {
      refs = use.items.map((it) => s(it.fields.refs) || it.name).filter((x) => x !== "");
    }
  }

  const trigger = typeof asset.frontmatter.trigger === "string" ? asset.frontmatter.trigger : undefined;
  const boundaries = parseBoundaries(asset).map<BoundaryNode>((b) => ({
    slot: b.slot, deps: b.deps, desc: b.desc,
  }));
  const layout = parseLayout(asset.frontmatter.layout);

  const struct: Struct = {
    name: typeof asset.frontmatter.name === "string" ? asset.frontmatter.name : stripKindSuffix(asset.name),
    kind,
    refs,
  };
  if (trigger) struct.trigger = trigger;
  if (boundaries.length > 0) struct.boundaries = boundaries;
  if (layout) struct.layout = layout;
  if (asset.frontmatter.manualLayout === "basic") struct.manualLayout = "basic";
  return struct;
}

function stripKindSuffix(fileBase: string): string {
  return fileBase.replace(/\.(scene|manual)$/, "");
}

function parseLayout(raw: unknown): StructureLayout | undefined {
  if (typeof raw === "string") {
    return VALID_MODES.includes(raw as StructureLayout["mode"])
      ? { mode: raw as StructureLayout["mode"] }
      : undefined;
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    const mode = obj.mode;
    if (typeof mode === "string" && VALID_MODES.includes(mode as StructureLayout["mode"])) {
      const layout: StructureLayout = { mode: mode as StructureLayout["mode"] };
      const order = obj.domainOrder;
      if (Array.isArray(order) && order.every((x) => typeof x === "string")) {
        layout.domainOrder = order as string[];
      }
      return layout;
    }
  }
  return undefined;
}

// ==================== OXN Adapter 入口 ====================

export const oxnAdapter: SourceAdapter = {
  name: "oxn",

  async load(cwd, sceneName): Promise<SchemaBundle> {
    // 1. 枚举所有 Domain
    const domains = await loadAllDomains(cwd);

    // 2. 解析 Scene / Manual Struct
    const structs = await loadAllStructs(cwd);
    const activeScene = structs.find((s) => s.kind === "scene" && s.name === sceneName);
    if (!activeScene) {
      // fallback：取第一个 Scene
      const fallback = structs.find((s) => s.kind === "scene");
      if (!fallback) {
        throw new Error(`Pt: 未找到 Scene struct "${sceneName}"（blueprints/*.scene.md）`);
      }
      return {
        domains,
        structs,
        activeScene: fallback.name,
      };
    }

    return {
      domains,
      structs,
      activeScene: activeScene.name,
    };
  },
};

/** 读 .openxenon/assets/domains/ 下所有 *.md，逐个解析为 Domain。 */
async function loadAllDomains(cwd: string): Promise<Domain[]> {
  const { readdir } = await import("node:fs/promises");
  const dir = join(cwd, ".openxenon/assets/domains");
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  return Promise.all(files.map((f) => loadDomain(cwd, f)));
}

/** 读 .openxenon/assets/blueprints/ 下所有 *.md，逐个解析为 Struct。
 *  kind 从 frontmatter.kind 读（"scene" 或 "blueprint"）。 */
async function loadAllStructs(cwd: string): Promise<Struct[]> {
  const { readdir } = await import("node:fs/promises");
  const dir = join(cwd, ".openxenon/assets/blueprints");
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  return Promise.all(files.map((f) => loadStruct(cwd, f)));
}