// tests/verify/parse-domain.test.ts — parseDomain 单元测试（P2.4）
//
// 直接调 parseDomain，绕开 loadAndTranspile（端到端路径），验证：
// - frontmatter.name 正确解析（Phase term-P9.3：type 字段已删）
// - H2 段映射到 modules
// - ## Scene 统一 Term[]（P9.1）；## Manual 段为 FlowTemplate[]（P9.2 workflow 拆 Manual→Flows）
// - term Scene 项 fields/note 保留（v9.2）

import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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

// pt-virtual-profile（issue §3.5 改动 2）：parseDomain 读 frontmatter mode + tagline。
//   mode="virtual" → d.mode==="virtual"；无 mode / 非法值 → d.mode==="normal"（缺省）；
//   tagline 字符串 → d.tagline；空串 / 非法 → undefined（静默忽略，与 profile.ts tagline 一致）。
describe("parseDomain — pt-virtual-profile：mode + tagline frontmatter", () => {
  const tempDirs: string[] = [];
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function parseVirtual(content: string) {
    const dir = await mkdtemp(join(tmpdir(), "pt-parse-domain-virtual-"));
    await writeFile(join(dir, "d.md"), content);
    tempDirs.push(dir);
    return parseDomain(dir, "d.md");
  }

  it('mode: virtual → d.mode === "virtual"（硬指标 2）', async () => {
    const d = await parseVirtual(
      `---\nname: v\nmode: virtual\ntagline: V tag\n---\n## Section1\n- a: desc\n`
    );
    expect(d.mode).toBe("virtual");
  });

  it('无 mode 字段 → d.mode === "normal"（缺省）', async () => {
    const d = await parseVirtual(`---\nname: n\n---\n## Scene\n- t: d\n`);
    expect(d.mode).toBe("normal");
  });

  it('mode: normal 显式 → d.mode === "normal"', async () => {
    const d = await parseVirtual(`---\nname: n2\nmode: normal\n---\n## Scene\n- t\n`);
    expect(d.mode).toBe("normal");
  });

  it('mode 非合法值 → d.mode === "normal"（缺省，不报错）', async () => {
    const d = await parseVirtual(`---\nname: bad\nmode: garbage\n---\n## Scene\n- t\n`);
    expect(d.mode).toBe("normal");
  });

  it('含 tagline → d.tagline === "..."（硬指标 2）', async () => {
    const d = await parseVirtual(
      `---\nname: v\nmode: virtual\ntagline: My tagline\n---\n## S\n- a\n`
    );
    expect(d.tagline).toBe("My tagline");
  });

  it("tagline 空字符串 → undefined（视为未填，与 profile.ts 一致）", async () => {
    const d = await parseVirtual(`---\nname: v\nmode: virtual\ntagline: ""\n---\n## S\n- a\n`);
    expect(d.tagline).toBeUndefined();
  });

  it("无 tagline 字段 → undefined", async () => {
    const d = await parseVirtual(`---\nname: v\nmode: virtual\n---\n## S\n- a\n`);
    expect(d.tagline).toBeUndefined();
  });
});

describe("parseDomain — Trigger hint 字段保留（pt-trigger-hint-field-loss 修复）", () => {
  it("Trigger 段走专属 parser（非 fallback）", async () => {
    const d = await parseDomain(FIXTURE_DIR, "domain-trigger-hint.md");
    expect(isTriggerItemArray(d.modules.Trigger)).toBe(true);
  });

  it("hint 字段保留为 TriggerItem.hint", async () => {
    const d = await parseDomain(FIXTURE_DIR, "domain-trigger-hint.md");
    const trigger = d.modules.Trigger as Array<{
      name: string;
      desc?: string;
      hint?: string;
    }>;
    const withHint = trigger.find((t) => t.name === "trigger-with-hint");
    expect(withHint?.desc).toBe("测试 hint 字段保留");
    expect(withHint?.hint).toBe("调 pt_inject tool domain=test 查看完整规范");
  });

  it("无 hint 时不输出 hint 字段", async () => {
    const d = await parseDomain(FIXTURE_DIR, "domain-trigger-hint.md");
    const trigger = d.modules.Trigger as Array<{
      name: string;
      desc?: string;
      hint?: string;
    }>;
    const withoutHint = trigger.find((t) => t.name === "trigger-without-hint");
    expect(withoutHint?.desc).toBe("测试无 hint 时不输出 hint 字段");
    expect(withoutHint?.hint).toBeUndefined();
  });
});

describe("parseDomain — Trigger anti 字段保留（pt-trigger-anti-field-phase-b 落地）", () => {
  // 背景：Phase A（commit 61f7186）只在 authoring.md 加 trigger-anti-field 文档约定，
  // parse 不强制——anti: 落入 fallback properties 丢弃。Phase B 把 anti 走完整
  // parse + type guard + render 链路，让 Pt 真正消费负向触发条件。
  it("anti 字段保留为 TriggerItem.anti", async () => {
    const d = await parseDomain(FIXTURE_DIR, "domain-trigger-anti.md");
    const trigger = d.modules.Trigger as Array<{
      name: string;
      desc?: string;
      hint?: string;
      anti?: string;
    }>;
    const withAnti = trigger.find((t) => t.name === "trigger-with-anti");
    expect(withAnti?.desc).toBe("测试 anti 字段保留");
    expect(withAnti?.anti).toBe("纯代码改动无任务派发/验收时（不触发手册注入）");
  });

  it("无 anti 时不输出 anti 字段", async () => {
    const d = await parseDomain(FIXTURE_DIR, "domain-trigger-anti.md");
    const trigger = d.modules.Trigger as Array<{
      name: string;
      desc?: string;
      hint?: string;
      anti?: string;
    }>;
    const withoutAnti = trigger.find((t) => t.name === "trigger-without-anti");
    expect(withoutAnti?.desc).toBe("测试无 anti 时不输出 anti 字段");
    expect(withoutAnti?.anti).toBeUndefined();
  });

  it("hint 与 anti 同时保留（两字段独立，互不覆盖）", async () => {
    const d = await parseDomain(FIXTURE_DIR, "domain-trigger-anti.md");
    const trigger = d.modules.Trigger as Array<{
      name: string;
      desc?: string;
      hint?: string;
      anti?: string;
    }>;
    const both = trigger.find((t) => t.name === "trigger-with-hint-and-anti");
    expect(both?.hint).toBe("调 pt_inject tool domain=test 查看完整规范");
    expect(both?.anti).toBe("纯查询无执行任务时（不触发手册注入）");
  });
});
