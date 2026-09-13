// src/asset-pack/loader.ts — Pack 构造工厂（v15.x PR1）
//
// 设计源：.pt/docs/designs/pt-asset-pack.md §3.1（加载顺序）/ §6.4（全局 Pack）/ §6.5（project-pack-dir）
//
// 职责：把"目录路径 + 来源类型"封装成 AssetPack 实例（PR1 走 MdFilePack）。
// mdAdapter.load 调用这些函数构造 4 类 pack 数组。
//
// PR1 范围：
//   - reserved pack（project/global/builtin）name 固定（"prj"/"gbl"/"pt"）——跳过 basename
//   - project pack 路径走 adapterCtx.assetDir / 默认 ASSETS_DIR（PR4 接通 pt.project-pack-dir 后改读 settings）
//   - global pack 路径走 adapterCtx.globalPackDir / env / 默认 ~/.pt/assets
//   - settings pack 加载 stub：loadSettingsPacks() 返空数组（PR4 接通 .pi/settings.json pt.asset-packs）
//   - directory 不存在不报错——tryLoadPack 内部不预加载，loadXxx 返空数组（"空 Pack" 等价）
//
// 不做的：manifest 解析（PR2）、@pack/name 限定语法（PR3）、settings 加载（PR4）。

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { ASSETS_DIR, BUILTIN_ASSETS_DIR } from "../constants.js";
import { readProjectSetting } from "../config.js";
import type { AssetPack, PackSource, SourceAdapterContext } from "../schema.js";
import { MdFilePack } from "./md-file-pack.js";

/** v15.x PR4（§6.2）：路径解析——支持 ~ / 绝对 / 相对 cwd。
 *  ~ 开头 → home dir（join 后自然处理 ~user/foo / ~/foo / ~foo）；绝对路径原样；相对路径 resolve(cwd, raw)。 */
export function resolvePackPath(raw: string, cwd: string): string {
  if (raw.startsWith("~")) {
    return join(homedir(), raw.slice(1));
  }
  if (isAbsolute(raw)) {
    return raw;
  }
  return resolve(cwd, raw);
}

/** 全局 Pack 默认路径（§6.4）。优先级：adapterCtx.globalPackDir > env > 默认 ~/.pt/assets。
 *  返回值永远是绝对路径或可被 resolve 的相对路径。 */
export function getGlobalPackDir(adapterCtx?: SourceAdapterContext): string {
  return (
    adapterCtx?.globalPackDir ?? process.env.PT_GLOBAL_PACK_DIR ?? join(homedir(), ".pt", "assets")
  );
}

/**
 * 尝试加载 pack：目录不存在返空 Pack（不报错，§6.4）。
 * reserved pack（project/global/builtin）用固定 name，跳过 basename 与 manifest。
 *
 * 不预加载——目录不存在时 loadDomains() 等返空数组，与"空 Pack"等价。
 * 这样调用方可以无差别调 loadXxx，不用关心目录是否存在。
 *
 * PR2：构造从 sync 改 async——走 MdFilePack.create 读 manifest。
 * adapterCtx 透传给 MdFilePack：parse 失败时调 reportError 上抛（PR1 补丁 S2）。
 */
export async function tryLoadPack(
  rootDir: string,
  reservedName: string | undefined,
  source: PackSource,
  adapterCtx?: SourceAdapterContext
): Promise<AssetPack> {
  return MdFilePack.create({ rootDir, source, reservedName, adapterCtx });
}

/** 构造 project pack（§6.5：路径可配，默认 .pt/assets）。
 *  v15.x PR4：优先读 settings 的 pt.project-pack-dir，fallback adapterCtx.assetDir / ASSETS_DIR。
 *  project pack 身份固定 "prj"（reservedName），与路径解耦（§6.5 核心价值）。
 *  指向项目外路径合法（../shared / 绝对），文档提示慎用。 */
export async function loadProjectPack(
  cwd: string,
  adapterCtx?: SourceAdapterContext
): Promise<AssetPack> {
  // 优先级：pt.project-pack-dir > adapterCtx.assetDir > ASSETS_DIR（默认 .pt/assets）
  const configured = await readProjectSetting<string>(cwd, "pt.project-pack-dir");
  const rawDir = configured ?? adapterCtx?.assetDir ?? ASSETS_DIR;
  const dir = resolvePackPath(rawDir, cwd);
  return tryLoadPack(dir, "prj", "project", adapterCtx);
}

/** 构造 global pack（§6.4）。 */
export async function loadGlobalPack(adapterCtx?: SourceAdapterContext): Promise<AssetPack> {
  return tryLoadPack(getGlobalPackDir(adapterCtx), "gbl", "global", adapterCtx);
}

/** 构造 builtin pack（src/builtin/assets/，随 npm 包发布）。 */
export async function loadBuiltinPack(adapterCtx?: SourceAdapterContext): Promise<AssetPack> {
  return tryLoadPack(BUILTIN_ASSETS_DIR, "pt", "builtin", adapterCtx);
}

/** v15.x PR4（§6.1 + §6.3）：settings pack 加载。
 *  读 .pi/settings.json 的 pt.asset-packs[]（只 path 字段，§6.2 单一事实源），构造 AssetPack[]。
 *  - pack name 从 manifest 读（MdFilePack.create 内部走 PR2 逻辑）
 *  - 路径解析 resolvePackPath（~ / 绝对 / 相对 cwd）
 *  - path 无效 / 目录不存在 / parse 失败 → 跳过该 pack（§6.7.5 不阻断）
 *  - 返回顺序 = settings 声明顺序（mdAdapter.load 负责 .reverse() 实现后者赢） */
export async function loadSettingsPacks(cwd: string): Promise<AssetPack[]> {
  const entries = await readProjectSetting<Array<{ path?: unknown }>>(cwd, "pt.asset-packs");
  if (!Array.isArray(entries) || entries.length === 0) {
    return [];
  }

  const packs: AssetPack[] = [];
  for (const entry of entries) {
    // 只 path 字段——name 从 manifest 读（§6.2 单一事实源）
    if (!entry || typeof entry.path !== "string" || !entry.path.trim()) {
      // 无效条目跳过（loader 不调 ui，预警由 session_start 的 validatePack 兜底）
      continue;
    }
    const rootDir = resolvePackPath(entry.path.trim(), cwd);
    try {
      // reservedName=undefined：settings pack 走 manifest 读 name（PR2 逻辑）
      const pack = await tryLoadPack(rootDir, undefined, "settings");
      packs.push(pack);
    } catch {
      // MdFilePack.create 内部已容错，catch 仅防御意外抛错——不阻断其他 pack
    }
  }
  return packs;
}

/**
 * 调试 / 测试用：判断给定路径是否"看起来像 Pack"——是目录 + 至少含一个 asset 子目录。
 * PR1 阶段主要用于测试断言，prod 路径不调。
 */
export function looksLikePackDir(rootDir: string): boolean {
  if (!existsSync(rootDir)) return false;
  return (
    existsSync(join(rootDir, "domains")) ||
    existsSync(join(rootDir, "blueprints")) ||
    existsSync(join(rootDir, "profiles"))
  );
}

/**
 * v15.x PR1（§6.7.3）：project pack 降级时强制覆盖 profileName 为 "guide"。
 * 抽为 pure helper 便于单元测试——transpileActive 调一下，逻辑集中。
 * back-compat：degraded=false 或 requested="guide" 时返 requested 原值。
 */
export function applyProjectPackDegrade(projectPackDegraded: boolean, requested: string): string {
  if (projectPackDegraded && requested !== "guide") return "guide";
  return requested;
}
