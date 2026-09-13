// src/render/cache.ts — AgentContext 文件读写 + hash 校验
//
// v9 失效策略：sourceHash = hash(Profile + Blueprint + Domains) 组合。
// 三者任一变化即失效重编译。
//
// v15.x PR2（§8.1）：sourceHash 加 packs 维度——pack 内容变化触发失效。
// v15.x PR2（§8.3）：cache 文件名 <pack>__<profile>.agent-context.md（sanitize 特殊字符）。
// v15.x PR2（§9.4.1）：旧缓存清理——loadAgentContext 检测旧名 → 删除 → 触发重编译。
//
// Phase term-P1：Context IR → AgentContext 改名同步——
//   - 文件后缀 .context.md → .agent-context.md
//   - saveContext → saveAgentContext / loadContext → loadAgentContext
//   - serializeContext → serializeAgentContext / deserializeContext → deserializeAgentContext
//
// Phase term-P4.2：cacheDir 改用 constants.CACHE_DIR 常量（替代 Blueprint.compilation.cacheDir）。
//   split 硬编码 single-file（唯一选项，by-injection-point 已 YAGNI 移除）。
//   签名删 compilation 参数。

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CACHE_DIR } from "../constants.js";
import type { AgentContext } from "../schema.js";

/** v15.x PR2（§8.3）：cache 文件名 <pack>__<profile>.agent-context.md，
 *  sanitize 非法字符为 _（pack 名已是 kebab-case 通常不需要；profile 名可能含特殊字符）。 */
function cacheFileName(packName: string, profileName: string): string {
  const sanitize = (s: string): string => s.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${sanitize(packName)}__${sanitize(profileName)}.agent-context.md`;
}

/** 把 AgentContext IR 序列化并写入 <CACHE_DIR>/<pack>__<name>.agent-context.md。
 *  文件头：source-hash: <hash>（缓存失效依据）+ pack: <packName>。 */
export async function saveAgentContext(cwd: string, ctx: AgentContext): Promise<string> {
  const dir = join(cwd, CACHE_DIR);
  await mkdir(dir, { recursive: true });

  // v15.x PR2（§8.3）：cache 文件名 <pack>__<profile>.agent-context.md
  const file = join(dir, cacheFileName(ctx.packName, ctx.name));
  const body = serializeAgentContext(ctx);
  await writeFile(file, body, "utf8");
  return file;
}

/** 读 <CACHE_DIR>/<pack>__<name>.agent-context.md 并校验 sourceHash。
 *  - 文件不存在 → 触发 §9.4.1 旧缓存清理：检测旧名 <name>.agent-context.md → 删除 → 返 null（重编译）
 *  - 文件存在但 hash 不一致 → 返 null（需重编译覆盖）
 *  - 命中 → 返 AgentContext IR
 *  v15.x PR2（§8.3）：签名加 packName 参数；旧名 <profile>.agent-context.md 自动清理迁移。 */
export async function loadAgentContext(
  cwd: string,
  packName: string,
  name: string,
  expectedHash: string
): Promise<AgentContext | null> {
  const file = join(cwd, CACHE_DIR, cacheFileName(packName, name));
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    // §9.4.1：旧缓存清理——新名不存在时尝试旧名
    return await tryLoadOldCacheAndCleanup(cwd, name, expectedHash);
  }
  const ctx = deserializeAgentContext(name, raw);
  if (!ctx) return null;
  if (ctx.sourceHash !== expectedHash) return null; // 失效，需重编译
  return ctx;
}

/** v15.x PR2（§9.4.1）：旧缓存清理——升级后旧名 <profile>.agent-context.md 检测 + 删除。
 *  旧文件存在时删除（无论 hash 是否匹配），返 null 触发 saveAgentContext 以新名重写。
 *  未传 packName 也能工作（旧名无 pack 概念，默认归 "prj"——但会被清理掉，不会真用到）。 */
async function tryLoadOldCacheAndCleanup(
  cwd: string,
  name: string,
  _expectedHash: string
): Promise<AgentContext | null> {
  const oldFile = join(cwd, CACHE_DIR, `${name}.agent-context.md`);
  try {
    await readFile(oldFile, "utf8");
  } catch {
    return null; // 旧名也不存在——首次加载
  }
  // 旧文件存在——无论 hash 是否匹配都删除（新名格式不同，重编译）
  await rm(oldFile, { force: true });
  return null; // 返 null 触发 saveAgentContext 以新名重写
}

// ==================== 序列化/反序列化 ====================

/** AgentContext IR → 文件内容（含 sourceHash 头 + pack 字段）。 */
function serializeAgentContext(ctx: AgentContext): string {
  const lines: string[] = [];
  lines.push("---");
  lines.push(`source-hash: ${ctx.sourceHash}`);
  lines.push(`pack: ${ctx.packName}`); // v15.x PR2 新增
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
  // v15.x PR2（§9.4.1）：旧 cache 无 pack 字段时兜底 "prj"——但 §9.4.1 tryLoadOldCacheAndCleanup
  // 会先删除旧文件，不会真用到兜底。这里兜底仅为 deserialize 容错。
  const fmPack = fm.pack ?? "prj";
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

  return { name: fmName, blueprint: fmBlueprint, sourceHash: hash, modules, packName: fmPack };
}

/** v15.x PR2（§8.3）：导出 cacheFileName 给测试用。 */
export { cacheFileName };
