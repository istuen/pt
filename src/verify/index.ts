// src/verify/index.ts — verify 注册表 + runVerify 入口
//
// P1：observe 字段的实现库。纯函数 (cwd, params) => ProbeOutcome，不依赖 OXN 的 kernel/verdict 链。
// 加新 probe = 注册表加一行 + 实现文件一个。

import type { ProbeOutcome } from "../schema.js";
import { fsContentMatch } from "./fs-content-match.js";
import { fsExists } from "./fs-exists.js";
import { fsNotExists } from "./fs-not-exists.js";
import { lintCheck } from "./lint-check.js";
import { tsCompiles } from "./ts-compiles.js";
import { testPass } from "./test-pass.js";
import { gitStatusClean } from "./git-status-clean.js";
import { fileHash } from "./file-hash.js";
import { docStructureMatch } from "./doc-structure-match.js";

/** verify 函数签名：纯函数，接收 cwd + 参数，返回 ProbeOutcome。 */
export type VerifyFunction = (cwd: string, params: Record<string, string>) => Promise<ProbeOutcome>;

/** 注册表：probe 名 → verify 函数。 */
const registry: Record<string, VerifyFunction> = {
  "fs-content-match": fsContentMatch,
  "fs-exists": fsExists,
  "fs-not-exists": fsNotExists,
  "lint-check": lintCheck,
  "ts-compiles": tsCompiles,
  "test-pass": testPass,
  "git-status-clean": gitStatusClean,
  "file-hash": fileHash,
  // Phase 3 (issue pt-doc-index-and-schema §L1) — doc-structure-match probe
  "doc-structure-match": docStructureMatch,
};

/** 轻量探针（毫秒级、无外部进程）——可安全地"即时复核"。
 *  重探针（lint-check / ts-compiles / test-pass）会起子进程（秒级~十秒级），
 *  不适合在每次写操作前同步跑。 */
const LIGHTWEIGHT_PROBES: ReadonlySet<string> = new Set([
  "fs-content-match",
  "fs-exists",
  "fs-not-exists",
  "file-hash",
  "git-status-clean",
  "doc-structure-match",
]);

/** 该探针是否轻量（可即时复核）。 */
export function isLightweightProbe(name: string): boolean {
  return LIGHTWEIGHT_PROBES.has(name);
}

/** 列出所有已注册的 probe 名（pt_doc {action: verify} tool 的错误提示用）。 */
export function listProbes(): string[] {
  return Object.keys(registry);
}

/** 按名执行 verify。未注册的 probe 名返回 INCONCLUSIVE。 */
export async function runVerify(
  cwd: string,
  name: string,
  params: Record<string, string>
): Promise<ProbeOutcome> {
  const fn = registry[name];
  if (!fn) {
    return {
      outcome: "INCONCLUSIVE",
      message: `未知 probe: ${name}（可用: ${listProbes().join(", ")}）`,
    };
  }
  try {
    return await fn(cwd, params);
  } catch (e) {
    return {
      outcome: "INCONCLUSIVE",
      message: `probe ${name} 执行异常: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
