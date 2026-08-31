// src/config.ts — 读项目 settings + 探测 Scene struct
// ExtensionAPI 无 getSettings，需自读 .pi/settings.json（用 CONFIG_DIR_NAME，不硬编码 .pi）。
//
// v6：user 选的是 Scene（静态结构，产 System Prompt）。"blueprint" 语义留给 Struct.kind="blueprint"（动态结构，产 Manual）。
//
// Phase 7.1：从顶层 config.ts 迁入，import 路径不变。

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** 读项目 settings.json 的指定 dotted key。文件不存在/解析失败 → undefined */
export async function readProjectSetting<T = unknown>(
  cwd: string,
  dottedKey: string,
): Promise<T | undefined> {
  const path = join(cwd, CONFIG_DIR_NAME, "settings.json");
  let json: unknown;
  try {
    const raw = await readFile(path, "utf8");
    json = JSON.parse(raw);
  } catch {
    return undefined;
  }
  return dottedKey.split(".").reduce<unknown>((acc, k) => {
    if (acc && typeof acc === "object" && k in acc) {
      return (acc as Record<string, unknown>)[k];
    }
    return undefined;
  }, json) as T | undefined;
}

/** 列出 .pt/assets/blueprints/*.blueprint.md 下的 Blueprint 名（v7：去 .blueprint 后缀）。
 *  一个 Blueprint = 一个场景（v6 的 Scene + Manual 合并）。 */
export async function listScenes(cwd: string): Promise<string[]> {
  const dir = join(cwd, ".pt", "assets", "blueprints");
  try {
    const files = await readdir(dir);
    const scenes: string[] = [];
    for (const f of files) {
      if (!f.endsWith(".md")) continue;
      const base = f.slice(0, -3);  // 去 .md
      // Blueprint：<name>.blueprint.md → 返回 <name>
      if (base.endsWith(".blueprint")) {
        scenes.push(base.slice(0, -10));  // 去 .blueprint
      }
    }
    return scenes.sort();
  } catch {
    return [];
  }
}

/** 自动探测：仅当 Blueprint 唯一时返回该名；否则 null */
export async function detectSingleScene(cwd: string): Promise<string | null> {
  const all = await listScenes(cwd);
  return all.length === 1 ? all[0] : null;
}