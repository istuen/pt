// tests/verify/parse-profile.test.ts — parseProfile 单元测试（P2.4）
//
// v9 Pt Profile：YAML 全局 domains + 各聚合组 ### Domains 追加。

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

  it("每个 H2 → ProfileGroup instance（### Domains 追加）", async () => {
    const p = await parseProfile(FIXTURE_DIR, "profile.md");
    expect(p.groups).toHaveLength(2);
    const sessionGroup = p.groups.find((g) => g.name === "会话背景");
    expect(sessionGroup?.domains).toEqual(["d3", "d4"]);
  });
});
