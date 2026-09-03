// tests/verify/parse-domain.test.ts — parseDomain 单元测试（P2.4）
//
// 直接调 parseDomain，绕开 loadAndTranspile（端到端路径），验证：
// - frontmatter.type / .name 正确解析
// - H2 段映射到 modules
// - term 形态走 fallback Term[]
// - workflow 形态的 ## Scene 段被注册表 parser 解析为 { externals? }

import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { parseDomain } from "../../src/parse/domain.js";
import {
  isFlowTemplateArray,
  isTermArray,
  isTriggerItemArray,
} from "../../src/compile/type-guards.js";

const FIXTURE_DIR = join(process.cwd(), "tests/fixtures/parse");

describe("parseDomain — term 类型", () => {
  it("frontmatter: type=term, name=test-term-domain", async () => {
    const d = await parseDomain(FIXTURE_DIR, "domain-term.md");
    expect(d.type).toBe("term");
    expect(d.name).toBe("test-term-domain");
  });

  it("H2 段 → modules（## Scene / ## Trigger 都解析为数组）", async () => {
    const d = await parseDomain(FIXTURE_DIR, "domain-term.md");
    expect(Object.keys(d.modules).sort()).toEqual(["Scene", "Trigger"]);
    expect(isTriggerItemArray(d.modules["Trigger"])).toBe(true);
  });

  it("term 形态的 ## Scene 走 fallback Term[]", async () => {
    const d = await parseDomain(FIXTURE_DIR, "domain-term.md");
    expect(isTermArray(d.modules["Scene"])).toBe(true);
  });
});

describe("parseDomain — workflow 类型", () => {
  it("frontmatter: type=workflow", async () => {
    const d = await parseDomain(FIXTURE_DIR, "domain-workflow.md");
    expect(d.type).toBe("workflow");
    expect(d.name).toBe("test-workflow-domain");
  });

  it("## Manual 段解析为 FlowTemplate[]（workflow Scene 走注册表 parser）", async () => {
    const d = await parseDomain(FIXTURE_DIR, "domain-workflow.md");
    expect(isFlowTemplateArray(d.modules["Manual"])).toBe(true);
  });
});
