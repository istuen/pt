// src/parse/index.ts — Parse 前端入口
//
// Phase 9.3：v9 适配 — 枚举 profiles/（用户面是 Profile，不是 Blueprint）；
//   channels/ 删除（v9 Channel 留作未来 Connector，不实现）。
// 按目录位置分发载体（domains/ → domain adapter / blueprints/ → blueprint adapter / profiles/ → profile adapter）。

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { BLUEPRINTS_DIR, DOMAINS_DIR, PROFILES_DIR, SUFFIX_MD } from "../constants.js";
import type { Blueprint, Domain, Profile, SchemaBundle, SourceAdapter, SourceAdapterContext } from "../schema.js";
import { findBlueprint, findProfile } from "../schema.js";
import { parseBlueprint } from "./blueprint.js";
import { parseDomain } from "./domain.js";
import { parseProfile } from "./profile.js";

/** MD adapter：按目录位置分发到 domain/blueprint/profile adapter，组装 SchemaBundle。
 *  v9 命名约定：适配的是 MD 文件格式（不再叫 OXN——OXN 是历史名）。 */
export const mdAdapter: SourceAdapter = {
  name: "md",

  async load(cwd, profileName, adapterCtx): Promise<SchemaBundle> {
    // 1. 枚举 domains/ 下所有 *.md → Domain[]
    const domains = await loadAllDomains(cwd, adapterCtx);

    // 2. 枚举 blueprints/ 下所有 *.md → Blueprint[]（结构层）
    const blueprints = await loadAllBlueprints(cwd, adapterCtx);

    // 3. 枚举 profiles/ 下所有 *.md → Profile[]（配置层，新增）
    const profiles = await loadAllProfiles(cwd, adapterCtx);

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
      reportWarn(adapterCtx, `Profile "${active.name}" 引用了未知 Blueprint "${active.blueprint}"`);
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
  const dir = join(cwd, DOMAINS_DIR);
  return loadDir(dir, SUFFIX_MD, (f) => parseDomain(cwd, f), adapterCtx);
}

async function loadAllBlueprints(cwd: string, adapterCtx?: SourceAdapterContext): Promise<Blueprint[]> {
  const dir = join(cwd, BLUEPRINTS_DIR);
  return loadDir(dir, SUFFIX_MD, (f) => parseBlueprint(cwd, f), adapterCtx);
}

async function loadAllProfiles(cwd: string, adapterCtx?: SourceAdapterContext): Promise<Profile[]> {
  const dir = join(cwd, PROFILES_DIR);
  return loadDir(dir, SUFFIX_MD, (f) => parseProfile(cwd, f), adapterCtx);
}

async function loadDir<T>(dir: string, suffix: string, parser: (f: string) => Promise<T>, adapterCtx?: SourceAdapterContext): Promise<T[]> {
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(suffix));
  } catch {
    return [];  // 目录不存在返空（profiles/ 在 9.3 前可能尚未建立）
  }
  const results: Array<T | null> = await Promise.all(
    files.map(async (f): Promise<T | null> => {
      try {
        return await parser(f);
      } catch (e) {
        // 错误通过 notify 回调上抛，index.ts 调 ctx.ui.notify（pt-quality #9）
        reportError(adapterCtx, `parse ${dir}/${f} failed: ${errMsg(e)}`);
        return null;
      }
    }),
  );
  return results.filter((r): r is T => r !== null);
}

/** adapterCtx 缺失/notify 未传 → fallback console（保持 debug 能看到错误）。 */
function reportWarn(adapterCtx: SourceAdapterContext | undefined, msg: string): void {
  if (adapterCtx?.notify) adapterCtx.notify(msg, "warning");
  else console.warn(`[pt] ${msg}`);
}
function reportError(adapterCtx: SourceAdapterContext | undefined, msg: string): void {
  if (adapterCtx?.notify) adapterCtx.notify(msg, "error");
  else console.error(`[pt] ${msg}`);
}
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}