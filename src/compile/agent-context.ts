// src/compile/agent-context.ts — 中端：Profile + Blueprint + Domains → AgentContext IR
//
// Phase 9.4：v9 中端重写。
//   - 输入：profile（v9 配置：blueprint + domains + groups）+ blueprint（v9 结构：groups）+ domains[]
//   - 输出：AgentContext IR（v9 产物层）—— modules: Record<聚合组名, 聚合后 markdown>
//
// Phase term-P1：Context IR 改名 AgentContext（避免与 Pi 的 context_message 撞名，加入 Agent 概念族）。
//   文件同步改名 src/compile/context.ts → src/compile/agent-context.ts。
//
// v9 编译流程：
//   遍历 Blueprint.groups：
//     1. 找 Profile 对应 ProfileGroup（同名）—— 聚合组追加的 Domains
//     2. resolveDomains(profile, group, bpGroup, domainByName) — 合并全局 + 追加，按 Blueprint.modules 过滤
//     3. dispatchGroup — 遍历 bpGroup.modules，按 modName 注册表聚合
//
// v9 核心变化：
//   - dispatchGroup 按 modName 驱动聚合（v8 按 target 硬编码）
//   - moduleRenderers 注册表替代 domainSceneRenderers（v8 按 type 分发）
//   - 加新聚合标题（Blueprint.modules 加项）= 改 Blueprint，不用改代码；generic fallback 自动处理
//   - Trigger 段聚合在 session 聚合组，作为索引段
//   - Profile domains 自动分发：YAML 全局 domains + 聚合组追加
//
// Tech Debt T6: 全用 type guard 收窄，不用 as 断言（pt-quality #1）

import {
  MOD_CHECKLISTS,
  MOD_FLOWS,
  MOD_PARTICIPANT,
  MOD_RULES,
  MOD_SCENE,
  MOD_TRIGGER,
} from "../constants.js";
import type {
  AgentContext,
  Blueprint,
  BlueprintGroup,
  Domain,
  Profile,
  ProfileGroup,
  StructureLayout,
} from "../schema.js";
import {
  isChecklistArray,
  isFlowTemplateArray,
  isNamedItemArray,
  isRecord,
  isRuleArray,
  isTermArray,
  isTriggerItemArray,
} from "./type-guards.js";

// ==================== AgentContext 编译入口 ====================

/**
 * 编译 Profile 为 AgentContext IR（v9）。
 * - 遍历 Blueprint.groups
 * - 每个聚合组找 Profile 同名 ProfileGroup
 * - 按 modName 注册表聚合（dispatchGroup）
 *
 * Phase term-P1：函数名 compileContext → compileAgentContext（IR 改名同步）。
 */
export function compileAgentContext(
  profile: Profile,
  blueprint: Blueprint,
  domains: Domain[]
): AgentContext {
  // 1. 按 Domain 名建立索引
  const domainByName = new Map(domains.map((d) => [d.name, d]));

  // 2. 按 Blueprint 的聚合组遍历
  const modules: Record<string, string> = {};
  for (const bpGroup of blueprint.groups) {
    // 找 Profile 对应的聚合组实例化（同名）
    const profileGroup = profile.groups.find((g) => g.name === bpGroup.name);

    // v9 Domains 分发：全局 domains + 聚合组追加，按 Blueprint.modules 过滤
    const refDomains = resolveDomains(profile, profileGroup, bpGroup, domainByName);

    // 按 modName 驱动聚合
    modules[bpGroup.name] = dispatchGroup(profileGroup, bpGroup, refDomains);
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

/** v9 Domains 分发：全局 domains + 聚合组追加（去重，保序），按 Blueprint.modules 过滤。
 *  规则：Domain 有该聚合组 modules 列出的任一 H2 段 → 贡献；没有 → 跳过。
 *  这就是 v9 "Domain 同一份内容可贡献多聚合组" 的语义——Profile 引用的 Domain，
 *  只有其 H2 段匹配 Blueprint.modules 时才进当前聚合组。 */
function resolveDomains(
  profile: Profile,
  profileGroup: ProfileGroup | undefined,
  bpGroup: BlueprintGroup,
  domainByName: Map<string, Domain>
): Domain[] {
  // 合并：全局 domains + 聚合组追加（去重，保序）
  const allNames = [...profile.domains];
  if (profileGroup) {
    for (const dn of profileGroup.domains) {
      if (!allNames.includes(dn)) allNames.push(dn);
    }
  }

  // 过滤：Domain 有该聚合组 modules 列出的任一 H2 段才贡献
  return allNames
    .map((n) => domainByName.get(n))
    .filter((d): d is Domain => !!d)
    .filter((d) => bpGroup.modules.some((m) => d.modules[m] !== undefined));
}

// ==================== modName 驱动聚合（v9 核心） ====================

/**
 * v9 dispatchGroup：按 modName 驱动聚合。
 *   - 遍历 bpGroup.modules（Blueprint 声明的聚合标题列表）
 *   - 每个 modName 调对应 moduleRenderers[modName] 渲染
 *   - renderer 内部按段名 spec 取内容格式（Phase term-P9.3：不再按 d.type 分发）
 *   - inject 不在此判断——inject 决定注入位置，由 AgentAdapter 处理（compile 不感知 Agent）
 */
function dispatchGroup(
  _profileGroup: ProfileGroup | undefined,
  bpGroup: BlueprintGroup,
  refDomains: Domain[]
): string {
  const parts: string[] = [];

  // 遍历 Blueprint.modules 列出的聚合标题
  for (const modName of bpGroup.modules) {
    const renderer = moduleRenderers[modName] ?? renderGenericModule;
    const modParts: string[] = [];
    for (const d of refDomains) {
      const content = d.modules[modName];
      if (content === undefined) continue;
      const rendered = renderer(d, content, bpGroup.mode);
      if (rendered) modParts.push(rendered);
    }
    if (modParts.length > 0) parts.push(modParts.join("\n\n"));
  }

  return parts.join("\n\n").trimEnd();
}

// ==================== moduleRenderers 注册表（替代 v8 domainSceneRenderers） ====================

type ModuleRenderer = (d: Domain, content: unknown, mode?: StructureLayout["mode"]) => string;

/** modName → renderer。已注册：Scene/Trigger/Rules/Flows/Checklists/Participant。
 *  Phase term-P9.2：从 Manual 拆出 Rules/Flows/Checklists 三个 H2 段。
 *  Phase term-P8：加 Participant，复用 renderSceneModule（与 Scene 同构——都是 Term[]）。
 *  扩展：调 registerModuleRenderer("xxx", fn) 加一行 + 一个函数即可，不动主循环。
 *  加新聚合标题（Blueprint.modules 加项）不注册 = 走 generic fallback（自动按 H3 + name/desc 输出）。 */
const moduleRenderers: Record<string, ModuleRenderer> = {
  [MOD_SCENE]: renderSceneModule,
  [MOD_TRIGGER]: renderTriggerModule,
  [MOD_RULES]: renderRulesModule,
  [MOD_FLOWS]: renderFlowsModule,
  [MOD_CHECKLISTS]: renderChecklistsModule,
  [MOD_PARTICIPANT]: renderSceneModule, // P8：复用 Scene renderer（Term[] 同构，带 ### domain 标题）
};

/** 扩展接口：加新 modName 只加一行 + 一个 renderer 函数。 */
export function registerModuleRenderer(modName: string, fn: ModuleRenderer): void {
  moduleRenderers[modName] = fn;
}

// ==================== Scene module renderer（Phase term-P9.3：去 type switch） ====================

/** Scene 段聚合：统一为 Term[] 列表（Phase term-P9.1：term + workflow Scene 合并）。
 *  - 无 type 区分——所有 Domain 的 Scene 段统一走 Term[] schema（path 可选）。
 *  - 渲染：有 path → `- name: path — desc`；无 path → `- name: desc`。
 *  - 附加 fields/note。
 *  hybrid mode 下 rule 也可从 Scene 抽——但 v9 规则在 Rules 段，Scene 段只承载场景元数据。 */
function renderSceneModule(d: Domain, content: unknown, _mode?: StructureLayout["mode"]): string {
  if (!isTermArray(content)) return "";
  const lines: string[] = [`### ${d.name}`];
  for (const t of content) {
    let line: string;
    if (t.path && t.desc) line = `- ${t.name}: ${t.path} — ${t.desc}`;
    else if (t.path) line = `- ${t.name}: ${t.path}`;
    else if (t.desc) line = `- ${t.name}: ${t.desc}`;
    else line = `- ${t.name}`;
    // v9.2：附加 fields/note
    if (t.fields && t.fields.length > 0) {
      line += `（字段：${t.fields.join("/")}）`;
    }
    if (t.note) {
      line += ` — ${t.note}`;
    }
    lines.push(line);
  }
  return lines.join("\n").trimEnd();
}

// ==================== Trigger module renderer（索引聚合，v9 新增） ====================

/** Trigger 段聚合：把所有 Domain 的 Trigger 项合并成索引。
 *  v9 关键：Trigger 是索引，告诉 LLM "有什么手册可查 + 何时查"。不加模块标题——索引段是平的。 */
function renderTriggerModule(_d: Domain, content: unknown): string {
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

// ==================== Manual module renderer（聚合参考手册，P9.2 拆三段） ====================

/** Phase term-P9.2：从 renderManualModule 拆出 Rules/Flows/Checklists 三段。
 *  每个 renderer 内部直接调对应 type guard（不再依赖 d.type——P9.3 后 type 字段删除）。 */

/** Rules 段：Rule[]（term 形态，含 slot/type/check/items） */
function renderRulesModule(d: Domain, content: unknown): string {
  if (!isRuleArray(content)) return "";
  const lines: string[] = [];
  for (const r of content) {
    if (r.type === "invariant") {
      if (r.check) lines.push(`- ${r.name}: ${r.check}`);
      else lines.push(`- ${r.name}`);
    } else if (r.type === "ban" && r.items && r.items.length > 0) {
      if (r.check) lines.push(`- ${r.name}: ${r.check} (${r.items.join(" / ")})`);
      else lines.push(`- ${r.name}: ${r.items.join(" / ")}`);
    }
  }
  if (lines.length === 0) return "";
  return `### ${d.name}\n\n${lines.join("\n")}`.trimEnd();
}

/** Flows 段：FlowTemplate[]（workflow 形态，含 argumentHint/intent/steps） */
function renderFlowsModule(d: Domain, content: unknown): string {
  if (!isFlowTemplateArray(content)) return "";
  const lines: string[] = [];
  for (const t of content) {
    const hint = t.argumentHint ? ` ${t.argumentHint}` : "";
    lines.push(`- ${t.name}${hint}: ${t.intent}`);
  }
  if (lines.length === 0) return "";
  return `### ${d.name}\n\n${lines.join("\n")}`.trimEnd();
}

/** Checklists 段：Checklist[]（name + items[]） */
function renderChecklistsModule(d: Domain, content: unknown): string {
  if (!isChecklistArray(content)) return "";
  const sections: string[] = [];
  for (const cl of content) {
    const items = cl.items.map((i) => `- ${i}`).join("\n");
    sections.push(`### ${cl.name}\n${items}`);
  }
  if (sections.length === 0) return "";
  return `### ${d.name}\n\n${sections.join("\n\n")}`.trimEnd();
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
  if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(",")}]`;
  if (!isRecord(obj)) return JSON.stringify(obj);
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/** FNV-1a 32-bit hash，足够用于缓存标识。 */
function simpleHash(s: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${(hash >>> 0).toString(16).padStart(8, "0")}-${s.length.toString(16).padStart(8, "0")}`;
}
