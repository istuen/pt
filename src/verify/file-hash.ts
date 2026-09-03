// src/verify/file-hash.ts — 验证文件 sha256 hash 匹配
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProbeOutcome } from "../schema.js";

export async function fileHash(cwd: string, params: Record<string, string>): Promise<ProbeOutcome> {
  const path = params.path;
  if (!path) return { outcome: "INCONCLUSIVE", message: "缺少参数: path" };
  const expected = params.expected;
  if (!expected) return { outcome: "INCONCLUSIVE", message: "缺少参数: expected (sha256)" };
  try {
    const content = readFileSync(join(cwd, path));
    const hash = createHash("sha256").update(content).digest("hex");
    const match = hash === expected;
    return {
      outcome: match ? "COMPLETED" : "DEVIATED",
      message: match
        ? `hash 匹配: ${path}`
        : `hash 不匹配: ${path}（期望 ${expected.slice(0, 8)}...，实际 ${hash.slice(0, 8)}...）`,
      actual: hash,
    };
  } catch (e) {
    return {
      outcome: "INCONCLUSIVE",
      message: `无法读取 ${path}: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
