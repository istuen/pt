// tests/verify/issue-pt-asset-health-diag-report-format.test.ts — 通知格式分级化
//
// 配套 .pt/docs/issues/pt-asset-health-diag-report-format.md §短期修复方向
// formatHealthSummary 纯函数测试——不依赖 scanProjectHealth 的副作用

import { describe, it, expect } from "vitest";
import { formatHealthSummary, type AssetHealthReport } from "../../src/asset-health.js";

function mkReport(issues: AssetHealthReport["issues"]): AssetHealthReport {
  return {
    issues,
    errors: issues.filter((i) => i.severity === "error").length,
    warnings: issues.filter((i) => i.severity === "warning").length,
  };
}

describe("formatHealthSummary", () => {
  it("空 issues → 返空字符串（不进 notify）", () => {
    const r = mkReport([]);
    expect(formatHealthSummary(r)).toBe("");
  });

  it("单 issue profile → 输出分类 + 路径", () => {
    const r = mkReport([
      { severity: "error", scope: "profile", name: "test", msg: "missing-modules" },
    ]);
    const out = formatHealthSummary(r);
    expect(out).toContain("1 项配置问题（不阻断）");
    expect(out).toContain("1× profile 配置问题 → /pt check");
  });

  it("多 issue 按 (scope, count) 聚合分组", () => {
    const r = mkReport([
      { severity: "error", scope: "profile", name: "p1", msg: "x" },
      { severity: "error", scope: "profile", name: "p2", msg: "y" },
      { severity: "warning", scope: "domain", name: "d1", msg: "dangling ref" },
      { severity: "warning", scope: "blueprint", name: "b1", msg: "orphan h2" },
    ]);
    const out = formatHealthSummary(r);
    expect(out).toContain("4 项配置问题（不阻断）");
    expect(out).toContain("2× profile 配置问题 → /pt check");
    expect(out).toContain("1× domain 引用问题 → /pt check");
    expect(out).toContain("1× blueprint 配置问题 → /pt check");
  });

  it("超 maxItems 时追加 '查看全部' 引导", () => {
    // 多个不同 scope 才能产生多个 group——仅一个 scope 时不超 maxItems
    const issues = [
      ...Array.from({ length: 4 }, (_, i) => ({
        severity: "error" as const,
        scope: "profile" as const,
        name: `p${i}`,
        msg: `profile issue ${i}`,
      })),
      ...Array.from({ length: 4 }, (_, i) => ({
        severity: "warning" as const,
        scope: "blueprint" as const,
        name: `b${i}`,
        msg: `blueprint issue ${i}`,
      })),
      ...Array.from({ length: 4 }, (_, i) => ({
        severity: "warning" as const,
        scope: "domain" as const,
        name: `d${i}`,
        msg: `domain issue ${i}`,
      })),
    ];
    const r = mkReport(issues);
    const out = formatHealthSummary(r, { maxItems: 2 });
    expect(out).toContain("→ /pt check 查看全部");
  });

  it("分组按 count 降序（多问题在前）", () => {
    const r = mkReport([
      { severity: "error", scope: "blueprint", name: "b1", msg: "x" },
      { severity: "error", scope: "profile", name: "p1", msg: "x" },
      { severity: "error", scope: "profile", name: "p2", msg: "x" },
      { severity: "error", scope: "profile", name: "p3", msg: "x" },
    ]);
    const out = formatHealthSummary(r);
    // profile（3 个）在 blueprint（1 个）之前
    const profileIdx = out.indexOf("profile 配置问题");
    const blueprintIdx = out.indexOf("blueprint 配置问题");
    expect(profileIdx).toBeLessThan(blueprintIdx);
  });

  it("prefix 可自定义", () => {
    const r = mkReport([{ severity: "error", scope: "profile", name: "p1", msg: "x" }]);
    expect(formatHealthSummary(r, { prefix: "[custom] " })).toContain("[custom]");
    expect(formatHealthSummary(r, { prefix: "" })).not.toContain("[pt]");
  });
});
