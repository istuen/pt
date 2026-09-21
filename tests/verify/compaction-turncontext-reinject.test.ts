// tests/verify/compaction-turncontext-reinject.test.ts — v18.x 决策 6
//
// 覆盖：
//   1. lastTurnRef 字段默认 null（createSessionState）
//   2. pt_turn_inject 成功后 lastTurnRef.turnInjectDomain 更新
//   3. pt_make_manual 成功后 lastTurnRef.manualPath 更新
//   4. 两字段独立累积（先 pt_turn_inject 后 pt_make_manual，两字段都有值）
//   5. session_compact handler：lastTurnRef 非空 → 调 sendMessage（triggerTurn: true）
//   6. session_compact handler：lastTurnRef 为 null → 不调 sendMessage
//   7. resetSessionState 不清 lastTurnRef（切换 Profile 保留线索）
//   8. persistLastTurnRef 写入 session entry
//   9. tryRestoreLastTurnRef 恢复 lastTurnRef

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import installExtension from "../../src/index.js";
import { PT_LAST_TURN_REF_ENTRY } from "../../src/manual-session.js";
import { createSessionState, getSessionById, resetSessionState } from "../../src/session.js";
import { resetTestSession, s, TEST_SESSION_ID } from "./session-fixtures.js";

type GenericHandler = (...args: unknown[]) => unknown;
type CtxLike = Record<string, unknown>;

function makePi(opts?: { sendMessage?: (...args: unknown[]) => unknown }) {
  const events = new Map<string, GenericHandler[]>();
  const commands = new Map<string, { handler: (args: string, ctx: CtxLike) => Promise<void> }>();
  const tools = new Map<string, { execute: (...a: unknown[]) => Promise<unknown> }>();
  const appendedEntries: Array<[string, unknown]> = [];
  const sendMessageCalls: Array<{ message: unknown; options: unknown }> = [];

  const pi = {
    registerFlag: () => undefined,
    registerCommand: (
      name: string,
      spec: { handler: (args: string, ctx: CtxLike) => Promise<void> }
    ) => {
      commands.set(name, spec);
    },
    registerTool: (spec: { name: string; execute: (...a: unknown[]) => Promise<unknown> }) => {
      tools.set(spec.name, spec);
    },
    on: (event: string, handler: GenericHandler) => {
      events.set(event, [...(events.get(event) ?? []), handler]);
    },
    getFlag: () => undefined,
    appendEntry: (customType: string, data?: unknown) => {
      appendedEntries.push([customType, data]);
    },
    sendMessage:
      opts?.sendMessage ??
      (async (msg, options) => {
        sendMessageCalls.push({ message: msg, options });
      }),
  };

  const ctx: CtxLike = {
    cwd: process.cwd(),
    sessionManager: {
      getEntries: () =>
        appendedEntries
          .filter(([t]) => t === PT_LAST_TURN_REF_ENTRY)
          .map(([_t, data]) => ({
            type: "custom",
            customType: PT_LAST_TURN_REF_ENTRY,
            data,
          })),
      getSessionId: () => TEST_SESSION_ID,
    },
    hasUI: true,
    ui: {
      notify: () => undefined,
      setStatus: () => undefined,
      setWidget: () => undefined,
    },
    getSystemPrompt: () => "BASE",
  };

  return { pi, ctx, events, commands, tools, appendedEntries, sendMessageCalls };
}

describe("compaction 后 TurnContext 重注入线索（v18.x 决策 6）", () => {
  beforeEach(() => {
    resetTestSession();
  });

  afterEach(() => {
    s().activeAdapter?.resetInjection?.();
    resetTestSession();
  });

  it("1. createSessionState 默认 lastTurnRef = null", () => {
    const s = createSessionState();
    expect(s.lastTurnRef).toBeNull();
  });

  it("2. pt_turn_inject 成功后 lastTurnRef.turnInjectDomain 更新（manualPath 保留 null）", async () => {
    const m = makePi();
    installExtension(m.pi as never);
    const sessionStart = m.events.get("session_start")?.[0]!;
    await sessionStart({ type: "session_start" }, m.ctx);

    // 加载 pt-dev 让 cachedBundles 有数据
    const switchCmd = m.commands.get("pt-profile")!;
    await switchCmd.handler("pt-dev", m.ctx);

    const tool = m.tools.get("pt_turn_inject");
    if (!tool) throw new Error("pt_turn_inject not registered");
    await tool.execute("c1", { domain: "pt-quality" }, undefined, undefined, m.ctx);

    const session = getSessionById(TEST_SESSION_ID);
    expect(session.lastTurnRef).not.toBeNull();
    expect(session.lastTurnRef?.turnInjectDomain).toBe("pt-quality");
    expect(session.lastTurnRef?.manualPath).toBeNull();
  });

  it("3. pt_turn_inject 后调 pt_make_manual → manualPath 填，turnInjectDomain 保留", async () => {
    const m = makePi();
    installExtension(m.pi as never);
    const sessionStart = m.events.get("session_start")?.[0]!;
    await sessionStart({ type: "session_start" }, m.ctx);

    const switchCmd = m.commands.get("pt-profile")!;
    await switchCmd.handler("pt-dev", m.ctx);

    const turnInjectTool = m.tools.get("pt_turn_inject")!;
    await turnInjectTool.execute("c1", { domain: "pt-quality" }, undefined, undefined, m.ctx);

    const makeManualTool = m.tools.get("pt_make_manual")!;
    await makeManualTool.execute(
      "c2",
      { procedure: "feature-lifecycle", args: "req-001" },
      undefined,
      undefined,
      m.ctx
    );

    const session = getSessionById(TEST_SESSION_ID);
    expect(session.lastTurnRef).not.toBeNull();
    expect(session.lastTurnRef?.turnInjectDomain).toBe("pt-quality");
    expect(session.lastTurnRef?.manualPath).toMatch(/feature-lifecycle-\d+\.md$/);
  });

  it("4. 调 pt_make_manual 时 turnInjectDomain 默认空字符串（顺序无关）", async () => {
    const m = makePi();
    installExtension(m.pi as never);
    const sessionStart = m.events.get("session_start")?.[0]!;
    await sessionStart({ type: "session_start" }, m.ctx);

    const switchCmd = m.commands.get("pt-profile")!;
    await switchCmd.handler("pt-dev", m.ctx);

    // 直接调 pt_make_manual（不调 pt_turn_inject）
    const makeManualTool = m.tools.get("pt_make_manual")!;
    await makeManualTool.execute(
      "c1",
      { procedure: "feature-lifecycle", args: "req-002" },
      undefined,
      undefined,
      m.ctx
    );

    const session = getSessionById(TEST_SESSION_ID);
    expect(session.lastTurnRef).not.toBeNull();
    expect(session.lastTurnRef?.turnInjectDomain).toBe(""); // 未调过 pt_turn_inject → 空串
    expect(session.lastTurnRef?.manualPath).toMatch(/feature-lifecycle-\d+\.md$/);
  });

  it("5. session_compact 触发 + lastTurnRef 非空 → 调 sendMessage triggerTurn", async () => {
    const m = makePi();
    installExtension(m.pi as never);
    const sessionStart = m.events.get("session_start")?.[0]!;
    await sessionStart({ type: "session_start" }, m.ctx);

    const switchCmd = m.commands.get("pt-profile")!;
    await switchCmd.handler("pt-dev", m.ctx);

    const turnInjectTool = m.tools.get("pt_turn_inject")!;
    await turnInjectTool.execute("c1", { domain: "pt-quality" }, undefined, undefined, m.ctx);

    // 清 sendMessage 计数
    m.sendMessageCalls.length = 0;

    const compactHandler = m.events.get("session_compact")?.[0]!;
    await compactHandler(
      {
        type: "session_compact",
        compactionEntry: {},
        fromExtension: false,
        reason: "threshold",
        willRetry: false,
      },
      m.ctx
    );

    expect(m.sendMessageCalls.length).toBe(1);
    const call = m.sendMessageCalls[0]!;
    expect((call.message as { customType: string }).customType).toBe("pt-compaction-clue");
    expect((call.options as { triggerTurn: boolean }).triggerTurn).toBe(true);
    expect((call.message as { content: string }).content).toContain("pt-quality");
  });

  it("6. session_compact 触发 + lastTurnRef 为 null → 不调 sendMessage", async () => {
    const m = makePi();
    installExtension(m.pi as never);
    const sessionStart = m.events.get("session_start")?.[0]!;
    await sessionStart({ type: "session_start" }, m.ctx);

    // 没调过 pt_turn_inject / pt_make_manual → lastTurnRef 为 null

    const compactHandler = m.events.get("session_compact")?.[0]!;
    await compactHandler(
      {
        type: "session_compact",
        compactionEntry: {},
        fromExtension: false,
        reason: "threshold",
        willRetry: false,
      },
      m.ctx
    );

    expect(m.sendMessageCalls.length).toBe(0);
  });

  it("7. resetSessionState 不清 lastTurnRef（切换 Profile 保留线索）", async () => {
    const m = makePi();
    installExtension(m.pi as never);
    const sessionStart = m.events.get("session_start")?.[0]!;
    await sessionStart({ type: "session_start" }, m.ctx);

    const switchCmd = m.commands.get("pt-profile")!;
    await switchCmd.handler("pt-dev", m.ctx);

    const turnInjectTool = m.tools.get("pt_turn_inject")!;
    await turnInjectTool.execute("c1", { domain: "pt-quality" }, undefined, undefined, m.ctx);

    const session = getSessionById(TEST_SESSION_ID);
    expect(session.lastTurnRef?.turnInjectDomain).toBe("pt-quality");

    // 切 Profile（触发 resetSessionState）
    await switchCmd.handler("pt-design", m.ctx);

    // lastTurnRef 应保留（resetSessionState 不清）
    const sessionAfter = getSessionById(TEST_SESSION_ID);
    expect(sessionAfter.lastTurnRef?.turnInjectDomain).toBe("pt-quality");
  });

  it("8. persistLastTurnRef 写入 session entry（pi.appendEntry 捕获）", async () => {
    const m = makePi();
    installExtension(m.pi as never);
    const sessionStart = m.events.get("session_start")?.[0]!;
    await sessionStart({ type: "session_start" }, m.ctx);

    const switchCmd = m.commands.get("pt-profile")!;
    await switchCmd.handler("pt-dev", m.ctx);

    m.appendedEntries.length = 0;

    const turnInjectTool = m.tools.get("pt_turn_inject")!;
    await turnInjectTool.execute("c1", { domain: "pt-quality" }, undefined, undefined, m.ctx);

    // 验证 appendEntry 被调，至少一条 PT_LAST_TURN_REF_ENTRY
    const entries = m.appendedEntries.filter(([t]) => t === PT_LAST_TURN_REF_ENTRY);
    expect(entries.length).toBeGreaterThan(0);
    expect(
      (entries[entries.length - 1]?.[1] as { turnInjectDomain: string }).turnInjectDomain
    ).toBe("pt-quality");
  });

  it("9. tryRestoreLastTurnRef 从 session entry 恢复 lastTurnRef", async () => {
    const m = makePi();
    installExtension(m.pi as never);

    // 在 session_start 之前预先放入 entry（模拟 resume）
    m.appendedEntries.push([
      PT_LAST_TURN_REF_ENTRY,
      { turnInjectDomain: "pt-quality", manualPath: "/some/manual.md" },
    ]);

    const sessionStart = m.events.get("session_start")?.[0]!;
    await sessionStart({ type: "session_start" }, m.ctx);

    const session = getSessionById(TEST_SESSION_ID);
    expect(session.lastTurnRef).not.toBeNull();
    expect(session.lastTurnRef?.turnInjectDomain).toBe("pt-quality");
    expect(session.lastTurnRef?.manualPath).toBe("/some/manual.md");
  });

  it("10. session_compact handler 异常不阻塞（sendMessage throw → log warn，不抛）", async () => {
    const sendMessageMock = vi.fn().mockRejectedValue(new Error("network down"));
    const m = makePi({ sendMessage: sendMessageMock });
    installExtension(m.pi as never);
    const sessionStart = m.events.get("session_start")?.[0]!;
    await sessionStart({ type: "session_start" }, m.ctx);

    const switchCmd = m.commands.get("pt-profile")!;
    await switchCmd.handler("pt-dev", m.ctx);

    const turnInjectTool = m.tools.get("pt_turn_inject")!;
    await turnInjectTool.execute("c1", { domain: "pt-quality" }, undefined, undefined, m.ctx);

    const compactHandler = m.events.get("session_compact")?.[0]!;
    // 不应 throw
    await expect(
      compactHandler(
        {
          type: "session_compact",
          compactionEntry: {},
          fromExtension: false,
          reason: "threshold",
          willRetry: false,
        },
        m.ctx
      )
    ).resolves.toBeUndefined();
    expect(sendMessageMock).toHaveBeenCalledOnce();
  });
});
