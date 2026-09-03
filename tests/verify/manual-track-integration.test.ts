// tests/verify/manual-track-integration.test.ts — index.ts 集成验证
//
// 配套 .pt/docs/designs/pt-injection-status-manual-track.md §2.5/2.6/2.7：
//   - pt_manual tool execute 成功后 → activeManual 设 + widget set + entry 写入
//   - session_start → tryRestoreManual → 读 entry → 校验 → 挂 widget
//   - /pt manual 命令 → 同 tool 路径
//   - session_shutdown → 清状态
//
// 测试策略：
//   - mock ExtensionAPI（仿 switch-injection.test.ts）
//   - 用真实 .pt/assets/profiles/pt-dev.profile.md（已在仓库）
//   - pt_manual 文件写入走真实 fs（用 mkdtemp 隔离，避免污染仓库）
//   - 不调真实 pi，验证会话内行为

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import installExtension from "../../src/index.js";
import { resetTestSession, s, TEST_SESSION_ID } from "./session-fixtures.js";

type GenericHandler = (...args: unknown[]) => unknown;
type CtxLike = Record<string, unknown>;

/** mock pi：track setStatus / setWidget 调用 + appendEntry 调用 */
function makePi() {
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
      getSessionId: () => TEST_SESSION_ID,
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

  return {
    pi,
    ctx,
    events,
    commands,
    tools,
    statusCalls,
    widgetCalls,
    appendedEntries,
  };
}

describe("manual track 集成", () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    resetTestSession();
  });

  afterEach(async () => {
    s().activeAdapter?.resetInjection?.();
    resetTestSession();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("pt_manual tool → 写 activeManual + widget setWidget + appendEntry", async () => {
    // 隔离 cwd：pt_manual 按 ctx.cwd 解析 .pt/manuals/ 写入路径，避免污染真实仓库
    // （issue pt-manual-test-residual 方案 A：原测试硬编码 ctx.cwd = process.cwd() 导致残留堆积）
    const tempDir = await mkdtemp(join(tmpdir(), "pt-manual-write-"));
    tempDirs.push(tempDir);
    await mkdir(join(tempDir, ".pt", "manuals"), { recursive: true });

    const m = makePi();
    installExtension(m.pi as never);

    // 触发 session_start（auto 可能不加载——项目根有多个 profile；用 switchProfile 加载 pt-dev）
    const sessionStart = m.events.get("session_start")?.[0]!;
    await sessionStart({ type: "session_start" }, m.ctx);

    // 用 /pt-context 强制加载 pt-dev（项目根有两个 profile，auto 不会 pick）
    const switchCmd = m.commands.get("pt-context")!;
    await switchCmd.handler("pt-dev", m.ctx);

    // 隔离 cwd：profile 已加载到全局 session（cachedBundles/cachedBlueprint 已设），
    // 此时切 cwd 让 pt_manual 写入到 tempDir，避免污染真实仓库
    // （issue pt-manual-test-residual 方案 A：profile 加载前不能切 cwd，否则 transpileActive 读不到 .pt/assets/）
    m.ctx.cwd = tempDir;

    // 清掉前置 status/widget 调用，便于断言
    m.statusCalls.length = 0;
    m.widgetCalls.length = 0;
    m.appendedEntries.length = 0;

    // 调 pt_manual tool
    const ptManualTool = m.tools.get("pt_manual");
    if (!ptManualTool) throw new Error("pt_manual tool not registered");
    const result = (await ptManualTool.execute(
      "call-1",
      { procedure: "deliver-feature", args: "manual-track-test" },
      undefined,
      undefined,
      m.ctx
    )) as { content: Array<{ type: string; text: string }>; details: { path: string } };

    expect(result).toBeDefined();
    expect(result.details).toBeDefined();
    expect(result.details.path).toMatch(/deliver-feature-\d+\.md$/);

    // 1. s().activeManual 已设
    expect(s().activeManual).not.toBeNull();
    expect(s().activeManual?.procedure).toBe("deliver-feature");
    expect(s().activeManual?.args).toBe("manual-track-test");

    // 2. widget 已 set（aboveEditor）
    const widgetSetCalls = m.widgetCalls.filter(([k]) => k === "pt-manual");
    expect(widgetSetCalls.length).toBeGreaterThanOrEqual(1);
    const lastWidget = widgetSetCalls[widgetSetCalls.length - 1]!;
    expect(Array.isArray(lastWidget[1])).toBe(true);
    expect(lastWidget[2]).toEqual({ placement: "aboveEditor" });

    // 3. appendEntry 已调（pt:active-manual）
    const manualEntries = m.appendedEntries.filter(([t]) => t === "pt:active-manual");
    expect(manualEntries.length).toBe(1);
    expect((manualEntries[0]?.[1] as { procedure: string }).procedure).toBe("deliver-feature");

    // 4. footer 已 setStatus（含 "manual: deliver-feature" 后缀）
    const lastStatus = m.statusCalls[m.statusCalls.length - 1]!;
    expect(lastStatus[0]).toBe("pt");
    expect(lastStatus[1]).toContain("manual: deliver-feature");
  });

  it("session_shutdown → resetSession 清空 activeManual + injectionState", async () => {
    const m = makePi();
    installExtension(m.pi as never);

    const sessionStart = m.events.get("session_start")?.[0]!;
    await sessionStart({ type: "session_start" }, m.ctx);

    // 模拟已有 activeManual
    s().activeManual = {
      filePath: "/tmp/fake.md",
      procedure: "fake",
      args: "",
      activatedAt: Date.now(),
    };
    s().injectionState = "injected";

    const shutdown = m.events.get("session_shutdown")?.[0]!;
    await shutdown({ type: "session_shutdown" }, m.ctx);

    expect(s().activeManual).toBeNull();
    expect(s().injectionState).toBe("idle");
    expect(s().injectionError).toBeNull();
  });

  it("session_start fallback: pt:active-manual entry → activeManual 恢复", async () => {
    // 预置一个 manual fixture 文件 + appendEntry 记录
    const fixtureDir = await mkdtemp(join(tmpdir(), "pt-manual-restore-"));
    tempDirs.push(fixtureDir);
    await mkdir(join(fixtureDir, ".pt/manuals"), { recursive: true });
    const fixtureManualPath = join(fixtureDir, ".pt/manuals/test-123.md");
    await writeFile(
      fixtureManualPath,
      `---
procedure: restore-test
status: in-progress
---
- [x] step1
- [ ] step2
`,
      "utf8"
    );

    const m = makePi();
    installExtension(m.pi as never);

    // 改 ctx.sessionManager 让它返回 manual entry
    const entries = [
      {
        type: "custom",
        customType: "pt:active-manual",
        data: { filePath: fixtureManualPath, procedure: "restore-test", args: "" },
      },
    ];
    m.ctx.sessionManager = { getEntries: () => entries, getSessionId: () => TEST_SESSION_ID };

    const sessionStart = m.events.get("session_start")?.[0]!;
    await sessionStart({ type: "session_start" }, m.ctx);

    // 恢复成功
    expect(s().activeManual?.procedure).toBe("restore-test");
    expect(s().activeManual?.filePath).toBe(fixtureManualPath);

    // widget set（in-progress）
    const widgetSetCalls = m.widgetCalls.filter(([k]) => k === "pt-manual");
    expect(widgetSetCalls.length).toBeGreaterThanOrEqual(1);
    const lastWidget = widgetSetCalls[widgetSetCalls.length - 1]!;
    expect(Array.isArray(lastWidget[1])).toBe(true);
    expect(lastWidget[2]).toEqual({ placement: "aboveEditor" });
  });

  it("session_start fallback: 已 completed 的 manual 不恢复", async () => {
    const fixtureDir = await mkdtemp(join(tmpdir(), "pt-manual-completed-"));
    tempDirs.push(fixtureDir);
    await mkdir(join(fixtureDir, ".pt/manuals"), { recursive: true });
    const fixtureManualPath = join(fixtureDir, ".pt/manuals/completed-456.md");
    await writeFile(
      fixtureManualPath,
      `---
procedure: done-test
status: completed
---
- [x] step1
`,
      "utf8"
    );

    const m = makePi();
    installExtension(m.pi as never);

    const entries = [
      {
        type: "custom",
        customType: "pt:active-manual",
        data: { filePath: fixtureManualPath, procedure: "done-test", args: "" },
      },
    ];
    m.ctx.sessionManager = { getEntries: () => entries, getSessionId: () => TEST_SESSION_ID };

    const sessionStart = m.events.get("session_start")?.[0]!;
    await sessionStart({ type: "session_start" }, m.ctx);

    // 不恢复
    expect(s().activeManual).toBeNull();
  });

  it("session_start fallback: 文件已被删的 manual 不恢复", async () => {
    const m = makePi();
    installExtension(m.pi as never);

    const entries = [
      {
        type: "custom",
        customType: "pt:active-manual",
        data: {
          filePath: "/tmp/this-file-does-not-exist-12345.md",
          procedure: "ghost",
          args: "",
        },
      },
    ];
    m.ctx.sessionManager = { getEntries: () => entries, getSessionId: () => TEST_SESSION_ID };

    const sessionStart = m.events.get("session_start")?.[0]!;
    await sessionStart({ type: "session_start" }, m.ctx);

    expect(s().activeManual).toBeNull();
  });

  it("/pt manual 命令 → 同 tool 路径（activeManual + widget + entry）", async () => {
    // 隔离 cwd：/pt manual 命令按 ctx.cwd 解析 .pt/manuals/ 写入路径，避免污染真实仓库
    // （issue pt-manual-test-residual 方案 A）
    const tempDir = await mkdtemp(join(tmpdir(), "pt-manual-write-"));
    tempDirs.push(tempDir);
    await mkdir(join(tempDir, ".pt", "manuals"), { recursive: true });

    const m = makePi();
    installExtension(m.pi as never);

    const sessionStart = m.events.get("session_start")?.[0]!;
    await sessionStart({ type: "session_start" }, m.ctx);

    const switchCmd = m.commands.get("pt-context")!;
    await switchCmd.handler("pt-dev", m.ctx);

    // 隔离 cwd：profile 已加载到全局 session，切 cwd 让 /pt manual 命令写入到 tempDir（避免污染真实仓库）
    // （issue pt-manual-test-residual 方案 A）
    m.ctx.cwd = tempDir;

    m.statusCalls.length = 0;
    m.widgetCalls.length = 0;
    m.appendedEntries.length = 0;

    const ptCmd = m.commands.get("pt")!;
    await ptCmd.handler("manual deliver-feature cmd-test", m.ctx);

    expect(s().activeManual?.procedure).toBe("deliver-feature");
    expect(s().activeManual?.args).toBe("cmd-test");

    const widgetSetCalls = m.widgetCalls.filter(([k]) => k === "pt-manual");
    expect(widgetSetCalls.length).toBeGreaterThanOrEqual(1);

    const manualEntries = m.appendedEntries.filter(([t]) => t === "pt:active-manual");
    expect(manualEntries.length).toBe(1);
  });

  it("injectionState 切换 profile 后变 pending", async () => {
    const m = makePi();
    installExtension(m.pi as never);

    const sessionStart = m.events.get("session_start")?.[0]!;
    await sessionStart({ type: "session_start" }, m.ctx);

    // 模拟一次成功注入（injected）
    s().injectionState = "injected";

    // 切换 profile
    const switchCmd = m.commands.get("pt-context")!;
    await switchCmd.handler("pt-chat", m.ctx);

    // 切换后立即 pending
    expect(s().injectionState).toBe("pending");
  });
});
