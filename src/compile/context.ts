// src/compile/context.ts — 中端：Blueprint + Channel + Domains → Context IR
//
// Phase 8.4：v8 中端重写。
//   - 输入：blueprint（v8 配置：injectionPoints + compilation）+ channel（v8 结构：injectionPoints）+ domains[]
//   - 输出：Context IR（v8 产物层）—— modules: Record<注入点名, 聚合后 markdown>
//
// v8 编译流程：
//   遍历 Channel.injectionPoints：
//     1. 找 Blueprint 对应 InjectionPointInstance（同名）
//     2. 取本注入点参与的 Domain（按 Blueprint.domains）
//     3. 按 ipConfig.target 分发：
//        - system_prompt → compileSystemPromptModule
//        - context_message → compileContextMessageModule
//        - 扩展 → compileGenericInjectionPoint
//
// Scene/Manual 在 v8 由注入点语义名替代（如"会话知识"/"对话记忆"），
// 但 H2 段名（Domain 内的 Scene/Manual）仍然是聚合点的供给侧。

import type {
  Blueprint,
  Channel,
  Context as ContextIR,
  Domain,
  InjectionPointConfig,
  InjectionPointInstance,
  InjectionTarget,
  Rule,
  StructureLayout,
} from "../schema.js";

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
 * 编译 Blueprint 为 Context IR（v8）。
 * - 遍历 Channel.injectionPoints
 * - 每个注入点找 Blueprint 同名 InjectionPointInstance
 * - 按 ipConfig.target 分发编译（system_prompt / context_message / 扩展）
 */
export function compileContext(
  blueprint: Blueprint,
  channel: Channel,
  domains: Domain[],
): ContextIR {
  // 1. 按 Domain 名建立索引
  const domainByName = new Map(domains.map((d) => [d.name, d]));

  // 2. 按 Channel 的注入点遍历
  const modules: Record<string, string> = {};
  for (const ipConfig of channel.injectionPoints) {
    // 找 Blueprint 对应的注入点实例化（同名）
    const ipInstance = blueprint.injectionPoints.find((i) => i.name === ipConfig.name);
    if (!ipInstance) continue;

    // 取本注入点参与的 Domain（按 Blueprint.domains 声明顺序）
    const refDomains = ipInstance.domains
      .map((n) => domainByName.get(n))
      .filter((d): d is Domain => !!d);

    // 按 target 分发编译
    modules[ipConfig.name] = dispatchInjectionPoint(ipInstance, ipConfig, refDomains);
  }

  // 3. 算 sourceHash
  const sourceHash = computeSourceHash(blueprint, channel, domains);

  return {
    name: blueprint.name,
    sourceHash,
    modules,
  };
}

function dispatchInjectionPoint(
  ipInstance: InjectionPointInstance,
  ipConfig: InjectionPointConfig,
  refDomains: Domain[],
): string {
  const target: InjectionTarget = ipConfig.target;
  if (target === "system_prompt") {
    return compileSystemPromptModule(ipInstance, ipConfig, refDomains);
  }
  if (target === "context_message") {
    return compileContextMessageModule(ipInstance, ipConfig, refDomains);
  }
  return compileGenericInjectionPoint(ipInstance, ipConfig, refDomains);
}

// ==================== System Prompt 注入点（原 Scene 模块内容） ====================

function compileSystemPromptModule(
  ipInstance: InjectionPointInstance,
  ipConfig: InjectionPointConfig,
  refDomains: Domain[],
): string {
  const mode: StructureLayout["mode"] = ipConfig.mode ?? "hybrid";
  const parts: string[] = [];

  // 1. Trigger（从 ipInstance 取）
  const trigger = ipInstance.trigger?.trim()
    || "当用户请求相关任务时按以下流程执行；其余对话正常响应，勿套用本流程。";
  parts.push(`> ${trigger}`);

  // 2. 全局约束（hybrid only）
  if (mode === "hybrid") {
    const globals = refDomains.flatMap(extractRules).filter((r) => r.slot === "global");
    if (globals.length > 0) parts.push(renderGlobalRules(globals));
  }

  // 3. 流程段（Boundaries 从 ipInstance 取）
  const flowText = compileFlow(ipInstance, refDomains);
  if (flowText) parts.push(flowText);

  // 4. 按 mode 拼装 Domain sections
  // v8：只聚合 ipConfig.modules 列出的 H2 段名（默认 "Scene"）
  const modulesToRender = ipConfig.modules.length > 0 ? ipConfig.modules : ["Scene"];
  const domainsToRender = refDomains.filter((d) =>
    modulesToRender.some((m) => d.modules[m] !== undefined),
  );
  if (mode === "byType") {
    const termsText = renderAggregatedTerms(domainsToRender);
    if (termsText) parts.push(termsText);
    const rulesText = renderAggregatedRules(domainsToRender);
    if (rulesText) parts.push(rulesText);
  } else {
    for (const d of domainsToRender) {
      const sec = formatDomainSceneSection(d, mode, modulesToRender);
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

// ==================== Context Message 注入点（原 Manual 模块内容） ====================

/**
 * 编译 target=context_message 的注入点。
 *  v8 修复：不再仅处理 workflow-Domain 的 FlowTemplate 列表——
 *  而是聚合 ipConfig.modules 列出的所有 H2 段内容。
 *  - workflow-Domain 的 Manual 段 → FlowTemplate 列表
 *  - term-Domain 的 Manual 段 → Rule 列表（v7 死代码，v8 修复）
 *  - 其他 H2 段 → 通用聚合
 */
function compileContextMessageModule(
  _ipInstance: InjectionPointInstance,
  ipConfig: InjectionPointConfig,
  refDomains: Domain[],
): string {
  const lines: string[] = [];
  // 默认聚合 "Manual" 段（v8 兼容 v7 行为）
  const modulesToRender = ipConfig.modules.length > 0 ? ipConfig.modules : ["Manual"];

  for (const d of refDomains) {
    const parts: string[] = [];
    for (const modName of modulesToRender) {
      const content = d.modules[modName];
      if (content === undefined) continue;

      if (modName === "Manual") {
        if (d.type === "workflow") {
          // workflow-Domain 的 Manual → FlowTemplate 列表
          const tpls = (content as Array<FlowTemplateLite> | undefined) ?? [];
          for (const t of tpls) {
            const hint = t.argumentHint ? ` ${t.argumentHint}` : "";
            parts.push(`- **/${t.name}**${hint}`);
          }
        } else if (d.type === "term") {
          // term-Domain 的 Manual → Rule 列表（v7 死代码，v8 修复）
          const rules = (content as Rule[]) ?? [];
          for (const r of rules) {
            if (r.type === "invariant") {
              parts.push(`- [ ] ${r.check}`);
            } else if (r.type === "ban" && r.items && r.items.length > 0) {
              parts.push(`- [ ] ${r.check}：${r.items.join(" / ")}`);
            }
          }
        }
      } else {
        // 其他 H2 段 → 通用聚合（按 generic fallback）
        if (Array.isArray(content)) {
          for (const item of content) {
            if (item && typeof item === "object" && "name" in item && "desc" in item) {
              const t = item as { name: string; desc: string };
              if (t.desc) parts.push(`- **${t.name}**：${t.desc}`);
              else parts.push(`- **${t.name}**`);
            }
          }
        }
      }
    }
    if (parts.length > 0) {
      lines.push(`### 模块「${d.name}」`);
      lines.push("");
      lines.push(...parts);
      lines.push("");
    }
  }

  return lines.join("\n").trimEnd();
}

// ==================== 通用注入点（扩展 target） ====================

function compileGenericInjectionPoint(
  _ipInstance: InjectionPointInstance,
  ipConfig: InjectionPointConfig,
  refDomains: Domain[],
): string {
  // 按域聚合 ipConfig.modules 列出的所有 H2 段内容
  const lines: string[] = [];
  const modulesToRender = ipConfig.modules.length > 0 ? ipConfig.modules : [];

  for (const d of refDomains) {
    for (const modName of modulesToRender) {
      const content = d.modules[modName];
      if (!content) continue;
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
  }
  return lines.join("\n").trimEnd();
}

// ==================== 流程段 ====================

/** v8：从 ipInstance.boundaries 取（不再从 blueprint 顶级）。 */
function compileFlow(ipInstance: InjectionPointInstance, refDomains: Domain[]): string {
  const boundaries = ipInstance.boundaries ?? [];
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

// ==================== 域段格式化（System Prompt 模块内按 type 分发） ====================

/** Domain Scene 渲染器：返回该 Domain 在 System Prompt 注入点里的 markdown 段（空字符串表示不输出）。 */
type DomainSceneRenderer = (
  d: Domain,
  mode: "byDomain" | "byType" | "hybrid",
  modules: string[],
) => string;

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

function formatDomainSceneSection(d: Domain, mode: "byDomain" | "byType" | "hybrid", modules: string[]): string {
  const fn = domainSceneRenderers[d.type];
  if (!fn) return "";  // 未注册 type：不输出
  return fn(d, mode, modules);
}

// ---- Scene 渲染器（按 type 注册） ----

function renderTermSceneSection(d: Domain, mode: "byDomain" | "byType" | "hybrid", modules: string[]): string {
  // v8：聚合 modules 列出的 H2 段（默认 "Scene" 段是 term-Term[]）
  const lines: string[] = [`### 模块「${d.name}」`];

  for (const modName of modules) {
    const content = d.modules[modName];
    if (content === undefined) continue;
    if (modName === "Scene") {
      const terms = (content as Array<{ name: string; desc: string }> | undefined) ?? [];
      if (terms.length > 0) {
        lines.push("", "**术语**");
        for (const t of terms) {
          if (t.desc) lines.push(`- **${t.name}**：${t.desc}`);
          else lines.push(`- **${t.name}**`);
        }
      }
    }
    // term-Domain 的 Manual 段（v8 支持聚合）
    if (modName === "Manual") {
      const rules = (content as Rule[]) ?? [];
      const nonGlobal = rules.filter((r) => r.slot !== "global");
      if (mode !== "hybrid" && nonGlobal.length > 0) {
        lines.push("", "**规则**");
        for (const r of nonGlobal) {
          if (r.type === "invariant") lines.push(`- ${r.check}`);
          else if (r.type === "ban" && r.items && r.items.length > 0) {
            lines.push(`- ${r.check}：禁止 ${r.items.join(" / ")}`);
          }
        }
      }
    }
  }
  return lines.join("\n").trimEnd();
}

function renderWorkflowSceneSection(d: Domain, _mode: "byDomain" | "byType" | "hybrid", modules: string[]): string {
  const lines: string[] = [`### 模块「${d.name}」`];
  let any = false;

  for (const modName of modules) {
    const content = d.modules[modName];
    if (content === undefined) continue;
    if (modName === "Scene") {
      const scene = content as { externals?: Array<{ name: string; path: string }> } | undefined;
      const externals = scene?.externals ?? [];
      if (externals.length > 0) {
        if (any) lines.push("");
        lines.push("**外部数据**");
        for (const ext of externals) {
          lines.push(`- ${ext.name}：\`${ext.path}\``);
        }
        any = true;
      }
    }
  }
  return any ? lines.join("\n").trimEnd() : "";
}

function renderStackSceneSection(_d: Domain, _mode: "byDomain" | "byType" | "hybrid", _modules: string[]): string {
  // stack: tools 在聚合段输出，不进 section
  return "";
}

function renderGlossarySceneSection(d: Domain, _mode: "byDomain" | "byType" | "hybrid", modules: string[]): string {
  const lines: string[] = [`### 术语表「${d.name}」`];
  let any = false;
  for (const modName of modules) {
    const content = d.modules[modName];
    if (content === undefined) continue;
    if (Array.isArray(content)) {
      for (const t of content as Array<{ name: string; desc: string }>) {
        if (t.desc) lines.push(`- **${t.name}**：${t.desc}`);
        else lines.push(`- **${t.name}**`);
        any = true;
      }
    }
  }
  return any ? lines.join("\n").trimEnd() : "";
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
