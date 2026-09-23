// src/doc-index.ts — frontmatter 扫描器（Phase 3 命令层数据源）
//
// 配套 .pt/docs/issues/pt-doc-index-and-schema.md：
//   - scanDocs：扫指定 kind 目录，返回 DocRecord[]
//   - filterByProfile：按 active profile 过滤（降级兼容：无 profile 字段 = 全可见）
//   - filterByStatus：按 status 字符串过滤
//
// 设计动机：
//   - frontmatter 是真相源，命令层实时聚合（不落盘 index.md）
//   - 用 `yaml` 包替代 manual-track 的手写 key:value 解析（支持数组/嵌套）
//   - 零新依赖——只用 node:fs/promises + yaml
//   - 失败的单文件不抛，记 parseError 继续扫（命令层聚合容错）
//
// 边界纪律：
//   - 不动 parse/compile/render 三层（仅新增独立模块）
//   - 不落盘（命令层 /pt issues 等调用实时聚合，可选 Phase 4 加 index.md）

import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { parse as parseYaml } from "yaml";

/** 文档目录类型——对应 .pt/ 下三类文档目录 */
export type DocKind = "issue" | "manual" | "design";

/** 文档目录映射——kind → 相对 cwd 的目录路径 */
const KIND_DIR: Record<DocKind, string> = {
  issue: ".pt/docs/issues",
  manual: ".pt/manuals",
  design: ".pt/docs/designs",
};

/** 扫描结果——单文档的 frontmatter 提取记录
 *  - filePath：相对 cwd 的路径
 *  - fileName：去掉 .md 后缀的文件名
 *  - kind：文档类型
 *  - frontmatter：parsed YAML；null = 无 frontmatter 或解析失败
 *  - parseError：YAML 解析错误信息（容错记录，不抛） */
export interface DocRecord {
  filePath: string;
  fileName: string;
  kind: DocKind;
  frontmatter: Record<string, unknown> | null;
  parseError?: string;
}

/** 抽出 markdown 文件首段 YAML frontmatter。
 *  - 首段 `---` ... `---` 之间的内容
 *  - 用 yaml.parse 替代 manual-track 的 key:value 行解析（支持数组/嵌套/引号）
 *  - 解析失败返回 null + parseError（容错：单文件问题不影响全 scan） */
function extractFrontmatter(content: string): {
  fm: Record<string, unknown> | null;
  parseError?: string;
} {
  // 兼容 \r?\n（Windows / Unix）
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!m) return { fm: null, parseError: "无 frontmatter" };
  try {
    const parsed = parseYaml(m[1]);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { fm: null, parseError: "frontmatter 不是对象" };
    }
    return { fm: parsed as Record<string, unknown> };
  } catch (e) {
    return { fm: null, parseError: e instanceof Error ? e.message : String(e) };
  }
}

/** 扫描指定 kind 目录的 .md 文件，返回 DocRecord[]。
 *  - 目录不存在 → 返回 []（不抛，记空）
 *  - 单文件读失败 / frontmatter 解析失败 → frontmatter=null + parseError，继续扫
 *  - 性能：229 文件 × readFile(全文) + yaml.parse ≈ 50-100ms，无感 */
export async function scanDocs(cwd: string, kind: DocKind): Promise<DocRecord[]> {
  const dir = join(cwd, KIND_DIR[kind]);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return []; // 目录不存在——降级兼容
  }
  const records: DocRecord[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const filePath = relative(cwd, join(dir, entry));
    const fileName = entry.slice(0, -3); // 去 .md
    try {
      const content = await readFile(join(dir, entry), "utf8");
      const { fm, parseError } = extractFrontmatter(content);
      records.push({ filePath, fileName, kind, frontmatter: fm, parseError });
    } catch (e) {
      records.push({
        filePath,
        fileName,
        kind,
        frontmatter: null,
        parseError: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return records;
}

/** 按 active profile 过滤。profile 字段形态：
 *  - 缺省 / undefined：全 profile 可见（降级兼容未迁移文档）
 *  - 字符串：`profile === activeProfile` 则包含
 *  - 数组：`profile.includes(activeProfile)` 则包含
 *  - activeProfile=null：不激活 profile 模式，返回全部（不过滤） */
export function filterByProfile(docs: DocRecord[], activeProfile: string | null): DocRecord[] {
  if (activeProfile === null) return docs;
  return docs.filter((d) => {
    const p = d.frontmatter?.profile;
    if (p === undefined || p === null) return true; // 降级兼容
    if (typeof p === "string") return p === activeProfile;
    if (Array.isArray(p)) return p.includes(activeProfile);
    return false;
  });
}

/** 按 status 过滤（issue/design/manual 的 status 枚举不同——命令层统一处理）。
 *  - status=null：不过滤 */
export function filterByStatus(docs: DocRecord[], status: string | null): DocRecord[] {
  if (status === null) return docs;
  return docs.filter((d) => {
    const s = d.frontmatter?.status;
    return typeof s === "string" && s === status;
  });
}

/** 统计 parseError 数（命令输出"X parse errors"用） */
export function countParseErrors(docs: DocRecord[]): number {
  return docs.filter((d) => d.parseError !== undefined).length;
}
