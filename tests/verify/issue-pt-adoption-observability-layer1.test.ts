// tests/verify/issue-pt-adoption-observability-layer1.test.ts
// issue pt-adoption-observability Layer 1（F1.1 + F1.2）验证
//
// 验证目标：
//   F1.1：session id 统一用 Pi 完整 id ——
//     ① session:start 日志的 ctx.sessionId === 完整 id（不再是 8-hex 短 id），
//        与 tool:call / turn:* 日志形态一致 → 可 join；
//     ② SessionState.sessionId === 完整 id（/pt logs 用它拼文件名 → 指向真实文件）。
//   F1.2：tool:call 日志按档位记 input ——
//     ① 默认档 "pt-only"：pt_inject 的 input 记（domain 参数可见），bash 的 input 不记；
//     ② 档位 "all"（settings 或 env）：所有工具的 input 都记；
//     ③ 档位 "none"（env）：一律不记。
//
// 档位来源优先级：env PT_LOG_TOOL_INPUT > 项目 settings `pt.log-tool-input` > 默认 "pt-only"。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import installExtension from "../../src/index.js";
import { clearAllSessions, getSessionById } from "../../src/session.js";
import { TOOL_INPUT_LOG_MODE_ENV } from "../../src/config.js";

/** 完整 session id（Pi 事实来源的形态：UUID）。刻意不用 8-hex 短 id 以便区分。 */
const SESSION_ID = "11111111-2222-3333-4444-555555555555";

type GenericHandler = (...args: unknown[]) => unknown;
type CtxLike = Record<string, unknown>;

let tmpDir: string;
let cwd: string;
let events: Map<string, GenericHandler[]>;
let ctx: CtxLike;
const savedEnv = process.env[TOOL_INPUT_LOG_MODE_ENV];

/** 装扩展 + 造 ctx（cwd = 临时目录，session id 固定）。 */
async function boot(): Promise<void> {
  events = new Map<string, GenericHandler[]>();
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
  ctx = {
    cwd,
    sessionManager: { getEntries: () => [], getSessionId: () => SESSION_ID },
    hasUI: true,
    ui: {
      notify: () => undefined,
      setStatus: () => undefined,
      setWidget: () => undefined,
    },
    getSystemPrompt: () => "BASE",
  };
  installExtension(pi as never);
}

/** 跑 session_start（建 logger + 读档位）。 */
async function runSessionStart(): Promise<void> {
  const handler = events.get("session_start")?.[0];
  expect(handler).toBeDefined();
  await handler?.({ type: "session_start" }, ctx);
}

/** 跑 tool_call。 */
async function runToolCall(event: Record<string, unknown>): Promise<void> {
  const handler = events.get("tool_call")?.[0];
  expect(handler).toBeDefined();
  await handler?.(event, ctx);
}

/** 读当前 session 的日志条目（NDJSON 解析）。 */
async function readLogEntries(): Promise<Array<Record<string, unknown>>> {
  await getSessionById(SESSION_ID).logger?.flush();
  const file = join(cwd, ".pt/logs", `pt-${SESSION_ID}.log`);
  const raw = readFileSync(file, "utf8");
  return raw
    .trim()
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** 取某 msg 的日志条目（无则 undefined）。 */
async function findEntry(msg: string): Promise<Record<string, unknown> | undefined> {
  const entries = await readLogEntries();
  return entries.find((e) => e.msg === msg);
}

/** 取某工具的 tool:call 条目 ctx。 */
async function findToolCallCtx(toolName: string): Promise<Record<string, unknown> | undefined> {
  const entries = await readLogEntries();
  const all = entries.filter((e) => e.msg === "tool:call");
  for (const e of all) {
    const c = e.ctx as Record<string, unknown>;
    if (c.name === toolName) return c;
  }
  return undefined;
}

/** 写项目 settings（pt 段）。 */
function writeSettings(pt: Record<string, unknown>): void {
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(cwd, ".pi/settings.json"), JSON.stringify({ pt }, "utf8"), "utf8");
}

beforeEach(() => {
  clearAllSessions();
  tmpDir = mkdtempSync(join(tmpdir(), "pt-adopt-layer1-"));
  cwd = tmpDir;
  delete process.env[TOOL_INPUT_LOG_MODE_ENV];
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[TOOL_INPUT_LOG_MODE_ENV];
  else process.env[TOOL_INPUT_LOG_MODE_ENV] = savedEnv;
  clearAllSessions();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("F1.1：session id 统一为 Pi 完整 id（joinable）", () => {
  it("session:start 日志的 ctx.sessionId === 完整 id（非 8-hex 短 id）", async () => {
    await boot();
    await runSessionStart();
    const entry = await findEntry("session:start");
    expect(entry).toBeDefined();
    const ctxField = (entry?.ctx as Record<string, unknown>).sessionId;
    expect(ctxField).toBe(SESSION_ID);
    // 旧实现是 randomUUID().slice(0, 8) —— 形态必须是完整 UUID 才算修好
    expect(String(ctxField)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("SessionState.sessionId === 完整 id（/pt logs 用它拼文件名 → 指向真实日志文件）", async () => {
    await boot();
    await runSessionStart();
    expect(getSessionById(SESSION_ID).sessionId).toBe(SESSION_ID);
  });

  it("session:start 与 tool:call 的 ctx.sessionId 完全相等（可 join）", async () => {
    await boot();
    await runSessionStart();
    await runToolCall({ type: "tool_call", toolName: "bash", input: { command: "ls" } });
    const entries = await readLogEntries();
    const startIds = entries
      .filter((e) => e.msg === "session:start")
      .map((e) => (e.ctx as Record<string, unknown>).sessionId);
    const callIds = entries
      .filter((e) => e.msg === "tool:call")
      .map((e) => (e.ctx as Record<string, unknown>).sessionId);
    expect(startIds.length).toBeGreaterThan(0);
    expect(callIds.length).toBeGreaterThan(0);
    expect(new Set(callIds)).toEqual(new Set(startIds));
  });
});

describe("F1.2：tool:call 日志按档位记 input", () => {
  it("默认档 pt-only：pt_inject 的 input 记（domain 可见），bash 的 input 不记", async () => {
    await boot();
    await runSessionStart();
    await runToolCall({
      type: "tool_call",
      toolName: "pt_inject",
      input: { domain: "pt-quality" },
    });
    await runToolCall({ type: "tool_call", toolName: "bash", input: { command: "ls -la" } });

    const injectCtx = await findToolCallCtx("pt_inject");
    expect(injectCtx).toBeDefined();
    const input = injectCtx?.input as Record<string, unknown> | undefined;
    expect(input?.domain).toBe("pt-quality");

    const bashCtx = await findToolCallCtx("bash");
    expect(bashCtx).toBeDefined();
    expect(bashCtx?.input).toBeUndefined();
  });

  it("settings pt.log-tool-input=all → 所有工具的 input 都记", async () => {
    writeSettings({ "log-tool-input": "all" });
    await boot();
    await runSessionStart();
    expect(getSessionById(SESSION_ID).toolInputLogMode).toBe("all");

    await runToolCall({ type: "tool_call", toolName: "bash", input: { command: "ls -la" } });
    const bashCtx = await findToolCallCtx("bash");
    expect((bashCtx?.input as Record<string, unknown> | undefined)?.command).toBe("ls -la");
  });

  it("env PT_LOG_TOOL_INPUT=all 覆盖 settings（env 优先级更高）", async () => {
    writeSettings({ "log-tool-input": "pt-only" });
    process.env[TOOL_INPUT_LOG_MODE_ENV] = "all";
    await boot();
    await runSessionStart();
    expect(getSessionById(SESSION_ID).toolInputLogMode).toBe("all");

    await runToolCall({ type: "tool_call", toolName: "bash", input: { command: "echo hi" } });
    const bashCtx = await findToolCallCtx("bash");
    expect((bashCtx?.input as Record<string, unknown> | undefined)?.command).toBe("echo hi");
  });

  it("env PT_LOG_TOOL_INPUT=none → 一律不记 input（含 pt_inject）", async () => {
    process.env[TOOL_INPUT_LOG_MODE_ENV] = "none";
    await boot();
    await runSessionStart();
    expect(getSessionById(SESSION_ID).toolInputLogMode).toBe("none");

    await runToolCall({
      type: "tool_call",
      toolName: "pt_inject",
      input: { domain: "pt-quality" },
    });
    const injectCtx = await findToolCallCtx("pt_inject");
    expect(injectCtx).toBeDefined();
    expect(injectCtx?.input).toBeUndefined();
  });

  it("非法档位值回退默认 pt-only（不崩、不全量记）", async () => {
    writeSettings({ "log-tool-input": "garbage-value" });
    await boot();
    await runSessionStart();
    expect(getSessionById(SESSION_ID).toolInputLogMode).toBe("pt-only");
  });
});
