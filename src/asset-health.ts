// src/asset-health.ts — 资产配置体检（issue pt-asset-migration-visibility Layer 2）
//
// 设计动机：存量项目升级 Pt 后无迁移可见性。
//   - v9.1 modules-to-profile 迁移后，旧 profile 缺 `### Modules` → 空 segment
//   - 单 profile 运行时检测（issue pt-status-no-injection-state 修复 2/3）只在切换时触发
//   - session_start 批量体检：主动告知"项目有 N 个配置问题"，不踩坑
//
// 6 条规则（issue §Layer 2 表）：
//   1. missing-modules        (error)   ProfileGroup.modules 为空
//   2. dangling-blueprint-ref (error)   profile.blueprint 不存在
//   3. orphan-h2              (warning) ProfileGroup.name 不在 Blueprint.groups
//   4. empty-segment          (error)   compileAgentContext 产出为空段
//   5. unknown-modname        (warning) `### Modules` 项不在 KNOWN_SECTION_NAMES
//
// v16+（issue pt-optional-domains-no-match-per-domain-aggregation）：
//   6. optional-domain-unresolved  移除——optional slot 空是设计意图，不推 issue
//   7. optional-domain-no-matching-section (warning) 改为 per-domain 聚合：
//      - 一个 domain 不贡献任一 bpGroup 才 warning 一条（不再 per-bpGroup × domain 嵌套）
//      - 部分贡献不警告（已在某 slot 有用即视为有效）
//      - warning 措辞改 actionable（点明"加载了但没效果"+ 两条处置路径）
//
// v17+（issue pt-scan-miss-use-chain）：
//   8. use-expansion-error    (warning) use 链展开失败（UseTargetNotFound / UseChainCycle /
//      BlueprintGroupOutOfScope）——scan 调 expandProfile 复用 transpile 路径的链解析
//      逻辑，消除 "use 父 profile 的 modules 继承类设计" 在规则 4 报 false-positive
//
// 边界纪律：
//   - 不替代运行时检测（transpile 内的 reportWarn）——两层互补：运行时按 profile 切，scan 按全集
//   - 不写资产——只检测 + 报告；修复走 `/pt check --fix`（v2 范围，本 issue 不实现）
//   - 不引入新依赖——只用 node:fs/promises + 已有 compile 层

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { compileAgentContext } from "./compile/agent-context.js";
import {
  expandProfile,
  BlueprintGroupOutOfScope,
  UseChainCycle,
  UseTargetNotFound,
} from "./compile/resolve-use.js";
import { resolveAndDedupRefs, parseRef } from "./parse/ref-resolver.js";
import type { AssetPack } from "./schema.js";
import { checkAllRefs } from "./verify/ref-check.js";
import { refName } from "./schema.js";
import { PROFILES_DIR } from "./constants.js";
import { KNOWN_SECTION_NAMES } from "./parse/profile.js";
import type { Blueprint, Domain, Profile, SourceAdapterContext, WorkingSet } from "./schema.js";

// ==================== 公共类型 ====================

/** 问题严重程度。error 必须修；warning 可延后；info 是预期但值得告知。 */
export type IssueSeverity = "error" | "warning" | "info";

/** 问题归属：profile / blueprint / domain。本 issue v1 范围只产 profile 类。 */
export type IssueScope = "profile" | "blueprint" | "domain";

/** 单条问题。issue-doc-structure 类似——结构化便于测试断言 + UI 格式化 + 自动 fix。 */
export interface AssetHealthIssue {
  severity: IssueSeverity;
  scope: IssueScope;
  /** 问题所在资产名（profile.name / blueprint.name / domain.name）。 */
  name: string;
  /** Optional field path (e.g. "groups.session-context.modules"), for precise pointing. */
  field?: string;
  /** 人类可读问题描述。 */
  msg: string;
  /** 修复建议（hint）。 */
  hint?: string;
  /** 自动 fix 命令（v2 `--fix` 用，本 issue v1 不实现执行）。 */
  fix?: string;
}

/** 规则 id。issue §Layer 2 5 条规则 → 5 个 id；v16+ optional-domains 诊断；v17+ use 链错误诊断；v18+ 引用完整性合并。 */
export type HealthRuleId =
  | "missing-modules"
  | "dangling-blueprint-ref"
  | "orphan-h2"
  | "empty-segment"
  | "unknown-modname"
  | "optional-domain-no-matching-section" // v16+：可选 ref 加载但 H2 段全不匹配任一 bpGroup 的 modules（warning，per-domain 聚合）
  | "use-expansion-error" // v17+：use 链展开失败（UseTargetNotFound/UseChainCycle/BlueprintGroupOutOfScope）→ warning
  | "dangling-domain-ref"; // v18+（issue pt-pack-ref-drift-detection 方案 A）：profile.domains / profile.groups[X].domains 引用悬空 Domain（settings pack 删 domain 后静默破坏）→ error

/** 资产健康扫描结果（按 profile 聚合）。 */
export interface AssetHealthReport {
  issues: AssetHealthIssue[];
  errors: number;
  warnings: number;
  /** v16：info 数（optional-domain-unresolved 等预期行为的诊断）。 */
  infos?: number;
}

// ==================== 通知格式化 ====================

/** 简报格式选项（issue pt-asset-health-diag-report-format）。
 *  - maxItems：最大列出项数；超限时附加一条「→ /pt check 查看全部」引导。
 *  - prefix：默认 "[pt] 诊断："；可换为 "[pt] " 或空。 */
export interface FormatHealthSummaryOpts {
  maxItems?: number;
  prefix?: string;
}

/** scope → 修复路径与人类可读分组名（issue pt-asset-health-diag-report-format §短期修复方向）。 */
const SCOPE_TO_ACTION: Record<IssueScope, { group: string; path: string }> = {
  profile: { group: "profile 配置问题", path: "/pt check" },
  blueprint: { group: "blueprint 配置问题", path: "/pt check" },
  domain: { group: "domain 引用问题", path: "/pt check" },
};

/** 把 AssetHealthReport 格式化为人类可读分类简报（不输出逐条详情——那是 /pt check 的职责）。
 *  输出形如：
 *  ```
 *  [pt] 诊断：4 项配置问题（不阻断）
 *    · 2× profile 配置问题 → /pt check
 *    · 1× domain 引用问题 → /pt check
 *    · 1× manifest 警告 → /pt packs
 *  ```
 *  超 maxItems 时追加 `→ /pt check 查看全部`。
 *
 *  v0.3.0 随 pt-cold-start-warning-noise 一起发版。 */
export function formatHealthSummary(
  report: AssetHealthReport,
  opts: FormatHealthSummaryOpts = {}
): string {
  const { maxItems = 6, prefix = "[pt] 诊断：" } = opts;

  if (report.issues.length === 0) return "";

  // 按 (scope, severity) 分组聚合计数
  const groups = new Map<string, { count: number; path: string }>();
  for (const issue of report.issues) {
    // 已知 scope 才走 scope → 路径映射；未知 scope 走 fallback
    const action = SCOPE_TO_ACTION[issue.scope as IssueScope] ?? {
      group: `${issue.scope} 问题`,
      path: "/pt check",
    };
    const key = action.group;
    const existing = groups.get(key);
    if (existing) {
      existing.count++;
    } else {
      groups.set(key, { count: 1, path: action.path });
    }
  }

  // 输出——不阻断语义
  const lines: string[] = [];
  lines.push(`${prefix}${report.issues.length} 项配置问题（不阻断）`);

  const sortedGroups = [...groups.entries()].sort((a, b) => b[1].count - a[1].count);
  const displayed = sortedGroups.slice(0, maxItems);
  for (const [group, { count, path }] of displayed) {
    lines.push(`  · ${count}× ${group} → ${path}`);
  }
  if (sortedGroups.length > maxItems) {
    lines.push(`  → /pt check 查看全部`);
  }
  return lines.join("\n");
}

// ==================== 主入口 ====================

/** 扫描整个项目的资产配置（issue §Layer 2 主入口）。
 *
 * 检测 5 类反模式：
 *   1. missing-modules        ProfileGroup.modules 为空
 *   2. dangling-blueprint-ref profile.blueprint 不存在
 *   3. orphan-h2              ProfileGroup.name 不在 Blueprint.groups
 *   4. empty-segment          compileAgentContext 产出为空段
 *   5. unknown-modname        `### Modules` 项不在 KNOWN_SECTION_NAMES（需重读文件）
 *
 * 参数：
 *   - cwd：项目根目录（unknown-modname 重读 profile 文件需要）
 *   - profiles / blueprints / domains：从 SchemaBundle 取的全集
 *   - adapterCtx：可选。log writer 用于 trace（warn 不走 notify——会刷屏）
 *
 * 调用方：session_start / /pt check / pt_check tool。
 *
 * 不抛错——任何内层异常降级为 log warn + 不阻止结果。体检失败不该阻塞 session 启动。
 */
export async function scanProjectHealth(
  cwd: string,
  profiles: Profile[],
  blueprints: Blueprint[],
  domains: Domain[],
  packs: AssetPack[], // v15.x PR2：compileAgentContext 需要 packs 进 sourceHash
  profilePack: string, // v15.x PR2：scan 时用 default "prj"——不真正读 pack 信息
  // v17.1（issue pt-scan-qualified-ref-pack-blind 完整修复）：
  // scan 需要按 pack 区分 asset 归属（限限定 ref 查找必须 preserve pack identity）.
  // 调用方可从 SchemaBundle.workingSet 直接传，避免 scan 从扁数组 + packs 重建（有信息损失）。
  // 缺省时退回原有行为（从 packs + 属数组构造），供测试场景使用。
  workingSet?: {
    domains?: WorkingSet<Domain>;
    blueprints?: WorkingSet<Blueprint>;
    profiles?: WorkingSet<Profile>;
  },
  adapterCtx?: SourceAdapterContext
): Promise<AssetHealthReport> {
  const issues: AssetHealthIssue[] = [];
  const _domainByName = new Map(domains.map((d) => [d.name, d]));

  // ===== v17+（issue pt-scan-miss-use-chain）：scan 与 transpile 对齐 use 链解析 =====
  // 复现：designer / stardex-dev 类 "完全继承 use" profile，原始 IR groups=[] → 规则 4
  // false-positive 报 empty-segment。transpile 路径（transpile.ts:131）调 expandProfile
  // 把 use 链展平后 modules 填满；scan 路径走 raw profile 故空段。
  // 修复：scan 循环开头对每个 profile 调 expandProfile（与 transpile 同函数同参数），
  //   - 成功 → 用 effectiveProfile（merge 后）跑规则 1/2/3/4/7
  //   - 失败（UseTargetNotFound / UseChainCycle / BlueprintGroupOutOfScope）→ 推
  //     use-expansion-error warning（field="use"）+ skip 该 profile 的后续规则
  //
  // 同时这修复了规则 2（blueprint 可能从 use 继承）与规则 7（optionalDomains 也可能从 use
  // 继承，issue pt-profile-optional-domains §5 决策）的同类问题。

  // v15.x PR3：scanProjectHealth 内部构造 working set（从 profiles/blueprints/domains + packs）
  // scan 默认把 domain/blueprint 归到 prj pack，模拟项目 pack 加载行为。
  // packs 为空时（如测试场景）用 profilePack 作 fallback key，配 mock AssetPack
  const effectivePackName = profilePack || "prj";
  const targetPack = packs.find((p) => p.source === "project") ??
    packs[0] ?? {
      name: effectivePackName,
      version: "0.0.0",
      rootDir: "/test",
      source: "project" as const,
      loadDomains: () => Promise.resolve([]),
      loadBlueprints: () => Promise.resolve([]),
      loadProfiles: () => Promise.resolve([]),
    };
  // v15.x §4.4.2：scan 临时构造双索引 workingSet——location（按位置 alias）+ identity（按 pack.name）
  // scan 场景 targetPack 是 project source → locAlias = "prj"
  // v17.1（issue pt-scan-qualified-ref-pack-blind 完整修复）：
  // 如果调用方传入了 workingSet（如 SchemaBundle.workingSet），直接复用——preserve 每个 asset 的 pack identity。
  // 否则从扁平 domains/blueprints 数组 + targetPack 重建（老路径，测试用——所有 asset 归 project pack）。
  const domainLocWS =
    workingSet?.domains?.location ??
    new Map<string, { pack: typeof targetPack; asset: (typeof domains)[0] }>();
  const domainIdWS =
    workingSet?.domains?.identity ??
    new Map<string, { pack: typeof targetPack; asset: (typeof domains)[0] }>();
  if (!workingSet?.domains) {
    for (const d of domains) {
      domainIdWS.set(`${targetPack.name}/${d.name}`, { pack: targetPack, asset: d });
      domainLocWS.set(`prj/${d.name}`, { pack: targetPack, asset: d });
    }
  }
  const blueprintLocWS =
    workingSet?.blueprints?.location ??
    new Map<string, { pack: typeof targetPack; asset: (typeof blueprints)[0] }>();
  const blueprintIdWS =
    workingSet?.blueprints?.identity ??
    new Map<string, { pack: typeof targetPack; asset: (typeof blueprints)[0] }>();
  if (!workingSet?.blueprints) {
    for (const b of blueprints) {
      blueprintIdWS.set(`${targetPack.name}/${b.name}`, { pack: targetPack, asset: b });
      blueprintLocWS.set(`prj/${b.name}`, { pack: targetPack, asset: b });
    }
  }

  // v17+（issue pt-scan-miss-use-chain）：expandProfile 所需的 profile/blueprint 视图
  // profileByQualifiedName 按 profile.sourcePack/name 索引（v15.x §4.4.2 identity 层）
  // blueprintByQualifiedName 同理——scan 不区分 reserved/settings，全归 effectivePackName
  // 展开失败（UseTargetNotFound）时此索引一致性是 find 的关键
  const profileByQualifiedName = new Map<string, Profile>();
  for (const p of profiles) {
    const packName = p.sourcePack ?? effectivePackName;
    profileByQualifiedName.set(`${packName}/${p.name}`, p);
  }
  const blueprintByQualifiedName =
    workingSet?.blueprints?.identity ??
    new Map<string, { pack: typeof targetPack; asset: (typeof blueprints)[0] }>();
  if (!workingSet?.blueprints) {
    for (const b of blueprints) {
      blueprintByQualifiedName.set(`${effectivePackName}/${b.name}`, {
        pack: targetPack,
        asset: b,
      });
    }
  }

  // ===== 单 profile 循环：展开 → 规则 1/2/3 → 规则 4/7 =====
  for (const profile of profiles) {
    // v17+：先展开 use 链——失败转 use-expansion-error warning + 跳过该 profile
    let effectiveProfile: Profile;
    try {
      effectiveProfile = expandProfile(
        profile,
        profileByQualifiedName,
        blueprintByQualifiedName,
        packs,
        new Set(),
        adapterCtx
      );
    } catch (e) {
      if (
        e instanceof UseTargetNotFound ||
        e instanceof UseChainCycle ||
        e instanceof BlueprintGroupOutOfScope
      ) {
        // use 链错误：使用 profile.name 而非 effectiveProfile.name（展开失败时
        // effectiveProfile 不可用）；field="use" 便于 UI 精确指向。
        issues.push({
          severity: "warning",
          scope: "profile",
          name: profile.name,
          field: "use",
          msg: `Profile「${profile.name}」use 链展开失败：${e.message}`,
          hint: `检查 use 引用（如 @pack/name 拼写）、目标 pack 是否已加载、blueprint slots 是否覆盖展开后的 groups`,
        });
      } else {
        adapterCtx?.log?.debug("scanProjectHealth:expandProfile unexpected", {
          profile: profile.name,
          err: e instanceof Error ? e.message : String(e),
        });
      }
      continue; // 展开失败 → 跳过规则 1/2/3/4/7（避免对未合并 IR 误报）
    }

    // ===== IR-only 规则（1-3）on effectiveProfile =====
    // 2. dangling-blueprint-ref：使用 effectiveProfile.blueprint（use 继承场景下原
    //    profile.blueprint 可能为空，由 useExpanded 提供）
    // v17+（issue pt-scan-qualified-ref-pack-blind）：限定 ref 走 pack-aware 查找
    // （parseRef + blueprintWS 精确匹配）；不限定 ref 走尾段 fallback（按 packNames 顺序）。
    // packAware=false 时退化为纯 name 查找（旧行为，back-compat）。
    const blueprintRef = effectiveProfile.blueprint;
    let blueprintFound: (typeof blueprints)[0] | undefined;
    let blueprintDriftMsg: string | undefined;
    if (blueprintRef.startsWith("@")) {
      try {
        const { kind, pack, name } = parseRef(blueprintRef, "");
        const ws = kind === "location" ? blueprintLocWS : blueprintIdWS;
        const entry = ws.get(`${pack}/${name}`);
        if (entry) {
          blueprintFound = entry.asset;
        } else {
          blueprintDriftMsg = `（限定 pack "${pack}" 中无该 Blueprint——可能是 pack 改名漂移）`;
        }
      } catch {
        // malformed ref — fall through to generic error
      }
    } else {
      // 不限定 ref：尾段 fallback（按 packNames 顺序）
      for (const pack of [
        effectivePackName,
        ...packs.filter((p) => p.name !== effectivePackName).map((p) => p.name),
      ]) {
        const entry = blueprintIdWS.get(`${pack}/${blueprintRef}`);
        if (entry) {
          blueprintFound = entry.asset;
          break;
        }
      }
      if (!blueprintFound) {
        // 退化：纯 name 查找（旧行为，给出更准确的错误）
        blueprintFound = blueprints.find((b) => b.name === blueprintRef);
      }
    }
    if (!blueprintFound) {
      issues.push({
        severity: "error",
        scope: "profile",
        name: effectiveProfile.name,
        field: "blueprint",
        msg: `Profile「${effectiveProfile.name}」引用 Blueprint「${blueprintRef}」不存在${blueprintDriftMsg ?? ""}`,
        hint: blueprintDriftMsg
          ? `检查 pack 是否改名（profile 里的 @pack/name 前缀可能过期）`
          : `检查拼写 / 项目 .pt/assets/blueprints/ 是否漏文件 / 备选内建 blueprint`,
      });
      continue; // 无 Blueprint 引用，下面的 group 检查无意义
    }

    const blueprint = blueprintFound;
    if (!blueprint) continue; // 上一步已 guard（type guard 收窄需要）
    const bpGroupNames = new Set(blueprint.groups.map((g) => g.name));

    for (const group of effectiveProfile.groups) {
      // 3. orphan-h2
      if (!bpGroupNames.has(group.name)) {
        issues.push({
          severity: "warning",
          scope: "profile",
          name: effectiveProfile.name,
          field: `groups.${group.name}`,
          msg: `Profile「${effectiveProfile.name}」的 H2「${group.name}」不在 Blueprint「${blueprint.name}」聚合组中`,
          hint: `删除该 H2，或加到 Blueprint ${blueprint.name} 的 groups 项`,
        });
      }

      // 1. missing-modules
      if (group.modules.length === 0) {
        issues.push({
          severity: "error",
          scope: "profile",
          name: effectiveProfile.name,
          field: `groups.${group.name}.modules`,
          msg: `Profile「${effectiveProfile.name}」聚合组「${group.name}」缺 ### Modules`,
          hint: `在 H2 段下加 \`### Modules\` 列出 modName（段名 Scene/Trigger/Rules/Flows/Checklists/User/Agent 等）`,
          fix: `/pt check --fix ${effectiveProfile.name}`,
        });
      }
    }

    // ===== 规则 4 empty-segment + 规则 7 optional-domain 诊断 on effectiveProfile =====
    // scan 兜底 effectiveProfile.sourcePack（compileAgentContext → resolveDomains 用 unqualified
    // ref 解析依赖 selfPack；测试场景 MdFilePack 未跑所以 sourcePack 未设）。
    // v17+：effectiveProfile 取代原 profileForCompile；spread 仅在缺 sourcePack 时生效，
    // 不修改原 profile（仅本调用范围）。
    const profileForCompile = effectiveProfile.sourcePack
      ? effectiveProfile
      : { ...effectiveProfile, sourcePack: effectivePackName };
    try {
      const ctx = compileAgentContext(profileForCompile, blueprint, domains, packs, profilePack, {
        domains: { location: domainLocWS, identity: domainIdWS },
        blueprints: { location: blueprintLocWS, identity: blueprintIdWS },
        profiles: { location: new Map(), identity: new Map() },
      });
      const totalLen = Object.values(ctx.modules).reduce((acc, s) => acc + s.length, 0);
      if (totalLen === 0) {
        issues.push({
          severity: "error",
          scope: "profile",
          name: effectiveProfile.name,
          msg: `Profile「${effectiveProfile.name}」编译产出全聚合组空字符串`,
          hint: `检查 Profile 的 \`### Modules\` 配置、Blueprint groups 名匹配、Domain H2 段名`,
        });
      }

      // v16+：optional-domain 诊断改为 per-domain 视角（issue pt-optional-domains-no-match-per-domain-aggregation）
      //   规则 6 (optional-domain-unresolved) 完全静默——optional slot 空是设计意图（pack-repair flow 含创建引导）
      //   规则 7 (optional-domain-no-matching-section) 改为 per-domain 聚合——
      //     - 一个 domain 不贡献任一 bpGroup 才 warning 一条
      //     - 部分贡献不警告（已在某 slot 有用即视为有效）
      //     - warning 措辞改 actionable：明确"加载了但没效果"+ 两条处置路径（加 H2 / 删引用）
      // v17+：optionalRefs 取自 effectiveProfile——use 链继承的 optionalDomains 由 mergeProfile 透传
      const optionalRefs = effectiveProfile.optionalDomains ?? [];
      if (optionalRefs.length > 0) {
        const { resolved: optionalResolved } = resolveAndDedupRefs<Domain>(
          optionalRefs,
          profileForCompile,
          { location: domainLocWS, identity: domainIdWS },
          packs.map((p) => p.name),
          { skipOnMissing: true }
        );
        for (const entry of optionalResolved) {
          const d = entry.asset;
          let contributed = false;
          for (const bpGroup of blueprint.groups) {
            // effectiveProfile.groups 已合并——查 inherit 后的 modules 列表
            const profileGroup = effectiveProfile.groups.find((g) => g.name === bpGroup.name);
            const mods = profileGroup?.modules ?? [];
            if (mods.some((m) => d.modules[m.section] !== undefined)) {
              contributed = true;
              break;
            }
          }
          if (!contributed) {
            issues.push({
              severity: "warning",
              scope: "profile",
              name: effectiveProfile.name,
              field: "optional-domains",
              msg: `Profile「${effectiveProfile.name}」的 optional-domain「${entry.rawRef}」已加载但未对任何聚合组产生贡献`,
              hint: `该 domain 加载了但 H2 段不匹配 Profile 的 ### Modules。可选处置：1) 在 ${refName(entry.rawRef)}.md 加匹配段（Scene/User/Trigger/Rules/Flows/Checklists 等）；2) 从 optional-domains 移除该引用`,
            });
          }
        }
        // 规则 6 静默：未解析的 ref 不推 issue（optional slot 空是设计意图）
      }
    } catch (e) {
      adapterCtx?.log?.debug("scanProjectHealth:compile failed", {
        profile: effectiveProfile.name,
        err: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // 5. unknown-modname：重读 profile 文件的 `### Modules` 原始行 vs KNOWN_SECTION_NAMES
  //   原因：parseProfile 已过滤失败 modname（reportWarn 一次）。scan 重读可检测存量项目
  //   未切过的 profile，避免"切一个 warn 一个"的渐进发现。
  for (const profile of profiles) {
    try {
      const rawMods = await readRawModNames(cwd, profile);
      for (const raw of rawMods) {
        if (!isKnownModName(raw)) {
          issues.push({
            severity: "warning",
            scope: "profile",
            name: profile.name,
            field: "groups.*.modules",
            msg: `Profile「${profile.name}」的 modName「${raw}」段名不在已知集合`,
            hint: `检查段名拼写 / KNOWN_SECTION_NAMES：Scene/Trigger/Rules/Flows/Checklists/User/Agent/Participant/Term`,
          });
        }
      }
    } catch (e) {
      adapterCtx?.log?.debug("scanProjectHealth:readRawModNames failed", {
        profile: profile.name,
        err: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // ===== 9. dangling-domain-ref（issue pt-pack-ref-drift-detection 方案 A）=====
  // settings pack（如 @fullstack）独立演进，删 domain 后 prj profile 引用静默悬空。
  // checkAllRefs（verify/ref-check.ts）能查 3 类，但 (1) 悬空 Blueprint + (3a) 聚合组名
  // 不在 Blueprint 已被规则 2/3 覆盖——跳过避免重复 issue。
  // 此处只新增两类：(2) profile.domains 引用悬空 + (3b) profile.groups[X].domains 引用悬空。
  // ref-check 是单一来源；regex 解析其 error 字符串提取 profile/group/domain ref。
  // 警告（未实例化聚合组）不纳入 scan——设计信号，scan 不越界判断。
  // v17（issue pt-scan-qualified-ref-pack-blind）：传 domainWS + packNames 让 checkAllRefs 走 pack-aware 查找
  const loadedPackNames = packs.map((p) => p.name);
  const refCheck = checkAllRefs(profiles, blueprints, domains, {
    domainWS: { location: domainLocWS, identity: domainIdWS },
    packNames: loadedPackNames,
  });
  for (const err of refCheck.errors) {
    // 格式：`Profile "X" 的 domains 引用悬空 Domain "Y"[（限定 pack "Z" 中无该 asset）]`
    // 后缀可选——pack-aware 查找报告 pack 漂移时附带。
    const mGlobal = err.match(
      /^Profile "([^"]+)" 的 domains 引用悬空 Domain "([^"]+)"(?:（限定 pack "([^"]+)" 中无该 asset）)?$/
    );
    if (mGlobal) {
      const profileName = mGlobal[1] ?? "";
      const domainRef = mGlobal[2] ?? "";
      const driftPack = mGlobal[3]; // undefined 或限定 pack 名
      issues.push({
        severity: "error",
        scope: "profile",
        name: profileName,
        field: "domains",
        msg: `Profile「${profileName}」全局 domains 引用悬空 Domain「${domainRef}」${
          driftPack ? `（限定 pack "${driftPack}" 中无该 asset——可能是 pack 改名漂移）` : ""
        }`,
        hint: driftPack
          ? `检查 pack 是否改名（profile 里的 @pack/name 前缀可能过期）`
          : `检查 settings pack 是否仍提供该 domain / 拼写是否正确 / 从 profile.domains 移除该引用`,
      });
      continue;
    }
    // 格式：`Profile "X" 聚合组 "Y" 引用悬空 Domain "Z"[（限定 pack "W" 中无该 asset）]`
    const mGroup = err.match(
      /^Profile "([^"]+)" 聚合组 "([^"]+)" 引用悬空 Domain "([^"]+)"(?:（限定 pack "([^"]+)" 中无该 asset）)?$/
    );
    if (mGroup) {
      const profileName = mGroup[1] ?? "";
      const groupName = mGroup[2] ?? "";
      const domainRef = mGroup[3] ?? "";
      const driftPack = mGroup[4]; // undefined 或限定 pack 名
      issues.push({
        severity: "error",
        scope: "profile",
        name: profileName,
        field: `groups.${groupName}.domains`,
        msg: `Profile「${profileName}」聚合组「${groupName}」引用悬空 Domain「${domainRef}」${
          driftPack ? `（限定 pack "${driftPack}" 中无该 asset——可能是 pack 改名漂移）` : ""
        }`,
        hint: driftPack
          ? `检查 pack 是否改名（profile 里的 @pack/name 前缀可能过期）`
          : `检查 settings pack 是否仍提供该 domain / 拼写是否正确 / 从聚合组 ### Domains 移除该引用`,
      });
    }
    // 其余错误（悬空 Blueprint / 聚合组名不在 Blueprint）已被规则 2/3 覆盖，忽略
  }

  const errors = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.filter((i) => i.severity === "warning").length;
  const infos = issues.filter((i) => i.severity === "info").length;
  adapterCtx?.log?.info("scanProjectHealth:done", {
    profileCount: profiles.length,
    issueCount: issues.length,
    errors,
    warnings,
    infos,
  });
  return { issues, errors, warnings, infos };
}

// ==================== unknown-modname 规则辅助 ====================

/** 重读 profile 文件的 `### Modules` 段原始 modname 列表（unknown-modname 规则专用）。
 *  builtin profile / 文件不存在 → 返空数组（不报错）。 */
async function readRawModNames(cwd: string, profile: Profile): Promise<string[]> {
  const file = join(cwd, PROFILES_DIR, `${profile.name}.profile.md`);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return []; // 文件不存在（builtin profile）跳过
  }
  // 简易 section 切分（不复用 parse/shared 的 splitSections——避免 import 链路拖长）
  const sections = splitSectionsLight(raw);
  const out: string[] = [];
  for (const sec of sections) {
    out.push(...extractModulesListFromRaw(sec));
  }
  return out;
}

/** 按 `## ` 切 H2 段（不计 H1）。空段过滤。 */
function splitSectionsLight(body: string): string[] {
  const lines = body.split(/\r?\n/);
  const out: string[] = [];
  let cur: string[] | null = null;
  for (const line of lines) {
    const h2 = line.match(/^##\s+(.+)$/);
    if (h2) {
      if (cur) out.push(cur.join("\n"));
      cur = [];
    }
    if (cur) cur.push(line);
  }
  if (cur) out.push(cur.join("\n"));
  return out;
}

/** 从段文本取 `### Modules` 下的 `- xxx` 行（裸名，不含 "key: value"）。 */
function extractModulesListFromRaw(sectionRaw: string): string[] {
  const lines = sectionRaw.split(/\r?\n/);
  const out: string[] = [];
  let inModules = false;
  for (const line of lines) {
    const h3 = line.match(/^###\s+(.+)$/);
    if (h3) {
      inModules = h3[1].trim() === "Modules";
      continue;
    }
    if (!inModules) continue;
    const bare = line.match(/^\s*-\s+([^\s:]+)\s*$/);
    if (bare) {
      out.push(bare[1].trim());
      continue;
    }
    // H4 段也终止（子嵌套不展开）
    if (/^#+\s/.test(line)) break;
  }
  return out;
}

/** 判断 modName 字符串是否合法（KNOWN_SECTION_NAMES 段名 + 可选 段.项）。 */
function isKnownModName(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  if (trimmed.includes(".")) {
    const dotIdx = trimmed.indexOf(".");
    const section = trimmed.slice(0, dotIdx);
    const item = trimmed.slice(dotIdx + 1);
    return KNOWN_SECTION_NAMES.has(section) && item.length > 0;
  }
  return KNOWN_SECTION_NAMES.has(trimmed);
}
