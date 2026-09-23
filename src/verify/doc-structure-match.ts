// src/verify/doc-structure-match.ts — 验证文档 frontmatter 符合 schema 规范
//
// 设计动机（.pt/docs/issues/pt-doc-index-and-schema.md §实施）：
//   - 不引 ajv（零运行时依赖哲学）；自写极简校验器覆盖 required + enum + type + 简单 if/then
//   - 字段：path（文档相对路径）+ schema（schema 文件名）
//   - 三态返回：COMPLETED（合规）/ DEVIATED（违规，含错误清单）/ INCONCLUSIVE（缺参数/IO 错）
//
// 边界纪律：
//   - 不支持 $ref / oneOf / 嵌套对象——若未来需要再评估引 ajv（保持 §Phase 3 极简）
//   - date / date-time 格式不做正则校验（schema 中格式提示已足；需严校验用 ajv）
//   - 不抛：任何 IO/parse 异常都进 ProbeOutcome.message
//
// 用法（手册 observe 字段）：
//   observe:
//     probe: doc-structure-match
//     params:
//       path: .pt/docs/issues/<name>.md
//       schema: issue.frontmatter.schema.json

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { BUILTIN_SCHEMAS_DIR } from "../constants.js";
import type { ProbeOutcome } from "../schema.js";

/** schema 极简结构（只取实现需要的字段） */
interface PropertySpec {
  type?: string;
  enum?: string[];
  minItems?: number;
  uniqueItems?: boolean;
  const?: unknown;
  items?: { type?: string };
  oneOf?: Array<{
    type?: string;
    items?: { type?: string };
    minItems?: number;
    uniqueItems?: boolean;
  }>;
}

interface SimpleSchema {
  required?: string[];
  properties?: Record<string, PropertySpec>;
  allOf?: Array<{
    if?: { properties?: Record<string, { const?: unknown }>; required?: string[] };
    then?: { required?: string[] };
  }>;
}

/** 抽取 markdown 首段 YAML frontmatter（内联，避免依赖 doc-index）。 */
function readFrontmatter(content: string): Record<string, unknown> | null {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!m) return null;
  const parsed = parseYaml(m[1]);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

/** 校验单个字段：返回错误串数组（空 = 合法）。
 *  spec 是 schema.properties[name]；value 是 frontmatter[name] */
function validateFieldSpec(fieldName: string, value: unknown, spec: PropertySpec): string[] {
  const errors: string[] = [];
  // type 检查
  if (spec.type && value !== undefined) {
    const got = Array.isArray(value) ? "array" : typeof value;
    if (got !== spec.type) {
      errors.push(`${fieldName}: expected ${spec.type}, got ${got}`);
      return errors; // type 错则跳过后续校验（避免噪音）
    }
  }
  // enum 检查
  if (spec.enum && value !== undefined && typeof value !== "string") {
    // enum 字段应字符串——非字符串已 type 阶段报错；此处防御
    errors.push(`${fieldName}: enum 字段应字符串`);
    return errors;
  }
  if (spec.enum && typeof value === "string" && !spec.enum.includes(value)) {
    errors.push(`${fieldName}: '${value}' not in enum [${spec.enum.join(", ")}]`);
  }
  // const 检查
  if (spec.const !== undefined && value !== spec.const) {
    errors.push(`${fieldName}: expected const '${String(spec.const)}', got '${String(value)}'`);
  }
  // items 检查（数组的 item type）
  if (spec.type === "array" && spec.items && Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const item = value[i];
      const itemGot = Array.isArray(item) ? "array" : typeof item;
      if (spec.items.type && itemGot !== spec.items.type) {
        errors.push(`${fieldName}[${i}]: expected ${spec.items.type}, got ${itemGot}`);
      }
    }
  }
  // minItems 检查
  if (spec.minItems !== undefined && Array.isArray(value) && value.length < spec.minItems) {
    errors.push(`${fieldName}: array 长度 ${value.length} < minItems ${spec.minItems}`);
  }
  // uniqueItems 检查（浅比较——内部数组也按 JSON.stringify 比对）
  if (spec.uniqueItems && Array.isArray(value)) {
    const seen = new Set<string>();
    for (const item of value) {
      const k = JSON.stringify(item);
      if (seen.has(k)) {
        errors.push(`${fieldName}: uniqueItems 重复 ${k}`);
        break;
      }
      seen.add(k);
    }
  }
  return errors;
}

/** oneOf 分支解析——选第一条 type 匹配的分支校验 */
function applyOneOf(fieldName: string, value: unknown, branches: PropertySpec["oneOf"]): string[] {
  if (!branches || branches.length === 0) return [];
  // 选第一条 type 匹配的分支
  const valueType = Array.isArray(value) ? "array" : typeof value;
  for (const branch of branches) {
    if (branch.type === undefined) {
      // 无 type 约束的分支（如约束 items.uniqueItems）——作 default
      return [];
    }
    if (branch.type === valueType) {
      // 命中：继续校验 items / minItems
      const errs: string[] = [];
      if (valueType === "array" && Array.isArray(value)) {
        if (branch.items?.type) {
          for (let i = 0; i < value.length; i++) {
            const itemGot = Array.isArray(value[i]) ? "array" : typeof value[i];
            if (itemGot !== branch.items.type) {
              errs.push(`${fieldName}[${i}]: expected ${branch.items.type}, got ${itemGot}`);
            }
          }
        }
        if (branch.minItems !== undefined && value.length < branch.minItems) {
          errs.push(`${fieldName}: array 长度 ${value.length} < minItems ${branch.minItems}`);
        }
        if (branch.uniqueItems) {
          const seen = new Set<string>();
          for (const item of value) {
            const k = JSON.stringify(item);
            if (seen.has(k)) {
              errs.push(`${fieldName}: uniqueItems 重复 ${k}`);
              break;
            }
            seen.add(k);
          }
        }
      }
      return errs;
    }
  }
  // 没命中任一 type 分支
  return [
    `${fieldName}: value type '${valueType}' not in oneOf [${branches.map((b) => b.type).join(", ")}]`,
  ];
}

/** 文档校验结果（供 doc-structure-match probe + checkDocsText 命令共享） */
export interface DocValidationResult {
  ok: boolean;
  errors: string[];
  /** 仅供错误信息输出——文档路径（绝对或相对） */
  docPath: string;
  /** 内联原因（如 “无 frontmatter”） */
  reason?: string;
}

/** 两级查找 schema 文件路径：项目级覆盖 > builtin 默认。
 *  - 项目级：`cwd/.pt/schemas/<schemaName>`（用户自建覆盖，粒度 = 单文件名）
 *  - builtin fallback：`src/builtin/schemas/<schemaName>`（随包发布，跨项目复用）
 *  - 返回 null 表示两级都不存在（调用方决定 INCONCLUSIVE / 抛错） */
export function resolveSchemaPath(cwd: string, schemaName: string): string | null {
  const projectSchemaPath = join(cwd, ".pt", "schemas", schemaName);
  if (existsSync(projectSchemaPath)) return projectSchemaPath;
  const builtinSchemaPath = join(BUILTIN_SCHEMAS_DIR, schemaName);
  if (existsSync(builtinSchemaPath)) return builtinSchemaPath;
  return null;
}

/** 内核函数：给定文档路径 + schema 名，返回校验结果（不构造 ProbeOutcome）。
 *  - 错误格式：完整错误描述列表（供 probe / 命令层格式化）
 *  - IO 错误不熔，抛 Error（命令层 / probe 层各自决定 INCONCLUSIVE / 错误提示） */
export async function validateDoc(
  cwd: string,
  docPath: string,
  schemaName: string
): Promise<DocValidationResult> {
  // 1. 读 schema（两级查找：项目级覆盖 > builtin fallback）
  const schemaPath = resolveSchemaPath(cwd, schemaName);
  if (!schemaPath) {
    throw new Error(
      `schema 未找到：项目级 ${join(cwd, ".pt", "schemas", schemaName)} 与 builtin ${join(BUILTIN_SCHEMAS_DIR, schemaName)} 均不存在`
    );
  }
  const schema: SimpleSchema = JSON.parse(readFileSync(schemaPath, "utf8"));

  // 2. 读文档 frontmatter
  const fm = readFrontmatter(readFileSync(join(cwd, docPath), "utf8"));
  if (!fm) {
    return {
      ok: false,
      errors: [],
      docPath,
      reason: "无 frontmatter 或 frontmatter 不是对象",
    };
  }

  // 3. 校验 required
  const errors: string[] = [];
  for (const field of schema.required ?? []) {
    if (!(field in fm) || fm[field] === undefined || fm[field] === null) {
      errors.push(`missing required: ${field}`);
    }
  }

  // 4. 校验每个 property
  for (const [fieldName, spec] of Object.entries(schema.properties ?? {})) {
    const value = fm[fieldName];
    if (value === undefined) continue;
    errors.push(...validateFieldSpec(fieldName, value, spec));
    if (spec.oneOf) {
      errors.push(...applyOneOf(fieldName, value, spec.oneOf));
    }
  }

  // 5. simple if/then
  for (const rule of schema.allOf ?? []) {
    const cond = rule.if;
    if (!cond?.properties || !rule.then?.required) continue;
    for (const [condField, condSpec] of Object.entries(cond.properties)) {
      if (condSpec.const === undefined) continue;
      if (fm[condField] !== condSpec.const) continue;
      for (const required of rule.then.required) {
        if (!(required in fm) || fm[required] === undefined || fm[required] === null) {
          errors.push(
            `missing required (conditional): ${required} (status=${String(condSpec.const)} requires ${required})`
          );
        }
      }
    }
  }

  return { ok: errors.length === 0, errors, docPath };
}

/** doc-structure-match probe：校验文档 frontmatter 是否符合指定 schema 文件。
 *  - params.path：文档相对路径（如 .pt/docs/issues/xxx.md）
 *  - params.schema：schema 文件名（如 issue.frontmatter.schema.json） */
export async function docStructureMatch(
  cwd: string,
  params: Record<string, string>
): Promise<ProbeOutcome> {
  const docPath = params.path;
  if (!docPath) return { outcome: "INCONCLUSIVE", message: "缺少参数: path" };
  const schemaName = params.schema;
  if (!schemaName) {
    return {
      outcome: "INCONCLUSIVE",
      message: "缺少参数: schema（如 issue.frontmatter.schema.json）",
    };
  }

  let result: DocValidationResult;
  try {
    result = await validateDoc(cwd, docPath, schemaName);
  } catch (e) {
    return {
      outcome: "INCONCLUSIVE",
      message: e instanceof Error ? e.message : String(e),
    };
  }

  if (result.reason) {
    return { outcome: "DEVIATED", message: `${docPath}: ${result.reason}` };
  }
  if (!result.ok) {
    return {
      outcome: "DEVIATED",
      message: `${docPath} ≠ ${schemaName}: ${result.errors.join("; ")}`,
    };
  }
  return { outcome: "COMPLETED", message: `${docPath} ✓ ${schemaName}` };
}
