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

import { basename as pathBasename } from "node:path";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { SUFFIX_BLUEPRINT_YAML, SUFFIX_MD } from "../constants.js";
import { errMsg, reportError } from "../diagnostics.js";
import type {
  AssetPack,
  Blueprint,
  Domain,
  PackSource,
  Profile,
  SourceAdapterContext,
} from "../schema.js";
import { parseBlueprint } from "../parse/blueprint.js";
import { parseDomain } from "../parse/domain.js";
import { parseProfile } from "../parse/profile.js";
import { parseManifest } from "./manifest.js";

/**
 * v15.x PR2：文件系统 Pack 实现——读 <rootDir>/{domains,blueprints,profiles}/。
 * 与 src/parse/{domain,blueprint,profile}.ts 现有 parser 共用，不重写 parse 算法。
 *
 * PR2：构造从 sync 改 async（读 manifest），走 `MdFilePack.create()` 工厂方法。
 * name 解析优先级（§2.4.2）：
 *   - reserved pack（source=project/global/builtin）→ 固定名 prj/gbl/pt，跳过 manifest
 *   - 显式 pack + 合法 manifest.name → manifest.name
 *   - 隐式 pack（无 manifest / manifest 无 name / name 校验失败）→ basename 兜底
 *
 * PR1 补丁（S2 修复）：构造可选接 adapterCtx——loadXxx 内部 parse 失败时调
 *           reportError，恢复 v10.x 旧 loadDir 行为的"错误可见性"。未传则 fallback
 *           console.error（diagnostics.ts:reportError 三通道 fallback）。
 */
export class MdFilePack implements AssetPack {
  readonly name: string;
  readonly version: string; // PR2：从 manifest 读（缺失则 "0.0.0"）
  readonly rootDir: string;
  readonly description: string | undefined; // PR2：从 manifest 读（缺失则 undefined）
  readonly source: PackSource;
  /** adapterCtx 可选——parse 失败时调 reportError 走 notify + log 通道。 */
  private readonly adapterCtx: SourceAdapterContext | undefined;

  private constructor(args: {
    rootDir: string;
    name: string;
    version: string;
    description?: string;
    source: PackSource;
    adapterCtx?: SourceAdapterContext;
  }) {
    this.rootDir = args.rootDir;
    this.name = args.name;
    this.version = args.version;
    this.description = args.description;
    this.source = args.source;
    this.adapterCtx = args.adapterCtx;
  }

  /** 位置别名退化表（v15.x §2.4.2 缺口 1-b）：reserved pack 无 manifest 时 name 退化到位置别名。
   *  用途：back-compat——今天无 manifest 的项目 pack.name 仍是 prj/gbl/pt，行为等价。 */
  private static readonly RESERVED_FALLBACK_NAME: ReadonlyMap<PackSource, string> = new Map([
    ["project", "prj"],
    ["global", "gbl"],
    ["builtin", "pt"],
  ]);

  /** PR2（v15.x §2.4.2 双层语义）：工厂方法（async，读 manifest）。
   *  所有 pack 都走 manifest 解析；reserved pack 无 manifest 时 name 退化到位置别名（back-compat）。
   *  - manifest.name 优先（身份 alias）
   *  - reserved pack 无 manifest → 退化到 RESERVED_FALLBACK_NAME.get(source)
   *  - 非 reserved pack 无 manifest → basename 兜底 */
  static async create(args: {
    rootDir: string;
    source: PackSource;
    adapterCtx?: SourceAdapterContext;
  }): Promise<MdFilePack> {
    const manifest = await parseManifest(args.rootDir);
    const dirName = pathBasename(args.rootDir);

    // manifest warnings 上抛 notify（不阻断——parseManifest 已容错）
    if (manifest.warnings.length > 0 && args.adapterCtx?.notify) {
      args.adapterCtx.notify(
        `Pt: pack "${dirName}" manifest 警告：${manifest.warnings.join("; ")}`,
        "warning"
      );
    }

    // name 解析优先级（§2.4.2）：
    //   1. manifest.name（身份 alias 优先）
    //   2. reserved pack 无 manifest → 退化到位置别名（prj/gbl/pt，back-compat）
    //   3. 非 reserved 无 manifest → basename 兜底
    const fallbackName = MdFilePack.RESERVED_FALLBACK_NAME.get(args.source) ?? dirName;
    const name = manifest.name ?? fallbackName;

    return new MdFilePack({
      rootDir: args.rootDir,
      name,
      version: manifest.version ?? "0.0.0",
      description: manifest.description,
      source: args.source,
      adapterCtx: args.adapterCtx,
    });
  }

  async loadDomains(): Promise<Domain[]> {
    const dir = join(this.rootDir, "domains");
    return loadDomainsRecursive(dir, this.adapterCtx);
  }

  async loadBlueprints(): Promise<Blueprint[]> {
    const dir = join(this.rootDir, "blueprints");
    return loadDir(dir, SUFFIX_BLUEPRINT_YAML, (f) => parseBlueprint(dir, f), this.adapterCtx);
  }

  async loadProfiles(): Promise<Profile[]> {
    const dir = join(this.rootDir, "profiles");
    const profiles = await loadDir(
      dir,
      SUFFIX_MD,
      (f) => parseProfile(dir, f, this.adapterCtx),
      this.adapterCtx
    );
    // v15.x PR3（§4.4.1）：MdFilePack 加载时给每个 Profile 打上 sourcePack——parseRef 不限定 ref 自动绑定用。
    for (const p of profiles) {
      p.sourcePack = this.name;
    }
    return profiles;
  }
}

// ==================== 共享加载辅助（PR1 内部，未来抽到独立模块） ====================

/** 顶层目录加载：只扫顶层文件（Blueprint/Profile 不递归——避免破坏现有结构）。
 *  parse 失败的文件：调 reportError 上抛 notify + log（恢复 v10.x 旧 loadDir 行为，
 *  PR1 补丁 S2 修复），未传 adapterCtx 时 fallback console.error。
 *  目录不存在返空数组（与现有 loadDir 行为一致）。 */
async function loadDir<T>(
  dir: string,
  suffix: string,
  parser: (f: string) => Promise<T>,
  adapterCtx: SourceAdapterContext | undefined
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
      } catch (e) {
        reportError(adapterCtx, `parse ${dir}/${f} failed: ${errMsg(e)}`, { file: f });
        return null;
      }
    })
  );
  return results.filter((r): r is T => r !== null);
}

/** 递归加载 domains/ 下所有 .md（多级目录支持）。
 *  Node.js 20+ readdir({ recursive: true }) 跨平台统一返回 POSIX '/' 分隔路径。
 *  Domain.name = POSIX 相对路径去 .md（支持 "workflow/dev-workflow" 等多级命名）。
 *  parse 失败的文件：调 reportError 上抛（PR1 补丁 S2）。 */
async function loadDomainsRecursive(
  dir: string,
  adapterCtx: SourceAdapterContext | undefined
): Promise<Domain[]> {
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
      } catch (e) {
        reportError(adapterCtx, `parse ${dir}/${relPath} failed: ${errMsg(e)}`, { file: relPath });
        return null;
      }
    })
  );
  return results.filter((r): r is Domain => !!r);
}
