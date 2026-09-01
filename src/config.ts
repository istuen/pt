// src/config.ts — 读项目 settings + 探测 Profile
// ExtensionAPI 无 getSettings，需自读 .pi/settings.json（用 CONFIG_DIR_NAME，不硬编码 .pi）。
//
// v9：用户面是 Profile（.pt/assets/profiles/*.profile.md），不是 Blueprint。

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

/** 列出 .pt/assets/profiles/*.profile.md 下的 Profile 名（v9：去 .profile 后缀）。 */
export async function listProfiles(cwd: string): Promise<string[]> {
  const dir = join(cwd, ".pt", "assets", "profiles");
  try {
    const files = await readdir(dir);
    const profiles: string[] = [];
    for (const f of files) {
      if (!f.endsWith(".md")) continue;
      const base = f.slice(0, -3);  // 去 .md
      if (base.endsWith(".profile")) {
        profiles.push(base.slice(0, -8));  // 去 .profile
      }
    }
    return profiles.sort();
  } catch {
    return [];
  }
}

/** 自动探测：仅当 Profile 唯一时返回该名；否则 null */
export async function detectSingleProfile(cwd: string): Promise<string | null> {
  const all = await listProfiles(cwd);
  return all.length === 1 ? all[0] : null;
}