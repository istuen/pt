// frontend/oxn/adapter.ts — OXN MD → SchemaBundle (v6)
//
// Phase 5 重写：按 v6 语义读 OXN asset。
//   - 每个 Domain 一个 md，type 决定 scene/blueprint 形状（term/workflow/stack）
//   - Scene struct / Blueprint struct 各独立 md，frontmatter.kind 区分
//   - SchemaBundle 同时填充 v6 新字段（domains/structs/activeScene）
//     与 v3 legacy 字段（knowledgeBase）—— 后者供 midend/layout.ts 消费（**中端零改动**）。
//
// OXN 内部类型（Asset/Item/Section）保留，仅其映射路径换了。

import { join } from "node:path";
import type {
  BoundaryNode,
  Domain,
  DomainModule,
  ExternalRef,
  FlowStep,
  FlowTemplate,
  KnowledgeBase,
  Rule,
  SchemaBundle,
  SourceAdapter,
  Struct,
  StructureLayout,
  Term,
  ToolRef,
} from "../../schema.js";
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
      // 未知 type 仍返回 Domain，scene/blueprint 用空。
      return { name: asset.name, type, scene: undefined, blueprint: undefined };
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

// ==================== 派生 legacy knowledgeBase ====================

/** 从 Scene struct + 其引用的 Domains 派生 v3-shape KnowledgeBase，供 midend 消费。
 *  语义：modules 来自 scene.refs 中 type=term 的 Domain；flows 来自 type=workflow 的 Domain。
 *  identity.tools 来自 type=stack 的 Domain。 */
function deriveKnowledgeBase(scene: Struct, domains: Domain[]): KnowledgeBase {
  const domainByName = new Map(domains.map((d) => [d.name, d]));
  const refsDomains = scene.refs.map((r) => domainByName.get(r)).filter((d): d is Domain => !!d);

  // modules: 从 term-Domain 派生 DomainModule（v3 形态：terms + rules + externals）
  //   - externals: 取自同一 Scene refs 中的 workflow-Domain（关联的"数据源"）
  const allExts: ExternalRef[] = [];
  for (const d of refsDomains) {
    if (d.type === "workflow" && d.scene && typeof d.scene === "object" && "externals" in d.scene) {
      for (const e of (d.scene as { externals: ExternalRef[] }).externals) allExts.push(e);
    }
  }
  const modules: DomainModule[] = refsDomains
    .filter((d) => d.type === "term")
    .map((d) => ({
      name: d.name,
      terms: (d.scene as Term[]) ?? [],
      rules: (d.blueprint as Rule[]) ?? [],
      externals: allExts,  // term-Domain 在 v6 不持 externals；归到 scene 范围内
    }));

  // flows: 从 workflow-Domain 派生
  const flows: (FlowTemplate & { _vars?: string[] })[] = [];
  for (const d of refsDomains) {
    if (d.type === "workflow" && Array.isArray(d.blueprint)) {
      for (const tpl of d.blueprint as FlowTemplate[]) flows.push(tpl as FlowTemplate & { _vars?: string[] });
    }
  }

  // tools: 从 stack-Domain 派生
  const tools: ToolRef[] = [];
  for (const d of refsDomains) {
    if (d.type === "stack" && Array.isArray(d.scene)) {
      for (const t of d.scene as ToolRef[]) tools.push(t);
    }
  }

  return {
    identity: {
      trigger: scene.trigger ?? "",
      boundaries: scene.boundaries ?? [],
      tools,
    },
    modules,
    flows,
    layout: scene.layout ?? { mode: "hybrid" },
  };
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
        knowledgeBase: deriveKnowledgeBase(fallback, domains),
        domains,
        structs,
        activeScene: fallback.name,
      };
    }

    return {
      knowledgeBase: deriveKnowledgeBase(activeScene, domains),
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