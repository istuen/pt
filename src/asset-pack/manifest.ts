// src/asset-pack/manifest.ts — pt-asset-pack.yaml manifest 解析（v15.x PR2 + PR7）
//
// 设计源：.pt/docs/designs/pt-asset-pack.md §2.2（manifest 格式）+ §2.4.1（命名约束）
//
// 职责：解析 <rootDir>/pt-asset-pack.yaml（可选），提取 name/version/description。
// 所有问题收集到 warnings——不抛异常，调用方走默认值（§2.2 校验规则）。
//
// PR2 阶段保留名 reserved pack（source=project/builtin）跳过 manifest，
//  用固定名 prj/pt——见 md-file-pack.ts create()。
//
// PR7（issue pt-remove-global-pack 移除）：global pack 删除，reserved pack 从
//  3 类收敛为 2 类（project/builtin）。
//
// semver 正则按设计文档 §2.2 固定（不引 semver 包）。

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { errMsg } from "../diagnostics.js";
import type { PackSource } from "../schema.js";

/** manifest 解析结果。ok=false 表示文件不存在/解析失败/校验不过——调用方走默认值。 */
export interface ParsedManifest {
  /** 文件存在且 YAML 解析成功（name/version/description 校验失败仍 ok=true，错误进 warnings）。 */
  ok: boolean;
  /** 合法 kebab-case name（ok=true 且 manifest 有 name 且校验通过时） */
  name?: string;
  /** 合法 semver（ok=true 且 manifest 有 version 且校验通过时） */
  version?: string;
  /** 原样保留（仅诊断用） */
  description?: string;
  /** 非致命问题（name 非 kebab / version 非 semver / 保留名冲突 / top-level 不是 mapping） */
  warnings: string[];
}

/** reserved pack 名（§2.4.1 精确匹配禁用）+ 别名兼容。
 *  精确匹配，不是前缀禁用——`pt-internal` 合法；只有完全等于集合内值才触发冲突。
 *  v15.x PR7（issue pt-remove-global-pack 移除）：删除 `gbl`/`global`——全局 pack
 *  不再存在，这两个名字从 reserved 名中移出。 */
const RESERVED_NAMES: ReadonlySet<string> = new Set(["prj", "pt", "project", "builtin"]);

/** semver 正则（§2.2 实现备注）。
 *  格式：<major>.<minor>.<patch>[-<pre-release>][+<build>]
 *  pre-release / build 标识符字符集：[0-9A-Za-z.-] */
const SEMVER_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

/** kebab-case 正则（§2.4.1：[a-z0-9-]+，1-64 字符）。 */
const KEBAB_RE = /^[a-z0-9-]{1,64}$/;

/**
 * 解析 <rootDir>/pt-asset-pack.yaml（可选）。
 * - 文件不存在 → { ok: false, warnings: [] }（隐式 pack，走 basename 兜底）
 * - 文件存在但解析失败 → { ok: false, warnings: ["manifest parse failed: ..."] }
 * - name 非 kebab-case / 保留名冲突 → warnings + name 丢弃（走 basename）
 * - version 非 semver → warnings + version 丢弃（走 "0.0.0"）
 *
 * v15.x builtin 特例：source="builtin" 时 manifest.name 等于保留名合法
 * （位置 alias @pt = 身份 alias 合一；builtin pack 的"身份"就是"内置"）。
 * project/settings pack 仍禁用保留名（保护位置 slot）。
 *
 * 永远不抛异常（§2.2 校验规则：解析失败当无 manifest 处理，不阻断加载）。
 */
export async function parseManifest(rootDir: string, source?: PackSource): Promise<ParsedManifest> {
  const file = join(rootDir, "pt-asset-pack.yaml");
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    // 文件不存在 → 隐式 pack
    return { ok: false, warnings: [] };
  }

  let data: unknown;
  try {
    data = parseYaml(raw);
  } catch (e) {
    return { ok: false, warnings: [`manifest parse failed: ${errMsg(e)}`] };
  }

  if (!isRecord(data)) {
    return { ok: false, warnings: ["manifest top-level not a mapping"] };
  }

  const warnings: string[] = [];
  let name: string | undefined;
  let version: string | undefined;
  let description: string | undefined;

  // name 校验
  if (typeof data.name === "string" && data.name.trim()) {
    const n = data.name.trim();
    if (!KEBAB_RE.test(n)) {
      warnings.push(
        `[repair-required][name-kebab] manifest.name "${n}" not kebab-case, fallback: basename. Auto-fix: /pt_turn_inject pack-management#pack-repair`
      );
    } else if (RESERVED_NAMES.has(n) && source !== "builtin") {
      // v15.x builtin 特例：source="builtin" 时保留名（prj/pt）合法——位置 alias = 身份 alias 合一。
      // 其他 source（project/settings）仍禁用保留名：位置 slot 是 reserved pack 的，身份 alias
      // 不能占用。project pack 应该用跨项目身份名（如 pt-internal）走身份寻址，不是用保留名。
      warnings.push(
        `[repair-required][name-reserved] manifest.name "${n}" is reserved, fallback: basename. Auto-fix: /pt_turn_inject pack-management#pack-repair`
      );
    } else {
      name = n;
    }
  }

  // version 校验
  if (typeof data.version === "string" && data.version.trim()) {
    const v = data.version.trim();
    if (!SEMVER_RE.test(v)) {
      warnings.push(
        `[repair-required][version-semver] manifest.version "${v}" not semver, default: "0.0.0". Auto-fix: /pt_turn_inject pack-management#pack-repair`
      );
    } else {
      version = v;
    }
  }

  // description 原样保留（仅诊断用，无校验）
  if (typeof data.description === "string" && data.description.trim()) {
    description = data.description.trim();
  }

  return { ok: true, name, version, description, warnings };
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === "object" && !Array.isArray(x);
}
