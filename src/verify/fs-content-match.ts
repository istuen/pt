// src/verify/fs-content-match.ts — 验证文件包含某文本
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProbeOutcome } from "../schema.js";

export async function fsContentMatch(cwd: string, params: Record<string, string>): Promise<ProbeOutcome> {
  const path = params.path;
  if (!path) return { outcome: "INCONCLUSIVE", message: "缺少参数: path" };
  const pattern = params.pattern;
  if (!pattern) return { outcome: "INCONCLUSIVE", message: "缺少参数: pattern" };
  try {
    const content = readFileSync(join(cwd, path), "utf8");
    const found = content.includes(pattern);
    return {
      outcome: found ? "COMPLETED" : "DEVIATED",
      message: found ? `文件 ${path} 包含 "${pattern}"` : `文件 ${path} 不包含 "${pattern}"`,
      actual: found ? "found" : "not-found",
    };
  } catch (e) {
    return { outcome: "INCONCLUSIVE", message: `无法读取 ${path}: ${e instanceof Error ? e.message : String(e)}` };
  }
}
