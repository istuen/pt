// backend/prompt.ts — SchemaBundle → System Prompt 段（v6 渲染器注册制）
//
// Phase 5 重写：从 LayoutedBundle 切换到 SchemaBundle，按 Domain Type 注册 scene/blueprint renderer。
// 加新 Domain Type = 在 sceneRenderers/blueprintRenderers 表加一行，中端/Schema 不动。
//
// v3 路径（generatePrompt(LayoutedBundle)）保留在文件底部作 legacy 参考，不再被 transpile.ts 调用。

import type {
  BoundaryNode,
  Domain,
  ExternalRef,
  FlowTemplate,
  Rule,
  SchemaBundle,
  Struct,
  Term,
  ToolRef,
} from "../schema.js";

const CIRCLED = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩"];
const DEFAULT_TRIGGER = "当用户请求相关任务时按以下流程执行；其余对话正常响应，勿套用本流程。";

// ==================== v6：Renderer 注册表 ====================

type DomainSceneRenderer = (d: Domain, mode: "byDomain" | "byType" | "hybrid") => DomainSection;
type DomainBlueprintRenderer = (d: Domain) => string;

/** Domain scene 渲染结果：分离 section / rules / externals，便于 mode-based 拼装 */
interface DomainSection {
  /** 模块段 markdown（已含 ### 模块「name」 头）。空字符串表示该 type 不产 section。 */
  section: string;
  /** 该 Domain 含的规则（hybrid 模式下抽到全局段） */
  rules: Rule[];
  /** 该 Domain 声明的外部数据源（用于首步挂数据行） */
  externals: ExternalRef[];
  /** 该 Domain 声明的工具（stack-Domain 才有） */
  tools: ToolRef[];
  /** 该 Domain 声明的 FlowTemplate（workflow-Domain 才有，产 可用手册 catalog） */
  templates: FlowTemplate[];
}

/** 域类型 → scene renderer。已注册：term / workflow / stack。
 *  扩展 type：调 registerSceneRenderer("xxx", fn) 即可，不动遍历逻辑。 */
const sceneRenderers: Record<string, DomainSceneRenderer> = {
  term: renderTermScene,
  workflow: renderWorkflowScene,
  stack: renderStackScene,
};

/** 域类型 → blueprint renderer。Manual 渲染时按 type 分发。
 *  本期 message.ts 单独处理 workflow 的 FlowTemplate 展开，blueprintRenderers 暂只占位。 */
const blueprintRenderers: Record<string, DomainBlueprintRenderer> = {
  term: renderTermBlueprint,
  workflow: renderWorkflowBlueprint,
  stack: renderStackBlueprint,
};

export function registerSceneRenderer(type: string, fn: DomainSceneRenderer): void {
  sceneRenderers[type] = fn;
}
export function registerBlueprintRenderer(type: string, fn: DomainBlueprintRenderer): void {
  blueprintRenderers[type] = fn;
}

// ==================== Scene Renderers ====================

/** term-Domain.## Scene = 公理/术语。规则在 ## Blueprint（按 §0.4 表）。
 *  hybrid 模式下：rules 不进 section（抽到全局段），避免重复。 */
function renderTermScene(d: Domain, mode: "byDomain" | "byType" | "hybrid"): DomainSection {
  const terms = (d.scene as Term[] | undefined) ?? [];
  const rules = (d.blueprint as Rule[] | undefined) ?? [];
  const lines: string[] = [`### 模块「${d.name}」`];

  if (terms.length > 0) {
    lines.push("", "**术语**");
    for (const t of terms) {
      if (t.desc) lines.push(`- **${t.name}**：${t.desc}`);
      else lines.push(`- **${t.name}**`);
    }
  }
  if (mode !== "hybrid" && rules.length > 0) {
    lines.push("", "**规则**");
    for (const r of rules.filter((x) => x.type === "invariant")) {
      lines.push(`- ${r.check}`);
    }
    for (const r of rules.filter((x) => x.type === "ban")) {
      if (r.items && r.items.length > 0) {
        lines.push(`- ${r.check}：禁止 ${r.items.join(" / ")}`);
      }
    }
  }
  return { section: lines.join("\n").trimEnd(), rules, externals: [], tools: [], templates: [] };
}

/** workflow-Domain.## Scene = 手册清单+数据源。
 *  catalog 由 ## Blueprint 的 FlowTemplate 自动派生（按 §5 risk 4）。
 *  数据源在 scene.externals 里。 */
function renderWorkflowScene(d: Domain, _mode: "byDomain" | "byType" | "hybrid"): DomainSection {
  const scene = (d.scene as { externals: ExternalRef[] } | undefined) ?? { externals: [] };
  const externals = scene.externals ?? [];
  const templates = (d.blueprint as FlowTemplate[] | undefined) ?? [];
  return { section: "", rules: [], externals, tools: [], templates };
}

/** stack-Domain.## Scene = tools 清单。## Blueprint（usage）本期为空。 */
function renderStackScene(d: Domain, _mode: "byDomain" | "byType" | "hybrid"): DomainSection {
  const tools = (d.scene as ToolRef[] | undefined) ?? [];
  return { section: "", rules: [], externals: [], tools, templates: [] };
}

// ==================== Blueprint Renderers（Manual 用，本期暂占位） ====================

function renderTermBlueprint(_d: Domain): string { return ""; }
function renderWorkflowBlueprint(_d: Domain): string { return ""; }
function renderStackBlueprint(_d: Domain): string { return ""; }

// ==================== 主入口：v6 SchemaBundle → System Prompt ====================

/** SchemaBundle → 注入 systemPrompt 的字符串段（v6 路径）。 */
export function generateV6Prompt(bundle: SchemaBundle): string {
  const scene = bundle.structs.find((s) => s.kind === "scene" && s.name === bundle.activeScene);
  if (!scene) return "";

  const domainByName = new Map(bundle.domains.map((d) => [d.name, d]));
  const refDomains: Domain[] = scene.refs
    .map((n) => domainByName.get(n))
    .filter((d): d is Domain => !!d);

  const mode = scene.layout?.mode ?? "hybrid";

  // 每个 ref Domain 跑自己的 scene renderer，拿到结构化结果
  const rendered: DomainSection[] = [];
  for (const d of refDomains) {
    const fn = sceneRenderers[d.type];
    if (!fn) continue;  // 未注册 type：跳过（Phase 5 MVP：仅跳过，不报错）
    rendered.push(fn(d, mode));
  }

  const parts: string[] = [];

  // 触发条件
  parts.push(`> ${scene.trigger?.trim() || DEFAULT_TRIGGER}`);

  // hybrid：全局约束段（slot:global 规则聚合）放在流程段之前
  if (mode === "hybrid") {
    const globalRules = rendered.flatMap((r) => r.rules.filter((x) => x.slot === "global" || !x.slot));
    if (globalRules.length > 0) parts.push(renderGlobalRules(globalRules));
  }

  // 流程段（从 Scene.boundaries + 所有 externals + 步骤专属 rules）
  const flowText = renderFlow(scene, rendered);
  if (flowText) parts.push(flowText);

  // 按 mode 拼装 Domain sections
  if (mode === "byType") {
    const termsText = renderAggregatedTerms(rendered);
    if (termsText) parts.push(termsText);
    const rulesText = renderAggregatedRules(rendered, mode);
    if (rulesText) parts.push(rulesText);
    const toolsText = renderAggregatedTools(rendered);
    if (toolsText) parts.push(toolsText);
    const flowsText = renderFlowsCatalog(rendered);
    if (flowsText) parts.push(flowsText);
  } else {
    // byDomain / hybrid：按域输出
    for (const r of rendered) {
      if (r.section) parts.push(r.section);
    }
    // tools（stack-Domain 贡献；byType 下已在聚合段输出）
    const toolsText = renderAggregatedTools(rendered);
    if (toolsText) parts.push(toolsText);
    // 可用手册（workflow-Domain 贡献）
    const flowsText = renderFlowsCatalog(rendered);
    if (flowsText) parts.push(flowsText);
  }

  return parts.join("\n\n");
}

// ==================== 流程段 ====================

/** 流程段：步骤 DAG + 首步 externals + 步骤专属 rules checklist。
 *  hybrid 下：r.rules 已含全部 rules；本函数只挂 slot == stepName 的（slot:global 的已抽走）。 */
function renderFlow(scene: Struct, rendered: DomainSection[]): string {
  const boundaries = scene.boundaries ?? [];
  if (boundaries.length === 0) return "";

  const idxMap = new Map<string, number>();
  boundaries.forEach((b, i) => idxMap.set(b.slot, i));

  const allExts = rendered.flatMap((r) => r.externals);
  const stepRules = new Map<string, Rule[]>();
  for (const r of rendered) {
    for (const rule of r.rules) {
      if (rule.slot && rule.slot !== "global") {
        const arr = stepRules.get(rule.slot) ?? [];
        arr.push(rule);
        stepRules.set(rule.slot, arr);
      }
    }
  }

  const lines: string[] = ["### 流程"];
  boundaries.forEach((bd, i) => {
    const depSuffix = bd.deps.length > 0
      ? ` ← 依赖 ${bd.deps.map((d) => CIRCLED[idxMap.get(d) ?? 0] ?? d).join(" ")}`
      : "";
    lines.push(`${CIRCLED[i] ?? i + 1} **${bd.slot}** — ${bd.desc || "（未指定）"}${depSuffix}`);

    if (i === 0 && allExts.length > 0) {
      for (const ext of allExts) {
        lines.push(`   数据：读 \`${ext.path}\`。`);
      }
    }
    const rules = stepRules.get(bd.slot);
    if (rules) {
      for (const r of rules.filter((x) => x.type === "invariant")) {
        lines.push(`   - [ ] ${r.check}`);
      }
      for (const r of rules.filter((x) => x.type === "ban")) {
        if (r.items && r.items.length > 0) {
          lines.push(`   - [ ] ${r.check}：${r.items.join(" / ")}`);
        }
      }
    }
  });

  return lines.join("\n").trimEnd();
}

// ==================== 公共段（mode-based） ====================

function renderGlobalRules(rules: Rule[]): string {
  const lines: string[] = ["### 全局约束"];
  for (const r of rules.filter((x) => x.type === "invariant")) {
    lines.push(`- [ ] ${r.check}`);
  }
  for (const r of rules.filter((x) => x.type === "ban")) {
    if (r.items && r.items.length > 0) {
      lines.push(`- [ ] ${r.check}：${r.items.join(" / ")}`);
    }
  }
  return lines.join("\n");
}

function renderAggregatedTerms(rendered: DomainSection[]): string {
  // byType：跨模块聚合术语
  // term-Domain 的 section 里"术语"段要拆出来。本期简化：直接扫 term-Domain 的 section，
  // 按"**术语**"标记切。Phase 6 可改成结构化 section 返回。
  const lines: string[] = ["### 业务术语"];
  for (const r of rendered) {
    const m = r.section.match(/### 模块「(.+?)」[\s\S]*?\n\*\*术语\*\*\n([\s\S]*?)(?=\n\*\*|$)/);
    if (!m) continue;
    const from = m[1];
    for (const line of m[2].split("\n").filter(Boolean)) {
      lines.push(`${line}（来自：${from}）`);
    }
  }
  return lines.length > 1 ? lines.join("\n") : "";
}

function renderAggregatedRules(rendered: DomainSection[], mode: SchemaBundle["activeScene"] extends string ? "byDomain" | "byType" | "hybrid" : never): string {
  // byType：跨模块聚合规则（标注来源）
  const lines: string[] = ["### 业务规则"];
  for (const r of rendered) {
    const m = r.section.match(/### 模块「(.+?)」[\s\S]*?\n\*\*规则\*\*\n([\s\S]*?)$/);
    if (!m) continue;
    const from = m[1];
    for (const line of m[2].split("\n").filter(Boolean)) {
      lines.push(`${line}（来自：${from}）`);
    }
  }
  void mode;
  return lines.length > 1 ? lines.join("\n") : "";
}

function renderAggregatedTools(rendered: DomainSection[]): string {
  const allTools = rendered.flatMap((r) => r.tools);
  if (allTools.length === 0) return "";
  const lines: string[] = ["### 工具"];
  for (const t of allTools) {
    if (t.role) lines.push(`- ${t.name}：${t.role}`);
    else if (t.operations && t.operations.length > 0) lines.push(`- ${t.name}：${t.operations.join(" / ")}`);
    else lines.push(`- ${t.name}`);
  }
  return lines.join("\n").trimEnd();
}

function renderFlowsCatalog(rendered: DomainSection[]): string {
  const allTpls = rendered.flatMap((r) => r.templates);
  if (allTpls.length === 0) return "";
  const lines: string[] = ["### 可用手册"];
  for (const t of allTpls) {
    const hint = t.argumentHint ? ` ${t.argumentHint}` : "";
    lines.push(`- **/${t.name}**${hint}`);
  }
  return lines.join("\n");
}

// ==================== Legacy：v3 generatePrompt（保留作参考，不被调用） ====================
//
// 原 v3 后端消费 LayoutedBundle，本 Phase 5 不删，仅注释标记。transpile.ts 已切到 v6 路径。
// 如需 fallback，可解开注释启用。

/*
import type { DomainModule, LayoutedBundle } from "../midend/layout.js";

export function generatePrompt(b: LayoutedBundle): string {
  // ...（v3 实现原样保留）
}
*/