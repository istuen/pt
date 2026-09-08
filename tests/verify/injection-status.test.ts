// tests/verify/injection-status.test.ts — renderInjectionFooter 单测
//
// 配套 .pt/docs/designs/pt-injection-status-manual-track.md §2.3：
//   - 4 态 × 有/无 profile = 8 case
//   - failed 状态追加 error 前 40 字

import { describe, it, expect } from "vitest";
import { renderInjectionFooter } from "../../src/injection-status.js";

describe("renderInjectionFooter", () => {
  describe("profile = null", () => {
    it("idle + null → 'pt: 无 context'", () => {
      expect(renderInjectionFooter("idle", null, null)).toBe("pt: 无 context");
    });

    it("pending + null → 'pt: 无 context'（profile 缺失时统一降级）", () => {
      expect(renderInjectionFooter("pending", null, null)).toBe("pt: 无 context");
    });

    it("injected + null → 'pt: 无 context'", () => {
      expect(renderInjectionFooter("injected", null, null)).toBe("pt: 无 context");
    });

    it("failed + null → 'pt: 无 context'", () => {
      expect(renderInjectionFooter("failed", null, "boom")).toBe("pt: 无 context");
    });
  });

  describe("profile = 'pt-design'", () => {
    it("idle → 'pt: pt-design idle'", () => {
      expect(renderInjectionFooter("idle", "pt-design", null)).toBe("pt: pt-design idle");
    });

    it("pending → 'pt: pt-design pending'", () => {
      expect(renderInjectionFooter("pending", "pt-design", null)).toBe("pt: pt-design pending");
    });

    it("injected → 'pt: pt-design ok'", () => {
      expect(renderInjectionFooter("injected", "pt-design", null)).toBe("pt: pt-design ok");
    });

    it("failed + 短 error → 'pt: pt-design failed: <error>'", () => {
      expect(renderInjectionFooter("failed", "pt-design", "boom")).toBe(
        "pt: pt-design failed: boom"
      );
    });

    it("failed + 40+ 字符 error → 截断到 40 + '...'", () => {
      const long = "x".repeat(50);
      const out = renderInjectionFooter("failed", "pt-design", long);
      expect(out).toMatch(/^pt: pt-design failed: x{40}\.\.\.$/);
    });

    it("failed + null error → 'failed: unknown'", () => {
      expect(renderInjectionFooter("failed", "pt-design", null)).toBe(
        "pt: pt-design failed: unknown"
      );
    });
  });

  describe("profile = 自定义名", () => {
    it("profile 名为 'pt-dev' 也正常拼接", () => {
      expect(renderInjectionFooter("injected", "pt-dev", null)).toBe("pt: pt-dev ok");
    });
  });
});
