// src/asset-pack/md-file-pack.ts — AssetPack 的文件系统实现（v15.x PR1）
//
// 设计源：.pt/docs/designs/pt-asset-pack.md §2.3（MdFilePack）
//
// 与 src/parse/{domain,blueprint,profile}.ts 现有 parser 复用，不重写 parse 算法。
// AssetPack 只是把"目录"封装成可命名、可版本化的单元。
//
// PR1 简化（按 PR1.2 + PR1.6 文档）：
//   - name 由构造传入（reserved 固定名 "prj"/"gbl"/"pt"，PR4 接通后 settings pack 走 basename 兜底）
//   - version / description 固定占位（PR2 接通 manifest 后从 manifest 读）
//   - loadXxx 内 parse 失败的文件返 null 后 filter 掉——**不**调 reportWarn/reportError
//     （那些是 adapterCtx 依赖；PR1 的 MdFilePack 内部错误由 validatePack 层捕获，见 PR1.6）
//   - loadXxx 不接 adapterCtx 参数（AssetPack interface 不暴露）——
//     parseProfile 内 modName 解析失败的 warn 通道在本 PR 阶段丢失（已知 PR1 简化，
//     不影响 pack 加载本身；后续 PR 可选把 adapterCtx 透传回 parseProfile）

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { SUFFIX_BLUEPRINT_YAML, SUFFIX_MD } from "../constants.js";
import type { AssetPack, Blueprint, Domain, PackSource, Profile } from "../schema.js";
import { parseBlueprint } from "../parse/blueprint.js";
import { parseDomain } from "../parse/domain.js";
import { parseProfile } from "../parse/profile.js";

/**
 * v15.x PR1：文件系统 Pack 实现——读 <rootDir>/{domains,blueprints,profiles}/。
 * 与 src/parse/{domain,blueprint,profile}.ts 现有 parser 共用，不重写 parse 算法。
 *
 * PR1 简化：name 由构造传入（reserved 固定名或 basename），不读 manifest。
 *           PR2 接通 manifest 后改为从 manifest 读 name/version/description。
 */
export class MdFilePack implements AssetPack {
  readonly name: string;
  readonly version = "0.0.0"; // PR1 固定；PR2 从 manifest 读
  readonly rootDir: string;
  readonly description: undefined; // PR1 固定；PR2 从 manifest 读
  readonly source: PackSource;

  constructor(rootDir: string, name: string, source: PackSource) {
    this.rootDir = rootDir;
    this.name = name;
    this.source = source;
  }

  async loadDomains(): Promise<Domain[]> {
    const dir = join(this.rootDir, "domains");
    return loadDomainsRecursive(dir);
  }

  async loadBlueprints(): Promise<Blueprint[]> {
    const dir = join(this.rootDir, "blueprints");
    return loadDir(dir, SUFFIX_BLUEPRINT_YAML, (f) => parseBlueprint(dir, f));
  }

  async loadProfiles(): Promise<Profile[]> {
    const dir = join(this.rootDir, "profiles");
    return loadDir(dir, SUFFIX_MD, (f) => parseProfile(dir, f));
  }
}

// ==================== 共享加载辅助（PR1 内部，未来抽到独立模块） ====================

/** 顶层目录加载：只扫顶层文件（Blueprint/Profile 不递归——避免破坏现有结构）。
 *  parse 失败的文件返 null 后 filter 掉。目录不存在返空数组（与现有 loadDir 行为一致）。 */
async function loadDir<T>(
  dir: string,
  suffix: string,
  parser: (f: string) => Promise<T>
): Promise<T[]> {
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(suffix));
  } catch {
    return []; // 目录不存在返空
  }
  const results: Array<T | null> = await Promise.all(
    files.map(async (f): Promise<T | null> => {
      try {
        return await parser(f);
      } catch {
        // PR1 简化：不调 reportWarn/reportError，由 validatePack 层统一兜底（PR1.6）。
        return null;
      }
    })
  );
  return results.filter((r): r is T => r !== null);
}

/** 递归加载 domains/ 下所有 .md（多级目录支持）。
 *  Node.js 20+ readdir({ recursive: true }) 跨平台统一返回 POSIX '/' 分隔路径。
 *  Domain.name = POSIX 相对路径去 .md（支持 "workflow/dev-workflow" 等多级命名）。
 *  parse 失败的文件 filter 掉——不调 reportWarn（PR1.6 validatePack 兜底）。 */
async function loadDomainsRecursive(dir: string): Promise<Domain[]> {
  let files: string[];
  try {
    files = (await readdir(dir, { recursive: true })).filter((f) => f.endsWith(SUFFIX_MD));
  } catch {
    return []; // 目录不存在返空
  }
  const results: Array<Domain | null> = await Promise.all(
    files.map(async (relPath) => {
      try {
        return await parseDomain(dir, relPath);
      } catch {
        return null;
      }
    })
  );
  return results.filter((r): r is Domain => !!r);
}
