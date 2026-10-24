// tests/verify/issue-pt-asset-verifiable-norm-a2.test.ts
// A2 主动检查验证（issue pt-asset-verifiable-norm §三 A2）
//
// 目标：Pt 自己在 agent 跑完时执行声明的探针——不靠模型主动调 pt_doc verify。
//   覆盖：
//     1. 声明解析：settings `pt.checks`（宽松解析，坏条目跳过）+ `pt.auto-checks` 模式
//     2. manual observe 探针收集（`- 验证参照：a, b` 格式）
//     3. 执行：只跑当期的检查；同探针去重；DEVIATED → notify；其他只记日志
//     4. 写回：命中 activeManual 的 step observe → 写回 manual 文件

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectManualObserveProbes,
  parseAutoCheckMode,
  readDeclaredChecks,
  runAutoChecks,
  type CheckRunResult,
} from "../../src/checks.js";
import { clearAllSessions, getSessionById } from "../../src/session.js";

let cwd: string;
const SESSION_ID = "test-a2-session";

beforeEach(() => {
  clearAllSessions();
  cwd = mkdtempSync(join(tmpdir(), "pt-a2-"));
  mkdirSync(join(cwd, ".pi"), { recursive: true });
});

afterEach(() => {
  clearAllSessions();
  rmSync(cwd, { recursive: true, force: true });
});

/** 写项目 settings。 */
function writeSettings(pt: Record<string, unknown>): void {
  writeFileSync(join(cwd, ".pi/settings.json"), JSON.stringify({ pt }, "utf8"), "utf8");
}

describe("A2.1 声明解析", () => {
  it("auto-checks 模式：off / on / on+manual；非法值回退 on", () => {
    expect(parseAutoCheckMode("off")).toBe("off");
    expect(parseAutoCheckMode("on")).toBe("on");
    expect(parseAutoCheckMode("on+manual")).toBe("on+manual");
    expect(parseAutoCheckMode("garbage")).toBe("on");
    expect(parseAutoCheckMode(undefined)).toBe("on");
  });

  it("读 settings pt.checks（宽松解析）", async () => {
    writeSettings({
      checks: [
        { probe: "git-status-clean" },
        { probe: "lint-check", params: { cmd: "npm run lint" }, when: "session_end" },
        { probe: "" },
        "not-an-object",
      ],
    });
    const checks = await readDeclaredChecks(cwd);
    expect(checks).toHaveLength(2);
    expect(checks[0].probe).toBe("git-status-clean");
    expect(checks[0].when).toBe("agent_settled");
    expect(checks[1].params).toEqual({ cmd: "npm run lint" });
    expect(checks[1].when).toBe("session_end");
  });

  it("无声明 → 空（零成本）", async () => {
    expect(await readDeclaredChecks(cwd)).toEqual([]);
  });
});

describe("A2.2 manual observe 探针收集", () => {
  it("扫 `- 验证参照：a, b` 行", () => {
    const content = [
      "- [ ] 1. 改代码",
      "  - 验证参照：fs-content-match, lint-check",
      "- [ ] 2. 提交",
      "  - 验证参照：git-status-clean",
    ].join("\n");
    expect(collectManualObserveProbes(content)).toEqual([
      "fs-content-match",
      "lint-check",
      "git-status-clean",
    ]);
  });

  it("无 observe 行 → 空", () => {
    expect(collectManualObserveProbes("- [ ] 1. x")).toEqual([]);
  });
});

describe("A2.3 执行 + 通知 + 写回", () => {
  it("只跑当期的检查；DEVIATED → notify；其他只记日志", async () => {
    // fs-exists 探针：文件不存在 → DEVIATED
    writeSettings({
      checks: [
        { probe: "fs-exists", params: { path: "missing.txt" } },
        { probe: "fs-exists", params: { path: "also-missing.txt" } },
        { probe: "git-status-clean", when: "session_end" },
      ],
    });
    const notices: Array<{ msg: string; level: string }> = [];
    const logs: Array<{ msg: string; ctx?: Record<string, unknown> }> = [];
    const results: CheckRunResult[] = await runAutoChecks(
      {
        cwd,
        ui: { notify: (msg, level) => notices.push({ msg, level }) },
      },
      SESSION_ID,
      "agent_settled",
      (msg, c) => logs.push({ msg, ctx: c })
    );
    // 两条 agent_settled 检查都跑了；session_end 的没跑
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.outcome === "DEVIATED")).toBe(true);
    // notify 一次一条
    expect(notices).toHaveLength(2);
    expect(notices[0].level).toBe("warning");
    expect(notices[0].msg).toContain("fs-exists");
    // 日志有 check:run
    expect(logs.some((l) => l.msg === "check:run")).toBe(true);
  });

  it("开关 off → 一条都不跑", async () => {
    writeSettings({
      "auto-checks": "off",
      checks: [{ probe: "fs-exists", params: { path: "x" } }],
    });
    const results = await runAutoChecks({ cwd }, SESSION_ID, "agent_settled");
    expect(results).toHaveLength(0);
  });

  it("命中 activeManual 的 step observe → 写回 manual 文件", async () => {
    const manualPath = join(cwd, "manual.md");
    writeFileSync(
      manualPath,
      [
        "# manual",
        "",
        "| # | 状态 | 说明 |",
        "|---|---|---|",
        "| 1 |  |  |",
        "",
        "- [ ] 1. 改代码",
        "  - 验证参照：fs-exists",
        "",
      ].join("\n"),
      "utf8"
    );
    getSessionById(SESSION_ID).activeManual = {
      filePath: manualPath,
      procedure: "feature-lifecycle",
      args: "",
      activatedAt: Date.now(),
    };
    writeSettings({ checks: [{ probe: "fs-exists", params: { path: "missing.txt" } }] });
    await runAutoChecks({ cwd }, SESSION_ID, "agent_settled");
    const after = readFileSync(manualPath, "utf8");
    // 命中 step observe → 写回：状态表行填 DEVIATED + completed 注释 + step 勾选
    expect(after).toContain("DEVIATED");
    expect(after).toContain("pt-verify-completed");
    expect(after).toContain("- [x] 1. 改代码");
  });

  it("COMPLETED 不 notify（不刷屏）", async () => {
    writeFileSync(join(cwd, "present.txt"), "x", "utf8");
    writeSettings({ checks: [{ probe: "fs-exists", params: { path: "present.txt" } }] });
    const notices: string[] = [];
    const results = await runAutoChecks(
      { cwd, ui: { notify: (msg) => notices.push(msg) } },
      SESSION_ID,
      "agent_settled"
    );
    expect(results[0].outcome).toBe("COMPLETED");
    expect(notices).toHaveLength(0);
  });
});
