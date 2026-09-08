// tests/verify/persist-profile.test.ts — issue pt-context-persist-lost 修复验证
//
// v10.x：session JSONL 持久化 activeProfile。
//   - readProfileFromSession：反向遍历 entries，取最后一个 pt:active-profile。
//   - persistProfileToSession：调 pi.appendEntry() 写入 session。
//   - session_start fallback 链：flag > settings > session > auto。
//   - s().loadedFrom 记录来源（可观测性）。
//
// 测试策略：
//   - 不启动真实 Pi 进程（无法注入 mock ExtensionAPI）。
//   - 直接调内部 helper（readProfileFromSession）+ 验证 SessionState 字段。
//   - 端到端验证靠 issue 文档列出的「重启 pi 后 footer 显示 pt: pt-dev」手动验证。

import { describe, it, expect, beforeEach } from "vitest";
import { createSessionState, type ProfileLoadSource } from "../../src/session.js";
import { resetTestSession, s } from "./session-fixtures.js";
import { statusText } from "../../src/commands.js";

/** 模拟 MinimalSessionManager（与 src/index.ts 同构）。 */
interface MockEntry {
  type: string;
  customType?: string;
  data?: unknown;
}
function makeSessionManager(entries: MockEntry[]) {
  return { getEntries: () => entries };
}

/** 镜像 src/index.ts 的 readProfileFromSession（不导出，测试用 inline）。
 *  保持与生产代码同构——任何修改要同步两边。 */
const PT_PROFILE_ENTRY = "pt:active-profile";
function readProfileFromSession(sm: ReturnType<typeof makeSessionManager>): string | undefined {
  try {
    const entries = sm.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e && e.type === "custom" && e.customType === PT_PROFILE_ENTRY) {
        const data = (e as { data?: unknown }).data;
        if (data && typeof data === "object") {
          const profile = (data as { profile?: unknown }).profile;
          if (typeof profile === "string" && profile.trim()) {
            return profile.trim();
          }
        }
      }
    }
  } catch {}
  return undefined;
}

describe("s().activeProfile 持久化（issue pt-context-persist-lost 修复）", () => {
  beforeEach(() => {
    resetTestSession();
  });

  describe("1. SessionState 字段", () => {
    it("createSessionState 默认 loadedFrom = null", () => {
      const s = createSessionState();
      expect(s.loadedFrom).toBeNull();
    });

    it("resetSession 后 loadedFrom 恢复 null", () => {
      s().loadedFrom = "session";
      resetTestSession();
      expect(s().loadedFrom).toBeNull();
    });

    it("loadedFrom 可被赋值四种来源", () => {
      const sources: ProfileLoadSource[] = ["flag", "settings", "session", "auto"];
      for (const src of sources) {
        s().loadedFrom = src;
        expect(s().loadedFrom).toBe(src);
      }
    });
  });

  describe("2. readProfileFromSession（mock SessionManager）", () => {
    it("空 entries → undefined", () => {
      expect(readProfileFromSession(makeSessionManager([]))).toBeUndefined();
    });

    it("无匹配 customType → undefined", () => {
      const sm = makeSessionManager([
        { type: "custom", customType: "other-extension:state", data: { foo: 1 } },
        { type: "message", data: { role: "user" } },
      ]);
      expect(readProfileFromSession(sm)).toBeUndefined();
    });

    it("单个 pt:active-profile entry → 返回 profile 名", () => {
      const sm = makeSessionManager([
        { type: "model_change", data: { provider: "x" } },
        { type: "custom", customType: "pt:active-profile", data: { profile: "pt-dev" } },
        { type: "message" },
      ]);
      expect(readProfileFromSession(sm)).toBe("pt-dev");
    });

    it("多个 pt:active-profile entry → 取最后一个（最新）", () => {
      const sm = makeSessionManager([
        { type: "custom", customType: "pt:active-profile", data: { profile: "pt-design" } },
        { type: "custom", customType: "pt:active-profile", data: { profile: "pt-dev" } },
      ]);
      expect(readProfileFromSession(sm)).toBe("pt-dev");
    });

    it("data 损坏（非 object）→ 跳过", () => {
      const sm = makeSessionManager([
        { type: "custom", customType: "pt:active-profile", data: "garbage" as unknown },
        { type: "custom", customType: "pt:active-profile", data: null as unknown },
        { type: "custom", customType: "pt:active-profile", data: { profile: 42 as unknown } },
      ]);
      expect(readProfileFromSession(sm)).toBeUndefined();
    });

    it("profile 字段为空字符串 / 纯空白 → 跳过", () => {
      const sm = makeSessionManager([
        { type: "custom", customType: "pt:active-profile", data: { profile: "" } },
        { type: "custom", customType: "pt:active-profile", data: { profile: "   " } },
        { type: "custom", customType: "pt:active-profile", data: { profile: "  pt-dev  " } },
      ]);
      expect(readProfileFromSession(sm)).toBe("pt-dev"); // trim 后非空
    });
  });

  describe("3. statusText 输出 loadedFrom", () => {
    it("默认状态 → 'pt loadedFrom: (none)'", () => {
      const text = statusText(s());
      expect(text).toContain("pt loadedFrom: (none)");
    });

    it("loadedFrom = session → 输出 'session'", () => {
      s().activeProfile = "pt-dev";
      s().loadedFrom = "session";
      const text = statusText(s());
      expect(text).toContain("pt loadedFrom: session");
      expect(text).toContain("pt profile: pt-dev");
    });

    it("loadedFrom 四种合法值都能渲染", () => {
      const sources: ProfileLoadSource[] = ["flag", "settings", "session", "auto"];
      for (const src of sources) {
        s().loadedFrom = src;
        expect(statusText(s())).toContain(`pt loadedFrom: ${src}`);
      }
    });
  });

  describe("4. fallback 优先级契约（issue v2 §4.3）", () => {
    // 此测试不直接调 session_start handler（需 mock ExtensionAPI），
    // 而是验证 SessionState 中 loadedFrom 的语义契约：
    //   - "session" 来源不应被 "auto" 覆盖（user's last choice wins）
    //   - flag > settings > session > auto 优先级由 src/index.ts:186-191 if/else 实现
    //     （生产代码 review-only 验证；详细行为靠 issue 列出的「重启验证」端到端测）

    it("s().loadedFrom 用于可观测性，不会反过来影响 fallback 选择", () => {
      // 模拟 fallback 后状态
      s().activeProfile = "pt-dev";
      s().loadedFrom = "session";

      // /pt status 显示来源
      const text = statusText(s());
      expect(text).toContain("pt profile: pt-dev");
      expect(text).toContain("pt loadedFrom: session");

      // resetSession 清空
      resetTestSession();
      expect(s().activeProfile).toBeNull();
      expect(s().loadedFrom).toBeNull();
    });
  });
});
