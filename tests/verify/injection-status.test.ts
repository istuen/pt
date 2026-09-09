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

    // colorMode='always' 路径：强制启用 ANSI，绕过 TTY 检测
    describe("colorMode='always'（强制 TUI 路径）", () => {
      it("injected → green ANSI 包裹", () => {
        const out = renderInjectionFooter("injected", "pt-dev", null, 0, "always");
        expect(out.startsWith("\x1b[32m")).toBe(true);
        expect(out.endsWith("\x1b[0m")).toBe(true);
        expect(stripAnsi(out)).toBe("pt: pt-dev ok");
      });

      it("pending → yellow ANSI 包裹", () => {
        const out = renderInjectionFooter("pending", "pt-dev", null, 0, "always");
        expect(out.startsWith("\x1b[33m")).toBe(true);
        expect(stripAnsi(out)).toBe("pt: pt-dev pending");
      });

      it("idle → dim gray ANSI 包裹", () => {
        const out = renderInjectionFooter("idle", "pt-dev", null, 0, "always");
        expect(out.startsWith("\x1b[90m")).toBe(true);
        expect(stripAnsi(out)).toBe("pt: pt-dev idle");
      });

      it("failed → red ANSI 包裹 + error 文本", () => {
        const out = renderInjectionFooter("failed", "pt-dev", "boom", 0, "always");
        expect(out.startsWith("\x1b[31m")).toBe(true);
        expect(stripAnsi(out)).toBe("pt: pt-dev failed: boom");
      });

      it("health issue 染色优先于 state 颜色：injected + 3 issues → red+bold 而非 green", () => {
        const out = renderInjectionFooter("injected", "pt-dev", null, 3, "always");
        expect(out.startsWith("\x1b[31m\x1b[1m")).toBe(true); // red + bold
        expect(stripAnsi(out)).toBe("⚠ pt: pt-dev ok ⚠ 3 issues");
      });

      it("health issue 染色：failed + 1 issue → red+bold 而非 red only", () => {
        const out = renderInjectionFooter("failed", "pt-dev", "boom", 1, "always");
        expect(out.startsWith("\x1b[31m\x1b[1m")).toBe(true);
        expect(stripAnsi(out)).toContain("failed: boom");
        expect(stripAnsi(out)).toContain("⚠ 1 issue");
      });
    });

    // colorMode='never' 路径：强制关闭 ANSI（即便 isTTY=true）
    describe("colorMode='never'（强制 web 路径）", () => {
      it("injected → 纯文本，无 ANSI", () => {
        const out = renderInjectionFooter("injected", "pt-dev", null, 0, "never");
        // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI CSI 序列故意用 ESC 控制符
        expect(out).not.toMatch(/\x1b\[/);
        expect(out).toBe("pt: pt-dev ok");
      });

      it("health issue + never → 纯文本 + ⚠ 前缀", () => {
        const out = renderInjectionFooter("injected", "pt-dev", null, 5, "never");
        // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI CSI 序列故意用 ESC 控制符
        expect(out).not.toMatch(/\x1b\[/);
        expect(out).toContain("⚠ 5 issues");
      });
    });

    // colorMode='auto'（默认）行为兼容
    it("colorMode='auto'（默认）→ 走 isTTY 检测路径", () => {
      const outAuto = renderInjectionFooter("injected", "pt-dev", null, 0, "auto");
      const outDefault = renderInjectionFooter("injected", "pt-dev", null, 0);
      expect(outAuto).toBe(outDefault);
    });
  });
});
