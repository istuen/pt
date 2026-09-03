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
      agent: "pi",
      injectionPoints: [],
      compilation: { cacheDir: ".pt/cache", split: "single-file" },
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
      agent: "pi",
      injectionPoints: [{ name: "会话知识", target: "system_prompt", modules: ["Scene"] }],
      compilation: { cacheDir: ".pt/cache", split: "single-file" },
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
      agent: "pi",
      injectionPoints: [{ name: "会话知识", target: "system_prompt", modules: ["Scene"] }],
      compilation: { cacheDir: ".pt/cache", split: "single-file" },
    };
    const result = checkProfileRefs(profile, [blueprint], []);
    expect(result.ok).toBe(true); // 无错误
    expect(result.warnings.length).toBeGreaterThan(0); // 有警告
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
