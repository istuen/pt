// tests/verify/issue-pt-adoption-observability-layer2.test.ts
// Layer 2 per-session 汇总验证（issue pt-adoption-observability §五 Layer 2）
//
// 目标：一个 session 成为**可分析的一行**——查了 AND 改了 AND 改的是哪个文件；
//   同时是 headless / CI 的结构化摘要（`pi -p` 下 notify 不渲染 → 失败信号只落日志）。
//
// 覆盖：
//   1. 汇总累积：turn / 工具调用 / pt_inject(domain,turn) / 读过的文件 / 改动的文件
//   2. 检查结果与状态判定（ok / checks-failed / blocked / bypassed）
//   3. 产出端：开关关闭 → 不产出；开启 → 日志一条 + .pt/logs/summary.ndjson 一行
//   4. 开关来源：--pt-observe flag > settings pt.observe > off

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import installExtension from "../../src/index.js";
import { clearAllSessions, getSessionById } from "../../src/session.js";
import {
  buildSessionSummaryRecord,
  createSessionSummary,
  SUMMARY_FILE,
  type SessionSummary,
} from "../../src/summary.js";

type GenericHandler = (...args: unknown[]) => unknown;

const SESSION_ID = "test-layer2-session";
let cwd: string;

beforeEach(() => {
  clearAllSessions();
  cwd = mkdtempSync(join(tmpdir(), "pt-layer2-"));
});

afterEach(() => {
  clearAllSessions();
  rmSync(cwd, { recursive: true, force: true });
});

/** 装扩展（可指定 flag 值）。 */
function makePi(flags: Record<string, unknown> = {}) {
  const events = new Map<string, GenericHandler[]>();
  const appended: Array<{ customType: string; data: unknown }> = [];
  const pi = {
    registerFlag: () => undefined,
    registerCommand: () => undefined,
    registerTool: () => undefined,
    on: (event: string, handler: GenericHandler) => {
      events.set(event, [...(events.get(event) ?? []), handler]);
    },
    getFlag: (name: string) => flags[name],
    appendEntry: (customType: string, data?: unknown) => {
      appended.push({ customType, data });
    },
  };
  const ctx = {
    cwd,
    sessionManager: { getEntries: () => [], getSessionId: () => SESSION_ID },
    hasUI: true,
    ui: { notify: () => undefined, setStatus: () => undefined, setWidget: () => undefined },
    getSystemPrompt: () => "BASE",
  };
  installExtension(pi as never);
  return { events, ctx, appended };
}

describe("L2.1 汇总累积", () => {
  it("turn / 工具调用 / pt_inject / 文件维度都进汇总", async () => {
    const { events, ctx } = makePi();
    const turnStart = events.get("turn_start")?.[0];
    const toolCall = events.get("tool_call")?.[0];
    expect(turnStart).toBeDefined();
    expect(toolCall).toBeDefined();

    await turnStart?.({ type: "turn_start" }, ctx);
    await toolCall?.({ type: "tool_call", toolName: "read", input: { path: "src/a.ts" } }, ctx);
    await turnStart?.({ type: "turn_start" }, ctx);
    await toolCall?.(
      { type: "tool_call", toolName: "pt_inject", input: { domain: "pt-quality" } },
      ctx
    );
    await turnStart?.({ type: "turn_start" }, ctx);
    await toolCall?.(
      { type: "tool_call", toolName: "edit", input: { path: "src/schema.ts" } },
      ctx
    );

    const sum = getSessionById(SESSION_ID).summary;
    expect(sum.turns).toBe(3);
    expect(sum.toolCalls).toBe(3);
    expect(sum.ptInjectCalls).toEqual([{ domain: "pt-quality", turn: 2 }]);
    expect(sum.filesRead).toEqual(["src/a.ts"]);
    expect(sum.filesModified).toEqual(["src/schema.ts"]);
  });
});

describe("L2.2 状态判定", () => {
  it("ok / checks-failed / blocked / bypassed", () => {
    const base = createSessionSummary();
    expect(buildSessionSummaryRecord(base, meta()).status).toBe("ok");

    const failed: SessionSummary = {
      ...base,
      checkResults: [{ probe: "lint-check", outcome: "DEVIATED", message: "lint 失败" }],
    };
    const rec = buildSessionSummaryRecord(failed, meta());
    expect(rec.status).toBe("checks-failed");
    expect(rec.failedChecks).toEqual(["lint-check"]);

    expect(buildSessionSummaryRecord({ ...base, blockedCount: 1 }, meta()).status).toBe("blocked");
    expect(buildSessionSummaryRecord({ ...base, bypassCount: 1 }, meta()).status).toBe("bypassed");
  });

  function meta() {
    return {
      sessionId: SESSION_ID,
      profile: "lab",
      startedAt: "2026-06-24T00:00:00.000Z",
      endedAt: "2026-06-24T00:01:00.000Z",
      durationSec: 60,
    };
  }
});

describe("L2.3 产出端 + 开关", () => {
  it("开关关闭 → 不产出汇总文件", async () => {
    const { events, ctx } = makePi();
    await events.get("session_start")?.[0]?.({ type: "session_start" }, ctx);
    const shutdown = events.get("session_shutdown")?.[0];
    await shutdown?.({ type: "session_shutdown" }, ctx);
    expect(existsSync(join(cwd, ".pt/logs", SUMMARY_FILE))).toBe(false);
  });

  it("settings pt.observe=on → session 结束产出汇总文件（一行 JSON）", async () => {
    const { mkdtempSync: mk, writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi/settings.json"),
      JSON.stringify({ pt: { observe: "on" } }),
      "utf8"
    );
    void mk;

    const { events, ctx } = makePi();
    await events.get("session_start")?.[0]?.({ type: "session_start" }, ctx);
    const turnStart = events.get("turn_start")?.[0];
    const toolCall = events.get("tool_call")?.[0];
    const shutdown = events.get("session_shutdown")?.[0];
    await turnStart?.({ type: "turn_start" }, ctx);
    await toolCall?.(
      { type: "tool_call", toolName: "edit", input: { path: "src/schema.ts" } },
      ctx
    );
    await toolCall?.(
      { type: "tool_call", toolName: "pt_inject", input: { domain: "pt-quality" } },
      ctx
    );
    await shutdown?.({ type: "session_shutdown" }, ctx);

    const file = join(cwd, ".pt/logs", SUMMARY_FILE);
    expect(existsSync(file)).toBe(true);
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0] ?? "{}");
    expect(rec.sessionId).toBe(SESSION_ID);
    expect(rec.filesModified).toEqual(["src/schema.ts"]);
    expect(rec.ptInjectCalls).toEqual([{ domain: "pt-quality", turn: 1 }]);
    expect(rec.turns).toBe(1);
    expect(rec.status).toBe("ok");
  });

  it("--pt-observe flag 也能开（flag > settings）", async () => {
    const { events, ctx } = makePi({ "pt-observe": true });
    await events.get("session_start")?.[0]?.({ type: "session_start" }, ctx);
    const shutdown = events.get("session_shutdown")?.[0];
    await shutdown?.({ type: "session_shutdown" }, ctx);
    expect(existsSync(join(cwd, ".pt/logs", SUMMARY_FILE))).toBe(true);
  });
});
