// tests/verify/parse-blueprint.test.ts — parseBlueprint 单元测试（P2.4）
//
// v9 Blueprint：groups 项（inject + mode + Modules）。
//   Phase term-P4.2：## Compilation 段已移除（cacheDir 改用 CACHE_DIR 常量）。
//   Phase term-P4.5：载体 .md → .yaml（parseBlueprint 读 YAML 文件）。

import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { parseBlueprint } from "../../src/parse/blueprint.js";

const FIXTURE_DIR = join(process.cwd(), "tests/fixtures/parse");

describe("parseBlueprint", () => {
  it("frontmatter: name=test-blueprint（Phase term-P4.1：agent 字段移除）", async () => {
    // Phase term-P4.5：fixture 文件名 blueprint.md → blueprint.yaml
    const bp = await parseBlueprint(FIXTURE_DIR, "blueprint.yaml");
    expect(bp.name).toBe("test-blueprint");
    // Phase term-P4.1：Blueprint.agent 字段移除，BP 应无 agent 字段
    expect((bp as { agent?: unknown }).agent).toBeUndefined();
  });

  it("groups 项解析", async () => {
    const bp = await parseBlueprint(FIXTURE_DIR, "blueprint.yaml");
    const groupNames = bp.groups.map((g) => g.name).sort();
    expect(groupNames).toEqual(["会话背景", "参考手册", "触发索引"]);
  });

  it("聚合组字段：inject + mode + modules", async () => {
    const bp = await parseBlueprint(FIXTURE_DIR, "blueprint.yaml");
    const sessionGroup = bp.groups.find((g) => g.name === "会话背景");
    expect(sessionGroup?.inject).toBe("session");
    expect(sessionGroup?.mode).toBe("hybrid");
    expect(sessionGroup?.modules).toEqual(["Scene", "Participant"]);
  });

  it("Phase term-P4.2：Blueprint 不含 compilation 字段", async () => {
    const bp = await parseBlueprint(FIXTURE_DIR, "blueprint.yaml");
    expect((bp as { compilation?: unknown }).compilation).toBeUndefined();
  });
});
