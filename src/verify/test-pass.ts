// src/verify/test-pass.ts — 验证测试通过
import { execSync } from "node:child_process";
import type { ProbeOutcome } from "../schema.js";

export async function testPass(cwd: string, params: Record<string, string>): Promise<ProbeOutcome> {
  const cmd = params.cmd ?? "npx vitest run tests/verify/";
  try {
    execSync(cmd, { cwd, stdio: "pipe", timeout: 120000 });
    return { outcome: "COMPLETED", message: `测试通过: ${cmd}` };
  } catch (e) {
    const stderr =
      e instanceof Error && "stderr" in e
        ? Buffer.from((e as { stderr?: Uint8Array }).stderr ?? "").toString()
        : "";
    return {
      outcome: "DEVIATED",
      message: `测试失败: ${cmd}`,
      actual: stderr.slice(0, 500),
    };
  }
}
