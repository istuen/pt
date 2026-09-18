// tests/verify/build-manual-doc-issue.test.ts — P3：manual frontmatter issue 关联字段
//
// 验证：
//   - buildManualDoc 接受 issue 参数 → frontmatter 含 `issue: <name>`
//   - issue=undefined / "" / 空白 → frontmatter 无 `issue:` 行（back-compat）
//   - pt_manual tool 把 issue 传给 buildManualDoc + activeManual
//   - persistManualToSession 写入 entry 含 issue 字段（旧 entry 无 issue 也兼容）
//   - tryRestoreManual 恢复时把 issue 写回 activeManual
//   - /pt manual <proc> [args] --issue <name> 命令解析（拆出 flag，不污染 args）

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildManualDoc } from "../../src/commands.js";
import installExtension from "../../src/index.js";
import { clearAllSessions, getSessionById } from "../../src/session.js";
import { resetTestSession, s, TEST_SESSION_ID } from "./session-fixtures.js";

type GenericHandler = (...args: unknown[]) => unknown;
type CtxLike = Record<string, unknown>;

interface PiObj {
  events: Map<string, GenericHandler[]>;
  commands: Map<string, { handler: (args: string, ctx: CtxLike) => Promise<void> }>;
  tools: Map<string, { execute: (...a: unknown[]) => Promise<unknown> }>;
  statusCalls: Array<[string, string | undefined]>;
  widgetCalls: Array<[string, unknown, unknown?]>;
  appendedEntries: Array<[string, unknown]>;
  pi: unknown;
  ctx: CtxLike;
}

/** mock pi：与 manual-track-integration.test.ts 同构，但允许自定义 sessionId + 自定义 entries。 */
function makePi(
  opts: {
    sessionId?: string;
    entries?: Array<{ type: string; customType?: string; data?: unknown }>;
  } = {}
): PiObj {
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
      getEntries: () => opts.entries ?? [],
      getSessionId: () => opts.sessionId ?? TEST_SESSION_ID,
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

describe("P3 buildManualDoc：issue 关联字段", () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    resetTestSession();
  });
  afterEach(async () => {
    resetTestSession();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("issue 字段入 frontmatter（在 args: 之后）", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "p3-issue-"));
    tempDirs.push(tempDir);
    await mkdir(join(tempDir, ".pt", "manuals"), { recursive: true });

    const m = makePi();
    installExtension(m.pi as never);

    // 触发 session_start + 加载 pt-dev（需加载 Profile 才能找到 FlowTemplate）
    const sessionStart = m.events.get("session_start")?.[0]!;
    await sessionStart({ type: "session_start" }, m.ctx);
    const switchCmd = m.commands.get("pt-profile")!;
    await switchCmd.handler("pt-dev", m.ctx);

    // 切 cwd 到 tempDir 让 manual 写入到 tempDir
    m.ctx.cwd = tempDir;

    const doc = buildManualDoc(tempDir, s(), "feature-lifecycle", "req-001", "pt-widget-bug");
    expect(doc.error).toBeUndefined();
    expect(doc.content).toContain("issue: pt-widget-bug");
    // 位置：在 args: 之后（frontmatter 顺序：procedure/domain/created/status/args/issue/---）
    const lines = doc.content.split("\n");
    const idxArgs = lines.findIndex((l) => l.startsWith("args:"));
    const idxIssue = lines.findIndex((l) => l.startsWith("issue:"));
    expect(idxArgs).toBeGreaterThan(-1);
    expect(idxIssue).toBeGreaterThan(idxArgs);
  });

  it("issue=undefined → frontmatter 无 `issue:` 行（back-compat）", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "p3-issue-"));
    tempDirs.push(tempDir);
    await mkdir(join(tempDir, ".pt", "manuals"), { recursive: true });

    const m = makePi();
    installExtension(m.pi as never);
    const sessionStart = m.events.get("session_start")?.[0]!;
    await sessionStart({ type: "session_start" }, m.ctx);
    const switchCmd = m.commands.get("pt-profile")!;
    await switchCmd.handler("pt-dev", m.ctx);
    m.ctx.cwd = tempDir;

    const doc = buildManualDoc(tempDir, s(), "feature-lifecycle", "req-002");
    expect(doc.error).toBeUndefined();
    expect(doc.content).not.toContain("issue:");
  });

  it('issue="" → 同 undefined（不写行）', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "p3-issue-"));
    tempDirs.push(tempDir);
    await mkdir(join(tempDir, ".pt", "manuals"), { recursive: true });

    const m = makePi();
    installExtension(m.pi as never);
    const sessionStart = m.events.get("session_start")?.[0]!;
    await sessionStart({ type: "session_start" }, m.ctx);
    const switchCmd = m.commands.get("pt-profile")!;
    await switchCmd.handler("pt-dev", m.ctx);
    m.ctx.cwd = tempDir;

    const doc = buildManualDoc(tempDir, s(), "feature-lifecycle", "req-003", "");
    expect(doc.error).toBeUndefined();
    expect(doc.content).not.toContain("issue:");
  });

  it('issue="   "（纯空白）→ 同 undefined（trim 后为空）', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "p3-issue-"));
    tempDirs.push(tempDir);
    await mkdir(join(tempDir, ".pt", "manuals"), { recursive: true });

    const m = makePi();
    installExtension(m.pi as never);
    const sessionStart = m.events.get("session_start")?.[0]!;
    await sessionStart({ type: "session_start" }, m.ctx);
    const switchCmd = m.commands.get("pt-profile")!;
    await switchCmd.handler("pt-dev", m.ctx);
    m.ctx.cwd = tempDir;

    const doc = buildManualDoc(tempDir, s(), "feature-lifecycle", "req-004", "   ");
    expect(doc.error).toBeUndefined();
    expect(doc.content).not.toContain("issue:");
  });

  it("issue 前后空白被 trim", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "p3-issue-"));
    tempDirs.push(tempDir);
    await mkdir(join(tempDir, ".pt", "manuals"), { recursive: true });

    const m = makePi();
    installExtension(m.pi as never);
    const sessionStart = m.events.get("session_start")?.[0]!;
    await sessionStart({ type: "session_start" }, m.ctx);
    const switchCmd = m.commands.get("pt-profile")!;
    await switchCmd.handler("pt-dev", m.ctx);
    m.ctx.cwd = tempDir;

    const doc = buildManualDoc(tempDir, s(), "feature-lifecycle", "req", "  pt-foo  ");
    expect(doc.error).toBeUndefined();
    expect(doc.content).toContain("issue: pt-foo"); // trim 后无前后空格
    expect(doc.content).not.toContain("issue:   pt-foo"); // 不留原文
  });
});

describe("P3 pt_manual tool：issue 参数链路", () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    clearAllSessions();
  });
  afterEach(async () => {
    clearAllSessions();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("传 issue → activeManual.issue + persistManualToSession entry.issue 同步", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "p3-tool-"));
    tempDirs.push(tempDir);
    await mkdir(join(tempDir, ".pt", "manuals"), { recursive: true });

    const m = makePi();
    installExtension(m.pi as never);
    const sessionStart = m.events.get("session_start")?.[0]!;
    await sessionStart({ type: "session_start" }, m.ctx);
    const switchCmd = m.commands.get("pt-profile")!;
    await switchCmd.handler("pt-dev", m.ctx);
    m.ctx.cwd = tempDir;

    // 清掉前置 widget/status/appended 调用
    m.statusCalls.length = 0;
    m.widgetCalls.length = 0;
    m.appendedEntries.length = 0;

    const ptManualTool = m.tools.get("pt_manual");
    if (!ptManualTool) throw new Error("pt_manual tool not registered");

    const result = (await ptManualTool.execute(
      "call-1",
      {
        procedure: "feature-lifecycle",
        args: "req-001",
        issue: "pt-widget-bug",
      },
      undefined,
      undefined,
      m.ctx
    )) as { details: { path: string } };
    expect(result.details.path).toMatch(/feature-lifecycle-\d+\.md$/);

    // 1. activeManual.issue 已设
    const session = getSessionById(TEST_SESSION_ID);
    expect(session.activeManual).not.toBeNull();
    expect(session.activeManual?.issue).toBe("pt-widget-bug");

    // 2. persistManualToSession entry 含 issue
    const manualEntries = m.appendedEntries.filter(([t]) => t === "pt:active-manual");
    expect(manualEntries.length).toBe(1);
    expect((manualEntries[0]?.[1] as { issue?: string }).issue).toBe("pt-widget-bug");

    // 3. manual 文件含 issue: 行
    const { readFile } = await import("node:fs/promises");
    const fileContent = await readFile(result.details.path, "utf8");
    expect(fileContent).toContain("issue: pt-widget-bug");
  });

  it("不传 issue → activeManual.issue = undefined + entry 无 issue 字段", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "p3-tool-"));
    tempDirs.push(tempDir);
    await mkdir(join(tempDir, ".pt", "manuals"), { recursive: true });

    const m = makePi();
    installExtension(m.pi as never);
    const sessionStart = m.events.get("session_start")?.[0]!;
    await sessionStart({ type: "session_start" }, m.ctx);
    const switchCmd = m.commands.get("pt-profile")!;
    await switchCmd.handler("pt-dev", m.ctx);
    m.ctx.cwd = tempDir;

    m.appendedEntries.length = 0;

    const ptManualTool = m.tools.get("pt_manual")!;
    const result = (await ptManualTool.execute(
      "call-1",
      { procedure: "feature-lifecycle", args: "req-002" },
      undefined,
      undefined,
      m.ctx
    )) as { details: { path: string } };

    const session = getSessionById(TEST_SESSION_ID);
    expect(session.activeManual?.issue).toBeUndefined();
    const manualEntries = m.appendedEntries.filter(([t]) => t === "pt:active-manual");
    expect((manualEntries[0]?.[1] as { issue?: string }).issue).toBeUndefined();

    const { readFile } = await import("node:fs/promises");
    const fileContent = await readFile(result.details.path, "utf8");
    expect(fileContent).not.toContain("issue:");
  });
});

describe("P3 tryRestoreManual：恢复 issue 字段", () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    clearAllSessions();
  });
  afterEach(async () => {
    clearAllSessions();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("entry.issue 存在 → activeManual.issue 正确恢复", async () => {
    const fixtureDir = await mkdtemp(join(tmpdir(), "p3-restore-"));
    tempDirs.push(fixtureDir);
    await mkdir(join(fixtureDir, ".pt/manuals"), { recursive: true });
    const fixtureManualPath = join(fixtureDir, ".pt/manuals/test-issue.md");
    await writeFile(
      fixtureManualPath,
      `---
procedure: restore-issue-test
status: in-progress
---
- [x] step1
- [ ] step2
`,
      "utf8"
    );

    const m = makePi({
      entries: [
        {
          type: "custom",
          customType: "pt:active-manual",
          data: {
            filePath: fixtureManualPath,
            procedure: "restore-issue-test",
            args: "",
            issue: "pt-restore-bug",
          },
        },
      ],
    });
    installExtension(m.pi as never);

    const sessionStart = m.events.get("session_start")?.[0]!;
    await sessionStart({ type: "session_start" }, m.ctx);

    const session = getSessionById(TEST_SESSION_ID);
    expect(session.activeManual?.issue).toBe("pt-restore-bug");
  });

  it("旧 entry（P3 之前）无 issue 字段 → activeManual.issue = undefined，恢复不报错", async () => {
    const fixtureDir = await mkdtemp(join(tmpdir(), "p3-restore-"));
    tempDirs.push(fixtureDir);
    await mkdir(join(fixtureDir, ".pt/manuals"), { recursive: true });
    const fixtureManualPath = join(fixtureDir, ".pt/manuals/legacy.md");
    await writeFile(
      fixtureManualPath,
      `---
procedure: legacy
status: in-progress
---
- [x] step1
`,
      "utf8"
    );

    const m = makePi({
      entries: [
        {
          type: "custom",
          customType: "pt:active-manual",
          data: { filePath: fixtureManualPath, procedure: "legacy", args: "" }, // 无 issue 字段
        },
      ],
    });
    installExtension(m.pi as never);

    const sessionStart = m.events.get("session_start")?.[0]!;
    await sessionStart({ type: "session_start" }, m.ctx);

    const session = getSessionById(TEST_SESSION_ID);
    expect(session.activeManual?.issue).toBeUndefined();
    expect(session.activeManual?.procedure).toBe("legacy"); // 其他字段正常恢复
  });
});

describe("P3 /pt manual command：--issue flag 解析", () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    clearAllSessions();
  });
  afterEach(async () => {
    clearAllSessions();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("/pt manual feature-lifecycle req-003 --issue pt-foo → frontmatter 含 issue: pt-foo", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "p3-cmd-"));
    tempDirs.push(tempDir);
    await mkdir(join(tempDir, ".pt", "manuals"), { recursive: true });

    const m = makePi();
    installExtension(m.pi as never);
    const sessionStart = m.events.get("session_start")?.[0]!;
    await sessionStart({ type: "session_start" }, m.ctx);
    const switchCmd = m.commands.get("pt-profile")!;
    await switchCmd.handler("pt-dev", m.ctx);
    m.ctx.cwd = tempDir;

    m.appendedEntries.length = 0;
    const ptCmd = m.commands.get("pt")!;
    await ptCmd.handler("manual feature-lifecycle req-003 --issue pt-foo", m.ctx);

    const session = getSessionById(TEST_SESSION_ID);
    expect(session.activeManual?.issue).toBe("pt-foo");
    expect(session.activeManual?.procedure).toBe("feature-lifecycle");
    expect(session.activeManual?.args).toBe("req-003");

    const manualEntries = m.appendedEntries.filter(([t]) => t === "pt:active-manual");
    expect((manualEntries[0]?.[1] as { issue?: string }).issue).toBe("pt-foo");
  });

  it("/pt manual feature-lifecycle req --issue=pt-bar（= 形式）→ 也支持", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "p3-cmd-"));
    tempDirs.push(tempDir);
    await mkdir(join(tempDir, ".pt", "manuals"), { recursive: true });

    const m = makePi();
    installExtension(m.pi as never);
    const sessionStart = m.events.get("session_start")?.[0]!;
    await sessionStart({ type: "session_start" }, m.ctx);
    const switchCmd = m.commands.get("pt-profile")!;
    await switchCmd.handler("pt-dev", m.ctx);
    m.ctx.cwd = tempDir;

    const ptCmd = m.commands.get("pt")!;
    await ptCmd.handler("manual feature-lifecycle req --issue=pt-bar", m.ctx);

    const session = getSessionById(TEST_SESSION_ID);
    expect(session.activeManual?.issue).toBe("pt-bar");
  });

  it("/pt manual feature-lifecycle req（不传 --issue）→ activeManual.issue = undefined（back-compat）", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "p3-cmd-"));
    tempDirs.push(tempDir);
    await mkdir(join(tempDir, ".pt", "manuals"), { recursive: true });

    const m = makePi();
    installExtension(m.pi as never);
    const sessionStart = m.events.get("session_start")?.[0]!;
    await sessionStart({ type: "session_start" }, m.ctx);
    const switchCmd = m.commands.get("pt-profile")!;
    await switchCmd.handler("pt-dev", m.ctx);
    m.ctx.cwd = tempDir;

    const ptCmd = m.commands.get("pt")!;
    await ptCmd.handler("manual feature-lifecycle req-005", m.ctx);

    const session = getSessionById(TEST_SESSION_ID);
    expect(session.activeManual?.issue).toBeUndefined();
    expect(session.activeManual?.args).toBe("req-005"); // 现有 args 解析不受影响
  });

  it("--issue 后缺参数 → 不传 issue（issueName 留 undefined），现有 args 不被吞", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "p3-cmd-"));
    tempDirs.push(tempDir);
    await mkdir(join(tempDir, ".pt", "manuals"), { recursive: true });

    const m = makePi();
    installExtension(m.pi as never);
    const sessionStart = m.events.get("session_start")?.[0]!;
    await sessionStart({ type: "session_start" }, m.ctx);
    const switchCmd = m.commands.get("pt-profile")!;
    await switchCmd.handler("pt-dev", m.ctx);
    m.ctx.cwd = tempDir;

    const ptCmd = m.commands.get("pt")!;
    // 缺少 --issue 的值（紧跟 procedure）
    await ptCmd.handler("manual feature-lifecycle req --issue", m.ctx);

    const session = getSessionById(TEST_SESSION_ID);
    expect(session.activeManual?.issue).toBeUndefined();
    // "req" 仍作为 args 传入（不被 --issue 污染）
    expect(session.activeManual?.args).toBe("req");
  });
});
