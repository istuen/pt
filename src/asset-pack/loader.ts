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
import { join, resolve } from "node:path";
import { ASSETS_DIR, BUILTIN_ASSETS_DIR } from "../constants.js";
import type { AssetPack, PackSource, SourceAdapterContext } from "../schema.js";
import { MdFilePack } from "./md-file-pack.js";

/** 全局 Pack 默认路径（§6.4）。优先级：adapterCtx.globalPackDir > env > 默认 ~/.pt/assets。
 *  返回值永远是绝对路径或可被 resolve 的相对路径。 */
export function getGlobalPackDir(adapterCtx?: SourceAdapterContext): string {
  return (
    adapterCtx?.globalPackDir ?? process.env.PT_GLOBAL_PACK_DIR ?? join(homedir(), ".pt", "assets")
  );
}

/**
 * 尝试加载 pack：目录不存在返空 Pack（不报错，§6.4）。
 * reserved pack（project/global/builtin）用固定 name，跳过 basename。
 *
 * 不预加载——目录不存在时 loadDomains() 等返空数组，与"空 Pack"等价。
 * 这样调用方可以无差别调 loadXxx，不用关心目录是否存在。
 *
 * adapterCtx 透传给 MdFilePack：parse 失败时调 reportError 上抛（PR1 补丁 S2）。
 */
export async function tryLoadPack(
  rootDir: string,
  reservedName: string,
  source: PackSource,
  adapterCtx?: SourceAdapterContext
): Promise<AssetPack> {
  return new MdFilePack(rootDir, reservedName, source, adapterCtx);
}

/** 构造 project pack（§6.5：路径可配，默认 .pt/assets）。
 *  PR1 阶段路径走 adapterCtx.assetDir / 默认 ASSETS_DIR——
 *  PR4 接通 .pi/settings.json 的 pt.project-pack-dir 后改为读 settings。 */
export async function loadProjectPack(
  cwd: string,
  adapterCtx?: SourceAdapterContext
): Promise<AssetPack> {
  const dir = adapterCtx?.assetDir ? resolve(cwd, adapterCtx.assetDir) : resolve(cwd, ASSETS_DIR);
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

/**
 * PR1 stub：settings pack 加载。PR4 接通 .pi/settings.json pt.asset-packs 解析。
 * PR1 阶段返空数组（不阻塞 PR1 的 4 类加载顺序验证）——
 * 保留函数签名稳定（PR4 改实现不改签名）。
 *
 * 入参 _cwd：保留以匹配 PR4 接通后的真实签名（路径解析依赖 cwd）。
 */
export async function loadSettingsPacks(_cwd: string): Promise<AssetPack[]> {
  return []; // PR4 实现：读 .pi/settings.json 的 pt.asset-packs[] → 构造 AssetPack[]
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
