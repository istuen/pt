// src/parse/channel.ts — channels/*.md → Channel IR
//
// Phase 8.3：v8 适配 — Channel 的 H2 = 注入点（InjectionPointConfig）。
//   - 每个 H2（除特殊段外）解析为一个 InjectionPointConfig
//   - H2 名 = 注入点名（语义名）
//   - H2 下 `target: <value>` / `mode: <value>` = 字段
//   - H2 下 `### Modules` 下列出参与本注入点的 Domain H2 段名（裸名）
//
// Channel asset 格式（v8）：
//   ---
//   name: <channel-name>
//   ---
//
//   ## 会话知识                          ← H2 = 注入点
//   target: system_prompt                ← 注入到 Pi 的哪里
//   mode: hybrid                         ← 聚合方式
//   ### Modules                          ← 聚合点 H3
//   - Scene                              ← 参与本注入点的 Domain H2 段名
//
//   ## 对话记忆
//   target: context_message
//   ### Modules
//   - Manual

import { join } from "node:path";
import type { Channel, InjectionPointConfig, InjectionTarget, StructureLayout } from "../schema.js";
import { extractFieldValue, extractModulesList, readAsset, s, sArr } from "./shared.js";

const VALID_MODES: ReadonlyArray<StructureLayout["mode"]> = ["byDomain", "byType", "hybrid"];
/** v7 残留段名——跳过不作为注入点。 */
const V7_LEGACY_SECTIONS = new Set(["Modules", "Layout"]);

/** 读 channels/<fileName>.md → Channel { name, injectionPoints } */
export async function parseChannel(cwd: string, fileName: string): Promise<Channel> {
  const asset = await readAsset(join(cwd, ".pt/assets/channels", fileName));

  // v8：每个 H2（除 v7 残留段外）= 一个注入点
  const injectionPoints: InjectionPointConfig[] = [];
  for (const [h2Name, section] of Object.entries(asset.sections)) {
    if (V7_LEGACY_SECTIONS.has(h2Name)) continue;  // 跳过 v7 残留段
    injectionPoints.push(parseInjectionPointFromSection(h2Name, section));
  }

  // name：优先 frontmatter.name，否则去文件名后缀
  const name = typeof asset.frontmatter.name === "string"
    ? asset.frontmatter.name
    : stripChannelSuffix(asset.name);

  return { name, injectionPoints };
}

/** 把一个 H2 段解析为 InjectionPointConfig。 */
function parseInjectionPointFromSection(h2Name: string, section: { raw: string; items: { name: string; fields: Record<string, unknown> }[] }): InjectionPointConfig {
  const targetRaw = extractFieldValue(section as never, "target") || "system_prompt";
  const modeRaw = extractFieldValue(section as never, "mode");
  const modules = extractModulesList(section as never);

  const mode = modeRaw && VALID_MODES.includes(modeRaw as StructureLayout["mode"])
    ? (modeRaw as StructureLayout["mode"])
    : undefined;

  const ip: InjectionPointConfig = {
    name: h2Name,
    target: targetRaw as InjectionTarget,
    modules,
  };
  if (mode) ip.mode = mode;
  return ip;
}

function stripChannelSuffix(fileBase: string): string {
  // v8 命名约定：<name>.channel.md → 去 .channel 后缀
  return fileBase.replace(/\.channel$/, "");
}

// ==================== 共享辅助：复用给 blueprint.ts ====================

export { s, sArr };

/** 解析 frontmatter.layout 字段（v6 兼容）。v8 不再用，仅保留兼容函数。 */
export function parseLayoutFromFrontmatter(raw: unknown): StructureLayout | undefined {
  if (typeof raw === "string") {
    return VALID_MODES.includes(raw as StructureLayout["mode"])
      ? { mode: raw as StructureLayout["mode"] }
      : undefined;
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    const mode = obj.mode;
    if (typeof mode === "string" && VALID_MODES.includes(mode as StructureLayout["mode"])) {
      const layout: StructureLayout = { mode: mode as StructureLayout["mode"] };
      const order = obj.domainOrder;
      if (Array.isArray(order) && order.every((x) => typeof x === "string")) {
        layout.domainOrder = order as string[];
      }
      return layout;
    }
  }
  return undefined;
}
