// src/parse/index.ts — Parse 前端入口
//
// Phase 9.3：v9 适配 — 枚举 profiles/（用户面是 Profile，不是 Blueprint）；
//   channels/ 删除（v9 Channel 留作未来 Connector，不实现）。
// 按目录位置分发载体（domains/ → domain adapter / blueprints/ → blueprint adapter / profiles/ → profile adapter）。

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { ASSETS_DIR, BUILTIN_ASSETS_DIR, SUFFIX_BLUEPRINT_YAML, SUFFIX_MD } from "../constants.js";
import type {
  Blueprint,
  Domain,
  Profile,
  SchemaBundle,
  SourceAdapter,
  SourceAdapterContext,
} from "../schema.js";
import { errMsg, reportError, reportWarn } from "../diagnostics.js";
import { findBlueprint, findProfile } from "../schema.js";
import { parseBlueprint } from "./blueprint.js";
import { parseDomain } from "./domain.js";
import { parseProfile } from "./profile.js";

/** 资产根目录（adapterCtx.assetDir 缺失时默认）。 */
const DEFAULT_ASSET_DIR = ASSETS_DIR;

/** MD adapter：按目录位置分发到 domain/blueprint/profile adapter，组装 SchemaBundle。
 *  v9 命名约定：适配的是 MD 文件格式（不再叫 OXN——OXN 是历史名）。 */
export const mdAdapter: SourceAdapter = {
  name: "md",

  async load(cwd, profileName, adapterCtx): Promise<SchemaBundle> {
    // 1. 项目资产 + 内建资产（同名时项目覆盖内建）
    const projectDomains = await loadAllDomains(cwd, adapterCtx);
    const builtinDomains = await loadAllBuiltinDomains();
    const domains = dedupByName(projectDomains, builtinDomains);

    const projectBlueprints = await loadAllBlueprints(cwd, adapterCtx);
    const builtinBlueprints = await loadAllBuiltinBlueprints();
    const blueprints = dedupByName(projectBlueprints, builtinBlueprints);

    const projectProfiles = await loadAllProfiles(cwd, adapterCtx);
    const builtinProfiles = await loadAllBuiltinProfiles();
    const profiles = dedupByName(projectProfiles, builtinProfiles);

    // 4. 找激活的 Profile（按 profileName）
    const active = findProfile(profiles, profileName);
    if (!active) {
      // fallback：取第一个 Profile
      const fallback = profiles[0];
      if (!fallback) {
        throw new Error(`Pt: 未找到 Profile "${profileName}"（profiles/*.profile.md）`);
      }
      return {
        domains,
        blueprints,
        profiles,
        activeProfile: fallback.name,
      };
    }

    // 5. 校验 Profile 引用的 Blueprint 必须存在（明确的错误提示）
    const bp = findBlueprint(blueprints, active.blueprint);
    if (!bp && active.blueprint) {
      // 把"可用 Blueprint 列表"塞进 details，让日志/UI 用户能看到怎么改
      reportWarn(
        adapterCtx,
        `Profile "${active.name}" 引用了未知 Blueprint "${active.blueprint}"`,
        {
          profileName: active.name,
          referencedBlueprint: active.blueprint,
          availableBlueprints: blueprints.map((b) => b.name),
        }
      );
    }

    return {
      domains,
      blueprints,
      profiles,
      activeProfile: active.name,
    };
  },
};

// ==================== 目录枚举辅助 ====================

async function loadAllDomains(cwd: string, adapterCtx?: SourceAdapterContext): Promise<Domain[]> {
  const assetDir = adapterCtx?.assetDir ?? DEFAULT_ASSET_DIR;
  const dir = join(cwd, assetDir, "domains");
  return loadDomainsRecursive(dir, adapterCtx);
}

/** 递归加载 domains/ 下所有 .md（v9.1+ 多级目录支持）。
 *  Node.js 20+ readdir({ recursive: true }) 跨平台统一返回 POSIX '/' 分隔路径。
 *  Domain.name = POSIX 相对路径去 .md（支持 "meta/login" / "workflow/dev-workflow" 等多级命名）。
 *  Blueprint/Profile 不递归——只加载顶层（避免破坏现有结构）。 */
async function loadDomainsRecursive(
  dir: string,
  adapterCtx?: SourceAdapterContext
): Promise<Domain[]> {
  let files: string[];
  try {
    // recursive: true 返回 POSIX 相对路径（Windows 也用 '/'）
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

async function loadAllBlueprints(
  cwd: string,
  adapterCtx?: SourceAdapterContext
): Promise<Blueprint[]> {
  const assetDir = adapterCtx?.assetDir ?? DEFAULT_ASSET_DIR;
  const dir = join(cwd, assetDir, "blueprints");
  // Phase term-P4.5：Blueprint 载体 .md → .yaml，按 SUFFIX_BLUEPRINT_YAML 过滤
  return loadDir(dir, SUFFIX_BLUEPRINT_YAML, (f) => parseBlueprint(dir, f), adapterCtx);
}

async function loadAllProfiles(cwd: string, adapterCtx?: SourceAdapterContext): Promise<Profile[]> {
  const assetDir = adapterCtx?.assetDir ?? DEFAULT_ASSET_DIR;
  const dir = join(cwd, assetDir, "profiles");
  return loadDir(dir, SUFFIX_MD, (f) => parseProfile(dir, f, adapterCtx), adapterCtx);
}

// ==================== 内建资产加载（src/builtin/assets/，随包发布） ====================

async function loadAllBuiltinDomains(): Promise<Domain[]> {
  const dir = join(BUILTIN_ASSETS_DIR, "domains");
  return loadDir(dir, SUFFIX_MD, (f) => parseDomain(dir, f), undefined);
}

async function loadAllBuiltinBlueprints(): Promise<Blueprint[]> {
  const dir = join(BUILTIN_ASSETS_DIR, "blueprints");
  // Phase term-P4.5：Blueprint 载体 .md → .yaml
  return loadDir(dir, SUFFIX_BLUEPRINT_YAML, (f) => parseBlueprint(dir, f), undefined);
}

async function loadAllBuiltinProfiles(): Promise<Profile[]> {
  const dir = join(BUILTIN_ASSETS_DIR, "profiles");
  return loadDir(dir, SUFFIX_MD, (f) => parseProfile(dir, f), undefined);
}

/** 合并两源资产：项目优先，内建补充（同名时项目覆盖内建）。 */
function dedupByName<T extends { name: string }>(project: T[], builtin: T[]): T[] {
  const projectNames = new Set(project.map((x) => x.name));
  return [...project, ...builtin.filter((x) => !projectNames.has(x.name))];
}

async function loadDir<T>(
  dir: string,
  suffix: string,
  parser: (f: string) => Promise<T>,
  adapterCtx?: SourceAdapterContext
): Promise<T[]> {
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(suffix));
  } catch {
    return []; // 目录不存在返空（profiles/ 在 9.3 前可能尚未建立）
  }
  const results: Array<T | null> = await Promise.all(
    files.map(async (f): Promise<T | null> => {
      try {
        return await parser(f);
      } catch (e) {
        // 错误通过 notify 回调上抛，index.ts 调 ctx.ui.notify（pt-quality #9）
        reportError(adapterCtx, `parse ${dir}/${f} failed: ${errMsg(e)}`, { file: f });
        return null;
      }
    })
  );
  return results.filter((r): r is T => r !== null);
}
