// src/compile/context.ts — 中端：Blueprint + Channel + Domains → Context IR
//
// Phase 7.5：中端职责恢复（Phase 5.5 midend 退出后塌了，Phase 7 借 v7 重构把 midend 拉回）。
//   - 输入：blueprint（v7 配置）+ channel（v7 结构）+ domains[]（v7 内容）
//   - 输出：Context IR（v7 产物层）—— modules: Record<H2段名, 聚合后 markdown>
//
// layout 编排逻辑从 v6 generateV6Prompt 抽回此处——backend 不再做编排，只渲染。
//
// Context 与 Blueprint 一一对应（一个 Blueprint 编译一份 Context）。Channel 决定包含哪些 H2 段，
// Blueprint 决定引用哪些 Domain，layout.mode 决定聚合方式。
//
// Scene 模块（注入 System Prompt）的编排流程：
//   1. trigger (Blueprint.trigger)
//   2. 全局约束（hybrid only，slot:global 的 rules 聚合）
//   3. 流程段（Blueprint.boundaries + 首步 externals + 步骤专属 rules）
//   4. 按 mode 聚合 modules（byDomain/hybrid 按域输出；byType 按 type 聚合）
//   5. 工具段（stack-Domain 贡献）
//   6. 可用手册（workflow-Domain 的 FlowTemplate 派生）
//
// Manual 模块（注入 Context Message）：展开 workflow-Domain 的 FlowTemplate 列表（render 阶段 binder 展开）。

import type { Blueprint, Channel, Context as ContextIR, Domain, Rule, StructureLayout } from "../schema.js";

// ==================== 共享类型 ====================

interface FlowTemplateLite {
  name: string;
  argumentHint?: string;
}

interface ToolLite {
  name: string;
  role?: string;
  operations?: string[];
}

const CIRCLED = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩"];

// ==================== Context 编译入口 ====================

/**
 * 编译 Blueprint 为 Context IR。
 * - 按 channel.modules 遍历每个上下文模块名（如 "Scene"/"Manual"）
 * - 对每个模块：聚合所有 blueprint.domains 引用的 Domain 的该 H2 段内容，按 channel.layout.mode 编排
 * - 算 sourceHash = hash(blueprint + channel + domains 内容)
 */
export function compileContext(
  blueprint: Blueprint,
  channel: Channel,
  domains: Domain[],
): ContextIR {
  // 1. 按 blueprint.domains 取具体 Domain（保持声明顺序）
  const domainByName = new Map(domains.map((d) => [d.name, d]));
  const refDomains: Domain[] = blueprint.domains
    .map((n) => domainByName.get(n))
    .filter((d): d is Domain => !!d);

  // 2. 按 channel.modules 遍历每个上下文模块
  const modules: Record<string, string> = {};
  for (const moduleName of channel.modules) {
    if (moduleName === "Scene") {
      modules[moduleName] = compileSceneModule(blueprint, channel, refDomains);
    } else if (moduleName === "Manual") {
      modules[moduleName] = compileManualModule(refDomains);
    } else {
      // 其他 H2 段（如 "Term"）按域聚合
      modules[moduleName] = compileGenericModule(moduleName, refDomains, channel.layout);
    }
  }

  // 3. 算 sourceHash
  const sourceHash = computeSourceHash(blueprint, channel, refDomains);

  return {
    name: blueprint.name,
    sourceHash,
    modules,
  };
}

// ==================== Scene 模块（System Prompt 内容） ====================

function compileSceneModule(
  blueprint: Blueprint,
  channel: Channel,
  refDomains: Domain[],
): string {
  const mode = channel.layout.mode;
  const parts: string[] = [];

  // 1. Trigger
  const trigger = blueprint.trigger?.trim() || "当用户请求相关任务时按以下流程执行；其余对话正常响应，勿套用本流程。";
  parts.push(`> ${trigger}`);

  // 2. 全局约束（hybrid only）
  if (mode === "hybrid") {
    const globalRules = refDomains.flatMap((d) => extractRules(d));
    const globals = globalRules.filter((r) => r.slot === "global");
    if (globals.length > 0) parts.push(renderGlobalRules(globals));
  }

  // 3. 流程段（Blueprint.boundaries + 首步 externals + 步骤专属 rules）
  const flowText = compileFlow(blueprint, refDomains);
  if (flowText) parts.push(flowText);

  // 4. 按 mode 拼装 Domain sections
  if (mode === "byType") {
    const termsText = renderAggregatedTerms(refDomains);
    if (termsText) parts.push(termsText);
    const rulesText = renderAggregatedRules(refDomains);
    if (rulesText) parts.push(rulesText);
  } else {
    // byDomain / hybrid：按域输出（hybrid 下 rules 已抽走，section 只含 terms）
    for (const d of refDomains) {
      const sec = formatDomainSceneSection(d, mode);
      if (sec) parts.push(sec);
    }
  }

  // 5. 工具段（stack-Domain 贡献；byType 下聚合 tools 由 Scene 单独处理）
  const toolsText = renderAggregatedTools(refDomains);
  if (toolsText && mode !== "byType") parts.push(toolsText);

  // 6. 可用手册（workflow-Domain 的 FlowTemplate 派生）
  const flowsText = renderFlowsCatalog(refDomains);
  if (flowsText) parts.push(flowsText);

  return parts.join("\n\n");
}

// ==================== 流程段 ====================

function compileFlow(blueprint: Blueprint, refDomains: Domain[]): string {
  const boundaries = blueprint.boundaries ?? [];
  if (boundaries.length === 0) return "";

  const idxMap = new Map<string, number>();
  boundaries.forEach((b, i) => idxMap.set(b.slot, i));

  // 所有 externals（首步挂载）
  const allExts = refDomains.flatMap((d) => {
    if (d.type !== "workflow") return [];
    const scene = d.modules["Scene"] as { externals?: Array<{ name: string; path: string }> } | undefined;
    return (scene?.externals ?? []).map((ext) => ({ ...ext, _domainName: d.name }));
  });

  // 步骤专属 rules（slot == stepName）
  const stepRules = new Map<string, Rule[]>();
  for (const d of refDomains) {
    for (const rule of extractRules(d)) {
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

// ==================== Manual 模块（Context Message 内容） ====================

function compileManualModule(refDomains: Domain[]): string {
  // Manual 模块：列出所有 workflow-Domain 的 FlowTemplate 名（实际 binder 展开在 render 时进行）
  const lines: string[] = [];
  for (const d of refDomains) {
    if (d.type !== "workflow") continue;
    const tpls = (d.modules["Manual"] as Array<FlowTemplateLite> | undefined) ?? [];
    if (tpls.length === 0) continue;
    lines.push(`### 模块「${d.name}」`);
    lines.push("");
    lines.push("**可用手册**");
    for (const t of tpls) {
      const hint = t.argumentHint ? ` ${t.argumentHint}` : "";
      lines.push(`- **/${t.name}**${hint}`);
    }
  }
  return lines.join("\n\n").trimEnd();
}

// ==================== 通用模块（非 Scene/Manual 的 H2 段） ====================

function compileGenericModule(h2Name: string, refDomains: Domain[], _layout: StructureLayout): string {
  // 按域聚合 h2Name 段内容（按声明顺序，byDomain 风格——byType 一般不用在其他段上）
  const lines: string[] = [];
  for (const d of refDomains) {
    const content = d.modules[h2Name];
    if (!content) continue;
    // 直接序列化为 markdown：每个 term 一行
    if (Array.isArray(content)) {
      for (const item of content) {
        if (item && typeof item === "object" && "name" in item && "desc" in item) {
          const t = item as { name: string; desc: string };
          if (t.desc) lines.push(`- **${t.name}**：${t.desc}`);
          else lines.push(`- **${t.name}**`);
        }
      }
    }
  }
  return lines.join("\n").trimEnd();
}

// ==================== 域段格式化（Scene 模块内按 type 分发） ====================

/** Domain Scene 渲染器：返回该 Domain 在 Scene 模块里的 markdown 段（空字符串表示不输出）。 */
type DomainSceneRenderer = (d: Domain, mode: "byDomain" | "byType" | "hybrid") => string;

/** Domain type → Scene renderer。已注册：term / workflow / stack / glossary。
 *  扩展 type：调 registerDomainSceneRenderer("xxx", fn) 即可，不动主循环。 */
const domainSceneRenderers: Record<string, DomainSceneRenderer> = {
  term: renderTermSceneSection,
  workflow: renderWorkflowSceneSection,
  stack: renderStackSceneSection,
  glossary: renderGlossarySceneSection,
};

/** 扩展接口：加新 Domain type 只加一行注册 + 一个 renderer 函数。 */
export function registerDomainSceneRenderer(type: string, fn: DomainSceneRenderer): void {
  domainSceneRenderers[type] = fn;
}

function formatDomainSceneSection(d: Domain, mode: "byDomain" | "byType" | "hybrid"): string {
  const fn = domainSceneRenderers[d.type];
  if (!fn) return "";  // 未注册 type：不输出
  return fn(d, mode);
}

// ---- Scene 渲染器（按 type 注册） ----

function renderTermSceneSection(d: Domain, mode: "byDomain" | "byType" | "hybrid"): string {
  const terms = (d.modules["Scene"] as Array<{ name: string; desc: string }> | undefined) ?? [];
  const rules = extractRules(d);
  const lines: string[] = [`### 模块「${d.name}」`];

  if (terms.length > 0) {
    lines.push("", "**术语**");
    for (const t of terms) {
      if (t.desc) lines.push(`- **${t.name}**：${t.desc}`);
      else lines.push(`- **${t.name}**`);
    }
  }
  // hybrid 下 rules 不进 section（已抽到全局段）；byDomain 下保留 rules
  if (mode !== "hybrid" && rules.length > 0) {
    lines.push("", "**规则**");
    for (const r of rules.filter((x) => x.slot !== "global")) {
      if (r.type === "invariant") lines.push(`- ${r.check}`);
      else if (r.type === "ban" && r.items && r.items.length > 0) {
        lines.push(`- ${r.check}：禁止 ${r.items.join(" / ")}`);
      }
    }
  }
  return lines.join("\n").trimEnd();
}

function renderWorkflowSceneSection(d: Domain, _mode: "byDomain" | "byType" | "hybrid"): string {
  const scene = d.modules["Scene"] as { externals?: Array<{ name: string; path: string }> } | undefined;
  const externals = scene?.externals ?? [];
  if (externals.length === 0) return "";
  const lines: string[] = [`### 模块「${d.name}」`, "", "**外部数据**"];
  for (const ext of externals) {
    lines.push(`- ${ext.name}：\`${ext.path}\``);
  }
  return lines.join("\n").trimEnd();
}

function renderStackSceneSection(_d: Domain, _mode: "byDomain" | "byType" | "hybrid"): string {
  // stack: tools 在聚合段输出，不进 section
  return "";
}

function renderGlossarySceneSection(d: Domain, _mode: "byDomain" | "byType" | "hybrid"): string {
  const terms = (d.modules["Scene"] as Array<{ name: string; desc: string }> | undefined) ?? [];
  if (terms.length === 0) return "";
  const lines: string[] = [`### 术语表「${d.name}」`];
  for (const t of terms) {
    if (t.desc) lines.push(`- **${t.name}**：${t.desc}`);
    else lines.push(`- **${t.name}**`);
  }
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

function renderAggregatedTerms(refDomains: Domain[]): string {
  // byType：跨模块聚合术语
  const lines: string[] = ["### 业务术语"];
  let any = false;
  for (const d of refDomains) {
    if (d.type !== "term") continue;
    const terms = (d.modules["Scene"] as Array<{ name: string; desc: string }> | undefined) ?? [];
    for (const t of terms) {
      const text = t.desc ? `- **${t.name}**：${t.desc}` : `- **${t.name}**`;
      lines.push(`${text}（来自：${d.name}）`);
      any = true;
    }
  }
  return any ? lines.join("\n") : "";
}

function renderAggregatedRules(refDomains: Domain[]): string {
  // byType：跨模块聚合 rules
  const lines: string[] = ["### 业务规则"];
  let any = false;
  for (const d of refDomains) {
    const rules = extractRules(d);
    for (const r of rules) {
      const text = r.type === "ban" && r.items
        ? `- ${r.check}：禁止 ${r.items.join(" / ")}`
        : `- ${r.check}`;
      lines.push(`${text}（来自：${d.name}）`);
      any = true;
    }
  }
  return any ? lines.join("\n") : "";
}

function renderAggregatedTools(refDomains: Domain[]): string {
  const allTools = refDomains.flatMap<ToolLite>((d) => {
    if (d.type !== "stack") return [];
    return (d.modules["Scene"] as Array<ToolLite> | undefined) ?? [];
  });
  if (allTools.length === 0) return "";
  const lines: string[] = ["### 工具"];
  for (const t of allTools) {
    if (t.role) lines.push(`- ${t.name}：${t.role}`);
    else if (t.operations && t.operations.length > 0) lines.push(`- ${t.name}：${t.operations.join(" / ")}`);
    else lines.push(`- ${t.name}`);
  }
  return lines.join("\n").trimEnd();
}

function renderFlowsCatalog(refDomains: Domain[]): string {
  const allTpls = refDomains.flatMap<FlowTemplateLite>((d) => {
    if (d.type !== "workflow") return [];
    return (d.modules["Manual"] as Array<FlowTemplateLite> | undefined) ?? [];
  });
  if (allTpls.length === 0) return "";
  const lines: string[] = ["### 可用手册"];
  for (const t of allTpls) {
    const hint = t.argumentHint ? ` ${t.argumentHint}` : "";
    lines.push(`- **/${t.name}**${hint}`);
  }
  return lines.join("\n");
}

// ==================== 辅助 ====================

function extractRules(d: Domain): Rule[] {
  const val = d.modules["Manual"];
  if (Array.isArray(val)) return val as Rule[];
  return [];
}

// ==================== sourceHash ====================

/** sha256(JSON.stringify(blueprint) + channel + domains 内容) → hex */
export function computeSourceHash(
  blueprint: Blueprint,
  channel: Channel,
  domains: Domain[],
): string {
  const payload = JSON.stringify({
    blueprint: stableStringify(blueprint),
    channel: stableStringify(channel),
    domains: domains.map((d) => stableStringify(d)),
  });
  return simpleHash(payload);
}

function stableStringify(obj: unknown): string {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return "[" + obj.map(stableStringify).join(",") + "]";
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  return "{" + keys.map((k) => `${JSON.stringify(k)}:${stableStringify((obj as Record<string, unknown>)[k])}`).join(",") + "}";
}

/** FNV-1a 32-bit hash，足够用于缓存标识。 */
function simpleHash(s: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0") + "-" + s.length.toString(16).padStart(8, "0");
}