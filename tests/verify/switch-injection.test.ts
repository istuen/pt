import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import installExtension from "../../src/index.js";
import { PiAdapter } from "../../src/agent/pi-adapter.js";
import { detectDefaultProfile, detectSingleProfile, listProfiles } from "../../src/config.js";
import { resetTestSession, s, TEST_SESSION_ID } from "./session-fixtures.js";
import type { AgentAPI, Blueprint, Context, Domain, FlowTemplate } from "../../src/schema.js";

type GenericHandler = (...args: unknown[]) => unknown;

interface MockApi {
  api: AgentAPI;
  handlers: Map<string, GenericHandler[]>;
  logs: string[];
}

function makeApi(): MockApi {
  const handlers = new Map<string, GenericHandler[]>();
  const logs: string[] = [];
  const api: AgentAPI = {
    on: (event, handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerCommand: () => undefined,
    registerFlag: () => undefined,
    getFlag: () => undefined,
    ui: {
      notify: () => undefined,
      setStatus: () => undefined,
    },
    log: {
      debug: (msg) => logs.push(msg),
      info: (msg) => logs.push(msg),
      warn: (msg) => logs.push(msg),
      error: (msg) => logs.push(msg),
    },
  };
  return { api, handlers, logs };
}

function makeFixture(marker: string): {
  context: Context;
  blueprint: Blueprint;
  domains: Domain[];
} {
  const blueprint: Blueprint = {
    name: `blueprint-${marker}`,
    agent: "pi",
    groups: [
      { name: "system", inject: "session", modules: [] },
      { name: "manual", inject: "turn", modules: [] },
    ],
  };
  const context: Context = {
    name: marker,
    blueprint: blueprint.name,
    sourceHash: marker,
    modules: { system: `SEG-${marker}` },
  };
  const flow: FlowTemplate = {
    name: "switch-test-flow",
    intent: "switch test",
    steps: [{ desc: `FLOW-${marker}`, output: "done" }],
    externals: [],
  };
  const domains: Domain[] = [
    // Phase term-P9.2：FlowTemplate 在 ## Flows 段（不是 ## Manual）
    { name: `domain-${marker}`, type: "workflow", modules: { Flows: [flow] } },
  ];
  return { context, blueprint, domains };
}

async function makeProjectCwd(dirs: string[]): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "pt-switch-group-"));
  dirs.push(cwd);
  await mkdir(join(cwd, ".pt/assets/profiles"), { recursive: true });
  return cwd;
}

describe("manual profile switch and Session Inject", () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    resetTestSession();
  });

  afterEach(async () => {
    s().activeAdapter?.resetInjection?.();
    resetTestSession();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("keeps one live handler and uses the latest segment after repeated switches", async () => {
    const { api, handlers } = makeApi();
    const adapter = new PiAdapter();
    const first = makeFixture("A");
    const second = makeFixture("B");

    adapter.setAgentContext(first.context, first.blueprint, first.domains);
    adapter.registerInject(api, first.context, first.blueprint, first.domains);
    const beforeHandler = handlers.get("before_agent_start")?.[0];
    const inputHandler = handlers.get("input")?.[0];

    adapter.setAgentContext(second.context, second.blueprint, second.domains);
    adapter.registerInject(api, second.context, second.blueprint, second.domains);

    expect(handlers.get("before_agent_start")).toHaveLength(1);
    expect(handlers.get("input")).toHaveLength(1);

    const beforeResult = (await beforeHandler({
      type: "before_agent_start",
      systemPrompt: "BASE",
    })) as { systemPrompt: string };
    expect(beforeResult.systemPrompt).toContain("SEG-B");
    expect(beforeResult.systemPrompt).not.toContain("SEG-A");

    const inputResult = (await inputHandler({
      type: "input",
      text: "/switch-test-flow",
    })) as { action: string; text: string };
    expect(inputResult.action).toBe("transform");
    expect(inputResult.text).toContain("FLOW-B");
    expect(inputResult.text).not.toContain("FLOW-A");
  });

  it("clears the old session context on reset", async () => {
    const { api, handlers } = makeApi();
    const adapter = new PiAdapter();
    const first = makeFixture("A");
    adapter.setAgentContext(first.context, first.blueprint, first.domains);
    adapter.registerInject(api, first.context, first.blueprint, first.domains);
    const beforeHandler = handlers.get("before_agent_start")?.[0];

    adapter.resetInjection();
    const result = await beforeHandler({
      type: "before_agent_start",
      systemPrompt: "BASE",
    });
    expect(result).toBeUndefined();
  });

  it("installs Session Inject when the first profile is selected by the command", async () => {
    const events = new Map<string, GenericHandler[]>();
    const commands = new Map<
      string,
      { handler: (args: string, ctx: Record<string, unknown>) => Promise<void> }
    >();
    const pi = {
      registerFlag: () => undefined,
      registerCommand: (
        name: string,
        spec: { handler: (args: string, ctx: Record<string, unknown>) => Promise<void> }
      ) => {
        commands.set(name, spec);
      },
      registerTool: () => undefined,
      on: (event: string, handler: GenericHandler) => {
        events.set(event, [...(events.get(event) ?? []), handler]);
      },
      getFlag: () => undefined,
      appendEntry: () => undefined,
    };
    const ctx = {
      cwd: process.cwd(),
      sessionManager: { getEntries: () => [], getSessionId: () => TEST_SESSION_ID },
      hasUI: true,
      ui: {
        notify: () => undefined,
        setStatus: () => undefined,
        setWidget: () => undefined,
      },
      getSystemPrompt: () => "BASE",
    };

    installExtension(pi as never);
    const sessionStart = events.get("session_start")?.[0];
    await sessionStart({ type: "session_start" }, ctx);
    // v13.x：detectDefaultProfile 兜底加载内建 guide → session_start 即注册 before_agent_start
    expect(events.get("before_agent_start")).toBeDefined();

    const switchCommand = commands.get("pt-profile")!;
    await switchCommand.handler("pt-dev", ctx);
    const beforeHandler = events.get("before_agent_start")?.[0];
    const firstSegment = s().cachedSegment;
    const firstResult = (await beforeHandler(
      { type: "before_agent_start", systemPrompt: "BASE" },
      ctx
    )) as {
      systemPrompt: string;
    };
    expect(firstResult.systemPrompt).toBe(`BASE\n\n## 当前任务上下文\n\n${firstSegment}`);
    expect(s().lastBuiltPrompt).toBe(firstResult.systemPrompt);
    expect(events.get("before_agent_start")).toHaveLength(1);

    await switchCommand.handler("pt-chat", ctx);
    const secondBeforeHandler = events.get("before_agent_start")?.[0];
    const secondSegment = s().cachedSegment;
    const secondResult = (await secondBeforeHandler(
      { type: "before_agent_start", systemPrompt: "BASE" },
      ctx
    )) as { systemPrompt: string };

    expect(events.get("before_agent_start")).toHaveLength(1);
    expect(secondResult.systemPrompt).toBe(`BASE\n\n## 当前任务上下文\n\n${secondSegment}`);
    expect(s().lastBuiltPrompt).toBe(secondResult.systemPrompt);
    expect(secondResult.systemPrompt).not.toContain(firstSegment);

    const shutdown = events.get("session_shutdown")?.[0];
    await shutdown({ type: "session_shutdown" }, ctx);
    await sessionStart({ type: "session_start" }, ctx);
    // v13.x：detectDefaultProfile 兜底加载内建 guide → shutdown + session_start 后旧 handler 读到新 state，注入 guide segment（非 pt-chat）
    const restartResult = (await secondBeforeHandler(
      { type: "before_agent_start", systemPrompt: "BASE" },
      ctx
    )) as { systemPrompt?: string } | undefined;
    const restartPrompt = restartResult?.systemPrompt ?? "";
    expect(restartPrompt).not.toContain(secondSegment);
  });

  it("does not let the built-in profile affect project auto detection", async () => {
    const cwd = await makeProjectCwd(tempDirs);
    expect(await listProfiles(cwd)).toContain("guide");
    expect(await detectSingleProfile(cwd)).toBeNull();

    await writeFile(join(cwd, ".pt/assets/profiles/project.profile.md"), "");
    expect(await detectSingleProfile(cwd)).toBe("project");
  });

  it("detectDefaultProfile: 未设 settings → 返回内建 guide", async () => {
    const cwd = await makeProjectCwd(tempDirs);
    expect(await detectDefaultProfile(cwd)).toBe("guide");
  });

  it("detectDefaultProfile: settings pt.default-profile='none' → 返回 null", async () => {
    const cwd = await makeProjectCwd(tempDirs);
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(
      join(cwd, ".pi/settings.json"),
      JSON.stringify({ pt: { "default-profile": "none" } })
    );
    expect(await detectDefaultProfile(cwd)).toBeNull();
  });

  it("detectDefaultProfile: settings pt.default-profile='my' → 返回 my", async () => {
    const cwd = await makeProjectCwd(tempDirs);
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(
      join(cwd, ".pi/settings.json"),
      JSON.stringify({ pt: { "default-profile": "my" } })
    );
    expect(await detectDefaultProfile(cwd)).toBe("my");
  });
});
