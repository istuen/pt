// src/verify/lint-check.ts — 验证 lint 通过
import { execSync } from "node:child_process";
import type { ProbeOutcome } from "../schema.js";

export async function lintCheck(
  cwd: string,
  params: Record<string, string>
): Promise<ProbeOutcome> {
  const cmd = params.cmd ?? "npx biome check";
  try {
    execSync(cmd, { cwd, stdio: "pipe", timeout: 30000 });
    return { outcome: "COMPLETED", message: `lint 通过: ${cmd}` };
  } catch (e) {
    const stderr =
      e instanceof Error && "stderr" in e
        ? Buffer.from((e as { stderr?: Uint8Array }).stderr ?? "").toString()
        : "";
    return {
      outcome: "DEVIATED",
      message: `lint 失败: ${cmd}`,
      actual: stderr.slice(0, 500),
    };
  }
}
