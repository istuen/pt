// src/verify/ts-compiles.ts — 验证 TS 编译通过
import { execSync } from "node:child_process";
import type { ProbeOutcome } from "../schema.js";

export async function tsCompiles(
  cwd: string,
  params: Record<string, string>
): Promise<ProbeOutcome> {
  const cmd = params.cmd ?? "npx tsc --noEmit";
  try {
    execSync(cmd, { cwd, stdio: "pipe", timeout: 60000 });
    return { outcome: "COMPLETED", message: `TS 编译通过: ${cmd}` };
  } catch (e) {
    const stderr =
      e instanceof Error && "stderr" in e
        ? Buffer.from((e as { stderr?: Uint8Array }).stderr ?? "").toString()
        : "";
    return {
      outcome: "DEVIATED",
      message: `TS 编译失败: ${cmd}`,
      actual: stderr.slice(0, 500),
    };
  }
}
