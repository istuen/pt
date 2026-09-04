// tests/verify/ref-check.test.ts — P2：引用完整性校验
import { describe, it, expect } from "vitest";
import { loadAndTranspile } from "../../src/transpile.js";
import {
  checkAllRefs,
  checkProfileRefs,
  formatRefCheckResult,
} from "../../src/verify/ref-check.js";
import type { Profile, Blueprint } from "../../src/schema.js";

describe("P2: 引用完整性校验", () => {
  it("项目自身资产无悬空引用", async () => {
    const r = await loadAndTranspile(process.cwd(), "pt-dev");
    const b = r.bundles[0];
    const result = checkAllRefs(b.profiles, b.blueprints, b.domains);
    expect(result.errors).toEqual([]);
  });

  it("悬空 Blueprint 被检测", () => {
    const profile: Profile = {
      name: "test",
      blueprint: "nonexistent-blueprint",
      domains: [],
      injectionPoints: [],
    };
    const result = checkProfileRefs(profile, [], []);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("nonexistent-blueprint");
  });

  it("悬空 Domain 被检测", () => {
    const profile: Profile = {
      name: "test",
      blueprint: "bp1",
      domains: ["nonexistent-domain"],
      injectionPoints: [],
    };
    const blueprint: Blueprint = {
      name: "bp1",
      injectionPoints: [],
    };
    const result = checkProfileRefs(profile, [blueprint], []);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("nonexistent-domain");
  });

  it("注入点名不匹配被检测", () => {
    const profile: Profile = {
      name: "test",
      blueprint: "bp1",
      domains: [],
      injectionPoints: [{ name: "unknown-ip", domains: [] }],
    };
    const blueprint: Blueprint = {
      name: "bp1",
      injectionPoints: [{ name: "会话知识", target: "system_prompt", modules: ["Scene"] }],
    };
    const result = checkProfileRefs(profile, [blueprint], []);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("unknown-ip"))).toBe(true);
  });

  it("Blueprint 声明注入点但 Profile 未实例化 → 警告（非错误）", () => {
    const profile: Profile = {
      name: "test",
      blueprint: "bp1",
      domains: [],
      injectionPoints: [], // 未实例化任何注入点
    };
    const blueprint: Blueprint = {
      name: "bp1",
      injectionPoints: [{ name: "会话知识", target: "system_prompt", modules: ["Scene"] }],
    };
    const result = checkProfileRefs(profile, [blueprint], []);
    expect(result.ok).toBe(true); // 无错误
    expect(result.warnings.length).toBeGreaterThan(0); // 有警告
  });

  it("v11.x：Profile 全局 domains 覆盖时，未 H2 实例化不报 warning", () => {
    // 主用例：Profile YAML 全局 domains 自动分发到所有注入点（不写 H2 实例化）。
    // 这种情况不该报"未实例化" warning。
    const profile: Profile = {
      name: "test",
      blueprint: "bp1",
      domains: ["d1", "d2"], // 全局 domains 覆盖
      injectionPoints: [], // 未 H2 实例化任何注入点
    };
    const blueprint: Blueprint = {
      name: "bp1",
      injectionPoints: [
        { name: "会话知识", target: "system_prompt", modules: ["Scene"] },
        { name: "参考手册", target: "context_message", modules: ["Manual"] },
      ],
    };
    const d1 = { name: "d1", type: "term" as const, modules: {} };
    const d2 = { name: "d2", type: "term" as const, modules: {} };
    const result = checkProfileRefs(profile, [blueprint], [d1, d2]);
    expect(result.ok).toBe(true); // 无错误
    expect(result.warnings).toEqual([]); // 无 warning（全局 domains 覆盖）
  });

  it("formatRefCheckResult 输出可读文本", () => {
    const text = formatRefCheckResult({
      ok: true,
      errors: [],
      warnings: [],
    });
    expect(text).toContain("通过");
  });
});
