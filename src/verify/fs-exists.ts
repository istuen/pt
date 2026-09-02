// src/verify/fs-exists.ts — 验证文件存在
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ProbeOutcome } from "../schema.js";

export async function fsExists(cwd: string, params: Record<string, string>): Promise<ProbeOutcome> {
  const path = params.path;
  if (!path) return { outcome: "INCONCLUSIVE", message: "缺少参数: path" };
  const exists = existsSync(join(cwd, path));
  return {
    outcome: exists ? "COMPLETED" : "DEVIATED",
    message: exists ? `存在: ${path}` : `不存在: ${path}`,
  };
}
