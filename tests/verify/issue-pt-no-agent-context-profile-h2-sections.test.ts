// tests/verify/issue-pt-no-agent-context-profile-h2-sections.test.ts
//
// 验证 sub-issue pt-no-agent-context-profile-h2-sections 修复：
//   Profile.md 范本统一加 H2 注入点段
//   验证 parseProfile 输出 injectionPoints 长度 > 0（之前为 0）
//
// v13.x 边界纪律：
//   - 不依赖真实 pi ExtensionAPI
//   - 不依赖真实 transpile（手工读 Profile 资产 + 调 parseProfile）
//   - 覆盖 3 个 Profile 资产（pt-dev / pt-chat / builtin pt）

import { describe, expect, it } from "vitest";
import { parseProfile } from "../../src/parse/profile.js";

describe("parseProfile injectionPoints (v13.x issue pt-no-agent-context-profile-h2-sections)", () => {
  it("pt-dev.profile.md 解析后 injectionPoints 长度 > 0（之前为 0）", async () => {
    const profile = await parseProfile(
      "/Users/issac/pro/pt/.pt/assets/profiles",
      "pt-dev.profile.md"
    );
    expect(profile.injectionPoints.length).toBeGreaterThan(0);
    // 期望：会话知识 + 参考手册 两个段（H2 段注入点实例化）
    expect(profile.injectionPoints.length).toBe(2);
    const names = profile.injectionPoints.map((ip) => ip.name);
    expect(names).toContain("会话知识");
    expect(names).toContain("参考手册");
  });

  it("pt-chat.profile.md 解析后 injectionPoints 长度 > 0", async () => {
    const profile = await parseProfile(
      "/Users/issac/pro/pt/.pt/assets/profiles",
      "pt-chat.profile.md"
    );
    expect(profile.injectionPoints.length).toBe(2);
    const names = profile.injectionPoints.map((ip) => ip.name);
    expect(names).toContain("会话知识");
    expect(names).toContain("参考手册");
  });

  it("builtin pt.profile.md 解析后 injectionPoints 长度 > 0", async () => {
    const profile = await parseProfile(
      "/Users/issac/pro/pt/src/builtin/assets/profiles",
      "pt.profile.md"
    );
    expect(profile.injectionPoints.length).toBe(2);
    const names = profile.injectionPoints.map((ip) => ip.name);
    expect(names).toContain("会话知识");
    expect(names).toContain("参考手册");
  });

  it("Profile H2 段无追加 domains 时, injectionPoints[].domains 为空数组", async () => {
    // 3 个 Profile 都用 YAML 全局 domains 兜底分发, H2 段无追加
    // parseProfile 提取 ### Domains 列表, 但当前 H2 段只有 HTML 注释无追加
    const profile = await parseProfile(
      "/Users/issac/pro/pt/.pt/assets/profiles",
      "pt-dev.profile.md"
    );
    for (const ip of profile.injectionPoints) {
      expect(ip.domains).toEqual([]);
    }
  });

  it("H2 段名为注入点名（与 Blueprint.injectionPoints.name 对齐）", async () => {
    const profile = await parseProfile(
      "/Users/issac/pro/pt/.pt/assets/profiles",
      "pt-dev.profile.md"
    );
    // Profile H2 段名应匹配 Blueprint 注入点名
    // 当前 Blueprint.dev-knowledge.yaml 的 injectionPoints.name:
    //   - 会话知识
    //   - 参考手册
    const blueprintNames = ["会话知识", "参考手册"];
    const profileNames = profile.injectionPoints.map((ip) => ip.name);
    for (const bn of blueprintNames) {
      expect(profileNames).toContain(bn);
    }
  });
});
