// tests/verify/parse-profile.test.ts — parseProfile 单元测试（P2.4）
//
// v9 Profile：YAML 全局 domains + 各注入点 ### Domains 追加。

import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { parseProfile } from "../../src/parse/profile.js";

const FIXTURE_DIR = join(process.cwd(), "tests/fixtures/parse");

describe("parseProfile", () => {
  it("frontmatter: name=test-profile, blueprint=test-blueprint", async () => {
    const p = await parseProfile(FIXTURE_DIR, "profile.md");
    expect(p.name).toBe("test-profile");
    expect(p.blueprint).toBe("test-blueprint");
  });

  it("YAML 全局 domains 解析为 string[]", async () => {
    const p = await parseProfile(FIXTURE_DIR, "profile.md");
    expect(p.domains).toEqual(["d1", "d2"]);
  });

  it("每个 H2 → injectionPoint instance（### Domains 追加）", async () => {
    const p = await parseProfile(FIXTURE_DIR, "profile.md");
    expect(p.injectionPoints).toHaveLength(2);
    const sessionIp = p.injectionPoints.find((ip) => ip.name === "会话知识");
    expect(sessionIp?.domains).toEqual(["d3", "d4"]);
  });
});
