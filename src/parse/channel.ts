// src/parse/channel.ts — channels/*.md → Channel IR
//
// Phase 7.3：parse 拆分。Channel 是结构层模块，定义通道含哪些上下文模块 + 编排策略。
//
// Channel asset 格式（v7）：
//   ---
//   name: <channel-name>
//   ---
//
//   ## Modules
//     - Scene
//     - Manual
//     - Term
//
//   ## Layout
//     mode: hybrid
//     domainOrder: [writing, article-flow]   # 可选

import { join } from "node:path";
import type { Channel, StructureLayout } from "../schema.js";
import { readAsset, s, sArr } from "./shared.js";

const VALID_MODES: ReadonlyArray<StructureLayout["mode"]> = ["byDomain", "byType", "hybrid"];

/** 读 channels/<fileName>.md → Channel { name, modules, layout } */
export async function parseChannel(cwd: string, fileName: string): Promise<Channel> {
  const asset = await readAsset(join(cwd, ".openxenon/assets/channels", fileName));

  // modules：从 ## Modules 段读列表（每行一个 H2 段名）
  const modulesSection = asset.sections["Modules"];
  const modules = modulesSection
    ? modulesSection.items.map((it) => it.name)
    : [];

  // layout：从 ## Layout 段读 mode + domainOrder
  const layout = parseLayoutFromSection(asset.sections["Layout"]);

  // name：优先 frontmatter.name，否则去文件名后缀
  const name = typeof asset.frontmatter.name === "string"
    ? asset.frontmatter.name
    : stripChannelSuffix(asset.name);

  return { name, modules, layout };
}

function parseLayoutFromSection(section: { items: { name: string; fields: Record<string, unknown> }[] } | undefined): StructureLayout {
  if (!section) return { mode: "hybrid" };  // 默认 hybrid
  // ## Layout 段可能用单 H3 项（mode: hybrid）或顶层 list（- mode: hybrid / - domainOrder: [...]）
  // 优先取 H3 项（每个 H3 name = mode/domainOrder），其次顶层 list
  if (section.items.length > 0) {
    const modeField = section.items[0].fields.mode;
    const orderField = section.items[0].fields.domainOrder;
    if (typeof modeField === "string" && VALID_MODES.includes(modeField as StructureLayout["mode"])) {
      const layout: StructureLayout = { mode: modeField as StructureLayout["mode"] };
      if (Array.isArray(orderField)) {
        const orders = orderField.filter((x): x is string => typeof x === "string");
        if (orders.length > 0) layout.domainOrder = orders;
      }
      return layout;
    }
  }
  // 兼容：直接从 frontmatter 解析 layout 字段（v6 兼容路径）
  return { mode: "hybrid" };
}

function stripChannelSuffix(fileBase: string): string {
  // v7 命名约定：<name>.channel.md → 去 .channel 后缀
  return fileBase.replace(/\.channel$/, "");
}

// ==================== 共享辅助：复用给 blueprint.ts ====================

export { s, sArr };

/** 解析 frontmatter.layout 字段（YAML inline object / string）。 */
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