// tests/verify/issue-pt-asset-verifiable-norm-b3.test.ts
// B3 事件驱动回注验证（issue pt-asset-verifiable-norm §三 B3）
//
// 目标："这一次的输出"成为"后续的输入"——
//   记录端：tool_call 收集本轮产出（改/建的文件 + 查过的手册）→ turn_end 落 session JSONL
//   注入端：下一轮 before_agent_start 把产出摘要追加到 systemPrompt（独立 H2 段）
//
// 覆盖：
//   1. renderTurnOutputSegment —— 无产出不注入 / 内容形态 / 体积封顶 / 超长截断
//   2. readTurnOutputs —— 从 session entries 回读（跨进程恢复）/ 坏数据跳过
//   3. 端到端（mock pi）：tool_call → turn_end → appendEntry 收到 pt:turn-output
//      → 下一轮 before_agent_start 的 systemPrompt 含该段

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import installExtension from "../../src/index.js";
import { PiAdapter } from "../../src/agent/pi-adapter.js";
import { clearAllSessions, getSessionById } from "../../src/session.js";
import {
  extractBashWritePaths,
  MAX_DOMAINS,
  MAX_FILES,
  MAX_SEGMENT_LEN,
  PT_TURN_OUTPUT_ENTRY,
  readTurnOutputs,
  renderTurnOutputSegment,
  type TurnOutput,
} from "../../src/turn-output.js";
import type { AgentAPI, Blueprint, Context, Domain } from "../../src/schema.js";

type GenericHandler = (...args: unknown[]) => unknown;

const SESSION_ID = "test-b3-session";

let cwd: string;

beforeEach(() => {
  clearAllSessions();
  cwd = mkdtempSync(join(tmpdir(), "pt-b3-"));
});

afterEach(() => {
  clearAllSessions();
  rmSync(cwd, { recursive: true, force: true });
});

/** 造一个 TurnOutput。 */
function out(partial: Partial<TurnOutput> = {}): TurnOutput {
  return {
    turn: 1,
    files: [],
    domains: [],
    at: new Date().toISOString(),
    ...partial,
  };
}

describe("B3.1 renderTurnOutputSegment", () => {
  it("无产出 → undefined（不注入，零噪音）", () => {
    expect(renderTurnOutputSegment([])).toBeUndefined();
    expect(renderTurnOutputSegment([out()])).toBeUndefined();
  });

  it("有产出 → 独立 H2 段，含文件 / 手册 / 活跃手册", () => {
    const seg = renderTurnOutputSegment([
      out({ files: ["src/schema.ts", "src/compile/renderer.ts"], domains: ["pt-quality"] }),
      out({
        turn: 2,
        files: ["src/parse/index.ts"],
        domains: ["pt-arch"],
        manual: "feature-lifecycle",
      }),
    ]);
    expect(seg).toBeDefined();
    expect(seg).toContain("## 上一轮产出（Pt 记录）");
    expect(seg).toContain("src/schema.ts");
    expect(seg).toContain("src/compile/renderer.ts");
    expect(seg).toContain("src/parse/index.ts");
    expect(seg).toContain("pt-quality");
    expect(seg).toContain("pt-arch");
    expect(seg).toContain("feature-lifecycle");
  });

  it("体积封顶：文件 ≤ MAX_FILES、domain ≤ MAX_DOMAINS（超出显示等 N 个）", () => {
    const files = Array.from({ length: MAX_FILES + 3 }, (_, i) => `src/f${i}.ts`);
    const domains = Array.from({ length: MAX_DOMAINS + 2 }, (_, i) => `dom-${i}`);
    const seg = renderTurnOutputSegment([out({ files, domains })]) ?? "";
    expect(seg).toContain(files[MAX_FILES - 1]);
    expect(seg).not.toContain(files[MAX_FILES]);
    expect(seg).toContain(`（等 ${files.length} 个）`);
    expect(seg).toContain(domains[MAX_DOMAINS - 1]);
    expect(seg).not.toContain(domains[MAX_DOMAINS]);
  });

  it("shell 写入路径抽取（启发式）", () => {
    expect(extractBashWritePaths("printf 'x\\n' >> README.md")).toEqual(["README.md"]);
    expect(extractBashWritePaths("cat > src/out.ts <<'EOF'")).toEqual(["src/out.ts"]);
    expect(extractBashWritePaths("sed -i 's/a/b/' src/schema.ts")).toEqual(["src/schema.ts"]);
    expect(extractBashWritePaths("ls -la | tee /dev/null")).toEqual([]);
    expect(extractBashWritePaths("rm -rf /tmp/x && echo hi > /dev/null")).toEqual([]);
    expect(extractBashWritePaths("grep -n 'a' src/a.ts")).toEqual([]);
  });

  it("超长段截断到 MAX_SEGMENT_LEN", () => {
    const files = Array.from({ length: MAX_FILES }, (_, i) => `src/${"x".repeat(200)}-${i}.ts`);
    const seg = renderTurnOutputSegment([out({ files })]) ?? "";
    expect(seg.length).toBeLessThanOrEqual(MAX_SEGMENT_LEN);
  });
});

describe("B3.2 readTurnOutputs（跨进程恢复）", () => {
  it("从 session entries 回读 pt:turn-output", () => {
    const entries = [
      { type: "custom", customType: "pt:active-profile", data: { profile: "x" } },
      { type: "custom", customType: PT_TURN_OUTPUT_ENTRY, data: out({ files: ["a.ts"] }) },
      {
        type: "custom",
        customType: PT_TURN_OUTPUT_ENTRY,
        data: out({ turn: 2, domains: ["pt-quality"] }),
      },
    ];
    const got = readTurnOutputs({ getEntries: () => entries });
    expect(got).toHaveLength(2);
    expect(got[0].files).toEqual(["a.ts"]);
    expect(got[1].domains).toEqual(["pt-quality"]);
  });

  it("坏数据跳过；无 sessionManager → 空", () => {
    const entries = [
      { type: "custom", customType: PT_TURN_OUTPUT_ENTRY, data: "not-an-object" },
      { type: "custom", customType: PT_TURN_OUTPUT_ENTRY, data: { files: "not-array" } },
    ];
    // 非对象的 data 被跳过；对象但字段类型不对的兜底为默认值
    expect(readTurnOutputs({ getEntries: () => entries })).toHaveLength(1);
    expect(readTurnOutputs({ getEntries: () => entries })[0].files).toEqual([]);
    expect(readTurnOutputs(undefined)).toEqual([]);
    expect(readTurnOutputs({ getEntries: () => [] })).toEqual([]);
  });
});

/** mock pi：捕获事件 handler + appendEntry。 */
function makePi(entries: Array<{ type: string; customType?: string; data?: unknown }>) {
  const events = new Map<string, GenericHandler[]>();
  const appended: Array<{ customType: string; data: unknown }> = [];
  const pi = {
    registerFlag: () => undefined,
    registerCommand: () => undefined,
    registerTool: () => undefined,
    on: (event: string, handler: GenericHandler) => {
      events.set(event, [...(events.get(event) ?? []), handler]);
    },
    getFlag: () => undefined,
    appendEntry: (customType: string, data?: unknown) => {
      appended.push({ customType, data });
      entries.push({ type: "custom", customType, data });
    },
  };
  const ctx = {
    cwd,
    sessionManager: { getEntries: () => entries, getSessionId: () => SESSION_ID },
    hasUI: true,
    ui: { notify: () => undefined, setStatus: () => undefined, setWidget: () => undefined },
    getSystemPrompt: () => "BASE",
  };
  return { pi, ctx, events, appended };
}

describe("B3.3 端到端：记录 → 落盘 → 下一轮回注", () => {
  it("tool_call 收集产出 → turn_end 落 pt:turn-output → 下一轮 systemPrompt 含该段", async () => {
    const entries: Array<{ type: string; customType?: string; data?: unknown }> = [];
    const { pi, ctx, events, appended } = makePi(entries);
    installExtension(pi as never);

    // 第 1 轮：改文件 + 查手册
    const toolCall = events.get("tool_call")?.[0];
    expect(toolCall).toBeDefined();
    await toolCall?.(
      { type: "tool_call", toolName: "edit", input: { path: "src/schema.ts" } },
      ctx
    );
    await toolCall?.(
      { type: "tool_call", toolName: "pt_inject", input: { domain: "pt-quality" } },
      ctx
    );

    // turn_end → 固化并落盘
    const turnEnd = events.get("turn_end")?.[0];
    expect(turnEnd).toBeDefined();
    await turnEnd?.({ type: "turn_end" }, ctx);

    const persisted = appended.find((a) => a.customType === PT_TURN_OUTPUT_ENTRY);
    expect(persisted).toBeDefined();
    const data = persisted?.data as TurnOutput;
    expect(data.files).toEqual(["src/schema.ts"]);
    expect(data.domains).toEqual(["pt-quality"]);

    // 第 2 轮：before_agent_start 应回注该段
    const blueprint: Blueprint = {
      name: "b3-blueprint",
      agent: "pi",
      groups: [
        { name: "system", inject: "session" },
        { name: "manual", inject: "turn" },
      ],
    };
    const context: Context = {
      name: "b3",
      blueprint: blueprint.name,
      sourceHash: "b3",
      modules: { system: "SEG-B3" },
    };
    const domains: Domain[] = [];
    const handlers = new Map<string, GenericHandler[]>();
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
    const adapter = new PiAdapter();
    adapter.setAgentContext(context, blueprint, domains);
    adapter.registerInject(api, context, blueprint, domains);
    const beforeHandler = handlers.get("before_agent_start")?.[0];
    expect(beforeHandler).toBeDefined();

    const result = (await beforeHandler?.(
      { type: "before_agent_start", systemPrompt: "BASE" },
      { sessionManager: { getSessionId: () => SESSION_ID } }
    )) as { systemPrompt: string };
    expect(result.systemPrompt).toContain("SEG-B3");
    expect(result.systemPrompt).toContain("## 上一轮产出（Pt 记录）");
    expect(result.systemPrompt).toContain("src/schema.ts");
    expect(result.systemPrompt).toContain("pt-quality");
  });

  it("开关关闭（settings pt.turn-output-inject=off）→ 不回注", async () => {
    // 直接改 session state 模拟关闭（session_start 读 settings 的分支单独由 e2e 覆盖）
    getSessionById(SESSION_ID).turnOutputInject = false;
    getSessionById(SESSION_ID).turnOutputs = [out({ files: ["src/schema.ts"] })];

    const blueprint: Blueprint = {
      name: "b3-off",
      agent: "pi",
      groups: [{ name: "system", inject: "session" }],
    };
    const context: Context = {
      name: "b3-off",
      blueprint: blueprint.name,
      sourceHash: "b3-off",
      modules: { system: "SEG-OFF" },
    };
    const handlers = new Map<string, GenericHandler[]>();
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
    const adapter = new PiAdapter();
    adapter.setAgentContext(context, blueprint, []);
    adapter.registerInject(api, context, blueprint, []);
    const beforeHandler = handlers.get("before_agent_start")?.[0];
    const result = (await beforeHandler?.(
      { type: "before_agent_start", systemPrompt: "BASE" },
      { sessionManager: { getSessionId: () => SESSION_ID } }
    )) as { systemPrompt: string };
    expect(result.systemPrompt).toContain("SEG-OFF");
    expect(result.systemPrompt).not.toContain("上一轮产出");
  });
});
