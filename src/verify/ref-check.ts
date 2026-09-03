// src/verify/ref-check.ts — Profile→Blueprint→Domain 引用完整性校验
//
// pt 引用图是三层星型（非 OXN Domain→Domain 网状），无环风险。
// 校验重点是完整性：悬空引用检测。
// 不校验 Blueprint.injectionPoints[].modules（H2 段名是模块类型声明，非 Domain 引用）。

import type { Blueprint, Domain, Profile } from "../schema.js";

export interface RefCheckResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/** 校验单个 Profile 的引用完整性。
 *  传入该 Profile 引用的 Blueprint（若存在）+ 全集 Domains。 */
export function checkProfileRefs(
  profile: Profile,
  blueprints: Blueprint[],
  domains: Domain[],
): RefCheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const domainNames = new Set(domains.map((d) => d.name));
  const blueprintNames = new Set(blueprints.map((b) => b.name));

  // 1. Profile → Blueprint 存在性
  const bp = blueprints.find((b) => b.name === profile.blueprint);
  if (!bp) {
    errors.push(`Profile "${profile.name}" 引用的 Blueprint "${profile.blueprint}" 不存在`);
  }

  // 2. Profile → Domain（全局 domains）
  for (const dn of profile.domains) {
    if (!domainNames.has(dn)) {
      errors.push(`Profile "${profile.name}" 的 domains 引用悬空 Domain "${dn}"`);
    }
  }

  // 3. Profile.injectionPoints → Domain + 注入点名匹配
  for (const ip of profile.injectionPoints) {
    // 3a. 注入点名应在 Blueprint 里有对应
    if (bp) {
      const bpIp = bp.injectionPoints.find((bip) => bip.name === ip.name);
      if (!bpIp) {
        errors.push(`Profile "${profile.name}" 的注入点 "${ip.name}" 在 Blueprint "${bp.name}" 里无对应`);
      }
    }

    // 3b. 注入点引用的 Domain 存在
    for (const dn of ip.domains) {
      if (!domainNames.has(dn)) {
        errors.push(`Profile "${profile.name}" 注入点 "${ip.name}" 引用悬空 Domain "${dn}"`);
      }
    }
  }

  // 4. 警告：Blueprint 声明了注入点但 Profile 未实例化（非错误——Profile 可只实例化部分注入点）
  if (bp) {
    for (const bpIp of bp.injectionPoints) {
      const hasProfileIp = profile.injectionPoints.some((pip) => pip.name === bpIp.name);
      if (!hasProfileIp) {
        warnings.push(`Blueprint "${bp.name}" 的注入点 "${bpIp.name}" 在 Profile "${profile.name}" 里未实例化`);
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
): RefCheckResult {
  const allErrors: string[] = [];
  const allWarnings: string[] = [];

  for (const profile of profiles) {
    const r = checkProfileRefs(profile, blueprints, domains);
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
