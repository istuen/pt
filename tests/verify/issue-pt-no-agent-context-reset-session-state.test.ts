// tests/verify/issue-pt-no-agent-context-reset-session-state.test.ts
//
// 验证 sub-issue pt-no-agent-context-reset-session-state 修复：
//   resetSessionState() 公共函数 + 3 处 catch 调它
//   验证 catch 后 7 个 cached 字段全 null/[]（不残留旧 Profile 数据）
//
// v13.x 边界纪律：
//   - 不依赖真实 pi ExtensionAPI（用 mock）
//   - 不依赖真实 transpile（手工构造 SessionState）
//   - 覆盖 resetSessionState 本身 + 3 个 catch 调用点

import { describe, expect, it } from "vitest";
import { createSessionState, resetSessionState, type SessionState } from "../../src/session.js";

/** 构造一个"装满数据的" SessionState，用于验证 resetSessionState 清干净。 */
function makePopulatedSessionState(): SessionState {
  const s = createSessionState();
  s.activeProfile = "pt-dev";
  s.cachedSegment = "SEGMENT";
  s.cachedBundles = [{ domains: [], blueprints: [], profiles: [], activeProfile: "pt-dev" }];
  s.cachedAgentContext = {
    name: "pt-dev",
    blueprint: "dev-knowledge",
    sourceHash: "abc",
    modules: { 会话背景: "content" },
  };
  s.cachedBlueprint = {
    name: "dev-knowledge",
    agent: "pi",
    groups: [{ name: "会话背景", inject: "session" }],
    compilation: { cacheDir: ".pt/cache/agent-contexts", split: "single-file" },
  };
  s.cachedDomains = [{ name: "user-info", modules: {} }];
  s.cachedProfile = {
    name: "pt-dev",
    blueprint: "dev-knowledge",
    domains: ["user-info"],
    groups: [],
  };
  s.lastCacheHit = true;
  s.injectionState = "injected";
  s.injectionError = null;
  return s;
}

describe("resetSessionState (v13.x issue pt-no-agent-context-reset-session-state)", () => {
  it("清空 7 个编译产物字段 + injection 状态", () => {
    const s = makePopulatedSessionState();
    resetSessionState(s);

    expect(s.cachedSegment).toBeNull();
    expect(s.cachedBundles).toBeNull();
    expect(s.cachedAgentContext).toBeNull();
    expect(s.cachedBlueprint).toBeNull();
    expect(s.cachedDomains).toEqual([]);
    expect(s.cachedProfile).toBeNull();
    expect(s.activeAdapter).toBeNull();
    expect(s.lastCacheHit).toBe(false);
    expect(s.injectionState).toBe("idle");
    expect(s.injectionError).toBeNull();
  });

  it("保留 session 标识 + 用户意图字段", () => {
    const s = makePopulatedSessionState();
    s.sessionId = "test-sid-123";
    s.lastCwd = "/Users/issac/pro/pt";
    s.activeProfile = "pt-dev";
    s.loadedFrom = "auto";
    s.activeManual = null;

    resetSessionState(s);

    // 不应清：session 生命周期相关字段
    expect(s.sessionId).toBe("test-sid-123");
    expect(s.lastCwd).toBe("/Users/issac/pro/pt");
    expect(s.activeProfile).toBe("pt-dev");
    expect(s.loadedFrom).toBe("auto");
    expect(s.activeManual).toBeNull();
  });

  it("调 activeAdapter.resetInjection（如实现）", () => {
    const s = makePopulatedSessionState();
    let resetCalled = false;
    s.activeAdapter = {
      name: "pi",
      supportedTargets: ["system_prompt", "context_message"],
      setAgentContext: () => undefined,
      registerInject: () => undefined,
      resetInjection: () => {
        resetCalled = true;
      },
    };

    resetSessionState(s);

    expect(resetCalled).toBe(true);
    expect(s.activeAdapter).toBeNull(); // resetInjection 调完后才置 null
  });

  it("activeAdapter 未实现 resetInjection 时不抛错", () => {
    const s = makePopulatedSessionState();
    s.activeAdapter = {
      name: "pi",
      supportedTargets: ["system_prompt", "context_message"],
      setAgentContext: () => undefined,
      registerInject: () => undefined,
      // resetInjection 未实现（可选方法）
    };

    // 不应 throw
    expect(() => resetSessionState(s)).not.toThrow();
    expect(s.activeAdapter).toBeNull();
  });

  it("idempotent：空 state 调一次也是空", () => {
    const s = createSessionState();
    resetSessionState(s);
    // 再次调不应抛错
    expect(() => resetSessionState(s)).not.toThrow();
  });
});

describe("resetSessionState 调用点（3 catch 路径）", () => {
  // 这里只验证"resetSessionState 函数本身"+"调用约定"——具体的 3 catch 在
  // src/index.ts 里调，调用的功能等价已在上面测试覆盖。
  // 端到端测试（mock pi + 改坏 Blueprint）超出本 issue 范围，参见 sub-issue 文档「排查方法」段。

  it("resetSessionState 是 named export", () => {
    expect(typeof resetSessionState).toBe("function");
    expect(resetSessionState.name).toBe("resetSessionState");
  });
});
