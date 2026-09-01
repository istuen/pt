// src/render/cache.ts — Context 文件读写 + hash 校验
//
// Phase 8.5：v8 缓存配置从 Blueprint.Compilation 取（替代 v7 硬编码 .pt/contexts/cache）。
//   - cacheDir：从 Blueprint.compilation.cacheDir 读
//   - split：single-file / by-injection-point（本步只实现 single-file，by-injection-point 留 TODO）
//
// 失效策略：sourceHash = hash(Domains + Channel + Blueprint) 组合。
// 三者任一变化即失效重编译。

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CompilationConfig, Context } from "../schema.js";

/** 把 Context IR 序列化并写入 <cacheDir>/<name>.context.md。
 *  文件头：source-hash: <hash>（缓存失效依据）。 */
export async function saveContext(cwd: string, ctx: Context, compilation: CompilationConfig): Promise<string> {
  const dir = join(cwd, compilation.cacheDir);
  await mkdir(dir, { recursive: true });

  if (compilation.split === "by-injection-point") {
    // TODO：v8.5 留作扩展——按注入点拆多文件，本步先实现 single-file
    // 实现要点：每个注入点一个 <name>.<ipName>.md，frontmatter 含 ipName 标记
  }

  // single-file：默认路径
  const file = join(dir, `${ctx.name}.context.md`);
  const body = serializeContext(ctx);
  await writeFile(file, body, "utf8");
  return file;
}

/** 读 <cacheDir>/<name>.context.md 并校验 sourceHash。
 *  - 文件不存在 → 返 null（首次加载）
 *  - 文件存在但 hash 不一致 → 返 null（需重编译覆盖）
 *  - 命中 → 返 Context IR */
export async function loadContext(
  cwd: string,
  name: string,
  expectedHash: string,
  compilation: CompilationConfig,
): Promise<Context | null> {
  // v8：按 compilation.split 决定文件名
  //   - single-file：<name>.context.md
  //   - by-injection-point：<name>.<ipName>.md（多文件）→ 本步未实现，按 single-file fallback
  const file = join(cwd, compilation.cacheDir, `${name}.context.md`);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return null;
  }
  const ctx = deserializeContext(name, raw);
  if (!ctx) return null;
  if (ctx.sourceHash !== expectedHash) return null;  // 失效，需重编译
  return ctx;
}

// ==================== 序列化/反序列化 ====================

/** Context IR → 文件内容（含 sourceHash 头）。 */
function serializeContext(ctx: Context): string {
  const lines: string[] = [];
  lines.push("---");
  lines.push(`source-hash: ${ctx.sourceHash}`);
  lines.push(`name: ${ctx.name}`);
  lines.push("---");
  lines.push("");
  for (const [h2Name, content] of Object.entries(ctx.modules)) {
    lines.push(`## ${h2Name}`);
    lines.push("");
    lines.push(content);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

/** 文件内容 → Context IR。返 null 表示格式损坏。 */
function deserializeContext(name: string, raw: string): Context | null {
  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!fmMatch) return null;
  const fm: Record<string, string> = {};
  for (const line of fmMatch[1].split(/\r?\n/)) {
    const kv = line.match(/^([a-zA-Z_-]+)\s*:\s*(.+)$/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  const hash = fm["source-hash"];
  const fmName = fm["name"] ?? name;
  if (!hash) return null;

  const body = fmMatch[2];
  const modules: Record<string, string> = {};
  // 按 ## H2 切分（保留段内换行）
  const sectionRe = /^## (.+)$/gm;
  const matches: Array<{ name: string; start: number; end: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = sectionRe.exec(body)) !== null) {
    matches.push({ name: m[1].trim(), start: m.index + m[0].length + 1, end: body.length });
  }
  // 排序每个段的结束位置
  for (let i = 0; i < matches.length; i++) {
    const cur = matches[i];
    const next = matches[i + 1];
    cur.end = next ? next.start - ("## " + next.name).length - 2 : body.length;
  }
  for (const sec of matches) {
    modules[sec.name] = body.slice(sec.start, sec.end).trim();
  }

  return { name: fmName, sourceHash: hash, modules };
}
