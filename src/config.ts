// src/config.ts — 读项目 settings + 探测 Profile
// ExtensionAPI 无 getSettings，需自读 .pi/settings.json（用 CONFIG_DIR_NAME，不硬编码 .pi）。
//
// v9：用户面是 Profile（.pt/assets/profiles/*.profile.md），不是 Blueprint。

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { BUILTIN_ASSETS_DIR, PROFILES_DIR } from "./constants.js";

/** 读项目 settings.json 的指定 dotted key。文件不存在/解析失败 → undefined */
export async function readProjectSetting<T = unknown>(
  cwd: string,
  dottedKey: string
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
    if (isRecord(acc) && k in acc) {
      return acc[k];
    }
    return undefined;
  }, json) as T | undefined;
}

/** 判断 unknown 是否为索引签名对象。 */
function isRecord(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

/** 列出可选 Profile 名：项目 + 内建合并，同名时项目覆盖内建。
 *  必须与 mdAdapter.load 的合并语义一致——否则选择器/补全看不到内建 profile
 *  （如 builtin `pt`），但 transpile 又能加载，造成“选不到却能手敲”的不一致
 *  （issue: 内建 pt 无法通过 pt-context 选择）。 */
export async function listProfiles(cwd: string): Promise<string[]> {
  const project = await listProfileNamesIn(join(cwd, PROFILES_DIR));
  const builtin = await listProfileNamesIn(join(BUILTIN_ASSETS_DIR, "profiles"));
  const projectNames = new Set(project);
  const merged = [...project, ...builtin.filter((n) => !projectNames.has(n))];
  return merged.sort();
}

/** 扫描某个 profiles 目录提取 Profile 名（去 .profile.md 后缀）。目录不存在返空。 */
async function listProfileNamesIn(dir: string): Promise<string[]> {
  try {
    const files = await readdir(dir);
    const names: string[] = [];
    for (const f of files) {
      if (!f.endsWith(".md")) continue;
      const base = f.slice(0, -3); // 去 .md
      if (base.endsWith(".profile")) {
        names.push(base.slice(0, -8)); // 去 .profile
      }
    }
    return names;
  } catch {
    return [];
  }
}

/** 自动探测：只看项目级 Profile，不把内建 pt 计入用户项目选择。 */
export async function detectSingleProfile(cwd: string): Promise<string | null> {
  const project = await listProfileNamesIn(join(cwd, PROFILES_DIR));
  return project.length === 1 ? project[0] : null;
}
