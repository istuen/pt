// src/health-state.ts — 项目健康状态持久化（issue pt-cold-start-warning-noise 修复）
//
// 设计动机：scanProjectHealth 在 session_start 末批量体检，存量项目常带 4+ errors
// （如本 pt 项目）。每次启动 session 都 `ctx.ui.notify(summary, "warning")` →
// 用户体验："我没改任何东西却反复被警告轰炸"。
//
// 修复（§短期方案 1）：
//   - 把 issue 列表计算稳定 hash（不依赖 timestamp / 顺序）
//   - hash 跨 session 持久化到 .pt/state/last-health-hash
//   - session_start 只在 hash 变化时 notify；不变时仅 footer 染色
//   - 边界：hash 计算抛错 / state 文件读写失败 → 降级到"始终 notify"（back-compat 行为）
//
// 边界纪律：
//   - 不引入新依赖——只用 node:crypto + node:fs/promises（与 file-hash.ts 同源）
//   - 不阻塞 session_start——读/写 IO 失败一律 swallow 并 log warn
//   - 不修改 scanProjectHealth 内部——hash 在调用方计算（report.issues 出来后）

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AssetHealthIssue } from "./asset-health.js";
import { STATE_DIR } from "./constants.js";
import { errMsg } from "./diagnostics.js";

/** state 文件名（§短期方案 1）——单文件存"上次健康扫描 hash"。
 *  未来若需要持久化更多跨 session state（transient validation counts 等），
 *  应改 JSON 结构而非加新文件（避免散落）。 */
const HEALTH_HASH_FILE = "last-health-hash.json";

/** 持久化的 hash 文件结构。带 schemaVersion 字段以便未来 schema 演进。 */
interface PersistedHealthHash {
  schemaVersion: 1;
  /** sha256 16-hex（前 16 字符）—— 够防碰撞 + 节省空间 */
  hash: string;
  /** issue 总数（辅助 debug，不参与去重判断——hash 是唯一 truth） */
  issueCount: number;
  /** ISO 时间戳（debug 用，不参与去重） */
  updatedAt: string;
}

/** 计算 issue 列表的稳定 hash（issue pt-cold-start-warning-noise §短期方案 1）。
 *
 * 稳定性保证：
 *   - 按 (severity, scope, name, field, msg) 排序后拼接 —— issues 数组顺序不固定也能稳定
 *   - msg 也参与 hash —— 同 code + 同 name 但 msg 不同时视为不同（设计性变化要告知用户）
 *   - hint / fix 不参与 hash —— 它们是 hint 性变化，不弹通知
 *
 *  返回 sha256 16-hex（前 16 字符）—— 与 sourceHash 同粒度（ref-resolver.ts:124 用同样切法）。
 *  返回空字符串：issues.length === 0 —— 调用方把空 hash 也视为"无 issue"状态。 */
export function computeHealthHash(issues: AssetHealthIssue[]): string {
  if (issues.length === 0) return "";
  // 稳定排序：先 severity（error < warning < info），后 name，再后 field（field 可能 undefined）
  const SORT_ORDER: Record<string, number> = { error: 0, warning: 1, info: 2 };
  const sorted = [...issues].sort((a, b) => {
    const sa = SORT_ORDER[a.severity] ?? 99;
    const sb = SORT_ORDER[b.severity] ?? 99;
    if (sa !== sb) return sa - sb;
    if (a.name !== b.name) return a.name.localeCompare(b.name);
    const af = a.field ?? "";
    const bf = b.field ?? "";
    if (af !== bf) return af.localeCompare(bf);
    return a.msg.localeCompare(b.msg);
  });
  const payload = sorted
    .map((i) => `${i.severity}|${i.scope}|${i.name}|${i.field ?? ""}|${i.msg}`)
    .join("\n");
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

/** 读 .pt/state/last-health-hash.json 里的 hash。
 *  文件不存在 / parse 失败 / IO 失败 → 返 null（视为"首次启动"）。 */
export async function readPersistedHealthHash(cwd: string): Promise<string | null> {
  try {
    const raw = await readFile(join(cwd, STATE_DIR, HEALTH_HASH_FILE), "utf8");
    const parsed = JSON.parse(raw) as PersistedHealthHash;
    if (typeof parsed.hash === "string" && parsed.hash.length > 0) return parsed.hash;
    return null;
  } catch {
    return null; // 文件不存在 / parse 失败 → 视为首次
  }
}

/** 写 hash 到 .pt/state/last-health-hash.json。
 *  IO 失败一律 swallow（log warn 通过 adapterCtx.log 可选传入；本函数可裸调）。
 *  - 写时用 { flag: "wx" } 防止覆盖竞态——冲突时 swallow（另一 session 抢先写了 OK）。
 *  - mkdir recursive — 目录不存在时建。 */
export async function writePersistedHealthHash(
  cwd: string,
  hash: string,
  issueCount: number,
  logger?: { warn(msg: string, details?: Record<string, unknown>): void }
): Promise<void> {
  if (hash === "") return; // 无 issue 不持久化（避免 cache miss 时误报"无 issue 变化"）
  const payload: PersistedHealthHash = {
    schemaVersion: 1,
    hash,
    issueCount,
    updatedAt: new Date().toISOString(),
  };
  const dir = join(cwd, STATE_DIR);
  const file = join(dir, HEALTH_HASH_FILE);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(file, JSON.stringify(payload, null, 2) + "\n", "utf8");
  } catch (e) {
    logger?.warn("writePersistedHealthHash failed", {
      err: errMsg(e),
      file,
    });
  }
}
