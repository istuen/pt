// tests/verify/parse-domain.test.ts — parseDomain 单元测试（P2.4）
//
// 直接调 parseDomain，绕开 loadAndTranspile（端到端路径），验证：
// - frontmatter.name 正确解析（Phase term-P9.3：type 字段已删）
// - H2 段映射到 modules
// - ## Scene 统一 Term[]（P9.1）；## Manual 段为 FlowTemplate[]（P9.2 workflow 拆 Manual→Flows）
// - term Scene 项 fields/note 保留（v9.2）

import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { parseDomain } from "../../src/parse/domain.js";
import {
  isFlowTemplateArray,
  isTermArray,
  isTriggerItemArray,
} from "../../src/compile/type-guards.js";

const FIXTURE_DIR = join(process.cwd(), "tests/fixtures/parse");

describe("parseDomain — term Domain（Phase term-P9.3：type 字段已删）", () => {
  it("frontmatter: name=test-term-domain", async () => {
    const d = await parseDomain(FIXTURE_DIR, "domain-term.md");
    expect(d.name).toBe("test-term-domain");
    // Phase term-P9.3：Domain 不再有 type 字段
    expect((d as { type?: unknown }).type).toBeUndefined();
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

describe("parseDomain — workflow Domain（Phase term-P9.3：type 字段已删）", () => {
  it("frontmatter: name=test-workflow-domain", async () => {
    const d = await parseDomain(FIXTURE_DIR, "domain-workflow.md");
    expect(d.name).toBe("test-workflow-domain");
    expect((d as { type?: unknown }).type).toBeUndefined();
  });

  it("## Flows 段解析为 FlowTemplate[]（Phase term-P9.2：从 Manual 拆出）", async () => {
    const d = await parseDomain(FIXTURE_DIR, "domain-workflow.md");
    expect(isFlowTemplateArray(d.modules.Flows)).toBe(true);
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
