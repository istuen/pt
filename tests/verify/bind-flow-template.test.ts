// tests/verify/bind-flow-template.test.ts — P2：FlowStep.output / dataSource 渲染深化
//
// 验证：
//   - parse 层 collectSteps 正确读 dataSource（块式 YAML）+ output（行内文本）
//   - bindFlowTemplate 渲染 3 类子项（输入参照 / 期望产出 / 验证参照），顺序为 dataSource → output → observe
//   - buildManualDoc step 循环识别三类子项行 → checklist 子项
//   - back-compat：无 dataSource/output/observe 时不渲染新行（与 P1 后基线一致）

import { describe, it, expect, beforeAll } from "vitest";
import { join } from "node:path";
import { parseFrontmatter, splitSections, parseItems, readAsset } from "../../src/parse/shared.js";
import { getDomainSectionParser } from "../../src/parse/domain-renderers.js";
import { bindFlowTemplate } from "../../src/render/turn-inject.js";
import type { FlowStep, FlowTemplate } from "../../src/schema.js";

const FIX = join(process.cwd(), "tests/fixtures/p2-io");

/** 走 parse 链（readAsset → Flows renderer）取 IR.steps。 */
async function parseSteps(raw: string): Promise<FlowStep[]> {
  const itemName = raw.match(/^###\s+(.+)$/m)?.[1]?.trim();
  if (!itemName) throw new Error("item name missing in fixture");
  const { body } = parseFrontmatter(raw);
  const sectionsArr = splitSections(body);
  const sections: Record<string, { raw: string; items: ReturnType<typeof parseItems> }> = {};
  for (const sec of sectionsArr) {
    sections[sec.heading.replace(/^#+\s*/, "").trim()] = {
      raw: sec.raw,
      items: parseItems(sec.raw),
    };
  }
  const parser = getDomainSectionParser("Flows");
  if (!parser) throw new Error("Flows parser not registered");
  const flowsSection = sections.Flows;
  if (!flowsSection) throw new Error("Flows section missing");
  const flows = parser(flowsSection.items, flowsSection.raw) as FlowTemplate[];
  const hit = flows.find((t) => t.name === itemName);
  if (!hit) throw new Error(`flow ${itemName} not parsed`);
  return hit.steps;
}

function fixtureFlowRaw(
  opts: {
    name?: string;
    withDataSource?: boolean;
    withOutput?: boolean;
    withObserve?: boolean;
    indentDataSource?: number;
  } = {}
): string {
  const name = opts.name ?? "demo-io";
  const ds = opts.withDataSource ?? true;
  const out = opts.withOutput ?? true;
  const obs = opts.withObserve ?? true;
  const indent = " ".repeat(opts.indentDataSource ?? 2);

  const lines: string[] = [
    "## Flows",
    "",
    `### ${name}`,
    `- argument-hint: <topic>`,
    `- intent: P2 I/O 渲染示范`,
    "- vars: [topic]",
    "- step: 读取需求",
  ];
  if (ds) {
    lines.push(`${indent}- dataSource:`);
    lines.push(`      name: requirement`);
    lines.push(`      path: .pt/docs/designs/`);
    lines.push(`      desc: 需求文档目录`);
  }
  if (out) {
    lines.push(`  - output: 需求摘要（写给 {{topic}} 的开场陈述）`);
  }
  if (obs) {
    lines.push(`  - observe: [git-status-clean]`);
  }
  lines.push("- step: 实施改动");
  lines.push("- step: 收尾");
  return lines.join("\n");
}

describe("P2 parse: FlowStep.dataSource / output", () => {
  it("dataSource 块式：name / path / desc 三个字段正确入 IR", async () => {
    const raw = fixtureFlowRaw({ withDataSource: true, withOutput: false, withObserve: false });
    const steps = await parseSteps(raw);
    expect(steps).toHaveLength(3);
    expect(steps[0]?.desc).toBe("读取需求");
    expect(steps[0]?.dataSource).toEqual({
      name: "requirement",
      path: ".pt/docs/designs/",
      desc: "需求文档目录",
    });
  });

  it("output 行内：字符串正确入 IR", async () => {
    const raw = fixtureFlowRaw({ withDataSource: false, withOutput: true, withObserve: false });
    const steps = await parseSteps(raw);
    expect(steps[0]?.output).toBe("需求摘要（写给 {{topic}} 的开场陈述）");
  });

  it("三者都有：dataSource / output / observe 三个字段都正确", async () => {
    const raw = fixtureFlowRaw();
    const steps = await parseSteps(raw);
    expect(steps[0]?.dataSource?.name).toBe("requirement");
    expect(steps[0]?.output).toContain("需求摘要");
    expect(steps[0]?.observe).toEqual(["git-status-clean"]);
  });

  it("back-compat：step 仅有 desc 时无 dataSource / output / observe 字段", async () => {
    const raw = `## Flows\n\n### bare\n- argument-hint: <x>\n- intent: 纯 desc\n- step: 仅描述\n- step: 第二步\n`;
    const steps = await parseSteps(raw);
    expect(steps[0]?.desc).toBe("仅描述");
    expect(steps[0]?.dataSource).toBeUndefined();
    expect(steps[0]?.output).toBeUndefined();
    expect(steps[0]?.observe).toBeUndefined();
  });

  it("dataSource 缺必填字段（name 或 path）→ 不落 IR，避免空对象污染", async () => {
    const raw = `## Flows\n\n### nodp\n- intent: x\n- step: 仅 name\n  - dataSource:\n      name: only-name\n- step: 仅 path\n  - dataSource:\n      path: /tmp\n`;
    const steps = await parseSteps(raw);
    expect(steps[0]?.dataSource).toBeUndefined();
    expect(steps[1]?.dataSource).toBeUndefined();
  });

  it("dataSource protocol 字段：合法值入 IR，非法值丢弃", async () => {
    const raw = `## Flows\n\n### prot\n- intent: x\n- step: x\n  - dataSource:\n      name: a\n      path: /b\n      protocol: file\n- step: y\n  - dataSource:\n      name: c\n      path: /d\n      protocol: evil-string\n`;
    const steps = await parseSteps(raw);
    expect(steps[0]?.dataSource?.protocol).toBe("file");
    expect(steps[1]?.dataSource?.protocol).toBeUndefined();
  });
});

describe("P2 bindFlowTemplate 渲染", () => {
  const baseTpl = {
    name: "demo-io",
    argumentHint: "<topic>",
    intent: "P2 I/O 渲染示范",
    _vars: ["topic"],
    externals: [],
  } as const;

  let parsedSteps: FlowStep[];

  beforeAll(async () => {
    parsedSteps = await parseSteps(fixtureFlowRaw());
  });

  it("仅 output 字段 → 渲染 '期望产出：xxx' 行", () => {
    const tpl: FlowTemplate = {
      ...baseTpl,
      steps: [{ desc: "s", output: "产出说明" }],
    };
    const out = bindFlowTemplate(tpl, "");
    expect(out).toContain("   - 期望产出：产出说明");
    expect(out).not.toContain("输入参照：");
    expect(out).not.toContain("验证参照：");
  });

  it("仅 dataSource 字段（name + path）→ 渲染 '输入参照：name（path）' 行", () => {
    const tpl: FlowTemplate = {
      ...baseTpl,
      steps: [{ desc: "s", dataSource: { name: "req", path: ".pt/docs/" } }],
    };
    const out = bindFlowTemplate(tpl, "");
    expect(out).toContain("   - 输入参照：req（.pt/docs/）");
    expect(out).not.toContain("期望产出：");
  });

  it("dataSource 含 desc → 追加 ' — desc'", () => {
    const tpl: FlowTemplate = {
      ...baseTpl,
      steps: [{ desc: "s", dataSource: { name: "req", path: ".pt/docs/", desc: "需求文档目录" } }],
    };
    const out = bindFlowTemplate(tpl, "");
    expect(out).toContain("   - 输入参照：req（.pt/docs/） — 需求文档目录");
  });

  it("dataSource 仅 name 无 path → 只渲染 name", () => {
    const tpl: FlowTemplate = {
      ...baseTpl,
      steps: [{ desc: "s", dataSource: { name: "req", path: "" } }],
    };
    const out = bindFlowTemplate(tpl, "");
    expect(out).toContain("   - 输入参照：req");
    expect(out).not.toContain("（）");
  });

  it("output 行支持变量替换（{{var}} 路径）", () => {
    const tpl: FlowTemplate = {
      ...baseTpl,
      steps: [{ desc: "s", output: "给 {{topic}} 的开场" }],
    };
    const out = bindFlowTemplate(tpl, "reader-x");
    expect(out).toContain("期望产出：给 reader-x 的开场");
  });

  it("三者都有 → 顺序 dataSource → output → observe", () => {
    const tpl: FlowTemplate = {
      ...baseTpl,
      steps: [
        {
          desc: "读取需求",
          dataSource: { name: "requirement", path: ".pt/docs/designs/" },
          output: "需求摘要",
          observe: ["git-status-clean"],
        },
        { desc: "实施改动" },
      ],
    };
    const out = bindFlowTemplate(tpl, "");
    const lines = out.split("\n");
    const idxDs = lines.findIndex((l) => l.includes("输入参照："));
    const idxOut = lines.findIndex((l) => l.includes("期望产出："));
    const idxObs = lines.findIndex((l) => l.includes("验证参照："));
    expect(idxDs).toBeGreaterThan(-1);
    expect(idxOut).toBeGreaterThan(idxDs);
    expect(idxObs).toBeGreaterThan(idxOut);
  });

  it("back-compat：step 无 dataSource/output/observe → 不渲染新行", () => {
    const tpl: FlowTemplate = {
      ...baseTpl,
      steps: [{ desc: "s" }],
    };
    const out = bindFlowTemplate(tpl, "");
    expect(out).toBe(
      "# demo-io\n\n_参数：<topic>_\n\n## 前提（Intent）\nP2 I/O 渲染示范\n\n## 步骤\n1. s"
    );
  });

  it("parse → bind 完整链：fixtureFlowRaw → bindFlowTemplate → 输出三种子项", () => {
    const tpl: FlowTemplate = { ...baseTpl, steps: parsedSteps };
    const out = bindFlowTemplate(tpl, "topic");
    expect(out).toContain("   - 输入参照：requirement（.pt/docs/designs/） — 需求文档目录");
    expect(out).toContain("   - 期望产出：需求摘要（写给 topic 的开场陈述）");
    expect(out).toContain("   - 验证参照：git-status-clean");
  });
});

describe("P2 buildManualDoc step 循环识别三类子项行", () => {
  /** 复刻 buildManualDoc 的 step 循环逻辑（P2.3 改后），便于不依赖 transpile 验证识别行为。 */
  function processBound(bound: string): string[] {
    const lines: string[] = [];
    for (const line of bound.split("\n")) {
      if (line.startsWith("#")) continue;
      if (line.startsWith("_")) continue;
      const stepMatch = line.match(/^(\d+)\.\s+(.*)$/);
      if (stepMatch) {
        lines.push(`- [ ] ${stepMatch[2]}`);
        continue;
      }
      if (
        line.includes("验证参照：") ||
        line.includes("期望产出：") ||
        line.includes("输入参照：")
      ) {
        lines.push(`  ${line.trim()}`);
        continue;
      }
      lines.push(line);
    }
    return lines;
  }

  it("识别 输入参照 / 期望产出 / 验证参照 三类子项行", () => {
    const bound = [
      "# x",
      "",
      "_参数：<x>_",
      "",
      "## 前提（Intent）",
      "x",
      "",
      "## 步骤",
      "1. 读取需求",
      "   - 输入参照：req（path） — 需求目录",
      "   - 期望产出：需求摘要",
      "   - 验证参照：git-status-clean",
      "2. 实施改动",
    ].join("\n");
    // H2 行 (`## 步骤` / `## 前提...`) 被 processBound 跳过（line.startsWith("#") continue），
    // 与 buildManualDoc 行为一致；step 行 + 三类子项行进入 checklist 输出。
    // 空行也被透传（processBound 不显式跳空行），与 buildManualDoc 行为一致。
    expect(processBound(bound)).toEqual([
      "",
      "",
      "x",
      "",
      "- [ ] 读取需求",
      "  - 输入参照：req（path） — 需求目录",
      "  - 期望产出：需求摘要",
      "  - 验证参照：git-status-clean",
      "- [ ] 实施改动",
    ]);
  });

  it("back-compat：仅 observe 子项 → 与 P1 后基线一致", () => {
    const bound = ["# x", "", "## 步骤", "1. s", "   - 验证参照：obs"].join("\n");
    // H2 行被跳过 → 期望里不出现 `## 步骤`；空行透传。
    expect(processBound(bound)).toEqual(["", "- [ ] s", "  - 验证参照：obs"]);
  });

  it("step 行内不能误判：非 `-` 起首的子项行不识别为子项", () => {
    const bound = ["# x", "## 步骤", "1. s", "  - 期望产出：xxx（带括号）"].join("\n");
    // 这是合法的子项行（行内缩进 + "   - 期望产出："），期望被识别
    // H2 行被跳过 → 期望里不出现 `## 步骤`
    expect(processBound(bound)).toEqual(["- [ ] s", "  - 期望产出：xxx（带括号）"]);
  });
});

describe("P2 端到端：fixture md → parse → bind → step 循环识别", () => {
  it("demo-io-rendering.md 走完整链路 → manual 实例 checklist 包含三类子项行", async () => {
    // 读 fixture（不入主仓 `.pt/assets/`，仅供本测试）
    const asset = await readAsset(join(FIX, "demo-io-rendering.md"));
    expect(asset.name).toBe("demo-io-rendering");

    // parse Flows 段 → FlowTemplate
    const parser = getDomainSectionParser("Flows");
    expect(parser).toBeDefined();
    if (!parser) throw new Error("Flows parser not registered");
    const flowsSection = asset.sections["Flows"];
    expect(flowsSection).toBeDefined();
    if (!flowsSection) throw new Error("Flows section missing");
    const flows = parser(flowsSection.items, flowsSection.raw) as FlowTemplate[];
    const tpl = flows.find((t) => t.name === "demo-io-rendering");
    expect(tpl).toBeDefined();
    if (!tpl) throw new Error("demo-io-rendering not parsed");

    // 验 parse 后 IR 包含三类字段
    expect(tpl.steps[0]?.desc).toBe("读取需求");
    expect(tpl.steps[0]?.dataSource).toEqual({
      name: "requirement-doc",
      path: ".pt/docs/designs/",
      desc: "已有需求文档目录",
    });
    expect(tpl.steps[0]?.output).toBe("需求摘要（写给 {{topic}} 的开场陈述）");
    expect(tpl.steps[2]?.observe).toEqual(["git-status-clean"]);

    // bindFlowTemplate → 三类子项行
    const bound = bindFlowTemplate(tpl, "reader-x");
    expect(bound).toContain("1. 读取需求");
    expect(bound).toContain(
      "   - 输入参照：requirement-doc（.pt/docs/designs/） — 已有需求文档目录"
    );
    expect(bound).toContain("   - 期望产出：需求摘要（写给 reader-x 的开场陈述）");
    expect(bound).toContain("3. 收尾");
    expect(bound).toContain("   - 验证参照：git-status-clean");

    // buildManualDoc step 循环复刻函数 → checklist 输出
    function processBound(b: string): string[] {
      const lines: string[] = [];
      for (const line of b.split("\n")) {
        if (line.startsWith("#")) continue;
        if (line.startsWith("_")) continue;
        const stepMatch = line.match(/^(\d+)\.\s+(.*)$/);
        if (stepMatch) {
          lines.push(`- [ ] ${stepMatch[2]}`);
          continue;
        }
        if (
          line.includes("验证参照：") ||
          line.includes("期望产出：") ||
          line.includes("输入参照：")
        ) {
          lines.push(`  ${line.trim()}`);
          continue;
        }
        lines.push(line);
      }
      return lines;
    }
    const checklist = processBound(bound);
    // 顺序：input → output → observe → step 2 → step 3 + observe
    expect(checklist).toContain("- [ ] 读取需求");
    expect(checklist).toContain(
      "  - 输入参照：requirement-doc（.pt/docs/designs/） — 已有需求文档目录"
    );
    expect(checklist).toContain("  - 期望产出：需求摘要（写给 reader-x 的开场陈述）");
    expect(checklist).toContain("- [ ] 实施改动");
    expect(checklist).toContain("- [ ] 收尾");
    expect(checklist).toContain("  - 验证参照：git-status-clean");
  });
});
