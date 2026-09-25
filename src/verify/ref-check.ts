// src/verify/ref-check.ts — Profile→Blueprint→Domain 引用完整性校验
//
// pt 引用图是三层星型（非 OXN Domain→Domain 网状），无环风险。
// 校验重点是完整性：悬空引用检测。
// 不校验 Blueprint.groups[].modules（H2 段名是模块类型声明，非 Domain 引用）。
//
// v11.x：Profile 全局 domains 覆盖是主用例——"未实例化"警告在该模式下静默
//（未实例化 = 走全局分发，无 warning；只有 Profile 完全空 + 聚合组全空时才报 warning）。
//
// v17：可选 pack-aware 查找视图（issue pt-scan-qualified-ref-pack-blind）
//  - 限定 ref（@pack/name）→ parseRef 拆 + 查 WorkingSet 精确匹配
//  - 不限定 ref → 尾段 fallback（按 packNames 顺序，与 compile resolveAndDedupRefs 一致）
//  - 旧签名仍可用（opts 缺省时退化为纯 name 查找，back-compat）

import { type Blueprint, type Domain, type Profile, type WorkingSet, refName } from "../schema.js";
import { parseRef } from "../parse/ref-resolver.js";

export interface RefCheckResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/** pack-aware 查找的可选入参（issue pt-scan-qualified-ref-pack-blind）。
 *  - domainWS：Domain 双索引（限定 ref 精确查；不限定 ref fallback 查 identity 索引）
 *  - packNames：限定 ref fallback 顺序（与 compile 层 resolveAndDedupRefs 的 loadedPackNames 等价）
 *  两者都提供时启用 pack-aware 查找；任一缺省则退化为纯 name 查找（旧行为）。 */
export interface RefCheckOpts {
  domainWS?: WorkingSet<Domain>;
  packNames?: readonly string[];
}

/** Domain ref 是否存在（pack-aware 查找）
 *  - 限定 ref（@pack/name）：查 domainWS 精确匹配（按 parseRef kind 路由 location/identity 索引）
 *  - 不限定 ref：按 packNames 顺序查 identity 索引，找任一命中即返回 true
 *  - opts 缺任一参数时退化为纯 name 查找（旧行为，向后兼容）
 *  - 特殊场景：opts 提供但 packNames 为空（如 scan 测试场景未传 packs）——
 *    退化为纯 name 查找，避免误报全不存在
 *
 * packAware=true 时同时返回 false 的 ref——用于在 error 文案里精确标注 pack 名。 */
function isDomainRefValid(
  ref: string,
  domainNames: Set<string>,
  opts?: RefCheckOpts
): { valid: boolean; packName?: string } {
  const hasWS = !!opts?.domainWS;
  const hasPackNames = !!opts?.packNames && opts.packNames.length > 0;

  if (!hasWS || !hasPackNames) {
    // 旧行为：纯 name 查找（opts 缺省 / packNames 空 都退回）
    return { valid: domainNames.has(refName(ref)) };
  }

  // 类型收窄：opts.domainWS 与 opts.packNames 已确认非空
  const domainWS = opts.domainWS as NonNullable<typeof opts.domainWS>;
  const packNames = opts.packNames as NonNullable<typeof opts.packNames>;

  if (ref.startsWith("@")) {
    // 限定 ref：parseRef 拆 + WorkingSet 精确匹配（限定 ref 不 fallback）
    try {
      const { kind, pack, name } = parseRef(ref, "");
      const ws = kind === "location" ? domainWS.location : domainWS.identity;
      const entry = ws.get(`${pack}/${name}`);
      return entry ? { valid: true } : { valid: false, packName: pack };
    } catch {
      // malformed ref — 让上层报通用错误
      return { valid: false };
    }
  }

  // 不限定 ref：按 packNames 顺序 fallback 查 identity 索引
  for (const pack of packNames) {
    if (domainWS.identity.get(`${pack}/${ref}`)) return { valid: true };
  }
  return { valid: false };
}

/** 校验单个 Profile 的引用完整性。
 *  传入该 Profile 引用的 Blueprint（若存在）+ 全集 Domains。 */
export function checkProfileRefs(
  profile: Profile,
  blueprints: Blueprint[],
  domains: Domain[],
  opts?: RefCheckOpts
): RefCheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const domainNames = new Set(domains.map((d) => d.name));
  const _blueprintNames = new Set(blueprints.map((b) => b.name));

  // 1. Profile → Blueprint 存在性
  const bp = blueprints.find((b) => b.name === profile.blueprint);
  if (!bp) {
    errors.push(`Profile "${profile.name}" 引用的 Blueprint "${profile.blueprint}" 不存在`);
  }

  // 2. Profile → Domain（全局 domains）
  //    v15.x（issue pt-domain-abstraction-and-generic-profiles）：profile.domains 可写
  //    `@fullstack/dev-process` 限定来源 pack。
  //    v17（issue pt-scan-qualified-ref-pack-blind）：限定 ref 走 pack-aware 查找
  //    （parseRef + WorkingSet 精确匹配），不限定 ref 走尾段 fallback。
  for (const dn of profile.domains) {
    const result = isDomainRefValid(dn, domainNames, opts);
    if (!result.valid) {
      const suffix = result.packName ? `（限定 pack "${result.packName}" 中无该 asset）` : "";
      errors.push(`Profile "${profile.name}" 的 domains 引用悬空 Domain "${dn}"${suffix}`);
    }
  }

  // 3. Profile.groups → Domain + 聚合组名匹配
  for (const group of profile.groups) {
    // 3a. 聚合组名应在 Blueprint 里有对应
    if (bp) {
      const bpGroup = bp.groups.find((bg) => bg.name === group.name);
      if (!bpGroup) {
        errors.push(
          `Profile "${profile.name}" 的聚合组 "${group.name}" 在 Blueprint "${bp.name}" 里无对应`
        );
      }
    }

    // 3b. 聚合组引用的 Domain 存在
    for (const dn of group.domains) {
      const result = isDomainRefValid(dn, domainNames, opts);
      if (!result.valid) {
        const suffix = result.packName ? `（限定 pack "${result.packName}" 中无该 asset）` : "";
        errors.push(
          `Profile "${profile.name}" 聚合组 "${group.name}" 引用悬空 Domain "${dn}"${suffix}`
        );
      }
    }
  }

  // 4. 警告：Blueprint 声明了聚合组但 Profile 未实例化（非错误——Profile 可只实例化部分聚合组）
  //    v11.x：Profile 有全局 domains 时，聚合组未 H2 实例化是合法用法（全局分发到所有聚合组），
  //    静默不报。只有 Profile 全空（无全局 domains + 无 H2 实例化）时才报"未实例化" warning。
  if (bp && profile.domains.length === 0) {
    for (const bpGroup of bp.groups) {
      const hasProfileGroup = profile.groups.some((pg) => pg.name === bpGroup.name);
      if (!hasProfileGroup) {
        warnings.push(
          `Blueprint "${bp.name}" 的聚合组 "${bpGroup.name}" 在 Profile "${profile.name}" 里未实例化`
        );
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** 校验所有 Profile 的引用完整性（批量入口）。 */
export function checkAllRefs(
  profiles: Profile[],
  blueprints: Blueprint[],
  domains: Domain[],
  opts?: RefCheckOpts
): RefCheckResult {
  const allErrors: string[] = [];
  const allWarnings: string[] = [];

  for (const profile of profiles) {
    const r = checkProfileRefs(profile, blueprints, domains, opts);
    allErrors.push(...r.errors);
    allWarnings.push(...r.warnings);
  }

  return { ok: allErrors.length === 0, errors: allErrors, warnings: allWarnings };
}

/** 把 RefCheckResult 格式化为人类可读文本（pt_check_refs tool 输出用）。 */
export function formatRefCheckResult(r: RefCheckResult): string {
  const lines: string[] = [];
  if (r.ok && r.warnings.length === 0) {
    lines.push("✓ 引用完整性检查通过，无悬空引用");
    return lines.join("\n");
  }
  if (r.errors.length > 0) {
    lines.push(`✗ ${r.errors.length} 个悬空引用：`);
    for (const e of r.errors) lines.push(`  - ${e}`);
  }
  if (r.warnings.length > 0) {
    lines.push(`⚠ ${r.warnings.length} 个警告：`);
    for (const w of r.warnings) lines.push(`  - ${w}`);
  }
  if (r.ok && r.warnings.length > 0) {
    lines.unshift("✓ 引用完整性检查通过（有警告）");
  }
  return lines.join("\n");
}
