// src/render/cache.ts — Context 文件读写 + hash 校验
//
// Phase 7.6：Context 物理文件缓存（.pt/contexts/cache/*.context.md）。
//   - saveContext(ctx): 写文件（含 sourceHash 头）
//   - loadContext(cwd, name): 读文件，比对 sourceHash，命中返缓存，未命中返 null
//
// 失效策略：sourceHash = hash(Domains + Channel + Blueprint) 组合。
// 三者任一变化即失效重编译。

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "../schema.js";

const CACHE_DIR = ".pt/contexts/cache";

/** 把 Context IR 序列化并写入 .pt/contexts/cache/<name>.context.md。
 *  文件头：source-hash: <hash>（缓存失效依据）。 */
export async function saveContext(cwd: string, ctx: Context): Promise<string> {
  const dir = join(cwd, CACHE_DIR);
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${ctx.name}.context.md`);
  const body = serializeContext(ctx);
  await writeFile(file, body, "utf8");
  return file;
}

/** 读 .pt/contexts/cache/<name>.context.md 并校验 sourceHash。
 *  - 文件不存在 → 返 null（首次加载）
 *  - 文件存在但 hash 不一致 → 返 null（需重编译覆盖）
 *  - 命中 → 返 Context IR */
export async function loadContext(cwd: string, name: string, expectedHash: string): Promise<Context | null> {
  const file = join(cwd, CACHE_DIR, `${name}.context.md`);
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