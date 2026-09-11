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
import {
  formatTaglineForFooter,
  renderInjectionFooter,
  stripAnsi,
} from "../../src/injection-status.js";

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

  // pi-web / pi-web-style RPC 场景（issue pt-asset-migration-visibility §Layer 2 TUI/Web 兼容）
  describe("pi-web / RPC 场景", () => {
    it("pi-web 的 setStatus 走 RPC 模式（stdout 是 pipe，不是 TTY）→ isTTY=false 路径自动触发", () => {
      // pi-web spawn 一个 --mode=rpc 子进程，stdout/stdin 通过 JSONL RPC 接送，
      // 子进程的 process.stdout.isTTY 一定是 false。所以即使我们输出 ANSI，
      // 也不会有 TTY 终端解释它。自动走纯文本 + ⚠ 路径。
      const out = renderInjectionFooter("failed", "pt-dev", "boom", 3);
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI CSI 序列故意用 ESC 控制符
      expect(out).not.toMatch(/\x1b\[/);
      expect(out).toContain("⚠ 3 issues");
    });

    it("JSON.stringify 输出在 RPC 场景下无损携带 ANSI（colorMode='always' 手动调试场景）", () => {
      // 如果有人手动 colorMode='always'（如 debug 日志里），ANSI 字节会通过 JSON
      // 序列化被转成 \u001b—— pi-web 前端拿到后无法渲染（HTML 不解释 ANSI），
      // 但 JSON.stringify / JSON.parse 本身无损。
      const text = renderInjectionFooter("failed", "pt-dev", "boom", 3, "always");
      const rpc = JSON.stringify({
        method: "setStatus",
        statusKey: "pt",
        statusText: text,
      });
      const parsed = JSON.parse(rpc);
      // ANSI 字节被保留（但前端不会解释）
      expect(parsed.statusText.includes("\x1b[31m")).toBe(true);
      expect(parsed.statusText.includes("\x1b[1m")).toBe(true);
      expect(parsed.statusText.endsWith("\x1b[0m")).toBe(true);
      // 纯文本内容依然可读
      expect(stripAnsi(parsed.statusText)).toBe("⚠ pt: pt-dev failed: boom ⚠ 3 issues");
    });

    it("pi-web 默认场景（isTTY=false）→ 跨 emoji 的纯文本输出", () => {
      const out = renderInjectionFooter("idle", "ysl-developer", null, 5);
      // 不含 ANSI 字节
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI CSI 序列故意用 ESC 控制符
      expect(out).not.toMatch(/\x1b\[/);
      // ⚠ emoji + 中文 项目名 → 纯文本输出
      expect(out).toContain("⚠ 5 issues");
      expect(out).toContain("ysl-developer");
    });
  });

  // v14.x tagline — footer 拼接 `: <tagline>`
  describe("v14.x tagline（footer 展示）", () => {
    it("tagline 缺省 → 不添加（back-compat）", () => {
      const out = renderInjectionFooter("injected", "pt-dev", null, 0);
      expect(out).toBe("pt: pt-dev ok");
      // 不含 tagline 模式 `: <tag-text> ok`（tagline 应在 profile 名 + 状态之间）
      expect(out).not.toMatch(/^pt: pt-dev: [^ ]+ ok$/);
    });

    it("tagline 短 → footer 拼 `: <tagline>`", () => {
      const out = renderInjectionFooter("injected", "pt-dev", null, 0, "auto", "Senior dev + QA");
      expect(stripAnsi(out)).toBe("pt: pt-dev: Senior dev + QA ok");
    });

    it("tagline 跟 state/health suffix 顺序：profile: tagline state health", () => {
      const out = renderInjectionFooter(
        "injected",
        "pt-dev",
        null,
        3,
        "auto",
        "Senior dev + QA + Reviewer (3 agents)"
      );
      const stripped = stripAnsi(out);
      // 顺序断言
      const iProfile = stripped.indexOf("pt: pt-dev");
      const iTag = stripped.indexOf(": Senior dev");
      const iState = stripped.indexOf(" ok");
      const iHealth = stripped.indexOf("⚠ 3 issues");
      expect(iProfile).toBeLessThan(iTag);
      expect(iTag).toBeLessThan(iState);
      expect(iState).toBeLessThan(iHealth);
    });

    it("tagline 超长 → 裁到 34 字符 + '…'（避免 footer 爆宽）", () => {
      const long = "a".repeat(80);
      const out = renderInjectionFooter("injected", "pt-dev", null, 0, "auto", long);
      const stripped = stripAnsi(out);
      // tagline 部分应是 ': <34 个 a> + …' = 1 + 1 + 34 + 1 = 37 字符
      const tagPart = stripped.match(/: (a+…?)/)?.[1] ?? "";
      expect(tagPart.length).toBeLessThanOrEqual(35);
      expect(tagPart.endsWith("…")).toBe(true);
    });

    it("tagline=null 显式传 null → 等同缺省", () => {
      const out = renderInjectionFooter("injected", "pt-dev", null, 0, "auto", null);
      expect(out).toBe("pt: pt-dev ok");
    });

    it("tagline + failed state → error 仍拼在 tagline 后", () => {
      const out = renderInjectionFooter("failed", "pt-dev", "boom", 0, "auto", "Senior dev");
      expect(stripAnsi(out)).toBe("pt: pt-dev: Senior dev failed: boom");
    });

    it("tagline + health issue → red+bold 包裹完整（tagline 也染色）", () => {
      const out = renderInjectionFooter("injected", "pt-dev", null, 3, "always", "Senior dev");
      expect(out.startsWith("\x1b[31m\x1b[1m")).toBe(true);
      expect(out.endsWith("\x1b[0m")).toBe(true);
      expect(stripAnsi(out)).toContain("pt: pt-dev: Senior dev ok");
      expect(stripAnsi(out)).toContain("⚠ 3 issues");
    });

    it("tagline + never → 纯文本 + tagline + ⚠", () => {
      const out = renderInjectionFooter("idle", "pt-dev", null, 5, "never", "QA");
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI CSI 序列故意用 ESC 控制符
      expect(out).not.toMatch(/\x1b\[/);
      expect(out).toContain(": QA");
      expect(out).toContain("⚠ 5 issues");
    });
  });
});

describe("formatTaglineForFooter", () => {
  it("undefined → ''", () => {
    expect(formatTaglineForFooter(undefined)).toBe("");
  });

  it("空字符串 → ''", () => {
    expect(formatTaglineForFooter("")).toBe("");
    expect(formatTaglineForFooter("   ")).toBe("");
  });

  it("正常长度 → ': <tagline>'", () => {
    expect(formatTaglineForFooter("Senior dev")).toBe(": Senior dev");
  });

  it("超长 → ': <truncated>…'（总长度 ≤ maxLen）", () => {
    const long = "a".repeat(80);
    const result = formatTaglineForFooter(long, 35);
    // ': ' + 34 'a' + '…' = 2 + 34 + 1 = 37 chars total
    expect(result.length).toBe(37);
    expect(result.startsWith(": ")).toBe(true);
    expect(result.endsWith("…")).toBe(true);
    // 不含完整 80 a（确认被截）
    expect(result).not.toContain("a".repeat(50));
  });

  it("边界：长度恰好 = maxLen → 不裁", () => {
    const exact = "x".repeat(35);
    expect(formatTaglineForFooter(exact, 35)).toBe(`: ${exact}`);
    expect(formatTaglineForFooter(exact, 35).endsWith("…")).toBe(false);
  });
});
