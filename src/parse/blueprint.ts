// src/parse/blueprint.ts — blueprint/*.md → Blueprint IR
//
// Phase 8.3：v8 适配 — Blueprint 按注入点组织（H2 = 注入点名）。
//   - ## Channel   : 引用哪个 Channel（裸值）
//   - ## <注入点名> : 注入点实例化
//     - ### Domains : 参与本注入点的 Domain 名（裸名列表）
//     - ### Trigger : 本注入点的触发条件（裸值文本 / H3 形式）
//     - ### Boundaries : 本注入点的流程节点 DAG（H3 子项 → BoundaryNode[]）
//   - ## Compilation : 编译方式（cache-dir + split）
//
// Blueprint asset 格式（v8）：
//   ---
//   name: <blueprint-name>
//   ---
//
//   ## Channel
//
//   <channel-name>
//
//   ## 会话知识
//   ### Domains
//   - pt-concepts
//   ### Trigger
//   <裸文本>
//   ### Boundaries
//   ### identify-task
//   - deps: []
//   - desc: ...
//
//   ## 对话记忆
//   ### Domains
//   - pt-dev-flow
//
//   ## Compilation
//   cache-dir: .pt/contexts/cache/
//   split: single-file

import { join } from "node:path";
import type {
  Blueprint,
  BoundaryNode,
  CacheSplitStrategy,
  CompilationConfig,
  InjectionPointInstance,
} from "../schema.js";
import {
  extractDomainsList,
  extractFieldValue,
  readAsset,
  s,
  sArr,
} from "./shared.js";

const V7_LEGACY_SECTIONS = new Set(["Domains", "Trigger", "Boundaries"]);

/** 读 blueprints/<fileName>.md → Blueprint { name, channel, injectionPoints, compilation } */
export async function parseBlueprint(cwd: string, fileName: string): Promise<Blueprint> {
  const asset = await readAsset(join(cwd, ".pt/assets/blueprints", fileName));

  // channel：## Channel 段第一个非空行（裸值）
  const channelSection = asset.sections["Channel"];
  let channel = "";
  if (channelSection) {
    channel = extractBareValue(channelSection.raw);
  }
  // 兼容：frontmatter.channel
  if (!channel && typeof asset.frontmatter.channel === "string") {
    channel = asset.frontmatter.channel;
  }

  // injectionPoints：每个非特殊 H2 = 一个注入点实例化
  const injectionPoints: InjectionPointInstance[] = [];
  for (const [h2Name, section] of Object.entries(asset.sections)) {
    if (h2Name === "Channel" || h2Name === "Compilation") continue;
    if (V7_LEGACY_SECTIONS.has(h2Name)) continue;  // 跳过 v7 残留段
    injectionPoints.push(parseInjectionPointFromSection(h2Name, section));
  }

  // compilation：## Compilation 段
  const compilation = parseCompilationFromSection(asset.sections["Compilation"]);

  return {
    name: typeof asset.frontmatter.name === "string" ? asset.frontmatter.name : stripBlueprintSuffix(asset.name),
    channel,
    injectionPoints,
    compilation,
  };
}

/** 把一个 H2 段解析为 InjectionPointInstance。 */
function parseInjectionPointFromSection(
  h2Name: string,
  section: { raw: string; items: { name: string; fields: Record<string, unknown> }[] },
): InjectionPointInstance {
  const domains = extractDomainsList(section as never);
  const trigger = extractTriggerFromSection(section);
  const boundaries = extractBoundariesFromSection(section);

  const ip: InjectionPointInstance = {
    name: h2Name,
    domains,
  };
  if (trigger !== undefined) ip.trigger = trigger;
  if (boundaries && boundaries.length > 0) ip.boundaries = boundaries;
  return ip;
}

/** 提取注入点的 Trigger：优先 H3 形式（### Trigger 段下第一个 H3 项的 desc），其次裸值段。 */
function extractTriggerFromSection(section: { raw: string; items: { name: string; fields: Record<string, unknown> }[] }): string | undefined {
  const trigItem = section.items.find((it) => it.name === "Trigger");
  if (trigItem) {
    const t = s(trigItem.fields.desc) || s(trigItem.fields.trigger);
    if (t) return t;
  }
  // fallback：扫 raw text，找 `### Trigger` 后第一个非空非列表行
  const lines = section.raw.split(/\r?\n/);
  let inTrigger = false;
  const buf: string[] = [];
  for (const line of lines) {
    const h3 = line.match(/^###\s+(.+)$/);
    if (h3) {
      if (inTrigger) break;
      if (h3[1].trim() === "Trigger") inTrigger = true;
      continue;
    }
    if (!inTrigger) continue;
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("-") && !trimmed.startsWith("#")) {
      buf.push(trimmed);
    } else if (buf.length > 0) {
      break;  // 第一个非空行后遇空内容则结束
    }
  }
  const joined = buf.join(" ").trim();
  return joined || undefined;
}

/** 提取注入点的 Boundaries：### Boundaries H3 段下的所有 H3 子项 → BoundaryNode[]。 */
function extractBoundariesFromSection(section: { raw: string; items: { name: string; fields: Record<string, unknown> }[] }): BoundaryNode[] {
  const items = section.items;
  // 找 "Boundaries" 这个 H3 下的子项（它们被 collect 进 items 数组）
  // 因为 parseItems 在 H3 模式下把每个 H3 都作为 Item，
  // "Boundaries" 这个 H3 下的子 H3（如 "identify-task"）会被混在 items 数组里
  // —— 我们需要识别出它们是 Boundaries 的子项
  // 简化策略：直接识别所有形如"步骤名 + deps + desc"的 Item 作为 Boundaries 子项
  // —— Channel v8 资产里 Boundaries 是嵌套 H3，需特殊处理
  const itemsIdx = items.findIndex((it) => it.name === "Boundaries");
  if (itemsIdx >= 0) {
    // ### Boundaries 后面紧跟的 H3 子项是 BoundaryNode
    const result: BoundaryNode[] = [];
    for (let i = itemsIdx + 1; i < items.length; i++) {
      const it = items[i];
      // 遇到下一个非 Boundaries 的同级 H3 名就停？简化：只要它有 deps 字段就当 BoundaryNode
      if ("deps" in it.fields) {
        result.push({
          slot: it.name,
          deps: sArr(it.fields.deps),
          desc: s(it.fields.desc),
        });
      }
    }
    if (result.length > 0) return result;
  }
  // fallback：从 raw text 扫 ### Boundaries 后所有 ### 子项
  return extractBoundariesFromRaw(section.raw);
}

function extractBoundariesFromRaw(sectionRaw: string): BoundaryNode[] {
  const lines = sectionRaw.split(/\r?\n/);
  const result: BoundaryNode[] = [];
  let inBoundaries = false;
  let cur: BoundaryNode | null = null;
  for (const line of lines) {
    const h3 = line.match(/^###\s+(.+)$/);
    if (h3) {
      if (cur) result.push(cur);
      const name = h3[1].trim();
      if (inBoundaries) {
        // 新 H3 子项作为 BoundaryNode（继承 Boundaries 上下文）
        cur = { slot: name, deps: [], desc: "" };
      } else if (name === "Boundaries") {
        inBoundaries = true;
        cur = null;
      } else {
        cur = null;
      }
      continue;
    }
    if (!inBoundaries || !cur) continue;
    const fv = line.match(/^\s*-\s+([a-zA-Z_][\w-]*)\s*:\s*(.+)$/);
    if (fv) {
      const key = fv[1];
      const val = fv[2].trim();
      if (key === "deps") {
        const arrMatch = val.match(/^\[(.*)\]$/);
        if (arrMatch) {
          cur.deps = arrMatch[1]
            .split(",")
            .map((x) => x.trim())
            .filter((x) => x !== "");
        } else if (val === "[]") {
          cur.deps = [];
        } else if (val) {
          cur.deps = [val];
        }
      } else if (key === "desc") {
        cur.desc = val;
      }
    }
  }
  if (cur) result.push(cur);
  return result;
}

/** 解析 ## Compilation 段 → CompilationConfig。 */
function parseCompilationFromSection(section: { raw: string; items: { name: string; fields: Record<string, unknown> }[] } | undefined): CompilationConfig {
  if (!section) {
    return { cacheDir: ".pt/contexts/cache/", split: "single-file" };
  }
  const cacheDir = extractFieldValue(section as never, "cache-dir") || ".pt/contexts/cache/";
  const splitRaw = extractFieldValue(section as never, "split") || "single-file";
  return {
    cacheDir,
    split: (splitRaw === "by-injection-point" ? "by-injection-point" : "single-file") as CacheSplitStrategy,
  };
}

function stripBlueprintSuffix(fileBase: string): string {
  // v8 命名约定：<name>.blueprint.md → 去 .blueprint 后缀
  // v6 兼容：去 .scene/.manual 后缀
  return fileBase.replace(/\.blueprint$/, "").replace(/\.(scene|manual)$/, "");
}

/** 从裸值段（## <Name>\n\n<value>）提取第一个非空行作为 value。 */
function extractBareValue(sectionRaw: string): string {
  for (const line of sectionRaw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("-") && !trimmed.startsWith("#")) {
      return trimmed;
    }
  }
  return "";
}

// ==================== 共享辅助 ====================

export { s, sArr };
