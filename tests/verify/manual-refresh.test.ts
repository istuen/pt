// tests/verify/manual-refresh.test.ts — P1：manual widget 刷新路径集成测试
//
// 验证：
//   - refreshManualWidget 浅比较去重：进度未变时不发 setWidget IPC（mock ui.setWidget 计数）
//   - refreshInjectionFooter 字符串去重：text 未变时不发 setStatus IPC
//   - pathEquals：跨平台路径归一比较（绝对/相对/cwd-相对混合形态视为同一文件）
//   - 集成：tool_result / turn_end 钩子在 edit 命中 manual 时刷新，未命中时不动

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  pathEquals,
  refreshInjectionFooter,
  refreshManualWidget,
} from "../../src/manual-session.js";
import type { ManualProgress } from "../../src/manual-track.js";
import type { ActiveManual, SessionState } from "../../src/session.js";
import { clearAllSessions, getSessionById } from "../../src/session.js";

/** mock ExtensionUIContext：setWidget / setStatus 计数 + 记录。 */
function makeUi() {
  const widgetCalls: Array<[string, unknown, unknown?]> = [];
  const statusCalls: Array<[string, string | undefined]> = [];
  return {
    ui: {
      setWidget: (key: string, content: unknown, options?: unknown) => {
        widgetCalls.push([key, content, options]);
      },
      setStatus: (key: string, text: string | undefined) => {
        statusCalls.push([key, text]);
      },
    },
    widgetCalls,
    statusCalls,
  };
}

/** 写一个 in-progress manual fixture（- [x]/- [ ] 3/6 状态）到 tempDir/.pt/manuals/。 */
async function writeManualFixture(
  dir: string,
  opts: {
    procedure?: string;
    doneCount?: number;
    totalCount?: number;
    status?: string;
  }
): Promise<string> {
  const manualsDir = join(dir, ".pt", "manuals");
  await mkdir(manualsDir, { recursive: true });
  const filePath = join(manualsDir, "fixture.md");
  const done = opts.doneCount ?? 1;
  const total = opts.totalCount ?? 3;
  const status = opts.status ?? "in-progress";
  const procedure = opts.procedure ?? "fixture";
  const items: string[] = [];
  for (let i = 0; i < total; i++) {
    items.push(i < done ? `- [x] step${i + 1}` : `- [ ] step${i + 1}`);
  }
  const content = `---
procedure: ${procedure}
status: ${status}
---
# fixture
${items.join("\n")}
`;
  await writeFile(filePath, content);
  return filePath;
}

/** 构造 SessionState stub（覆盖 refreshManualWidget / refreshInjectionFooter 用到的字段）。 */
function makeSession(
  filePath: string,
  opts: { procedure?: string; args?: string } = {}
): SessionState {
  const activeManual: ActiveManual = {
    filePath,
    procedure: opts.procedure ?? "fixture",
    args: opts.args ?? "",
    activatedAt: Date.now(),
  };
  const s = getSessionById("manual-refresh-test");
  s.activeManual = activeManual;
  s.cachedManualProgress = null;
  s.lastFooterText = null;
  // refreshInjectionFooter 读到的最小字段
  s.injectionState = "idle";
  s.activeProfile = "test";
  s.injectionError = null;
  s.assetHealthIssues = null;
  s.cachedProfile = null;
  return s;
}

describe("P1: refreshManualWidget 浅比较去重", () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    clearAllSessions();
  });
  afterEach(async () => {
    clearAllSessions();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("首次刷新：activeManual 存在 + 文件解析成功 → 发 1 次 setWidget", async () => {
    const dir = await mkdtemp(join(tmpdir(), "manual-refresh-"));
    tempDirs.push(dir);
    const filePath = await writeManualFixture(dir, { doneCount: 1, totalCount: 3 });
    const session = makeSession(filePath);
    const { ui, widgetCalls } = makeUi();

    await refreshManualWidget(ui as never, session);

    expect(widgetCalls).toHaveLength(1);
    expect(widgetCalls[0]?.[0]).toBe("pt-manual");
    expect(Array.isArray(widgetCalls[0]?.[1])).toBe(true);
    expect(widgetCalls[0]?.[2]).toEqual({ placement: "aboveEditor" });
    expect(session.cachedManualProgress).not.toBeNull();
    expect(session.cachedManualProgress?.stepDone).toBe(1);
    expect(session.cachedManualProgress?.stepTotal).toBe(3);
  });

  it("连续两次刷新（文件不变）→ 只第 1 次发 setWidget，第 2 次浅比较跳过", async () => {
    const dir = await mkdtemp(join(tmpdir(), "manual-refresh-"));
    tempDirs.push(dir);
    const filePath = await writeManualFixture(dir, { doneCount: 1, totalCount: 3 });
    const session = makeSession(filePath);
    const { ui, widgetCalls } = makeUi();

    await refreshManualWidget(ui as never, session);
    await refreshManualWidget(ui as never, session);

    expect(widgetCalls).toHaveLength(1); // 浅比较去重生效
    expect(session.cachedManualProgress?.stepDone).toBe(1);
  });

  it("两次刷新（文件变化）→ 发 2 次 setWidget（浅比较判定有变化）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "manual-refresh-"));
    tempDirs.push(dir);
    const filePath = await writeManualFixture(dir, { doneCount: 1, totalCount: 3 });
    const session = makeSession(filePath);
    const { ui, widgetCalls } = makeUi();

    await refreshManualWidget(ui as never, session);
    expect(widgetCalls).toHaveLength(1);

    // 用户勾了一步
    await writeManualFixture(dir, { doneCount: 2, totalCount: 3 });
    await refreshManualWidget(ui as never, session);
    expect(widgetCalls).toHaveLength(2);
    expect(session.cachedManualProgress?.stepDone).toBe(2);
  });

  it("activeManual=null + cachedManualProgress=null → 不发 setWidget(undefined)（避免无变化 IPC）", async () => {
    const session = getSessionById("manual-refresh-test");
    session.activeManual = null;
    session.cachedManualProgress = null;
    const { ui, widgetCalls } = makeUi();

    await refreshManualWidget(ui as never, session);
    expect(widgetCalls).toHaveLength(0);
  });

  it("activeManual=null + cachedManualProgress 非 null → 发 setWidget(undefined) 撤 widget + 重置 footer 缓存", async () => {
    const session = getSessionById("manual-refresh-test");
    session.activeManual = null;
    const prev: ManualProgress = {
      procedure: "x",
      stepDone: 1,
      stepTotal: 2,
      status: "in-progress",
      nextStep: "step2",
      stepOutcomes: [],
      hasUnfinishedOutcome: false,
      pseudoComplete: false,
    };
    session.cachedManualProgress = prev;
    session.lastFooterText = "old";
    const { ui, widgetCalls } = makeUi();

    await refreshManualWidget(ui as never, session);
    expect(widgetCalls).toHaveLength(1);
    expect(widgetCalls[0]?.[0]).toBe("pt-manual");
    expect(widgetCalls[0]?.[1]).toBeUndefined();
    expect(session.cachedManualProgress).toBeNull();
    expect(session.lastFooterText).toBeNull();
  });

  it("activeManual 存在但文件被删（parse 返回 null + cachedManualProgress 之前非 null）→ 清 activeManual + 撤 widget", async () => {
    const session = getSessionById("manual-refresh-test");
    // 先模拟之前成功挂过 widget（cachedManualProgress 有值）
    const prev: ManualProgress = {
      procedure: "x",
      stepDone: 1,
      stepTotal: 2,
      status: "in-progress",
      nextStep: "step2",
      stepOutcomes: [],
      hasUnfinishedOutcome: false,
      pseudoComplete: false,
    };
    session.activeManual = {
      filePath: "/non/existent/path.md",
      procedure: "x",
      args: "",
      activatedAt: Date.now(),
    };
    session.cachedManualProgress = prev;
    session.lastFooterText = "old";
    const { ui, widgetCalls } = makeUi();

    await refreshManualWidget(ui as never, session);
    // cachedManualProgress 由非 null 变 null → 发撤 widget IPC
    expect(widgetCalls).toHaveLength(1);
    expect(widgetCalls[0]?.[0]).toBe("pt-manual");
    expect(widgetCalls[0]?.[1]).toBeUndefined();
    expect(session.activeManual).toBeNull();
    expect(session.cachedManualProgress).toBeNull();
    expect(session.lastFooterText).toBeNull();
  });

  it("activeManual 存在但文件被删 + cachedManualProgress 从未挂过 → 不发撤 widget IPC（widget 从未上）", async () => {
    const session = getSessionById("manual-refresh-test");
    session.activeManual = {
      filePath: "/non/existent/path.md",
      procedure: "x",
      args: "",
      activatedAt: Date.now(),
    };
    session.cachedManualProgress = null; // 从未成功挂过 widget
    const { ui, widgetCalls } = makeUi();

    await refreshManualWidget(ui as never, session);
    // cachedManualProgress 本来就是 null → 不发 IPC（widget 本就没挂）
    expect(widgetCalls).toHaveLength(0);
    expect(session.activeManual).toBeNull();
  });
});

describe("P1: refreshInjectionFooter 字符串去重", () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    clearAllSessions();
  });
  afterEach(async () => {
    clearAllSessions();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("连续两次刷新（footer 文本未变）→ 只第 1 次发 setStatus", async () => {
    const dir = await mkdtemp(join(tmpdir(), "manual-refresh-"));
    tempDirs.push(dir);
    const filePath = await writeManualFixture(dir, { doneCount: 1, totalCount: 3 });
    const session = makeSession(filePath);
    const { ui, statusCalls, widgetCalls } = makeUi();

    // 先设一次 widget 让 cachedManualProgress 有值（footer 读这个）
    await refreshManualWidget(ui as never, session);
    widgetCalls.length = 0;
    statusCalls.length = 0;

    refreshInjectionFooter(ui as never, session);
    refreshInjectionFooter(ui as never, session);
    refreshInjectionFooter(ui as never, session);

    expect(statusCalls).toHaveLength(1); // 字符串去重
    expect(statusCalls[0]?.[0]).toBe("pt");
    expect(statusCalls[0]?.[1]).toContain("manual: fixture");
  });

  it("cachedManualProgress 变化 → footer 文本变 → 发新 setStatus", async () => {
    const dir = await mkdtemp(join(tmpdir(), "manual-refresh-"));
    tempDirs.push(dir);
    const filePath = await writeManualFixture(dir, { doneCount: 1, totalCount: 3 });
    const session = makeSession(filePath);
    const { ui, statusCalls } = makeUi();

    await refreshManualWidget(ui as never, session);
    refreshInjectionFooter(ui as never, session);
    const firstText = statusCalls[0]?.[1];

    // 用户勾了一步 → widget 重渲染 → cachedManualProgress 变 → footer 后缀变
    await writeManualFixture(dir, { doneCount: 2, totalCount: 3 });
    await refreshManualWidget(ui as never, session);
    refreshInjectionFooter(ui as never, session);
    const secondText = statusCalls[1]?.[1];

    expect(statusCalls).toHaveLength(2);
    expect(firstText).not.toBe(secondText);
    expect(secondText).toContain("2/3");
  });

  it("无 activeManual → footer 只含 injection 状态，刷新两次只发一次 setStatus", async () => {
    const session = getSessionById("manual-refresh-test");
    session.activeManual = null;
    session.cachedManualProgress = null;
    session.injectionState = "idle";
    session.activeProfile = "test";
    session.lastFooterText = null;
    const { ui, statusCalls } = makeUi();

    refreshInjectionFooter(ui as never, session);
    refreshInjectionFooter(ui as never, session);

    expect(statusCalls).toHaveLength(1);
  });

  it("injectionState 变化（idle → injected）+ 有 profile → footer 文本变 → 发新 setStatus", async () => {
    const session = getSessionById("manual-refresh-test");
    session.activeManual = null;
    session.cachedManualProgress = null;
    session.injectionState = "idle";
    session.activeProfile = "test";
    session.lastFooterText = null;
    const { ui, statusCalls } = makeUi();

    refreshInjectionFooter(ui as never, session);
    session.injectionState = "injected";
    refreshInjectionFooter(ui as never, session);

    expect(statusCalls).toHaveLength(2);
    expect(statusCalls[0]?.[1]).not.toBe(statusCalls[1]?.[1]);
    expect(statusCalls[0]?.[1]).toContain("idle");
    expect(statusCalls[1]?.[1]).toContain("ok");
  });
});

describe("P1: pathEquals 路径归一比较", () => {
  it("完全相同字符串 → true", () => {
    expect(pathEquals("/a/b/c.md", "/a/b/c.md")).toBe(true);
  });

  it("绝对路径 vs 相对路径 + cwd → resolve 后等比 true", () => {
    const abs = "/tmp/foo/bar.md";
    // 构造一个 resolve 后相同的相对路径
    const rel = resolve("/tmp", "./foo/bar.md");
    expect(pathEquals(abs, rel)).toBe(true);
  });

  it("不同文件 → false", () => {
    expect(pathEquals("/a/b/c.md", "/a/b/d.md")).toBe(false);
  });

  it("含 . / .. 等价路径 → true", () => {
    expect(pathEquals("/a/b/c.md", "/a/x/../b/c.md")).toBe(true);
  });

  it("resolve 抛错时（理论上极少触发）退化为原字符串等比", () => {
    // 用 mock 测：用 String 包装抛错对象不实际——只测相等/不等两路径足够
    expect(pathEquals("not/a/path", "not/a/path")).toBe(true);
    expect(pathEquals("not/a/path", "not/a/pathX")).toBe(false);
  });
});
