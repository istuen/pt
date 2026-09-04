// tests/verify/parse-blueprint.test.ts — parseBlueprint 单元测试（P2.4）
//
// v9 Blueprint：H2=注入点（target + mode + Modules），## Compilation 段独立解析。

import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { parseBlueprint } from "../../src/parse/blueprint.js";

const FIXTURE_DIR = join(process.cwd(), "tests/fixtures/parse");

describe("parseBlueprint", () => {
  it("frontmatter: name=test-blueprint（Phase term-P4.1：agent 字段移除）", async () => {
    const bp = await parseBlueprint(FIXTURE_DIR, "blueprint.md");
    expect(bp.name).toBe("test-blueprint");
    // Phase term-P4.1：Blueprint.agent 字段移除，BP 应无 agent 字段
    expect((bp as { agent?: unknown }).agent).toBeUndefined();
  });

  it("H2 段 → injectionPoints（## Compilation 不算注入点）", async () => {
    const bp = await parseBlueprint(FIXTURE_DIR, "blueprint.md");
    const ipNames = bp.injectionPoints.map((ip) => ip.name).sort();
    expect(ipNames).toEqual(["会话知识", "参考手册"]);
  });

  it("注入点字段：target + mode + modules", async () => {
    const bp = await parseBlueprint(FIXTURE_DIR, "blueprint.md");
    const sessionIp = bp.injectionPoints.find((ip) => ip.name === "会话知识");
    expect(sessionIp?.target).toBe("system_prompt");
    expect(sessionIp?.mode).toBe("hybrid");
    expect(sessionIp?.modules).toEqual(["Scene", "Trigger"]);
  });

  it("## Compilation 段 → compilation（cacheDir + split）", async () => {
    const bp = await parseBlueprint(FIXTURE_DIR, "blueprint.md");
    expect(bp.compilation.cacheDir).toBe(".pt/cache/test/");
    expect(bp.compilation.split).toBe("single-file");
  });
});
