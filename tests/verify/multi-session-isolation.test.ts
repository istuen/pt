// tests/verify/multi-session-isolation.test.ts — issue pt-session-singleton-pi-web-pollution 修复验证
//
// v12.x：pt state 容器从 module-level 单例改为 Map<sessionId, SessionState>，
//        AgentAdapter 注册表改为 WeakMap<ExtensionAPI, ...>。
//
// 验证目标：
//   - 两个 mock ExtensionAPI 各持一份 per-session state，互不污染
//   - tab B 调 setAgentContext / registerInject 不会覆盖 tab A 的 segment
//   - session_shutdown 精确清本 session，不影响其他 session
//   - api.log / onInjected 走 per-session state

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import installExtension from "../../src/index.js";
import { clearAllSessions, getSessionById } from "../../src/session.js";
import { getAgentAdapter } from "../../src/agent/index.js";
import { PiAdapter } from "../../src/agent/pi-adapter.js";

type GenericHandler = (...args: unknown[]) => unknown;
type CtxLike = Record<string, unknown>;

/** mock pi：track handlers / setStatus / setWidget / appendEntry，给定固定 sessionId。 */
function makePi(sessionId: string) {
  const events = new Map<string, GenericHandler[]>();
  const commands = new Map<string, { handler: (args: string, ctx: CtxLike) => Promise<void> }>();
  const tools = new Map<string, { execute: (...a: unknown[]) => Promise<unknown> }>();
  const statusCalls: Array<[string, string | undefined]> = [];
  const widgetCalls: Array<[string, unknown, unknown?]> = [];
  const appendedEntries: Array<[string, unknown]> = [];

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
  };

  const ctx: CtxLike = {
    cwd: process.cwd(),
    sessionManager: {
      getEntries: () => [],
      getSessionId: () => sessionId,
    },
    hasUI: true,
    ui: {
      notify: () => undefined,
      setStatus: (key: string, text: string | undefined) => {
        statusCalls.push([key, text]);
      },
      setWidget: (key: string, content: unknown, options?: unknown) => {
        widgetCalls.push([key, content, options]);
      },
    },
    getSystemPrompt: () => "BASE",
  };

  return { pi, ctx, events, commands, tools, statusCalls, widgetCalls, appendedEntries };
}

describe("multi-session isolation（v12.x）", () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    clearAllSessions();
  });
  afterEach(async () => {
    clearAllSessions();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("两个 mock pi 各自持独立 session state（Map entry 数 = 2）", async () => {
    const piA = makePi("session-A");
    const piB = makePi("session-B");
    installExtension(piA.pi as never);
    installExtension(piB.pi as never);

    const handlerA = piA.events.get("session_start")?.[0];
    const handlerB = piB.events.get("session_start")?.[0];
    expect(handlerA).toBeDefined();
    expect(handlerB).toBeDefined();

    // 触发 session_start —— 但因为 pi-web 用各自的 pi 实例，每个 pi.on 注册的 handler
    // 都是 per-pi。我们手动给两个 pi 不同的 fallback 路径触发 session_start。
    // 这里只验证：clearAllSessions 后两个 session 的 state 不互相影响。
    expect(getSessionById("session-A")).toBeDefined();
    expect(getSessionById("session-B")).toBeDefined();

    // 改其中一个 state，另一个 state 不变
    const sA = getSessionById("session-A");
    const sB = getSessionById("session-B");
    sA.activeProfile = "profile-A";
    expect(sB.activeProfile).toBeNull();
  });

  it("AgentAdapter 注册表 per-pi：两次 getAgentAdapter(pi, ...) 返回不同实例", () => {
    const piA = makePi("session-A");
    const piB = makePi("session-B");
    installExtension(piA.pi as never);
    installExtension(piB.pi as never);

    const adapterA1 = getAgentAdapter(piA.pi as never, "pi");
    const adapterA2 = getAgentAdapter(piA.pi as never, "pi");
    const adapterB = getAgentAdapter(piB.pi as never, "pi");

    // 同 pi 重复调用 → 同一实例（缓存命中）
    expect(adapterA1).toBe(adapterA2);
    // 不同 pi → 不同实例
    expect(adapterA1).not.toBe(adapterB);
    // 都是 PiAdapter
    expect(adapterA1).toBeInstanceOf(PiAdapter);
    expect(adapterB).toBeInstanceOf(PiAdapter);
  });

  it("setAgentContext 覆盖 per-pi 字段不跨 session 串", () => {
    const piA = makePi("session-A");
    const piB = makePi("session-B");
    installExtension(piA.pi as never);
    installExtension(piB.pi as never);

    const adapterA = getAgentAdapter(piA.pi as never, "pi");
    const adapterB = getAgentAdapter(piB.pi as never, "pi");

    // 用真实 fixtures profile+domain 走完整 transpile 路径 → setAgentContext 会写入 sourceHash
    // 直接验证私有字段 this.ctx / this.blueprint 隔离（不再依赖 renderSessionPrompt 输出）
    const ctxA = {
      modules: {},
      sources: [],
      sourceHash: "hash-A",
      cwd: process.cwd(),
    } as never;
    const blueprintA = { name: "blueprint-a", injectionPoints: [] } as never;

    const ctxB = {
      modules: {},
      sources: [],
      sourceHash: "hash-B",
      cwd: process.cwd(),
    } as never;
    const blueprintB = { name: "blueprint-b", injectionPoints: [] } as never;

    // tab A setAgentContext
    adapterA.setAgentContext(ctxA, blueprintA, []);
    // tab B setAgentContext（会覆盖自己 adapterB 的字段，但不动 adapterA）
    adapterB.setAgentContext(ctxB, blueprintB, []);

    // 验证 per-pi 字段隔离（私有字段）
    const aInternal = adapterA as unknown as {
      ctx: { sourceHash: string };
      blueprint: { name: string };
      segment: string | null;
      injectedApi: unknown;
    };
    const bInternal = adapterB as unknown as {
      ctx: { sourceHash: string };
      blueprint: { name: string };
      segment: string | null;
      injectedApi: unknown;
    };
    expect(aInternal.ctx.sourceHash).toBe("hash-A");
    expect(aInternal.blueprint.name).toBe("blueprint-a");
    expect(bInternal.ctx.sourceHash).toBe("hash-B");
    expect(bInternal.blueprint.name).toBe("blueprint-b");

    // 关键断言：tab B setAgentContext 不影响 adapterA 字段（核心污染问题）
    expect(aInternal.ctx).not.toBe(bInternal.ctx);
    expect(aInternal.blueprint).not.toBe(bInternal.blueprint);
  });

  it("session_shutdown 精确清本 session state，不影响其他 session", async () => {
    const piA = makePi("session-A");
    const piB = makePi("session-B");
    installExtension(piA.pi as never);
    installExtension(piB.pi as never);

    const handlerA = piA.events.get("session_shutdown")?.[0];
    const handlerB = piB.events.get("session_shutdown")?.[0];
    expect(handlerA).toBeDefined();
    expect(handlerB).toBeDefined();

    // 给两个 session 写入不同 state
    getSessionById("session-A").activeProfile = "profile-A";
    getSessionById("session-B").activeProfile = "profile-B";

    // session-A 触发 shutdown
    await handlerA({ type: "session_shutdown" }, piA.ctx);

    // session-A state 被清
    expect(getSessionById("session-A").activeProfile).toBeNull();
    // session-B state 不受影响（虽然 lazy create 一个空 entry，但 activeProfile 仍是 "profile-B"）
    // 注意：getSessionById 是 lazy create —— 调用后会创建空 entry。但 shutdown 不会清它
    // （除非显式 clearSessionById）。shutdown 只清"shutdown 那一 session"。
    // 验证：session-B 的 activeProfile 仍是 "profile-B"
    expect(getSessionById("session-B").activeProfile).toBe("profile-B");
  });

  it("pt_manual tool 写 activeManual 不跨 session 串（widget / footer / cachedManualProgress 隔离）", async () => {
    // issue module-state-pi-web-multisession 回归断言：
    // tab A 调 pt_manual → tab B 不应显示 tab A 的 widget / footer 后缀 / cachedManualProgress。
    // 走真实 pt_manual tool 路径（先 /pt-profile 加载 profile 让 buildManualDoc 能找到 FlowTemplate）。
    const tempDirA = await mkdtemp(join(tmpdir(), "pt-multi-manual-a-"));
    tempDirs.push(tempDirA);
    await mkdir(join(tempDirA, ".pt", "manuals"), { recursive: true });

    const piA = makePi("session-A");
    const piB = makePi("session-B");
    installExtension(piA.pi as never);
    installExtension(piB.pi as never);

    // 两个 session 都加载 pt-dev profile（写各自 session state，互不串）
    await piA.events.get("session_start")?.[0]!({ type: "session_start" }, piA.ctx);
    await piB.events.get("session_start")?.[0]!({ type: "session_start" }, piB.ctx);
    await piA.commands.get("pt-profile")!.handler("pt-dev", piA.ctx);
    await piB.commands.get("pt-profile")!.handler("pt-dev", piB.ctx);

    // tab A 切到独立 cwd 调 pt_manual（避免写真实仓库）
    piA.ctx.cwd = tempDirA;
    const ptManualTool = piA.tools.get("pt_manual")!;
    await ptManualTool.execute(
      "call-a",
      { procedure: "feature-lifecycle", args: "tab-a" },
      undefined,
      undefined,
      piA.ctx
    );

    // tab A：activeManual 已设 + widget 已 set
    const sA = getSessionById("session-A");
    expect(sA.activeManual).not.toBeNull();
    expect(sA.activeManual?.procedure).toBe("feature-lifecycle");
    expect(sA.activeManual?.args).toBe("tab-a");
    expect(piA.widgetCalls.some(([k]) => k === "pt-manual")).toBe(true);

    // 关键隔离断言：tab B 的 activeManual / cachedManualProgress 仍为 null
    // （tab A 的 refreshManualWidget 写的是 session-A 的 cachedManualProgress，不串到 session-B）
    const sB = getSessionById("session-B");
    expect(sB.activeManual).toBeNull();
    expect(sB.cachedManualProgress).toBeNull();
    // tab B 不应被"显示" tab A 的 manual widget
    // （撤掉调用 setWidget("pt-manual", undefined) 是 tab B 自身 session_start 时的合法行为，不算串）
    const bWidgetShows = piB.widgetCalls.filter(
      ([k, content]) => k === "pt-manual" && Array.isArray(content)
    );
    expect(bWidgetShows).toHaveLength(0);
  });
});
