// src/config.ts — 读项目 settings + 探测 Profile
// ExtensionAPI 无 getSettings，需自读 .pi/settings.json（用 CONFIG_DIR_NAME，不硬编码 .pi）。
//
// v9：用户面是 Profile（.pt/assets/profiles/*.profile.md），不是 Blueprint。
//
// v14.x（tagline）：加 listProfilesWithTagline() — /pt-profile 选择器展示 tagline 用。

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { BUILTIN_ASSETS_DIR, PROFILES_DIR } from "./constants.js";
import { isRecord } from "./compile/type-guards.js";

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

/** 列出可选 Profile 名：项目 + 内建合并，同名时项目覆盖内建。
 *  必须与 mdAdapter.load 的合并语义一致——否则选择器/补全看不到内建 profile
 *  （如 builtin `pt`），但 transpile 又能加载，造成“选不到却能手敲”的不一致
 *  （issue: 内建 pt 无法通过 pt-profile 选择）。 */
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

/** 从某个 profile 文件里粗读 tagline（只读 frontmatter，不走全 parse）。
 *  用途：/pt-profile 选择器拼选项 — 不必全 parse profile (可能慢)。
 *  返回 undefined 表示无 tagline 或读失败（缺省走纯名选项）。 */
async function readTaglineFromFile(absFilePath: string): Promise<string | undefined> {
  try {
    const raw = await readFile(absFilePath, "utf8");
    // 简易 frontmatter 解析：--- ... --- block + tagline: <value>
    const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m) return undefined;
    const fm = m[1];
    // tagline 值可能跨续行（含 # 注释）。取首个匹配后 trim
    const tagMatch = fm.match(/^tagline\s*:\s*(.+?)\s*$/m);
    if (!tagMatch) return undefined;
    const v = tagMatch[1].trim();
    // 去可选引号包裹（双 / 单引号）
    const unquoted =
      (v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))
        ? v.slice(1, -1).trim()
        : v;
    return unquoted || undefined;
  } catch {
    return undefined;
  }
}

/** Profile 名 + tagline 列表（项目 + builtin 合并；同名项目覆盖）。
 *  v14.x（tagline）：/pt-profile 选择器展示用——选型看到标签一眼分辨身份。
 *  builtin 没 tagline 的 profile 返 undefined（选择器退化为纯名）。
 */
export interface ProfileMeta {
  name: string;
  tagline?: string;
  source: "project" | "builtin";
}

export async function listProfilesWithTagline(cwd: string): Promise<ProfileMeta[]> {
  const projectDir = join(cwd, PROFILES_DIR);
  const builtinDir = join(BUILTIN_ASSETS_DIR, "profiles");
  const projectNames = await listProfileNamesIn(projectDir);
  const builtinNames = await listProfileNamesIn(builtinDir);
  // 同名合并：项目覆盖内建
  const seen = new Set<string>();
  const merged: ProfileMeta[] = [];
  for (const n of projectNames) {
    if (seen.has(n)) continue;
    seen.add(n);
    const tagline = await readTaglineFromFile(join(projectDir, `${n}.profile.md`));
    merged.push({ name: n, tagline, source: "project" });
  }
  for (const n of builtinNames) {
    if (seen.has(n)) continue;
    seen.add(n);
    const tagline = await readTaglineFromFile(join(builtinDir, `${n}.profile.md`));
    merged.push({ name: n, tagline, source: "builtin" });
  }
  merged.sort((a, b) => a.name.localeCompare(b.name));
  return merged;
}

/** 把 ProfileMeta 列表转成选择器展示标签（`name — tagline`）。
 *  tagline 缺省 → 纯名。空 tagline 也走纯名。 */
export function formatProfileLabels(profiles: ProfileMeta[]): string[] {
  return profiles.map((p) => (p.tagline ? `${p.name} — ${p.tagline}` : p.name));
}

/** 自动探测：只看项目级 Profile，不把内建 guide 计入用户项目选择。 */
export async function detectSingleProfile(cwd: string): Promise<string | null> {
  const project = await listProfileNamesIn(join(cwd, PROFILES_DIR));
  return project.length === 1 ? project[0] : null;
}

/** 默认兜底：项目无单 Profile 时，读 settings `pt.default-profile`。
 *  - 未设 → 返回内建 "guide"（装包即用，真默认）
 *  - "none" → 返回 null（用户明确不要自动加载）
 *  - 具体名 → 返回该名（用户自定义默认 Profile）
 *  与 detectSingleProfile 分离：auto 是项目探测（pickedFrom="auto"），
 *  default 是兜底机制（pickedFrom="default"），来源可观测。 */
export async function detectDefaultProfile(cwd: string): Promise<string | null> {
  const setting = await readProjectSetting<string>(cwd, "pt.default-profile");
  if (setting === undefined) return "guide"; // 未设 → 内建兜底
  if (setting === "none") return null; // 明确关闭
  const trimmed = setting.trim();
  return trimmed || null;
}
