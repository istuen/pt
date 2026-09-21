// tests/verify/turn-inject-tool.test.ts — pt_turn_inject tool（v18.x issue pt-turncontext-llm-call-trigger 决策 4）
//
// 覆盖：
//   - domain 存在 → execute 返回手册段内容（renderTurnInject 走 /pt_turn_inject <domain> 路径）
//   - domain 不存在 → execute 返回 "未找到 Domain 或无手册段"
//   - 无激活 Profile（cachedBundles 空） → execute 返回 "无激活 Profile" 提示
//   - tool 注册名是 "pt_turn_inject"，复用现有 renderTurnInject（不新造渲染）
//
// 测试策略：
//   - mock ExtensionAPI（仿 manual-track-injection.test.ts）
//   - 用真实 .pt/assets/profiles/pt-dev.profile.md（已在仓库）
//   - loadAndTranspile 拿 cachedBundles / cachedBlueprint / cachedProfile / cachedAgentContext
//   - 直接调 tool.execute 验证返回内容

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import installExtension from "../../src/index.js";
import { loadAndTranspile } from "../../src/transpile.js";
import {
  filterDomainsByProfile,
  findBlueprint,
  findProfile,
  type AgentContext,
  type Blueprint,
  type Domain,
  type Profile,
} from "../../src/schema.js";
import { resetTestSession, s, TEST_SESSION_ID } from "./session-fixtures.js";

type GenericHandler = (...args: unknown[]) => unknown;
type CtxLike = Record<string, unknown>;

/** Mock pi that captures registered tools. */
function makePi() {
  const events = new Map<string, GenericHandler[]>();
  const commands = new Map<string, { handler: (args: string, ctx: CtxLike) => Promise<void> }>();
  const tools = new Map<string, { execute: (...a: unknown[]) => Promise<unknown> }>();

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
    appendEntry: () => undefined,
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
      setStatus: () => undefined,
      setWidget: () => undefined,
    },
    getSystemPrompt: () => "BASE",
  };

  return { pi, ctx, events, commands, tools };
}

/** Force-load a profile into the test session's cached IR. */
async function loadProfileIntoSession(profileName: string): Promise<{
  agentContext: AgentContext;
  blueprint: Blueprint;
  domains: Domain[];
  profile: Profile;
}> {
  const r = await loadAndTranspile(process.cwd(), profileName);
  const bundle = r.bundles[0];
  if (!bundle) throw new Error(`profile ${profileName} produced no bundle`);
  const profile = findProfile(bundle.profiles, profileName);
  if (!profile) throw new Error(`profile ${profileName} not in bundle`);
  const blueprint = findBlueprint(bundle.blueprints, profile.blueprint);
  if (!blueprint) throw new Error(`blueprint ${profile.blueprint} not in bundle`);
  const session = s();
  session.cachedBundles = [bundle];
  session.cachedBlueprint = blueprint;
  session.cachedProfile = profile;
  session.cachedAgentContext = r.agentContext;
  return {
    agentContext: r.agentContext,
    blueprint,
    domains: bundle.domains,
    profile,
  };
}

describe("pt_turn_inject tool（v18.x）", () => {
  beforeEach(() => {
    resetTestSession();
  });

  afterEach(() => {
    s().activeAdapter?.resetInjection?.();
    resetTestSession();
  });

  it("工具已注册：name='pt_turn_inject'", () => {
    const m = makePi();
    installExtension(m.pi as never);
    const tool = m.tools.get("pt_turn_inject");
    expect(tool).toBeDefined();
  });

  it("domain 存在 → execute 返回手册段内容（含 ## 规范清单 等段）", async () => {
    const m = makePi();
    installExtension(m.pi as never);
    const sessionStart = m.events.get("session_start")?.[0]!;
    await sessionStart({ type: "session_start" }, m.ctx);

    // 加载 pt-dev（引用了 pt-quality 等域）
    const switchCmd = m.commands.get("pt-profile")!;
    await switchCmd.handler("pt-dev", m.ctx);

    const tool = m.tools.get("pt_turn_inject");
    if (!tool) throw new Error("pt_turn_inject not registered");
    const result = (await tool.execute(
      "call-1",
      { domain: "pt-quality" },
      undefined,
      undefined,
      m.ctx
    )) as { content: Array<{ type: string; text: string }>; details: { domain: string } };

    expect(result.content).toBeDefined();
    expect(result.content[0]?.type).toBe("text");
    const text = result.content[0]?.text ?? "";
    // 来自 renderDomainManual 的渲染输出——含 pt-quality 的 Rules 段标题
    expect(text).toContain("modules-type-safety");
    expect(result.details.domain).toBe("pt-quality");
  });

  it("domain 不存在 → execute 返回 '未找到 Domain' 提示", async () => {
    const m = makePi();
    installExtension(m.pi as never);
    const sessionStart = m.events.get("session_start")?.[0]!;
    await sessionStart({ type: "session_start" }, m.ctx);

    // 加载 profile 让 cachedIR 有数据，但请求一个不存在的 domain
    const switchCmd = m.commands.get("pt-profile")!;
    await switchCmd.handler("pt-dev", m.ctx);

    const tool = m.tools.get("pt_turn_inject");
    if (!tool) throw new Error("pt_turn_inject not registered");
    const result = (await tool.execute(
      "call-1",
      { domain: "nonexistent-domain-xyz" },
      undefined,
      undefined,
      m.ctx
    )) as { content: Array<{ type: string; text: string }>; details: { error: string } };

    expect(result.content[0]?.text).toContain("未找到 Domain 或无手册段");
    expect(result.details.error).toBe("not found");
  });

  it("无激活 Profile（cachedBundles 空） → execute 返回 '无激活 Profile' 提示", async () => {
    const m = makePi();
    installExtension(m.pi as never);
    // 不触发 session_start，不切 profile → cachedBundles 保持 undefined/空

    const tool = m.tools.get("pt_turn_inject");
    if (!tool) throw new Error("pt_turn_inject not registered");
    const result = (await tool.execute(
      "call-1",
      { domain: "pt-quality" },
      undefined,
      undefined,
      m.ctx
    )) as { content: Array<{ type: string; text: string }>; details: { error: string } };

    expect(result.content[0]?.text).toContain("无激活 Profile");
    expect(result.details.error).toBe("no active profile");
  });

  it("走内存 IR，不读物理缓存：cachedAgentContext + cachedBlueprint + cachedProfile 都被消费", async () => {
    // 这个测试只验证 cached* 字段被 execute 读——通过观察如果 cachedBundles 缺一会失败来确认
    const m = makePi();
    installExtension(m.pi as never);
    const sessionStart = m.events.get("session_start")?.[0]!;
    await sessionStart({ type: "session_start" }, m.ctx);

    const switchCmd = m.commands.get("pt-profile")!;
    await switchCmd.handler("pt-dev", m.ctx);

    // 删掉 cachedBlueprint → 模拟缺一字段
    s().cachedBlueprint = undefined;

    const tool = m.tools.get("pt_turn_inject");
    if (!tool) throw new Error("pt_turn_inject not registered");
    const result = (await tool.execute(
      "call-1",
      { domain: "pt-quality" },
      undefined,
      undefined,
      m.ctx
    )) as { content: Array<{ type: string; text: string }>; details: { error: string } };

    // cachedBlueprint 缺 → 走 "无激活 Profile" 分支（execute 内部 if 检查）
    expect(result.details.error).toBe("no active profile");
  });
});
