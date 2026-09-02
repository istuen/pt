// src/verify/git-status-clean.ts — 验证 git 工作树干净
import { execSync } from "node:child_process";
import type { ProbeOutcome } from "../schema.js";

export async function gitStatusClean(cwd: string, _params: Record<string, string>): Promise<ProbeOutcome> {
  try {
    const out = execSync("git status --porcelain", { cwd, encoding: "utf8", timeout: 10000 });
    const clean = out.trim() === "";
    return {
      outcome: clean ? "COMPLETED" : "DEVIATED",
      message: clean ? "git 工作树干净" : `git 工作树有变更:\n${out.trim()}`,
      actual: clean ? "clean" : "dirty",
    };
  } catch (e) {
    return { outcome: "INCONCLUSIVE", message: `git 执行失败: ${e instanceof Error ? e.message : String(e)}` };
  }
}
