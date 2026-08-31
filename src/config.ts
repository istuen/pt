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

/** 列出 .openxenon/assets/blueprints/*.md 下的 Scene struct 名（v6：去 .scene/.manual 后缀）。
 *  Manual struct 不参与选择（同名成对绑定到 Scene）。 */
export async function listScenes(cwd: string): Promise<string[]> {
  const dir = join(cwd, ".openxenon", "assets", "blueprints");
  try {
    const files = await readdir(dir);
    const scenes: string[] = [];
    for (const f of files) {
      if (!f.endsWith(".md")) continue;
      const base = f.slice(0, -3);  // 去 .md
      // Scene struct：<name>.scene.md → 返回 <name>
      if (base.endsWith(".scene")) {
        scenes.push(base.slice(0, -6));  // 去 .scene
      }
    }
    return scenes.sort();
  } catch {
    return [];
  }
}

/** 自动探测：仅当 Scene 唯一时返回该名；否则 null */
export async function detectSingleScene(cwd: string): Promise<string | null> {
  const all = await listScenes(cwd);
  return all.length === 1 ? all[0] : null;
}