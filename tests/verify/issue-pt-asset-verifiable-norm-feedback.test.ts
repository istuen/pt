// tests/verify/issue-pt-asset-verifiable-norm-feedback.test.ts
// 检查失败回注给模型验证（issue pt-asset-verifiable-norm §六剩余待办）
//
// 闭环：检查失败 → 落 session JSONL → 下一轮 before_agent_start 回注 → 注入后清空
//   → 失败持续存在时下次检查会重新记录（自我修正循环，不是一锤子买卖）
//
// 覆盖：
//   1. toCheckFailures：只有 DEVIATED 算失败（INCONCLUSIVE ≠ 违反）
//   2. renderCheckFailureSegment：段形态 / 封顶 / 无失败不注入
//   3. read/persistCheckFailures：JSONL 往返（跨进程恢复）
//   4. 端到端：agent_settled 检查失败 → 下一轮 systemPrompt 含失败段 → 注入后清空

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_CHECK_FAILURES,
  PT_CHECK_FAILURES_ENTRY,
  persistCheckFailures,
  readCheckFailures,
  renderCheckFailureSegment,
  toCheckFailures,
  type CheckRunResult,
} from "../../src/checks.js";
import { clearAllSessions, getSessionById } from "../../src/session.js";
import { PiAdapter } from "../../src/agent/pi-adapter.js";
import type { AgentAPI, Blueprint, Context } from "../../src/schema.js";

const SESSION_ID = "test-feedback-session";
let cwd: string;

beforeEach(() => {
  clearAllSessions();
  cwd = mkdtempSync(join(tmpdir(), "pt-feedback-"));
});

afterEach(() => {
  clearAllSessions();
  rmSync(cwd, { recursive: true, force: true });
});

/** 造一条检查结果。 */
function res(partial: Partial<CheckRunResult>): CheckRunResult {
  return {
    probe: "lint-check",
    when: "agent_settled",
    outcome: "COMPLETED",
    message: "ok",
    ...partial,
  };
}

describe("回注.1 失败项提取", () => {
  it("只有 DEVIATED 算失败（INCONCLUSIVE ≠ 违反）", () => {
    const failures = toCheckFailures([
      res({ outcome: "COMPLETED" }),
      res({ outcome: "DEVIATED", message: "lint 失败: npm run lint", actual: "error TS123" }),
      res({ outcome: "INCONCLUSIVE", message: "无法判定" }),
    ]);
    expect(failures).toHaveLength(1);
    expect(failures[0].probe).toBe("lint-check");
    expect(failures[0].message).toContain("lint 失败");
    expect(failures[0].actual).toBe("error TS123");
  });
});

describe("回注.2 段渲染", () => {
  it("无失败 → undefined（不注入）", () => {
    expect(renderCheckFailureSegment([])).toBeUndefined();
  });

  it("含失败 → 独立 H2 段（探针 + 消息 + 行动提示）", () => {
    const seg =
      renderCheckFailureSegment([{ probe: "lint-check", message: "lint 失败: npm run lint" }]) ??
      "";
    expect(seg).toContain("## 检查未通过（Pt 自动检查）");
    expect(seg).toContain("lint-check");
    expect(seg).toContain("lint 失败");
    expect(seg).toContain("自动重查");
  });

  it("封顶：最多 MAX_CHECK_FAILURES 条 + 省略提示", () => {
    const many = Array.from({ length: MAX_CHECK_FAILURES + 2 }, (_, i) => ({
      probe: `p${i}`,
      message: "m",
    }));
    const seg = renderCheckFailureSegment(many) ?? "";
    expect(seg).toContain(`另有 ${many.length - MAX_CHECK_FAILURES} 项未列出`);
  });
});

describe("回注.3 JSONL 往返（跨进程恢复）", () => {
  it("persist → read 还原", () => {
    const entries: Array<{ type: string; customType?: string; data?: unknown }> = [];
    const pi = {
      appendEntry: (customType: string, data?: unknown) => {
        entries.push({ type: "custom", customType, data });
      },
    };
    persistCheckFailures(pi as never, [{ probe: "lint-check", message: "boom" }]);
    expect(entries[0]?.customType).toBe(PT_CHECK_FAILURES_ENTRY);
    const got = readCheckFailures({ getEntries: () => entries });
    expect(got).toEqual([
      { probe: "lint-check", message: "boom", actual: undefined, blocking: false },
    ]);
  });

  it("无 entry / 坏 data → 空", () => {
    expect(readCheckFailures(undefined)).toEqual([]);
    expect(readCheckFailures({ getEntries: () => [] })).toEqual([]);
    expect(
      readCheckFailures({
        getEntries: () => [{ type: "custom", customType: PT_CHECK_FAILURES_ENTRY, data: "x" }],
      })
    ).toEqual([]);
  });
});

describe("回注.4 端到端：失败 → 下一轮 systemPrompt", () => {
  /** 造一个注入 handler（PiAdapter）。 */
  function makeInjector() {
    const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const api: AgentAPI = {
      on: (event, handler) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
      registerCommand: () => undefined,
      registerFlag: () => undefined,
      getFlag: () => undefined,
      ui: { notify: () => undefined, setStatus: () => undefined },
      log: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    };
    const blueprint: Blueprint = {
      name: "b",
      agent: "pi",
      groups: [{ name: "system", inject: "session" }],
    };
    const context: Context = {
      name: "b",
      blueprint: blueprint.name,
      sourceHash: "b",
      modules: { system: "SEG" },
    };
    const adapter = new PiAdapter();
    adapter.setAgentContext(context, blueprint, []);
    adapter.registerInject(api, context, blueprint, []);
    const handler = handlers.get("before_agent_start")?.[0];
    return async (): Promise<string> => {
      const r = (await handler?.(
        { type: "before_agent_start", systemPrompt: "BASE" },
        { sessionManager: { getSessionId: () => SESSION_ID } }
      )) as { systemPrompt: string };
      return r.systemPrompt;
    };
  }

  it("待回注失败 → 注入段 → 注入后清空（同一轮不重复注入）", async () => {
    const inject = makeInjector();
    const s = getSessionById(SESSION_ID);
    s.checkFailures = [{ probe: "lint-check", message: "lint 失败: npm run lint" }];

    const first = await inject();
    expect(first).toContain("## 检查未通过（Pt 自动检查）");
    expect(first).toContain("lint 失败");
    // 注入后清空
    expect(s.checkFailures).toHaveLength(0);
    const second = await inject();
    expect(second).not.toContain("检查未通过");
  });

  it("开关关闭 → 不回注", async () => {
    const inject = makeInjector();
    const s = getSessionById(SESSION_ID);
    s.checkFailures = [{ probe: "lint-check", message: "boom" }];
    s.checkFeedbackInject = false;
    const out = await inject();
    expect(out).not.toContain("检查未通过");
  });

  it("与上一轮产出段并存（顺序：上下文 → 产出 → 检查失败）", async () => {
    const inject = makeInjector();
    const s = getSessionById(SESSION_ID);
    s.turnOutputs = [{ turn: 1, files: ["src/a.ts"], domains: [], at: new Date().toISOString() }];
    s.checkFailures = [{ probe: "lint-check", message: "boom" }];
    const out = await inject();
    expect(out).toContain("SEG");
    expect(out).toContain("## 上一轮产出（Pt 记录）");
    expect(out).toContain("## 检查未通过（Pt 自动检查）");
    expect(out.indexOf("上一轮产出")).toBeLessThan(out.indexOf("检查未通过"));
  });
});
