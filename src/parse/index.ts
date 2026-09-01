// src/parse/index.ts — Parse 前端入口
//
// Phase 9.3：v9 适配 — 枚举 profiles/（用户面是 Profile，不是 Blueprint）；
//   channels/ 删除（v9 Channel 留作未来 Connector，不实现）。
// 按目录位置分发载体（domains/ → domain adapter / blueprints/ → blueprint adapter / profiles/ → profile adapter）。

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { SUFFIX_MD, blueprintsDir, domainsDir, profilesDir } from "../constants.js";
import type { Blueprint, Domain, Profile, SchemaBundle, SourceAdapter } from "../schema.js";
import { findBlueprint, findProfile } from "../schema.js";
import { parseBlueprint } from "./blueprint.js";
import { parseDomain } from "./domain.js";
import { parseProfile } from "./profile.js";

/** MD adapter：按目录位置分发到 domain/blueprint/profile adapter，组装 SchemaBundle。
 *  v9 命名约定：适配的是 MD 文件格式（不再叫 OXN——OXN 是历史名）。 */
export const mdAdapter: SourceAdapter = {
  name: "md",

  async load(cwd, profileName): Promise<SchemaBundle> {
    // 1. 枚举 domains/ 下所有 *.md → Domain[]
    const domains = await loadAllDomains(cwd);

    // 2. 枚举 blueprints/ 下所有 *.md → Blueprint[]（结构层）
    const blueprints = await loadAllBlueprints(cwd);

    // 3. 枚举 profiles/ 下所有 *.md → Profile[]（配置层，新增）
    const profiles = await loadAllProfiles(cwd);

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
      console.warn(`[pt] Profile "${active.name}" 引用了未知 Blueprint "${active.blueprint}"`);
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

async function loadAllDomains(cwd: string): Promise<Domain[]> {
  const dir = join(cwd, domainsDir());
  return loadDir(dir, SUFFIX_MD, (f) => parseDomain(cwd, f));
}

async function loadAllBlueprints(cwd: string): Promise<Blueprint[]> {
  const dir = join(cwd, blueprintsDir());
  return loadDir(dir, SUFFIX_MD, (f) => parseBlueprint(cwd, f));
}

async function loadAllProfiles(cwd: string): Promise<Profile[]> {
  const dir = join(cwd, profilesDir());
  return loadDir(dir, SUFFIX_MD, (f) => parseProfile(cwd, f));
}

async function loadDir<T>(dir: string, suffix: string, parser: (f: string) => Promise<T>): Promise<T[]> {
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
        // 错误通过返回值传递，避免依赖 UI 层（T8 改造点）
        console.error(`[pt] parse ${dir}/${f} failed:`, e);
        return null;
      }
    }),
  );
  return results.filter((r): r is T => r !== null);
}