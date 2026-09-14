// src/asset-pack/validate.ts — Pack 校验（v15.x PR1）
//
// 设计源：.pt/docs/designs/pt-asset-pack.md §6.7.2（两层校验）/ §6.7.7（不抛异常）
//
// 关键纪律：validatePack 永远返结果对象，不抛异常——失败不阻断加载链。
// 错误收集到 errors[] / warnings[]，返 ok: boolean。
//
// 层 1（pack 结构）：rootDir 存在 + 至少一个 asset 子目录
// 层 2（asset 解析）：loadDomains/loadBlueprints/loadProfiles 不抛即过
//
// PR1 简化：
//   - 不做 manifest 校验（PR2）
//   - 不做 pack 内同 name asset 冲突检测（PR2 与 manifest 校验一起做）
//   - 不做 settings pack 之间冲突报错（PR4 接通 settings 加载时一起做）

import { existsSync } from "node:fs";
import { join } from "node:path";
import { errMsg } from "../diagnostics.js";
import type { AssetPack } from "../schema.js";

/** v15.x §2.4.4（位置 alias 表）：reserved pack 的位置别名。reserved pack 才有，非 reserved 为 undefined。
 *  UI 显示层用——reserved 显位置别名，settings 显 pack 名（§4.4.4 双层语义）。 */
const RESERVED_ALIAS: ReadonlyMap<AssetPack["source"], "prj" | "gbl" | "pt"> = new Map([
  ["project", "prj"],
  ["global", "gbl"],
  ["builtin", "pt"],
]);

/** 校验结果（§6.7.7）。validatePack 永远返结果对象，不抛异常。 */
export interface ValidationResult {
  /** Pack 名（来源 pack.name——manifest.name 或退化别名） */
  pack: string;
  /** Pack 来源类型 */
  source: AssetPack["source"];
  /** v15.x §4.4.4（缺口 4）：reserved pack 的位置别名（prj/gbl/pt），非 reserved 为 undefined。
   *  UI 显示层用——reserved 显位置别名，settings 显 pack 名。 */
  reservedAlias?: "prj" | "gbl" | "pt";
  /** 整体是否可用 */
  ok: boolean;
  /** 致命问题（pack 不可用） */
  errors: PackIssue[];
  /** 非致命（pack 可用但有隐患——目前未使用，预留扩展） */
  warnings: PackIssue[];
  /** v15.x PR2（§6.7.6 展示用）：pack version。 */
  version: string;
  /** v15.x PR2（§6.7.6 展示用）：pack description（可选）。 */
  description?: string;
  /** v15.x PR2（§6.7.6 展示用）：pack rootDir。 */
  rootDir: string;
}

/** 单条校验问题。code 机器可读，msg 人类可读，hint 修复建议。 */
export interface PackIssue {
  /** 机器可读错误码（如 "dir-not-found"） */
  code: string;
  /** 人类可读 */
  msg: string;
  /** 修复建议（可选） */
  hint?: string;
}

/**
 * 两层校验（§6.7.2）：
 *   层 1 pack 结构：rootDir 存在 + 至少一个 asset 子目录
 *   层 2 asset 解析：loadDomains/loadBlueprints/loadProfiles 不抛即过
 *     （parse 失败的文件已在 MdFilePack 内部 filter 掉，不阻断 pack 加载）
 *
 * 永远返结果对象，不抛异常（§6.7.7）——失败不阻断加载链。
 */
export async function validatePack(pack: AssetPack): Promise<ValidationResult> {
  const errors: PackIssue[] = [];
  const warnings: PackIssue[] = [];

  // 层 1：pack 结构——目录存在
  if (!existsSync(pack.rootDir)) {
    errors.push({
      code: "dir-not-found",
      msg: `pack 目录不存在: ${pack.rootDir}`,
      hint: "检查路径配置，或创建该目录（参考 /manual:pack-repair）",
    });
    return {
      pack: pack.name,
      source: pack.source,
      reservedAlias: RESERVED_ALIAS.get(pack.source),
      ok: false,
      errors,
      warnings,
      version: pack.version,
      rootDir: pack.rootDir,
    };
  }

  // 层 1：pack 结构——至少一个 asset 子目录
  const hasDomains = existsSync(join(pack.rootDir, "domains"));
  const hasBlueprints = existsSync(join(pack.rootDir, "blueprints"));
  const hasProfiles = existsSync(join(pack.rootDir, "profiles"));
  if (!hasDomains && !hasBlueprints && !hasProfiles) {
    errors.push({
      code: "no-asset-subdir",
      msg: `pack "${pack.name}" 无任何 asset 子目录（domains/blueprints/profiles）`,
      hint: "至少创建一个 asset 子目录（参考 /manual:pack-repair）",
    });
    return {
      pack: pack.name,
      source: pack.source,
      reservedAlias: RESERVED_ALIAS.get(pack.source),
      ok: false,
      errors,
      warnings,
      version: pack.version,
      rootDir: pack.rootDir,
    };
  }

  // 层 2：asset 解析 + pack 内一致性（§6.7.2 补全）
  try {
    const domains = await pack.loadDomains();
    const blueprints = await pack.loadBlueprints();
    const profiles = await pack.loadProfiles();
    // v15.x PR2（§6.7.2 层 2）：同 Pack 内同 name asset 冲突检测
    checkIntraPackConflicts("domain", domains, errors);
    checkIntraPackConflicts("blueprint", blueprints, errors);
    checkIntraPackConflicts("profile", profiles, errors);
  } catch (e) {
    errors.push({
      code: "load-failed",
      msg: `pack "${pack.name}" 加载失败: ${errMsg(e)}`,
      hint: "检查资产文件格式（参考 /manual:pack-repair）",
    });
  }

  // pack 内一致性（同 name asset 冲突）—— v15.x PR2 在层 2 已做（checkIntraPackConflicts）

  return {
    pack: pack.name,
    source: pack.source,
    reservedAlias: RESERVED_ALIAS.get(pack.source),
    ok: errors.length === 0,
    errors,
    warnings,
    version: pack.version,
    description: pack.description,
    rootDir: pack.rootDir,
  };
}

/** v15.x PR2（§6.7.2 层 2）：同 Pack 内同 name asset 冲突检测。
 *  重复 name 报错——同 Pack 内 asset name 必须唯一。
 *  不检测跨 Pack 冲突（那是 dedupByNameN 的职责，前者赢）。 */
function checkIntraPackConflicts<T extends { name: string }>(
  kind: string,
  assets: T[],
  errors: PackIssue[]
): void {
  const seen = new Map<string, number>();
  for (const a of assets) {
    const count = seen.get(a.name) ?? 0;
    if (count > 0) {
      errors.push({
        code: "intra-pack-conflict",
        msg: `pack 内 ${kind} "${a.name}" 重复（${count + 1} 次）`,
        hint: `同 Pack 内 ${kind} name 必须唯一——重命名或删除重复文件`,
      });
    }
    seen.set(a.name, count + 1);
  }
}

/**
 * v15.x PR1（§7.5 + §7.5.1）：判断是否该弹全局 Pack 初始化引导。
 * pure helper——抽出来让 session_start handler 简洁，也便于单元测试。
 *
 * 约束：TTY + 目录不存在 + 首次（每个 session 只提示一次）+ 非 CI + 非 PT_NO_GUIDE 禁用。
 * 调用方负责检查 isFirstRun（读 session state.globalPackGuideShown）和传 env。
 */
export function shouldPromptGlobalPackGuide(args: {
  isTTY: boolean;
  globalPackExists: boolean;
  isFirstRun: boolean;
  isCi: boolean;
  guideDisabled: boolean;
}): boolean {
  return (
    args.isTTY && !args.globalPackExists && args.isFirstRun && !args.isCi && !args.guideDisabled
  );
}
