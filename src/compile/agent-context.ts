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
  MOD_AGENT,
  MOD_CHECKLISTS,
  MOD_FLOWS,
  MOD_PARTICIPANT,
  MOD_RULES,
  MOD_SCENE,
  MOD_TRIGGER,
  MOD_USER,
} from "../constants.js";
import { reportWarn } from "../diagnostics.js";
import type {
  AgentContext,
  Blueprint,
  BlueprintGroup,
  Domain,
  ModName,
  Profile,
  ProfileGroup,
  SourceAdapterContext,
  StructureLayout,
  Term,
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
 * - 按 modName 注册表聚合（dispatchGroup）—— modName 来源从 Blueprint.modules 改为 ProfileGroup.modules
 *
 * Phase term-P1：函数名 compileContext → compileAgentContext（IR 改名同步）。
 * Phase term-P-modules-to-profile：
 *   - Blueprint 退化为插槽契约（无 modules 字段），modules 由 ProfileGroup.modules 提供
 *   - 加越权/缺填告警（log warn + notify / log debug only）—— 设计文档 §5
 *   - ctx 可选：测试 / CLI 直接调可不传；运行链路（transpile）传入同 adapterCtx 用 logger 留痕
 */
export function compileAgentContext(
  profile: Profile,
  blueprint: Blueprint,
  domains: Domain[],
  ctx?: SourceAdapterContext
): AgentContext {
  // 1. 按 Domain 名建立索引
  const domainByName = new Map(domains.map((d) => [d.name, d]));

  // 2. 按 Blueprint 的聚合组遍历
  const modules: Record<string, string> = {};
  for (const bpGroup of blueprint.groups) {
    // 找 Profile 对应的聚合组实例化（同名）
    const profileGroup = profile.groups.find((g) => g.name === bpGroup.name);

    // 缺填告警：Blueprint 有此插槽但 Profile 没填 modules
    // issue pt-status-no-injection-state：升级为 reportWarn——
    // v9.1 modules-to-profile 迁移后，"未填 modules"几乎总是配置错误，
    // 不再是 v9 的"故意留空"。三通道 fallback 让用户首次切换就看到告警，
    // 避免切换后 footer 永远 idle 却 `injected: true` 误导
    if (!profileGroup || profileGroup.modules.length === 0) {
      reportWarn(
        ctx,
        `Profile「${profile.name}」插槽「${bpGroup.name}」未填 modules（segment 会为空）`,
        {
          profile: profile.name,
          group: bpGroup.name,
          hasGroup: !!profileGroup,
          hint: "在 Profile 的 H2 段下加 `### Modules` 列出 modName（段名或 段.项 形态）",
        }
      );
    }

    // v9.1：按 ProfileGroup.modules 过滤（Blueprint 不再带 modules）
    const refDomains = resolveDomains(profile, profileGroup, bpGroup, domainByName);

    // 按 modName 驱动聚合（来源 = profileGroup.modules）
    modules[bpGroup.name] = dispatchGroup(profileGroup, bpGroup, refDomains);
  }

  // 3. 越权告警：Profile 有 Blueprint 未声明的 H2（遍历 profile.groups 找 bpGroup 没有的）
  //    几乎总是错误 → log warn + notify（设计文档 §5）。reportWarn 内部已 log → notify → console 三通道 fallback。
  const bpNames = new Set(blueprint.groups.map((g) => g.name));
  for (const pg of profile.groups) {
    if (!bpNames.has(pg.name)) {
      reportWarn(
        ctx,
        `Profile「${profile.name}」的 H2「${pg.name}」不在 Blueprint 插槽中（越权，被忽略）`,
        { profile: profile.name, group: pg.name }
      );
    }
  }

  // 4. 算 sourceHash
  const sourceHash = computeSourceHash(profile, blueprint, domains);

  return {
    name: profile.name,
    blueprint: profile.blueprint,
    sourceHash,
    modules,
  };
}

/** v9 Domains 分发：全局 domains + 聚合组追加（去重，保序），按 ProfileGroup.modules 过滤。
 *  规则：Domain 有该聚合组 modules 列出的任一 H2 段 → 贡献；没有 → 跳过。
 *  v9.1（modules-to-profile 迁移）：modules 来源从 Blueprint.modules 改为 ProfileGroup.modules
 *  —— Blueprint 退化为插槽契约，Profile 自带 modules 选择。ProfileGroup 不存在或 modules 为空
 *  时返空数组（与 dispatchGroup 行为一致——产出空段由 render 跳过）。
 *
 *  这就是 v9 "Domain 同一份内容可贡献多聚合组" 的语义——Profile 引用的 Domain，
 *  只有其 H2 段匹配 ProfileGroup.modules 时才进当前聚合组。 */
function resolveDomains(
  profile: Profile,
  profileGroup: ProfileGroup | undefined,
  _bpGroup: BlueprintGroup,
  domainByName: Map<string, Domain>
): Domain[] {
  // 合并：全局 domains + 聚合组追加（去重，保序）
  const allNames = [...profile.domains];
  if (profileGroup) {
    for (const dn of profileGroup.domains) {
      if (!allNames.includes(dn)) allNames.push(dn);
    }
  }

  // v9.1：从 ProfileGroup.modules 读过滤白名单（Blueprint.modules 已删除）
  // v9.1+（modules-to-profile-complete）：mods 是 ModName[]（段粒度 / 段.项粒度）
  const mods = profileGroup?.modules ?? [];

  // 过滤：Domain 有该聚合组 modules 列出的任一 H2 段才贡献
  return allNames
    .map((n) => domainByName.get(n))
    .filter((d): d is Domain => !!d)
    .filter((d) => mods.some((m) => d.modules[m.section] !== undefined));
}

// ==================== modName 驱动聚合（v9 核心） ====================

/**
 * v9 dispatchGroup：按 modName 驱动聚合。
 *   - 遍历 profileGroup.modules（Profile 填的聚合标题列表）
 *   - 每个 modName 调对应 moduleRenderers[modName] 渲染
 *   - renderer 内部按段名 spec 取内容格式（Phase term-P9.3：不再按 d.type 分发）
 *   - inject 不在此判断——inject 决定注入位置，由 AgentAdapter 处理（compile 不感知 Agent）
 *
 *  v9.1（modules-to-profile 迁移）：modName 来源从 BlueprintGroup.modules 改为
 *  ProfileGroup.modules。Blueprint 退化为插槽契约（声明有哪些插槽 + inject + mode），
 *  Profile 通过 H2 `### Modules` 填聚合标题列表。
 */
function dispatchGroup(
  profileGroup: ProfileGroup | undefined,
  bpGroup: BlueprintGroup,
  refDomains: Domain[]
): string {
  const parts: string[] = [];

  // 遍历 ProfileGroup.modules 列出的 ModName（Blueprint.modules 已删除）
  // v9.1+（modules-to-profile-complete）：mod 是 { section, item? } 结构
  //  - 段粒度：mod.item 未定义 → 整段渲染
  //  - 段.项粒度：mod.item 已定义 → 单 H3 项渲染
  const mods = profileGroup?.modules ?? [];
  for (const mod of mods) {
    const modParts: string[] = [];
    for (const d of refDomains) {
      const content = d.modules[mod.section];
      if (content === undefined) continue;
      const rendered = mod.item
        ? renderItemModule(d, content, mod)
        : (moduleRenderers[mod.section] ?? renderGenericModule)(d, content, bpGroup.mode);
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
  [MOD_USER]: renderSceneModule, // v9.1+：user-info 专用段（Term[] 同构）
  [MOD_AGENT]: renderSceneModule, // v9.1+：agent-info 专用段（Term[] 同构）
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

// ==================== H3 项粒度 renderer（v9.1+ modules-to-profile-complete） ====================

/** H3 项粒度渲染：输出 `### <domain>.<item>` 形式。
 *  复用 Scene/Participant/User/Agent renderer 的输出风格：带 fields/note/path。
 *  适用 mod：ModName.item 已定义。
 *  跨段同名 H3 项不跨段匹配——"User.user-profile" 只匹配 User 段下 user-profile，
 *  不匹配 Agent 段下同名 H3。设计约束：H3 项名跨段由段名命名空间避免。 */
function renderItemModule(d: Domain, content: unknown, mod: ModName): string {
  if (!mod.item) return ""; // 防御：未到这里的 caller 已用段粒度路径
  if (!isTermArray(content)) return "";
  // 同段内 H3 重名后覆盖前——只取最后一个（parse 时同名 H3 后出现覆盖前）
  const items = content as Array<Term & { name: string }>;
  let found: Term | undefined;
  for (const it of items) {
    if (it.name === mod.item) found = it;
  }
  if (!found) return "";
  const t = found as Term;
  const lines: string[] = [`### ${d.name}.${t.name}`];
  let line: string;
  if (t.path && t.desc) line = `- ${t.name}: ${t.path} — ${t.desc}`;
  else if (t.path) line = `- ${t.name}: ${t.path}`;
  else if (t.desc) line = `- ${t.name}: ${t.desc}`;
  else line = `- ${t.name}`;
  if (t.fields && t.fields.length > 0) {
    line += `（字段：${t.fields.join("/")}）`;
  }
  if (t.note) {
    line += ` — ${t.note}`;
  }
  lines.push(line);
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
