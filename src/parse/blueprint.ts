// src/parse/blueprint.ts — blueprints/*.md → Blueprint IR
//
// Phase 9.3：v9 适配 — Blueprint 直接拥有 injectionPoints（v8 Channel 吸收进来）。
//   - ## <注入点名> : 注入点定义（H2 名=注入点人类自定义名）
//     - target: <system_prompt|context_message|扩展>
//     - mode: <byDomain|byType|hybrid>
//     - ### Modules : 聚合点（Domain H2 段名列表，data-driven）
//   - ## Compilation : 编译方式（cache-dir + split）
//
// Blueprint asset 格式（v9）：
//   ---
//   name: <blueprint-name>
//   agent: pi
//   ---
//
//   ## 会话知识                          ← H2 = 注入点（人类自定义名）
//   target: system_prompt
//   mode: hybrid
//   ### Modules                          ← 聚合点列表
//   - Scene
//   - Trigger
//
//   ## 参考手册
//   target: context_message
//   ### Modules
//   - Manual
//
//   ## Compilation
//   cache-dir: .pt/cache/contexts/
//   split: single-file
//
// Tech Debt T6: 用 constants + type guard（pt-quality #1/#4/#5）

import { join } from "node:path";
import { CACHE_DIR, SUFFIX_BLUEPRINT } from "../constants.js";
import type {
  Blueprint,
  CacheSplitStrategy,
  CompilationConfig,
  InjectionPointConfig,
  StructureLayout,
} from "../schema.js";
import { extractFieldValue, extractModulesList, readAsset, type Section } from "./shared.js";

const VALID_MODES: ReadonlyArray<StructureLayout["mode"]> = ["byDomain", "byType", "hybrid"];

/** 读 blueprints/<fileName>.md → Blueprint { name, agent, injectionPoints, compilation }
 *  v10.x：assetDir 让 fixtures 可指向 tests/fixtures/assets/（默认 .pt/assets）。 */
export async function parseBlueprint(absDir: string, fileName: string): Promise<Blueprint> {
  const asset = await readAsset(join(absDir, fileName));

  const agent = typeof asset.frontmatter.agent === "string" ? asset.frontmatter.agent : "pi";

  // injectionPoints：每个非特殊 H2 = 一个注入点定义
  const injectionPoints: InjectionPointConfig[] = [];
  for (const [h2Name, section] of Object.entries(asset.sections)) {
    if (h2Name === "Compilation") continue;
    injectionPoints.push(parseInjectionPointFromSection(h2Name, section));
  }

  // compilation：## Compilation 段
  const compilation = parseCompilationFromSection(asset.sections["Compilation"]);

  return {
    name:
      typeof asset.frontmatter.name === "string"
        ? asset.frontmatter.name
        : stripBlueprintSuffix(asset.name),
    agent,
    injectionPoints,
    compilation,
  };
}

/** 把一个 H2 段解析为 InjectionPointConfig（v9 Blueprint 直接拥有，逻辑同 v8 Channel）。 */
function parseInjectionPointFromSection(h2Name: string, section: Section): InjectionPointConfig {
  const targetRaw = extractFieldValue(section, "target") || "system_prompt";
  const modeRaw = extractFieldValue(section, "mode");
  const modules = extractModulesList(section);

  const mode: StructureLayout["mode"] | undefined =
    modeRaw && isValidMode(modeRaw) ? modeRaw : undefined;

  // target 未严格收窄（扩展 InjectionTarget 可含任意字符串，如未来 Agent 扩展）
  const ip: InjectionPointConfig = {
    name: h2Name,
    target: targetRaw,
    modules,
  };
  if (mode) ip.mode = mode;
  return ip;
}

function isValidMode(x: string): x is StructureLayout["mode"] {
  return (VALID_MODES as readonly string[]).includes(x);
}

/** 解析 ## Compilation 段 → CompilationConfig。 */
function parseCompilationFromSection(section: Section | undefined): CompilationConfig {
  if (!section) {
    return { cacheDir: CACHE_DIR, split: "single-file" };
  }
  const cacheDir = extractFieldValue(section, "cache-dir") || CACHE_DIR;
  const splitRaw = extractFieldValue(section, "split") || "single-file";
  const split: CacheSplitStrategy =
    splitRaw === "by-injection-point" ? "by-injection-point" : "single-file";
  return { cacheDir, split };
}

function stripBlueprintSuffix(fileBase: string): string {
  // v9 命名约定：<name>.blueprint.md → 去 .blueprint 后缀
  // v8 兼容：去 .scene/.manual 后缀
  return fileBase.replace(new RegExp(`${SUFFIX_BLUEPRINT}$`), "").replace(/\.(scene|manual)$/, "");
}
