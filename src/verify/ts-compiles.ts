// src/verify/ts-compiles.ts — 验证 TS 编译通过
import { execSync } from "node:child_process";
import type { ProbeOutcome } from "../schema.js";
import { readStderr } from "./read-stderr.js";

export async function tsCompiles(
  cwd: string,
  params: Record<string, string>
): Promise<ProbeOutcome> {
  const cmd = params.cmd ?? "npx tsc --noEmit";
  try {
    execSync(cmd, { cwd, stdio: "pipe", timeout: 60000 });
    return { outcome: "COMPLETED", message: `TS 编译通过: ${cmd}` };
  } catch (e) {
    return {
      outcome: "DEVIATED",
      message: `TS 编译失败: ${cmd}`,
      actual: readStderr(e).slice(0, 500),
    };
  }
}
