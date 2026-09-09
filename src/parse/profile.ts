// src/parse/profile.ts — profiles/*.md → Profile IR
//
// Phase 9.3：v9 新增 — Profile（业务端实例）= 引用 Blueprint + 选 Domains（YAML 全局 + 聚合组追加）。
//   - YAML frontmatter:
//     - blueprint: <blueprint-name>
//     - domains: [d1, d2, ...]   ← 全局 Domain 列表（自动分发到所有聚合组）
//   - ## <聚合组名> : 聚合组实例化（与 Blueprint 同名）
//     - ### Domains : 追加到本聚合组的 Domain 名列表
//
// Profile asset 格式（v9 + v9.1 modules-to-profile-complete）：
//   ---
//   name: <profile-name>
//   blueprint: <blueprint-name>
//   domains: [d1, d2, ...]
//   ---
//
//   ## 会话背景
//   ### Modules
//   - Scene                  ← 段名（跨所有引用域该段）
//   - User.user-profile      ← 段.项（跨所有引用域该段下 H3 项）
//   - Agent.senior-developer
//   ### Domains
//   - d3

import { join } from "node:path";
import { reportWarn } from "../diagnostics.js";
import { SUFFIX_PROFILE } from "../constants.js";
import type { ModName, Profile, ProfileGroup } from "../schema.js";
import type { SourceAdapterContext } from "../schema.js";
import { extractDomainsList, extractModulesList, readAsset, sArr } from "./shared.js";

/** 已知 H2 段名（段名 = 命名空间）。modName 解析时左段必须是段名。
 *  扩展新段名 = 加这一行 + registerModuleRenderer 加一行 + 一致性测试。
 *  v9.1+（modules-to-profile-complete）：加 "User" / "Agent" 专用段（user-info / agent-info 重命名）。
 *  公开导出（src/asset-health.ts 复用做 unknown-modname 检测——避免重复常量）。 */
export const KNOWN_SECTION_NAMES: ReadonlySet<string> = new Set([
  "Scene",
  "Participant", // 保留兼容——之前 user-info / agent-info 用的段名
  "Trigger",
  "Rules",
  "Flows",
  "Checklists",
  "User", // user-info 重命名后专用段
  "Agent", // agent-info 重命名后专用段
  "Term", // fallback term 形态
]);

/** 解析 modName 字符串 → { section, item? }。
 *  形态 1: "Scene" → { section: "Scene" }（整段）
 *  形态 2: "User.user-profile" → { section: "User", item: "user-profile" }（单 H3 项）
 *  解析失败（不含 '.' 但段名未知 / 含 '.' 但段名未知 / 段名已知但项名为空）→ 返 null。
 *  不跨段匹配 item（"User.user-profile" 不匹配 "Agent" 段下同名 H3）—— 跨段同名由段名命名空间避免。 */
export function parseModName(raw: string): ModName | null {
  const modName = raw.trim();
  if (!modName) return null;
  if (modName.includes(".")) {
    const dotIdx = modName.indexOf(".");
    const section = modName.slice(0, dotIdx);
    const item = modName.slice(dotIdx + 1);
    if (KNOWN_SECTION_NAMES.has(section) && item) {
      return { section, item };
    }
    return null;
  }
  if (KNOWN_SECTION_NAMES.has(modName)) {
    return { section: modName };
  }
  return null;
}

/** 读 profiles/<fileName>.md → Profile { name, blueprint, domains, groups }
 *  v10.x：assetDir 让 fixtures 可指向 tests/fixtures/assets/（默认 .pt/assets）。
 *  v9.1（modules-to-profile 迁移）：每个 H2 段加读 `### Modules` 填 ProfileGroup.modules。
 *  v9.1+（modules-to-profile-complete）：modName 字符串解析为 ModName 对象（2 形态）。 */
export async function parseProfile(
  absDir: string,
  fileName: string,
  adapterCtx?: SourceAdapterContext
): Promise<Profile> {
  const asset = await readAsset(join(absDir, fileName));

  const blueprint =
    typeof asset.frontmatter.blueprint === "string" ? asset.frontmatter.blueprint : "";

  const domains = sArr(asset.frontmatter.domains); // YAML 全局 domains

  // groups：每个 H2 = 聚合组实例化
  //   - ### Domains → 追加到本聚合组的 Domain 名列表（v9 既有）
  //   - ### Modules → 本插槽填的聚合模块列表（v9.1+），modName 解析为 ModName 对象
  const groups: ProfileGroup[] = [];
  for (const [h2Name, section] of Object.entries(asset.sections)) {
    const appendDomains = extractDomainsList(section);
    const rawMods = extractModulesList(section);
    const modules: ModName[] = [];
    for (const raw of rawMods) {
      const parsed = parseModName(raw);
      if (parsed) {
        modules.push(parsed);
      } else {
        // 解析失败——log warn，skip（与设计文档 §5 "缺填" 一致：可能故意 / 笔误）
        reportWarn(
          adapterCtx,
          `Profile「${asset.name}」聚合组「${h2Name}」的 modName 解析失败：${raw}`,
          { profile: asset.name, group: h2Name, modName: raw }
        );
      }
    }
    groups.push({ name: h2Name, domains: appendDomains, modules });
  }

  return {
    name:
      typeof asset.frontmatter.name === "string"
        ? asset.frontmatter.name
        : stripProfileSuffix(asset.name),
    blueprint,
    domains,
    groups,
  };
}

function stripProfileSuffix(fileBase: string): string {
  // v9 命名约定：<name>.profile.md → 去 .profile 后缀
  return fileBase.replace(new RegExp(`${SUFFIX_PROFILE}$`), "");
}
