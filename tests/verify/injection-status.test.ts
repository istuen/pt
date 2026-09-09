// tests/verify/injection-status.test.ts — renderInjectionFooter 单测
//
// 配套 .pt/docs/designs/pt-injection-status-manual-track.md §2.3：
//   - 4 态 × 有/无 profile = 8 case
//   - failed 状态追加 error 前 40 字
//
// v14.x（issue pt-asset-migration-visibility Layer 2）：
//   - healthIssueCount 参数 → 末尾追加 ⚠ N issue(s)（颜色染色）
//   - stripAnsi() 辅助断言：测颜色时跳过 ANSI 码

import { describe, it, expect } from "vitest";
import { renderInjectionFooter, stripAnsi } from "../../src/injection-status.js";

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

    it("profile=null + healthIssueCount=3 → 仍返 'pt: 无 context'（health 被吞）", () => {
      expect(renderInjectionFooter("idle", null, null, 3)).toBe("pt: 无 context");
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

  describe("v14.x: healthIssueCount 参数", () => {
    it("healthIssueCount=0 → 不追加后缀（back-compat 默认行为）", () => {
      expect(renderInjectionFooter("injected", "pt-dev", null, 0)).toBe("pt: pt-dev ok");
    });

    it("healthIssueCount=1 → 末尾追加 '⚠ 1 issue'（单数）", () => {
      const out = renderInjectionFooter("injected", "pt-dev", null, 1);
      const stripped = stripAnsi(out);
      expect(stripped).toContain("⚠ 1 issue");
      expect(stripped).not.toContain("issues");
    });

    it("healthIssueCount=3 → 末尾追加 '⚠ 3 issues'（复数）", () => {
      const out = renderInjectionFooter("injected", "pt-dev", null, 3);
      const stripped = stripAnsi(out);
      expect(stripped).toContain("⚠ 3 issues");
    });

    it("healthIssueCount + failed 状态 → 末尾 health suffix 在 error 后", () => {
      const out = renderInjectionFooter("failed", "pt-dev", "boom", 2);
      const stripped = stripAnsi(out);
      expect(stripped).toContain("failed: boom");
      expect(stripped).toContain("⚠ 2 issues");
      // 顺序：state 后缀 → health 后缀
      expect(stripped.indexOf("failed: boom")).toBeLessThan(stripped.indexOf("⚠ 2 issues"));
    });

    it("healthIssueCount + idle → idle 也加 health suffix（不限于 injected）", () => {
      const out = renderInjectionFooter("idle", "pt-dev", null, 1);
      expect(stripAnsi(out)).toContain("⚠ 1 issue");
    });
  });

  describe("v14.x: ANSI 颜色", () => {
    it("stripAnsi 辅助：去掉 ANSI CSI 序列", () => {
      expect(stripAnsi("\x1b[31mhello\x1b[0m")).toBe("hello");
      expect(stripAnsi("\x1b[1;32mok\x1b[0m")).toBe("ok");
    });

    it("isTTY=false（vitest 默认）→ 不输出 ANSI 码，纯文本", () => {
      // vitest 跑测试 stdout 不是 TTY → useColor() 返 false
      const out = renderInjectionFooter("injected", "pt-dev", null, 0);
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI CSI 序列故意用 ESC 控制符
      expect(out).not.toMatch(/\x1b\[/);
      expect(out).toBe("pt: pt-dev ok");
    });

    it("isTTY=false + health issue → 纯文本 + ⚠ 前缀（无 ANSI）", () => {
      const out = renderInjectionFooter("injected", "pt-dev", null, 5);
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI CSI 序列故意用 ESC 控制符
      expect(out).not.toMatch(/\x1b\[/);
      expect(out).toContain("⚠ 5 issues");
    });
  });
});
