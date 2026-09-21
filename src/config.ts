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

/** issue pt-profile-selector-no-pack-grouping：选择器/补全的 profile 排序权重——
 *  project (0) 在前 → settings (1) 在中 → builtin (2) 在后。
 *  同 source 内仍走 name 字典序（保留 back-compat 行为）。
 *  抽到文件顶层：sortProfileMetasBySource + sortProfileMetasBySourceLite 共享同一权重表。 */
const SOURCE_ORDER: Record<ProfileMeta["source"], number> = {
  project: 0,
  settings: 1,
  builtin: 2,
};

/** ProfileMeta 排序器——按 source 分组、同 source 内按 name 字典序。
 *  listProfilesWithTagline 内部使用；listProfiles 因不暴露 source 字段走自己的 lite 版（共享 SOURCE_ORDER）。 */
export function sortProfileMetasBySource(a: ProfileMeta, b: ProfileMeta): number {
  const r = SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source];
  return r !== 0 ? r : a.name.localeCompare(b.name);
}

/** listProfiles 用轻量排序——只支持 project/builtin 两 source（不走 settings pack）。
 *  与 sortProfileMetasBySource 共享 SOURCE_ORDER 权重，避免两套排序规则漂移。 */
function sortProfileMetasBySourceLite(
  a: { name: string; source: "project" | "builtin" },
  b: { name: string; source: "project" | "builtin" }
): number {
  const r = SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source];
  return r !== 0 ? r : a.name.localeCompare(b.name);
}

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
 *  （issue: 内建 pt 无法通过 pt-profile 选择）。
 *  v15.x PR3+（issue pt-profile-selector-no-pack-grouping）：按 source 分组排——
 *  project 在前 / builtin 在后，同 source 内按 name 字典序。 */
export async function listProfiles(cwd: string): Promise<string[]> {
  const project = await listProfileNamesIn(join(cwd, PROFILES_DIR));
  const builtin = await listProfileNamesIn(join(BUILTIN_ASSETS_DIR, "profiles"));
  const projectNames = new Set(project);
  const merged: Array<{ name: string; source: "project" | "builtin" }> = [];
  for (const n of project) merged.push({ name: n, source: "project" });
  for (const n of builtin) {
    if (projectNames.has(n)) continue; // 项目覆盖内建
    merged.push({ name: n, source: "builtin" });
  }
  merged.sort(sortProfileMetasBySourceLite);
  return merged.map((m) => m.name);
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
// v15.x PR3：readTaglineFromFile 在新 listProfilesWithTagline 实现中已不用（pack.loadProfiles
// 返 Profile 对象含 tagline 字段），但保留作为其他代码（readProjectSetting）的辅助。
// 移除 unused：原 _readTaglineFromFile 实现见 git history。

/** Profile 名 + tagline 列表（项目 + builtin 合并；同名项目覆盖）。
 *  builtin 没 tagline 的 profile 返 undefined（选择器退化为纯名）。
 *  v15.x PR3（§7.2）：加 pack + source（4 类）——选择器显示 [@pack] 前缀；source 区分打包类型。 */
/** v15.x §4.4.4（位置 alias 表）：reserved pack 的位置别名。reserved pack 才有，非 reserved 为 undefined。
 *  UI 显示层用——reserved 显位置别名，settings 显 pack 名（§4.4.4 双层语义）。
 *  v15.x PR7（issue pt-remove-global-pack 移除）：从 3 个 reserved alias 收敛为 2 个——
 *  global pack（@gbl）删除，只剩 project（@prj） / builtin（@pt）。 */
const RESERVED_ALIAS: ReadonlyMap<ProfileMeta["source"], "prj" | "pt"> = new Map([
  ["project", "prj"],
  ["builtin", "pt"],
]);

export interface ProfileMeta {
  name: string;
  tagline?: string;
  source: "project" | "settings" | "builtin";
  /** v15.x PR3（§7.2）：pack 身份（reserved 短名 prj/pt 或 manifest.name）。 */
  pack: string;
  /** v15.x §4.4.4（缺口 4）：reserved pack 的位置别名（prj/pt），非 reserved 为 undefined。
   *  UI 显示层用——reserved 显位置别名，settings 显 pack 名。 */
  reservedAlias?: "prj" | "pt";
}

export async function listProfilesWithTagline(cwd: string): Promise<ProfileMeta[]> {
  // v15.x PR4（§4.4.3 #5 + §6.1）：扫所有 pack 含 settings
  // 顺序与 mdAdapter.load 一致（settings 倒序后者赢）——选择器展示优先级与实际加载一致
  // v15.x PR7（issue pt-remove-global-pack 移除）：从 4 类 pack 收敛为 3 类（globalPack 槽位删除）
  const { loadProjectPack, loadSettingsPacks, loadBuiltinPack } = await import(
    "./asset-pack/loader.js"
  );
  const projectPack = await loadProjectPack(cwd);
  const settingsPacks = await loadSettingsPacks(cwd);
  const builtinPack = await loadBuiltinPack();
  const packs = [projectPack, ...settingsPacks.slice().reverse(), builtinPack];

  const metas: ProfileMeta[] = [];
  for (const pack of packs) {
    const profiles = await pack.loadProfiles();
    for (const p of profiles) {
      if (metas.some((m) => m.name === p.name)) continue; // 前者赢
      metas.push({
        name: p.name,
        tagline: p.tagline,
        source: pack.source,
        pack: pack.name,
        reservedAlias: RESERVED_ALIAS.get(pack.source),
      });
    }
  }
  // issue pt-profile-selector-no-pack-grouping：按 source 分组（project → settings → builtin），
  // 同 source 内按 name 字典序——避免字母序穿插（如内置 `guide` 排在项目 `pt-*` 之前）
  metas.sort(sortProfileMetasBySource);
  return metas;
}

/** 把 ProfileMeta 列表转成选择器展示标签（`[@pack] name — tagline`，§7.3）。
 *  v15.x §4.4.4（缺口 4）：reserved pack 显 reservedAlias（位置别名），settings pack 显 pack 名。
 *  tagline 缺省 → 纯名。空 tagline 也走纯名。 */
export function formatProfileLabels(profiles: ProfileMeta[]): string[] {
  return profiles.map((p) => {
    const label = p.reservedAlias ?? p.pack;
    const prefix = label ? `[@${label}] ` : "";
    const tagline = p.tagline ? ` — ${p.tagline}` : "";
    return `${prefix}${p.name}${tagline}`;
  });
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
