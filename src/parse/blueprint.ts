// src/parse/blueprint.ts — blueprints/*.md → Blueprint IR
//
// Phase 7.3：parse 拆分。Blueprint 是配置层模块，Channel + 具体 Domains + trigger + boundaries。
//
// Blueprint asset 格式（v7）：
//   ---
//   name: <blueprint-name>
//   ---
//
//   ## Channel
//     <channel-name>   # 单行，引用哪个 Channel
//
//   ## Domains
//     - pt-concepts
//     - pt-transpile
//
//   ## Trigger
//     当用户询问 Pt 自身相关知识时按以下流程回答。
//
//   ## Boundaries
//     ### identify-topic
//     - deps: []
//     - desc: 识别用户问题属于哪一类
//
//     ### cite-domain
//     - deps: [identify-topic]
//     - desc: 按类别引用对应 Domain

import { join } from "node:path";
import type { Blueprint, BoundaryNode } from "../schema.js";
import { readAsset, s, sArr } from "./shared.js";

/** 读 blueprints/<fileName>.md → Blueprint { name, channel, domains, trigger, boundaries } */
export async function parseBlueprint(cwd: string, fileName: string): Promise<Blueprint> {
  const asset = await readAsset(join(cwd, ".openxenon/assets/blueprints", fileName));

  // channel：## Channel 段第一个 H3 项的 name 字段（单行引用）
  const channelSection = asset.sections["Channel"];
  let channel = "";
  if (channelSection && channelSection.items.length > 0) {
    channel = s(channelSection.items[0].fields.channel)
      || channelSection.items[0].name;
  }
  // 兼容：frontmatter.channel
  if (!channel && typeof asset.frontmatter.channel === "string") {
    channel = asset.frontmatter.channel;
  }

  // domains：## Domains 段读列表（每行一个 Domain 名）
  const domainsSection = asset.sections["Domains"];
  let domains: string[] = [];
  if (domainsSection) {
    if (domainsSection.items.length > 0) {
      // H3 形式
      domains = domainsSection.items.map((it) => s(it.fields.refs) || it.name).filter((x) => x !== "");
    } else {
      // 顶层 list 形式（兼容）
      const refs = asset.frontmatter.refs;
      if (Array.isArray(refs)) {
        domains = (refs as unknown[]).filter((x): x is string => typeof x === "string");
      }
    }
  } else {
    // 兼容：frontmatter.refs
    if (Array.isArray(asset.frontmatter.refs)) {
      domains = (asset.frontmatter.refs as unknown[]).filter((x): x is string => typeof x === "string");
    }
  }

  // trigger：## Trigger 段第一个 H3 项的 desc 字段
  let trigger: string | undefined;
  const triggerSection = asset.sections["Trigger"];
  if (triggerSection && triggerSection.items.length > 0) {
    trigger = s(triggerSection.items[0].fields.desc)
      || s(triggerSection.items[0].fields.trigger)
      || triggerSection.items[0].name;
  }
  // 兼容：frontmatter.trigger
  if (!trigger && typeof asset.frontmatter.trigger === "string") {
    trigger = asset.frontmatter.trigger;
  }

  // boundaries：## Boundaries 段 H3 子项 → BoundaryNode[]
  const boundaries: BoundaryNode[] = [];
  const bndSection = asset.sections["Boundaries"];
  if (bndSection) {
    for (const item of bndSection.items) {
      boundaries.push({
        slot: item.name,
        deps: sArr(item.fields.deps),
        desc: s(item.fields.desc),
      });
    }
  }

  return {
    name: typeof asset.frontmatter.name === "string" ? asset.frontmatter.name : stripBlueprintSuffix(asset.name),
    channel,
    domains,
    trigger,
    boundaries: boundaries.length > 0 ? boundaries : undefined,
  };
}

function stripBlueprintSuffix(fileBase: string): string {
  // v7 命名约定：<name>.blueprint.md → 去 .blueprint 后缀
  // v6 兼容：去 .scene/.manual 后缀
  return fileBase.replace(/\.blueprint$/, "").replace(/\.(scene|manual)$/, "");
}

// ==================== 共享辅助 ====================

export { s, sArr };