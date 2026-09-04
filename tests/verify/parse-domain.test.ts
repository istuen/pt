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
    expect(isTriggerItemArray(d.modules.Trigger)).toBe(true);
  });

  it("term 形态的 ## Scene 走 fallback Term[]", async () => {
    const d = await parseDomain(FIXTURE_DIR, "domain-term.md");
    expect(isTermArray(d.modules.Scene)).toBe(true);
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
    expect(isFlowTemplateArray(d.modules.Manual)).toBe(true);
  });
});

describe("parseDomain — term Scene 项 fields/note 保留（v9.2 修复）", () => {
  // 背景：pt-collab.md 等 term-Domain 在 Scene 段用了 `fields:` / `purpose:` / `rule:` 行，
  // 原 parse 层只取 desc/description/role，其余静默丢弃 → 编译产物只输出 `- name: desc`。
  // 修复后 parse 读 fields + purpose/rule，进 Term IR 的 fields?/note? 可选字段。
  it("fields 数组保留为 Term.fields", async () => {
    const d = await parseDomain(FIXTURE_DIR, "domain-term-fields-note.md");
    const scene = d.modules.Scene as Array<{
      name: string;
      desc: string;
      fields?: string[];
      note?: string;
    }>;
    expect(isTermArray(scene)).toBe(true);
    const td = scene.find((t) => t.name === "task-description");
    expect(td).toBeDefined();
    expect(td?.fields).toEqual(["必读", "设计原则", "步骤", "验收标准", "边界纪律", "baseline"]);
  });

  it("purpose 收纳为 Term.note", async () => {
    const d = await parseDomain(FIXTURE_DIR, "domain-term-fields-note.md");
    const scene = d.modules.Scene as Array<{
      name: string;
      desc: string;
      note?: string;
    }>;
    const td = scene.find((t) => t.name === "task-description");
    expect(td?.note).toBe("执行者不猜设计意图，按步骤执行即可");
  });

  it("rule 字段也走 note 路径（与 purpose 统一收纳）", async () => {
    const d = await parseDomain(FIXTURE_DIR, "domain-term-fields-note.md");
    const scene = d.modules.Scene as Array<{
      name: string;
      desc: string;
      note?: string;
    }>;
    const acc = scene.find((t) => t.name === "acceptance");
    expect(acc?.note).toBe("每个硬指标都要有独立验证方式，不只看执行者给的结果");
  });

  it("无 fields/note 的项不进 IR 字段（向后兼容）", async () => {
    const d = await parseDomain(FIXTURE_DIR, "domain-term-fields-note.md");
    const scene = d.modules.Scene as Array<{
      name: string;
      desc: string;
      fields?: string[];
      note?: string;
    }>;
    const plain = scene.find((t) => t.name === "plain-term");
    expect(plain?.desc).toBe("没 fields/note 的术语（向后兼容基线）");
    expect(plain?.fields).toBeUndefined();
    expect(plain?.note).toBeUndefined();
  });
});
