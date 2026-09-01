// src/parse/profile.ts — profiles/*.md → Profile IR
//
// Phase 9.3：v9 新增 — Profile（业务端实例）= 引用 Blueprint + 选 Domains（YAML 全局 + 注入点追加）。
//   - YAML frontmatter:
//     - blueprint: <blueprint-name>
//     - domains: [d1, d2, ...]   ← 全局 Domain 列表（自动分发到所有注入点）
//   - ## <注入点名> : 注入点实例化（与 Blueprint 同名）
//     - ### Domains : 追加到本注入点的 Domain 名列表
//
// Profile asset 格式（v9）：
//   ---
//   name: <profile-name>
//   blueprint: <blueprint-name>
//   domains: [d1, d2, ...]
//   ---
//
//   ## 会话知识
//   ### Domains
//   - d3
//   - d4
//
//   ## 参考手册
//   ### Domains
//   - d5

import { join } from "node:path";
import type { InjectionPointInstance, Profile } from "../schema.js";
import { extractDomainsList, readAsset, sArr } from "./shared.js";

/** 读 profiles/<fileName>.md → Profile { name, blueprint, domains, injectionPoints } */
export async function parseProfile(cwd: string, fileName: string): Promise<Profile> {
  const asset = await readAsset(join(cwd, ".pt/assets/profiles", fileName));

  const blueprint = typeof asset.frontmatter.blueprint === "string"
    ? asset.frontmatter.blueprint
    : "";

  const domains = sArr(asset.frontmatter.domains);  // YAML 全局 domains

  // injectionPoints：每个 H2 = 注入点实例化（只读 ### Domains 追加列表）
  const injectionPoints: InjectionPointInstance[] = [];
  for (const [h2Name, section] of Object.entries(asset.sections)) {
    const appendDomains = extractDomainsList(section as never);
    injectionPoints.push({ name: h2Name, domains: appendDomains });
  }

  return {
    name: typeof asset.frontmatter.name === "string" ? asset.frontmatter.name : stripProfileSuffix(asset.name),
    blueprint,
    domains,
    injectionPoints,
  };
}

function stripProfileSuffix(fileBase: string): string {
  // v9 命名约定：<name>.profile.md → 去 .profile 后缀
  return fileBase.replace(/\.profile$/, "");
}