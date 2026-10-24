// tests/verify/issue-pt-asset-verifiable-norm-a3.test.ts
// A3 硬约束阻断验证（issue pt-asset-verifiable-norm §三 A3）
//
// 语义：有 `on: block` 的检查未通过 → 阻断**写操作**（edit/write），让模型先修好再写。
// 安全边界：
//   ① 默认关（settings `pt.check-block` = off）
//   ② 只阻断写操作——bash / read 放行（模型可能需要 bash 去修）
//   ③ reason 说清怎么解（否则模型会卡死）
//   ④ 硬约束失败一直有效到该项检查通过（回注清空 checkFailures 不影响阻断）

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import installExtension from "../../src/index.js";
import { clearAllSessions, getSessionById } from "../../src/session.js";
import { collectDomainNormChecks, toCheckFailures } from "../../src/checks.js";
import { MOD_RULES } from "../../src/constants.js";
import type { Domain } from "../../src/schema.js";

const SESSION_ID = "test-a3-session";
type GenericHandler = (...args: unknown[]) => unknown;

let cwd: string;

beforeEach(() => {
  clearAllSessions();
  cwd = mkdtempSync(join(tmpdir(), "pt-a3-"));
});

afterEach(() => {
  clearAllSessions();
  rmSync(cwd, { recursive: true, force: true });
});

/** 装扩展并拿到 tool_call handler。 */
function makeToolCallHandler(): { handler: GenericHandler; ctx: Record<string, unknown> } {
  const events = new Map<string, GenericHandler[]>();
  const pi = {
    registerFlag: () => undefined,
    registerCommand: () => undefined,
    registerTool: () => undefined,
    on: (event: string, handler: GenericHandler) => {
      events.set(event, [...(events.get(event) ?? []), handler]);
    },
    getFlag: () => undefined,
    appendEntry: () => undefined,
  };
  const ctx = {
    cwd,
    sessionManager: { getEntries: () => [], getSessionId: () => SESSION_ID },
    hasUI: true,
    ui: { notify: () => undefined, setStatus: () => undefined, setWidget: () => undefined },
    getSystemPrompt: () => "BASE",
  };
  installExtension(pi as never);
  return { handler: events.get("tool_call")?.[0] as GenericHandler, ctx };
}

describe("A3.1 on:block 从声明到失败项", () => {
  it("Domain 规范项的 checks[].on=block → 失败项标 blocking", () => {
    const domain: Domain = {
      name: "d",
      modules: {
        [MOD_RULES]: [
          {
            name: "r1",
            slot: "global",
            type: "invariant",
            check: "x",
            checks: [{ probe: "lint-check", on: "block" }],
          },
          {
            name: "r2",
            slot: "global",
            type: "invariant",
            check: "y",
            checks: [{ probe: "fs-exists" }],
          },
        ],
      },
    };
    const declared = collectDomainNormChecks(domain);
    expect(declared.find((c) => c.probe === "lint-check")?.on).toBe("block");
    expect(declared.find((c) => c.probe === "fs-exists")?.on).toBe("notify");

    const failures = toCheckFailures([
      {
        probe: "lint-check",
        when: "agent_settled",
        outcome: "DEVIATED",
        message: "lint 失败",
        on: "block",
      },
      {
        probe: "fs-exists",
        when: "agent_settled",
        outcome: "DEVIATED",
        message: "文件缺",
        on: "notify",
      },
    ]);
    expect(failures.find((f) => f.probe === "lint-check")?.blocking).toBe(true);
    expect(failures.find((f) => f.probe === "fs-exists")?.blocking).toBe(false);
  });
});

describe("A3.2 阻断行为", () => {
  it("默认关 → 不阻断", async () => {
    const { handler, ctx } = makeToolCallHandler();
    const s = getSessionById(SESSION_ID);
    s.checkBlockEnabled = false;
    s.blockingFailures = [{ probe: "lint-check", message: "lint 失败", blocking: true }];
    const r = (await handler(
      { type: "tool_call", toolName: "edit", input: { path: "a.ts" } },
      ctx
    )) as { block?: boolean } | undefined;
    expect(r?.block).toBeUndefined();
  });

  it("开 + 有硬约束失败 → 阻断 edit/write，并给出可行动 reason", async () => {
    const { handler, ctx } = makeToolCallHandler();
    const s = getSessionById(SESSION_ID);
    s.checkBlockEnabled = true;
    s.blockingFailures = [
      { probe: "lint-check", message: "lint 失败: npm run lint", blocking: true },
    ];
    const r = (await handler(
      { type: "tool_call", toolName: "edit", input: { path: "a.ts" } },
      ctx
    )) as { block?: boolean; reason?: string } | undefined;
    expect(r?.block).toBe(true);
    expect(r?.reason).toContain("lint-check");
    expect(r?.reason).toContain("先修复");
    expect(r?.reason).toContain("pt.check-block");
  });

  it("bash / read 放行（模型可能需要 bash 去修）", async () => {
    const { handler, ctx } = makeToolCallHandler();
    const s = getSessionById(SESSION_ID);
    s.checkBlockEnabled = true;
    s.blockingFailures = [{ probe: "lint-check", message: "lint 失败", blocking: true }];
    for (const tool of ["bash", "read"]) {
      const r = (await handler({ type: "tool_call", toolName: tool, input: {} }, ctx)) as
        | { block?: boolean }
        | undefined;
      expect(r?.block).toBeUndefined();
    }
  });

  it("只有 notify 级失败 → 不阻断", async () => {
    const { handler, ctx } = makeToolCallHandler();
    const s = getSessionById(SESSION_ID);
    s.checkBlockEnabled = true;
    s.blockingFailures = []; // notify 级失败不进 blockingFailures
    const r = (await handler(
      { type: "tool_call", toolName: "write", input: { path: "a.ts" } },
      ctx
    )) as { block?: boolean } | undefined;
    expect(r?.block).toBeUndefined();
  });

  it("阻断前即时复核：失败项已被修好（轻量探针）→ 不阻断", async () => {
    // 复现 lab 真机发现的缺陷：上轮记录的失败是陈旧的，模型本轮已修好但仍被阻断
    const { handler, ctx } = makeToolCallHandler();
    const s = getSessionById(SESSION_ID);
    s.checkBlockEnabled = true;
    s.blockingFailures = [
      {
        probe: "fs-exists",
        message: "不存在: FIXED.txt",
        params: { path: "FIXED.txt" },
        blocking: true,
      },
    ];
    writeFileSync(join(cwd, "FIXED.txt"), "x", "utf8"); // 模型已修好
    const r = (await handler(
      { type: "tool_call", toolName: "edit", input: { path: "a.ts" } },
      ctx
    )) as { block?: boolean } | undefined;
    expect(r?.block).toBeUndefined();
    // 复核通过 → 失败项从阻断集合移除
    expect(s.blockingFailures).toHaveLength(0);
  });

  it("阻断前即时复核：仍未修好 → 继续阻断", async () => {
    const { handler, ctx } = makeToolCallHandler();
    const s = getSessionById(SESSION_ID);
    s.checkBlockEnabled = true;
    s.blockingFailures = [
      {
        probe: "fs-exists",
        message: "不存在: STILL-MISSING.txt",
        params: { path: "STILL-MISSING.txt" },
        blocking: true,
      },
    ];
    const r = (await handler(
      { type: "tool_call", toolName: "edit", input: { path: "a.ts" } },
      ctx
    )) as { block?: boolean } | undefined;
    expect(r?.block).toBe(true);
  });

  it("硬约束失败被清掉（检查已通过）→ 不再阻断", async () => {
    const { handler, ctx } = makeToolCallHandler();
    const s = getSessionById(SESSION_ID);
    s.checkBlockEnabled = true;
    s.blockingFailures = [{ probe: "lint-check", message: "lint 失败", blocking: true }];
    // 模拟下一次检查通过 → blockingFailures 被清空
    s.blockingFailures = [];
    const r = (await handler(
      { type: "tool_call", toolName: "edit", input: { path: "a.ts" } },
      ctx
    )) as { block?: boolean } | undefined;
    expect(r?.block).toBeUndefined();
  });
});
