// src/parse/index.ts — Parse 前端入口
//
// Phase 7.3：parse 拆分成 shared/domain/channel/blueprint 四文件。
// 按目录位置分发载体（domains/ → domain adapter / channels/ → channel adapter / blueprints/ → blueprint adapter）。

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Blueprint, Channel, Domain, SchemaBundle, SourceAdapter } from "../schema.js";
import { findBlueprint, findChannel } from "../schema.js";
import { parseBlueprint } from "./blueprint.js";
import { parseChannel } from "./channel.js";
import { parseDomain } from "./domain.js";

/** OXN adapter：按目录位置分发到 domain/channel/blueprint adapter，组装 SchemaBundle。 */
export const oxnAdapter: SourceAdapter = {
  name: "oxn",

  async load(cwd, blueprintName): Promise<SchemaBundle> {
    // 1. 枚举 domains/ 下所有 *.md → Domain[]
    const domains = await loadAllDomains(cwd);

    // 2. 枚举 channels/ 下所有 *.md → Channel[]
    const channels = await loadAllChannels(cwd);

    // 3. 枚举 blueprints/ 下所有 *.md → Blueprint[]
    const blueprints = await loadAllBlueprints(cwd);

    // 4. 找激活的 Blueprint（按 blueprintName）
    const active = findBlueprint(blueprints, blueprintName);
    if (!active) {
      // fallback：取第一个 Blueprint
      const fallback = blueprints[0];
      if (!fallback) {
        throw new Error(`Pt: 未找到 Blueprint "${blueprintName}"（blueprints/*.blueprint.md）`);
      }
      return {
        domains,
        channels,
        blueprints,
        activeBlueprint: fallback.name,
      };
    }

    // 5. 校验 Blueprint 引用的 Channel 必须存在（明确的错误提示）
    const ch = findChannel(channels, active.channel);
    if (!ch && active.channel) {
      console.warn(`[pt] Blueprint "${active.name}" 引用了未知 Channel "${active.channel}"`);
    }

    return {
      domains,
      channels,
      blueprints,
      activeBlueprint: active.name,
    };
  },
};

// ==================== 目录枚举辅助 ====================

async function loadAllDomains(cwd: string): Promise<Domain[]> {
  const dir = join(cwd, ".openxenon/assets/domains");
  return loadDir(dir, ".md", (f) => parseDomain(cwd, f));
}

async function loadAllChannels(cwd: string): Promise<Channel[]> {
  const dir = join(cwd, ".openxenon/assets/channels");
  return loadDir(dir, ".md", (f) => parseChannel(cwd, f));
}

async function loadAllBlueprints(cwd: string): Promise<Blueprint[]> {
  const dir = join(cwd, ".openxenon/assets/blueprints");
  return loadDir(dir, ".md", (f) => parseBlueprint(cwd, f));
}

async function loadDir<T>(dir: string, suffix: string, parser: (f: string) => Promise<T>): Promise<T[]> {
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(suffix));
  } catch {
    return [];  // 目录不存在返空（channels/ 在 7.4 前可能尚未建立）
  }
  const results: Array<T | null> = await Promise.all(
    files.map(async (f): Promise<T | null> => {
      try {
        return await parser(f);
      } catch (e) {
        console.error(`[pt] parse ${dir}/${f} failed:`, e);
        return null;
      }
    }),
  );
  return results.filter((r): r is T => r !== null);
}