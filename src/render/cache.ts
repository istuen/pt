// src/render/cache.ts — AgentContext 文件读写 + hash 校验
//
// v9 失效策略：sourceHash = hash(Profile + Blueprint + Domains) 组合。
// 三者任一变化即失效重编译。
//
// Phase term-P1：Context IR → AgentContext 改名同步——
//   - 文件后缀 .context.md → .agent-context.md
//   - saveContext → saveAgentContext / loadContext → loadAgentContext
//   - serializeContext → serializeAgentContext / deserializeContext → deserializeAgentContext
//
// Phase term-P4.2：cacheDir 改用 constants.CACHE_DIR 常量（替代 Blueprint.compilation.cacheDir）。
//   split 硬编码 single-file（唯一选项，by-injection-point 已 YAGNI 移除）。
//   签名删 compilation 参数。

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CACHE_DIR } from "../constants.js";
import type { AgentContext } from "../schema.js";

/** 把 AgentContext IR 序列化并写入 <CACHE_DIR>/<name>.agent-context.md。
 *  文件头：source-hash: <hash>（缓存失效依据）。 */
export async function saveAgentContext(cwd: string, ctx: AgentContext): Promise<string> {
  const dir = join(cwd, CACHE_DIR);
  await mkdir(dir, { recursive: true });

  // single-file：默认路径（<name>.agent-context.md）
  const file = join(dir, `${ctx.name}.agent-context.md`);
  const body = serializeAgentContext(ctx);
  await writeFile(file, body, "utf8");
  return file;
}

/** 读 <CACHE_DIR>/<name>.agent-context.md 并校验 sourceHash。
 *  - 文件不存在 → 返 null（首次加载）
 *  - 文件存在但 hash 不一致 → 返 null（需重编译覆盖）
 *  - 命中 → 返 AgentContext IR */
export async function loadAgentContext(
  cwd: string,
  name: string,
  expectedHash: string
): Promise<AgentContext | null> {
  const file = join(cwd, CACHE_DIR, `${name}.agent-context.md`);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return null;
  }
  const ctx = deserializeAgentContext(name, raw);
  if (!ctx) return null;
  if (ctx.sourceHash !== expectedHash) return null; // 失效，需重编译
  return ctx;
}

// ==================== 序列化/反序列化 ====================

/** AgentContext IR → 文件内容（含 sourceHash 头）。 */
function serializeAgentContext(ctx: AgentContext): string {
  const lines: string[] = [];
  lines.push("---");
  lines.push(`source-hash: ${ctx.sourceHash}`);
  lines.push(`profile: ${ctx.name}`);
  lines.push(`blueprint: ${ctx.blueprint}`);
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

/** 文件内容 → AgentContext IR。返 null 表示格式损坏。 */
function deserializeAgentContext(name: string, raw: string): AgentContext | null {
  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!fmMatch) return null;
  const fm: Record<string, string> = {};
  for (const line of fmMatch[1].split(/\r?\n/)) {
    const kv = line.match(/^([a-zA-Z_-]+)\s*:\s*(.+)$/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  const hash = fm["source-hash"];
  const fmName = fm.profile ?? fm.name ?? name;
  const fmBlueprint = fm.blueprint ?? "";
  if (!hash) return null;

  const body = fmMatch[2];
  const modules: Record<string, string> = {};
  // 按 ## H2 切分（保留段内换行）
  const sectionRe = /^## (.+)$/gm;
  const matches: Array<{ name: string; start: number; end: number }> = [];
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop pattern
  while ((m = sectionRe.exec(body)) !== null) {
    matches.push({ name: m[1].trim(), start: m.index + m[0].length + 1, end: body.length });
  }
  // 排序每个段的结束位置
  for (let i = 0; i < matches.length; i++) {
    const cur = matches[i];
    const next = matches[i + 1];
    cur.end = next ? next.start - `## ${next.name}`.length - 2 : body.length;
  }
  for (const sec of matches) {
    modules[sec.name] = body.slice(sec.start, sec.end).trim();
  }

  return { name: fmName, blueprint: fmBlueprint, sourceHash: hash, modules };
}
