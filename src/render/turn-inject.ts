// src/render/turn-inject.ts — FlowTemplate + 参数 → Turn Inject
//
// Phase 9.5：v9 后端通用化。
//   - renderTurnInject(ctx, blueprint, domains, args) 修复死代码——实现 /pt_turn_inject xxx 触发
//   - findFlowInBlueprint(blueprint, domains, tplName) — 替代 v8 findFlowInBundle
//
// /pt_turn_inject <domain-name> 触发：从 Blueprint 的 turn 聚合组引用的 Domain 里查 Manual 段
// /pt_turn_inject <flow-name> <args> 触发：展开 Domain 的 FlowTemplate
//
// Phase term-P4.3：renderContextMessage → renderTurnInject；inject 语义值 context_message → turn（Agent-agnostic 语义值）。
//   bindFlowTemplate / findFlowInBlueprint 函数名不改——它们是 FlowTemplate 操作，非注入位置概念。
//
// Tech Debt T6: 全用 type guard 收窄，不用 as 断言（pt-quality #1）
// Tech Debt T2: 用 constants 模块名常量（pt-quality #5）

import { MOD_CHECKLISTS, MOD_FLOWS, MOD_RULES } from "../constants.js";
import { isChecklistArray, isFlowTemplateArray, isRuleArray } from "../compile/type-guards.js";
import type {
  AgentContext,
  Blueprint,
  Domain,
  FlowStep,
  FlowTemplate,
  ModName,
  Profile,
} from "../schema.js";

/** FlowTemplate + 元数据（adapter 附加的 _vars）。_vars 优先于 argument-hint fallback。 */
export type BoundableTemplate = FlowTemplate & { _vars?: string[] };

interface VarSpec {
  name: string;
  default?: string;
}

/**
 * 给定 AgentContext + Blueprint + Domains + args（形如 "/pt_turn_inject pt-quality" 或 "/pt_turn_inject risk-check 客户A 5000"），
 * 展开目标 Domain 的 Manual 段内容或 FlowTemplate。
 *
 * v9 触发：
 *   - /pt_turn_inject <domain-name>：注入该 Domain 的 Manual 段内容（term→Rule checklist / workflow→FlowTemplate 列表）
 *   - /pt_turn_inject <flow-name> <args>：展开 workflow-Domain 的 FlowTemplate
 *
 * Phase term-P4.3：AgentAdapter 内部把 Turn Inject 注入到 Agent 的 turn 级（Pi: input 事件 transform）。
 *
 * v13.x（issue pt-turn-inject-not-profile-scoped）：加 profile 参数——
 *   - domain 维度：调用方（adapter）应已用 filterDomainsByProfile 过滤 domains，renderTurnInject
 *     不再二次过滤（信任传入的 domains scope）
 *   - modules 维度（阶段 2）：从 blueprint 的 inject=turn 聚合组 + profile 同名 ProfileGroup.modules 算
 *     白名单，/pt_turn_inject <domain> 只渲染白名单内的段，/pt_turn_inject <flow-name> 只在白名单含 Flows 段时查找。
 *     profile 为 null 或无 turn 聚合组 → 白名单 null = 不限制（向后兼容）。
 */
export function renderTurnInject(
  _ctx: AgentContext,
  blueprint: Blueprint,
  domains: Domain[],
  profile: Profile | null,
  args: string
): string | null {
  // v18.x（issue pt-turncontext-llm-call-trigger 决策 5）：统一入口 /pt_turn_inject <target>
  //   - /pt_turn_inject <domain>     → renderDomainManual（Rules/Flows/Checklists 段）
  //   - /pt_turn_inject <flow-name> <args> → bindFlowTemplate（FlowTemplate 展开）
  // 按 args 第一个 token 分流：先按 domain 名匹配，未命中再按 flow-name 匹配。
  const m = args.trim().match(/^\/pt_turn_inject\s+(.*)$/);
  if (!m) return null;
  const rest = m[1].trim();
  if (!rest) return null;

  // Stage 2: compute modules whitelist for turn aggregation group (Profile "reference-manual" aggregation group's ### Modules)
  const mods = turnGroupModules(blueprint, profile);

  // 先按 domain 名匹配（renderDomainManual）
  const firstToken = rest.split(/\s+/)[0];
  const d = domains.find((x) => x.name === firstToken);
  if (d) {
    return renderDomainManual(d, mods);
  }

  // 再按 flow-name 匹配（bindFlowTemplate）
  const parts = rest.split(/\s+/);
  const flowName = parts[0];
  const flowArgs = parts.slice(1).join(" ");
  const tpl = findFlowInBlueprint(blueprint, domains, flowName, profile);
  if (!tpl) return null;
  return bindFlowTemplate(tpl, flowArgs);
}

// ==================== turn 聚合组 modules 白名单辅助（v13.x issue pt-turn-inject-not-profile-scoped） ====================

/** 找 turn 聚合组的 modules 白名单（Profile 同名 ProfileGroup 的 ### Modules）。
 *  返 null = 不限制（profile 为 null / 无 turn 聚合组 / ProfileGroup 未填 modules——向后兼容）。
 *  This is the core of stage 2: let Profile "reference-manual" ### Modules section selection actually affect turn-triggered render scope. */
function turnGroupModules(blueprint: Blueprint, profile: Profile | null): ModName[] | null {
  if (!profile) return null;
  const turnGroupName = blueprint.groups.find((g) => g.inject === "turn")?.name;
  if (!turnGroupName) return null;
  const pg = profile.groups.find((g) => g.name === turnGroupName);
  if (!pg || pg.modules.length === 0) return null;
  return pg.modules;
}

/** 检查 mods 白名单是否包含某段名。null = 不限制（含）。 */
function modsAllowsSection(mods: ModName[] | null, section: string): boolean {
  if (!mods) return true;
  return mods.some((m) => m.section === section);
}

/**
 * 渲染 Domain 的"手册"段内容（Phase term-P9.2：从 Manual 拆三段）。
 *  - Rules → Rule checklist（"## 规范清单"）
 *  - Flows → FlowTemplate 列表（"## 可用手册"）
 *  - Checklists → Checklist 列表（"## 验收清单"）
 *  优先级：Flows > Rules > Checklists（workhorse 最常被查）
 *  v13.x：受 mods 白名单限制——只渲染 modsAllowsSection 通过的段。
 *  返回 null 表示该 Domain 没有任何手册段（或所有段都被白名单排除）。 */
function renderDomainManual(d: Domain, mods: ModName[] | null): string | null {
  if (modsAllowsSection(mods, MOD_FLOWS)) {
    const flows = d.modules[MOD_FLOWS];
    if (isFlowTemplateArray(flows)) {
      const lines: string[] = [];
      for (const t of flows) {
        const hint = t.argumentHint ? ` ${t.argumentHint}` : "";
        lines.push(`- ${t.name}${hint}: ${t.intent}`);
      }
      if (lines.length > 0) {
        return `# /pt_turn_inject ${d.name}\n\n## 可用手册\n\n${lines.join("\n")}`.trimEnd();
      }
    }
  }

  if (modsAllowsSection(mods, MOD_RULES)) {
    const rules = d.modules[MOD_RULES];
    if (isRuleArray(rules)) {
      const lines: string[] = [];
      for (const r of rules) {
        if (r.type === "invariant") {
          if (r.check) lines.push(`- ${r.name}: ${r.check}`);
          else lines.push(`- ${r.name}`);
        } else if (r.type === "ban" && r.items && r.items.length > 0) {
          if (r.check) lines.push(`- ${r.name}: ${r.check} (${r.items.join(" / ")})`);
          else lines.push(`- ${r.name}: ${r.items.join(" / ")}`);
        }
      }
      if (lines.length > 0) {
        return `# /pt_turn_inject ${d.name}\n\n## 规范清单\n\n${lines.join("\n")}`.trimEnd();
      }
    }
  }

  if (modsAllowsSection(mods, MOD_CHECKLISTS)) {
    const checklists = d.modules[MOD_CHECKLISTS];
    if (isChecklistArray(checklists)) {
      const sections: string[] = [];
      for (const cl of checklists) {
        sections.push(`### ${cl.name}\n${cl.items.map((i) => `- ${i}`).join("\n")}`);
      }
      if (sections.length > 0) {
        return `# /pt_turn_inject ${d.name}\n\n## 验收清单\n\n${sections.join("\n\n")}`.trimEnd();
      }
    }
  }

  return null;
}

/**
 * 把 FlowTemplate 模板 + 用户参数 展开为完整手册 markdown。
 * 错误 / 缺失变量 → 留为字面量（不抛异常）。
 */
export function bindFlowTemplate(tpl: BoundableTemplate, args: string): string {
  const tokens = args.trim() ? args.trim().split(/\s+/) : [];
  const varSpecs = parseVarSpecs(tpl._vars, tpl.argumentHint);

  const bound = new Map<string, string>();
  for (let i = 0; i < varSpecs.length; i++) {
    const spec = varSpecs[i];
    const token = tokens[i];
    if (token !== undefined) {
      bound.set(spec.name, token);
    } else if (spec.default !== undefined) {
      bound.set(spec.name, spec.default);
    }
  }

  const lines: string[] = [];
  lines.push(`# ${tpl.name}`);
  lines.push("");
  if (tpl.argumentHint) {
    lines.push(`_参数：${tpl.argumentHint}_`);
    lines.push("");
  }
  lines.push(`## 前提（Intent）`);
  lines.push(replaceVars(tpl.intent, bound));
  lines.push("");
  lines.push(`## 步骤`);
  tpl.steps.forEach((s: FlowStep, i: number) => {
    lines.push(`${i + 1}. ${replaceVars(s.desc, bound)}`);
    // P2：激活 step.dataSource（输入参照） + step.output（期望产出）+ observe（验证参照）。
    // 顺序为"输入→产出→验证"——体现 step 语义流；back-compat：三字段 optional，未填不渲染。
    if (s.dataSource) {
      const ds = s.dataSource;
      const name = ds.name ?? "";
      const path = ds.path ?? "";
      const desc = ds.desc ?? "";
      // 同时有 name + path 时把 path 包裹括号；只一个时直接输出那个。
      const head = name && path ? `${name}（${path}）` : name || path;
      const tail = desc ? ` — ${desc}` : "";
      lines.push(`   - 输入参照：${head}${tail}`);
    }
    if (s.output) {
      lines.push(`   - 期望产出：${replaceVars(s.output, bound)}`);
    }
    if (s.observe && s.observe.length > 0) {
      lines.push(`   - 验证参照：${s.observe.join(", ")}`);
    }
  });

  return lines.join("\n");
}

// ==================== 内部辅助 ====================

function parseVarSpecs(_vars: string[] | undefined, hint: string | undefined): VarSpec[] {
  if (_vars && _vars.length > 0) {
    return _vars.map(parseVarSpecName);
  }
  if (hint) {
    const matches = [...hint.matchAll(/<([^>]+)>/g)];
    return matches.map((m) => parseVarSpecName(m[1]));
  }
  return [];
}

function parseVarSpecName(raw: string): VarSpec {
  const trimmed = raw.trim();
  const idx = trimmed.indexOf("|");
  if (idx < 0) return { name: trimmed };
  const name = trimmed.slice(0, idx).trim();
  const defaultPart = trimmed.slice(idx + 1).trim();
  const defaultMatch = defaultPart.match(/^default\s*:\s*(.*)$/);
  if (defaultMatch) return { name, default: defaultMatch[1].trim() };
  return { name, default: defaultPart };
}

function replaceVars(text: string, bound: Map<string, string>): string {
  return text.replace(/\{\{([^}]+)\}\}/g, (match, inner: string) => {
    const spec = parseVarSpecName(inner);
    const v = bound.get(spec.name);
    if (v !== undefined) return v;
    if (spec.default !== undefined) return spec.default;
    return match;
  });
}

/** 在 Blueprint 聚合组（inject=turn）的引用域中按名查找 FlowTemplate（跨 Domain）。
 *  v13.x（issue pt-turn-inject-not-profile-scoped）：加 profile 参数——内部算 mods 白名单，
 *  Returns undefined when whitelist has no Flows section (Profile "reference-manual" ### Modules didn't declare Flows → /<flow-name> trigger fails).
 *  Phase term-P4.3 + term-final：inject 语义值 turn（原 context_message → turn → 现聚合组 inject=turn）。 */
export function findFlowInBlueprint(
  blueprint: Blueprint,
  // Phase term-P9.3：type 字段删除——Domain 不再有 type 维度，按 H2 段名（这里是 ## Flows）识别 FlowTemplate
  domains: Array<{ name: string; modules: Record<string, unknown> }>,
  tplName: string,
  profile: Profile | null = null
): BoundableTemplate | undefined {
  // 验证 Blueprint 里有 inject=turn 的聚合组（间接确认 input 事件该由本实例覆盖接管）
  const hasTurnGroup = blueprint.groups.some((g) => g.inject === "turn");
  if (!hasTurnGroup) return undefined;

  // v13.x：mods 白名单不含 Flows 段则不查找——配置即行为
  const mods = turnGroupModules(blueprint, profile);
  if (!modsAllowsSection(mods, MOD_FLOWS)) return undefined;

  for (const d of domains) {
    // Phase term-P9.2：FlowTemplate 在 ## Flows 段（不分 type）。
    const flows = d.modules[MOD_FLOWS];
    if (!isFlowTemplateArray(flows)) continue;
    const hit = flows.find((t) => t.name === tplName);
    if (hit) {
      const bt: BoundableTemplate = { ...hit };
      // P2.1：v9 BoundableTemplate = FlowTemplate & { _vars? }，vars 字段 spread 不会产生
      // 原双重 cast (bt as unknown as { vars?: unknown }).vars 永远 undefined（dead code）。
      // 若未来需从 args 传 vars 进来，应在调用方 bindFlowTemplate 处理，不在此处 cast 补救。
      return bt;
    }
  }
  return undefined;
}
