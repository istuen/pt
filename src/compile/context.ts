// src/compile/context.ts — 中端：Profile + Blueprint + Domains → Context IR
//
// Phase 9.4：v9 中端重写。
//   - 输入：profile（v9 配置：blueprint + domains + injectionPoints）+ blueprint（v9 结构：injectionPoints + compilation）+ domains[]
//   - 输出：Context IR（v9 产物层）—— modules: Record<注入点名, 聚合后 markdown>
//
// v9 编译流程：
//   遍历 Blueprint.injectionPoints：
//     1. 找 Profile 对应 InjectionPointInstance（同名）—— 注入点追加的 Domains
//     2. resolveDomains(profile, ipInstance, ipConfig, domainByName) — 合并全局 + 追加，按 Blueprint.Modules 过滤
//     3. dispatchInjectionPoint — 遍历 ipConfig.modules，按 modName 注册表聚合
//
// v9 核心变化：
//   - dispatchInjectionPoint 按 modName 驱动聚合（v8 按 target 硬编码）
//   - moduleRenderers 注册表替代 domainSceneRenderers（v8 按 type 分发）
//   - 加新聚合标题（### Modules 加新项）= 改 Blueprint，不用改代码；generic fallback 自动处理
//   - Trigger 段聚合在 system_prompt 注入点，作为索引段
//   - Profile domains 自动分发：YAML 全局 domains + 注入点追加
//
// Tech Debt T6: 全用 type guard 收窄，不用 as 断言（pt-quality #1）

import { MOD_MANUAL, MOD_SCENE, MOD_TRIGGER } from "../constants.js";
import type {
  Blueprint,
  Context as ContextIR,
  Domain,
  FlowTemplate,
  InjectionPointConfig,
  InjectionPointInstance,
  Profile,
  Rule,
  StructureLayout,
} from "../schema.js";
import {
  isFlowTemplateArray,
  isNamedItemArray,
  isRuleArray,
  isTermArray,
  isTriggerItemArray,
  isWorkflowScene,
} from "./type-guards.js";

// ==================== Context 编译入口 ====================

/**
 * 编译 Profile 为 Context IR（v9）。
 * - 遍历 Blueprint.injectionPoints
 * - 每个注入点找 Profile 同名 InjectionPointInstance
 * - 按 modName 注册表聚合（dispatchInjectionPoint）
 */
export function compileContext(
  profile: Profile,
  blueprint: Blueprint,
  domains: Domain[]
): ContextIR {
  // 1. 按 Domain 名建立索引
  const domainByName = new Map(domains.map((d) => [d.name, d]));

  // 2. 按 Blueprint 的注入点遍历
  const modules: Record<string, string> = {};
  for (const ipConfig of blueprint.injectionPoints) {
    // 找 Profile 对应的注入点实例化（同名）
    const ipInstance = profile.injectionPoints.find((i) => i.name === ipConfig.name);

    // v9 Domains 分发：全局 domains + 注入点追加，按 Blueprint Modules 过滤
    const refDomains = resolveDomains(profile, ipInstance, ipConfig, domainByName);

    // 按 modName 驱动聚合
    modules[ipConfig.name] = dispatchInjectionPoint(ipInstance, ipConfig, refDomains);
  }

  // 3. 算 sourceHash
  const sourceHash = computeSourceHash(profile, blueprint, domains);

  return {
    name: profile.name,
    blueprint: profile.blueprint,
    sourceHash,
    modules,
  };
}

/** v9 Domains 分发：全局 domains + 注入点追加（去重，保序），按 Blueprint Modules 过滤。
 *  规则：Domain 有该注入点 Modules 列出的任一 H2 段 → 贡献；没有 → 跳过。
 *  这就是 v9 "Domain 同一份内容可贡献多注入点" 的语义——Profile 引用的 Domain，
 *  只有其 H2 段匹配 Blueprint.Modules 时才进当前注入点。 */
function resolveDomains(
  profile: Profile,
  ipInstance: InjectionPointInstance | undefined,
  ipConfig: InjectionPointConfig,
  domainByName: Map<string, Domain>
): Domain[] {
  // 合并：全局 domains + 注入点追加（去重，保序）
  const allNames = [...profile.domains];
  if (ipInstance) {
    for (const dn of ipInstance.domains) {
      if (!allNames.includes(dn)) allNames.push(dn);
    }
  }

  // 过滤：Domain 有该注入点 Modules 列出的任一 H2 段才贡献
  return allNames
    .map((n) => domainByName.get(n))
    .filter((d): d is Domain => !!d)
    .filter((d) => ipConfig.modules.some((m) => d.modules[m] !== undefined));
}

// ==================== modName 驱动聚合（v9 核心） ====================

/**
 * v9 dispatchInjectionPoint：按 modName 驱动聚合。
 *   - 遍历 ipConfig.modules（Blueprint 声明的聚合标题列表）
 *   - 每个 modName 调对应 moduleRenderers[modName] 渲染
 *   - renderer 内部按 d.type 特化取内容格式
 *   - target 不在此判断——target 决定注入位置，由 AgentAdapter 处理（compile 不感知 Agent）
 */
function dispatchInjectionPoint(
  _ipInstance: InjectionPointInstance | undefined,
  ipConfig: InjectionPointConfig,
  refDomains: Domain[]
): string {
  const parts: string[] = [];

  // 遍历 Blueprint.Modules 列出的聚合标题
  for (const modName of ipConfig.modules) {
    const renderer = moduleRenderers[modName] ?? renderGenericModule;
    const modParts: string[] = [];
    for (const d of refDomains) {
      const content = d.modules[modName];
      if (content === undefined) continue;
      const rendered = renderer(d, content, ipConfig.mode);
      if (rendered) modParts.push(rendered);
    }
    if (modParts.length > 0) parts.push(modParts.join("\n\n"));
  }

  return parts.join("\n\n").trimEnd();
}

// ==================== moduleRenderers 注册表（替代 v8 domainSceneRenderers） ====================

type ModuleRenderer = (d: Domain, content: unknown, mode?: StructureLayout["mode"]) => string;

/** modName → renderer。已注册：Scene/Trigger/Manual。
 *  扩展：调 registerModuleRenderer("xxx", fn) 加一行 + 一个函数即可，不动主循环。
 *  加新聚合标题（Blueprint.Modules 加项）不注册 = 走 generic fallback（自动按 H3 + name/desc 输出）。 */
const moduleRenderers: Record<string, ModuleRenderer> = {
  [MOD_SCENE]: renderSceneModule,
  [MOD_TRIGGER]: renderTriggerModule,
  [MOD_MANUAL]: renderManualModule,
};

/** 扩展接口：加新 modName 只加一行 + 一个 renderer 函数。 */
export function registerModuleRenderer(modName: string, fn: ModuleRenderer): void {
  moduleRenderers[modName] = fn;
}

// ==================== Scene module renderer（按 d.type 特化） ====================

/** Scene 段聚合：term→Term[] 列表 / workflow→externals / stack→空。
 *  hybrid mode 下 rule 也可从 Scene 抽——但 v9 规则在 Manual 段，Scene 段只承载场景元数据。 */
function renderSceneModule(d: Domain, content: unknown, _mode?: StructureLayout["mode"]): string {
  const lines: string[] = [`### ${d.name}`];

  switch (d.type) {
    case "term": {
      if (!isTermArray(content)) return "";
      for (const t of content) {
        if (t.desc) lines.push(`- ${t.name}: ${t.desc}`);
        else lines.push(`- ${t.name}`);
      }
      break;
    }
    case "workflow": {
      if (!isWorkflowScene(content)) return "";
      const externals = content.externals ?? [];
      for (const ext of externals) {
        if (ext.path && ext.desc) lines.push(`- ${ext.name}: ${ext.path} — ${ext.desc}`);
        else if (ext.path) lines.push(`- ${ext.name}: ${ext.path}`);
        else if (ext.desc) lines.push(`- ${ext.name}: ${ext.desc}`);
        else lines.push(`- ${ext.name}`);
      }
      break;
    }
    case "stack": {
      // stack 的 tools 在 tools 聚合段输出，不进 Scene section
      return "";
    }
    default:
      // 未知 type 走 generic fallback（term 形态）
      return renderGenericModule(d, content);
  }
  return lines.join("\n").trimEnd();
}

// ==================== Trigger module renderer（索引聚合，v9 新增） ====================

/** Trigger 段聚合：把所有 Domain 的 Trigger 项合并成索引。
 *  v9 关键：Trigger 是索引，告诉 LLM "有什么手册可查 + 何时查"。不加模块标题——索引段是平的。 */
function renderTriggerModule(d: Domain, content: unknown): string {
  if (!isTriggerItemArray(content)) return "";
  if (content.length === 0) return "";
  const lines: string[] = [];
  for (const t of content) {
    if (t.desc) lines.push(`- ${t.name}: ${t.desc}`);
    else lines.push(`- ${t.name}`);
    if (t.hint) lines.push(`  ${t.hint}`);
  }
  return lines.join("\n");
}

// ==================== Manual module renderer（聚合参考手册） ====================

/** Manual 段聚合：workflow→FlowTemplate 列表 / term→Rule 列表。
 *  v9：context_message 注入点（参考手册）主要消费 Manual 段。 */
function renderManualModule(d: Domain, content: unknown): string {
  const lines: string[] = [`### ${d.name}`, ""];

  switch (d.type) {
    case "workflow": {
      if (!isFlowTemplateArray(content)) return "";
      for (const t of content) {
        const hint = t.argumentHint ? ` ${t.argumentHint}` : "";
        lines.push(`- ${t.name}${hint}: ${t.intent}`);
      }
      break;
    }
    case "term": {
      if (!isRuleArray(content)) return "";
      for (const r of content) {
        if (r.type === "invariant") {
          if (r.check) lines.push(`- ${r.name}: ${r.check}`);
          else lines.push(`- ${r.name}`);
        } else if (r.type === "ban" && r.items && r.items.length > 0) {
          if (r.check) lines.push(`- ${r.name}: ${r.check} (${r.items.join(" / ")})`);
          else lines.push(`- ${r.name}: ${r.items.join(" / ")}`);
        }
      }
      break;
    }
    case "stack":
      // stack 无 Manual 段
      return "";
    default:
      return renderGenericModule(d, content);
  }
  return lines.join("\n").trimEnd();
}

// ==================== Generic fallback（扩展 modName 时自动适用） ====================

/** Generic fallback：原样输出 H3 标题 + 列表项，不解析内容格式。
 *  加新聚合标题（如 ### Modules 加 ## Glossary）不用注册 renderer，自动用 fallback 聚合。 */
function renderGenericModule(_d: Domain, content: unknown): string {
  if (!isNamedItemArray(content)) return "";
  const lines: string[] = [];
  for (const item of content) {
    if (item.desc) lines.push(`- ${item.name}: ${item.desc}`);
    else lines.push(`- ${item.name}`);
  }
  return lines.join("\n");
}

// ==================== 公共段（mode-based，hybrid 模式的全局约束段保留） ====================

/** hybrid mode 下的全局约束段：从 term-Domain 的 Manual 段聚合 global slot 的 Rule。
 *  v9：保留此逻辑但不在 dispatchInjectionPoint 主路径调用——如有 Blueprint 扩展需要，
 *      可通过 registerModuleRenderer 加 modName 复用。 */
function renderGlobalRules(rules: Rule[]): string {
  const lines: string[] = ["### 全局约束"];
  for (const r of rules.filter((x) => x.type === "invariant")) {
    lines.push(`- ${r.name}: ${r.check}`);
  }
  for (const r of rules.filter((x) => x.type === "ban")) {
    if (r.items && r.items.length > 0) {
      lines.push(`- ${r.name}: ${r.check} (${r.items.join(" / ")})`);
    }
  }
  return lines.join("\n");
}

// ==================== sourceHash ====================

/** sha256(JSON.stringify(profile) + blueprint + domains) → hex */
export function computeSourceHash(
  profile: Profile,
  blueprint: Blueprint,
  domains: Domain[]
): string {
  const payload = JSON.stringify({
    profile: stableStringify(profile),
    blueprint: stableStringify(blueprint),
    domains: domains.map((d) => stableStringify(d)),
  });
  return simpleHash(payload);
}

function stableStringify(obj: unknown): string {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return "[" + obj.map(stableStringify).join(",") + "]";
  if (!isRecord(obj)) return JSON.stringify(obj);
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",") + "}";
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === "object" && !Array.isArray(x);
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
