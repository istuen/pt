// src/verify/lint-check.ts — 验证 lint 通过
import { execSync } from "node:child_process";
import type { ProbeOutcome } from "../schema.js";
import { readStderr } from "./read-stderr.js";

export async function lintCheck(
  cwd: string,
  params: Record<string, string>
): Promise<ProbeOutcome> {
  const cmd = params.cmd ?? "npx biome check";
  try {
    execSync(cmd, { cwd, stdio: "pipe", timeout: 30000 });
    return { outcome: "COMPLETED", message: `lint 通过: ${cmd}` };
  } catch (e) {
    return {
      outcome: "DEVIATED",
      message: `lint 失败: ${cmd}`,
      actual: readStderr(e).slice(0, 500),
    };
  }
}
