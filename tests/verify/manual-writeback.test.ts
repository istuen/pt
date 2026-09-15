// tests/verify/manual-writeback.test.ts — pt_verify 自动写回 manual 实例（v15.x）
//
// 覆盖 src/manual-writeback.ts 的纯函数：
//   - findStepForProbe：probe ↔ step 映射
//   - writeProbeResult：执行状态表写回 + completed probes 列表 + checklist 同步打勾
//
// 边界：
//   - 纯函数，不依赖 fs / ExtensionAPI
//   - 不依赖任何 Pt 资产（fixture 全部 inline）

import { describe, it, expect } from "vitest";
import { findStepForProbe, writeProbeResult } from "../../src/manual-writeback.js";

/** 构造一个最小 manual 文件 fixture（带 frontmatter + 3 step + 2 验证参照 + 执行状态表）。 */
function makeManual(
  overrides: { observedSteps?: Array<{ desc: string; observe: string[] }> } = {}
): string {
  const observedSteps = overrides.observedSteps ?? [
    { desc: "step 1", observe: [] },
    { desc: "step 2", observe: ["ts-compiles", "test-pass"] },
    { desc: "step 3", observe: ["git-status-clean"] },
  ];
  const lines: string[] = [
    "---",
    "procedure: test",
    "status: in-progress",
    "---",
    "",
    "# test 实例",
    "",
  ];
  observedSteps.forEach((s, i) => {
    lines.push(`- [ ] ${i + 1}. ${s.desc}`);
    if (s.observe.length > 0) {
      lines.push(`  - 验证参照：${s.observe.join(", ")}`);
    }
  });
  lines.push("");
  lines.push("## 执行状态");
  lines.push("| Step | Outcome | Message |");
  lines.push("|---|---|---|");
  for (let i = 1; i <= observedSteps.length; i++) {
    lines.push(`| ${i} | — | |`);
  }
  lines.push("");
  return lines.join("\n");
}

describe("findStepForProbe", () => {
  it("找到 probe 名匹配的 step", () => {
    const content = makeManual();
    const m = findStepForProbe(content, "ts-compiles");
    expect(m).not.toBeNull();
    expect(m!.stepIndex).toBe(2);
    expect(m!.observeNames).toEqual(["ts-compiles", "test-pass"]);
  });

  it("多个 step 含同一 probe 时返回首个", () => {
    const content = makeManual({
      observedSteps: [
        { desc: "first", observe: ["ts-compiles"] },
        { desc: "second", observe: ["ts-compiles"] },
      ],
    });
    const m = findStepForProbe(content, "ts-compiles");
    expect(m?.stepIndex).toBe(1);
  });

  it("probe 不在 observe 中时返 null", () => {
    const content = makeManual();
    expect(findStepForProbe(content, "fs-content-match")).toBeNull();
  });

  it("空 probe 名返 null", () => {
    const content = makeManual();
    expect(findStepForProbe(content, "")).toBeNull();
  });

  it("空内容返 null", () => {
    expect(findStepForProbe("", "ts-compiles")).toBeNull();
  });

  it("兼容无数字前缀的 step 行（手动写的 manual 实例）", () => {
    const content = [
      "---",
      "procedure: test",
      "status: in-progress",
      "---",
      "",
      "- [ ] 实施修复",
      "  - 验证参照：test-pass",
      "- [ ] 跑 verify",
      "  - 验证参照：ts-compiles, test-pass",
    ].join("\n");
    const m = findStepForProbe(content, "test-pass");
    expect(m?.stepIndex).toBe(1);
    const m2 = findStepForProbe(content, "ts-compiles");
    expect(m2?.stepIndex).toBe(2);
  });

  it("无 observe 行的 step 不会匹配", () => {
    const content = makeManual({
      observedSteps: [{ desc: "no observe", observe: [] }],
    });
    expect(findStepForProbe(content, "anything")).toBeNull();
  });
});

describe("writeProbeResult", () => {
  it("写入执行状态表对应行：— → COMPLETED + message", () => {
    const content = makeManual();
    const r = writeProbeResult(content, "ts-compiles", "COMPLETED", "TS 编译通过");
    expect(r.changed).toBe(true);
    expect(r.matchCount).toBe(1);
    expect(r.stepIndexes).toEqual([2]);
    expect(r.content).toContain("| 2 | COMPLETED | TS 编译通过 |");
    expect(r.content).not.toMatch(/^\| 2 \| — \| \|$/m);
  });

  it("DEVIATED outcome 也正确写入", () => {
    const content = makeManual();
    const r = writeProbeResult(content, "ts-compiles", "DEVIATED", "TS 编译失败");
    expect(r.content).toContain("| 2 | DEVIATED | TS 编译失败 |");
  });

  it("message 里的 | 字符转义，避免破坏 markdown 表格", () => {
    const content = makeManual();
    const r = writeProbeResult(content, "ts-compiles", "DEVIATED", "err at line 5 | line 6");
    expect(r.content).toContain("err at line 5 \\| line 6");
    // 表格行数不变（仍是 1 行 | 2 | xxx | xxx |）
    const tableRows = r.content.split("\n").filter((l) => l.startsWith("| 2 |"));
    expect(tableRows).toHaveLength(1);
  });

  it("多次跑同一 probe → 覆盖原 message（最新结果赢）", () => {
    let content = makeManual();
    content = writeProbeResult(content, "ts-compiles", "COMPLETED", "first").content;
    expect(content).toContain("| 2 | COMPLETED | first |");
    const r2 = writeProbeResult(content, "ts-compiles", "DEVIATED", "second");
    expect(r2.content).toContain("| 2 | DEVIATED | second |");
    expect(r2.content).not.toContain("first");
  });

  it("多 observe 同步：第二个 probe 完成后 checklist 自动打勾", () => {
    let content = makeManual();
    // step 2 的 observe 是 [ts-compiles, test-pass]
    content = writeProbeResult(content, "ts-compiles", "COMPLETED", "ok").content;
    // 第一次：只有 ts-compiles 完成 → checklist 不变（还差 test-pass）
    expect(content).toMatch(/^- \[ \] 2\. step 2$/m);
    expect(content).not.toMatch(/^- \[x\] 2\. step 2$/m);
    // 第二次：test-pass 也完成 → checklist 打勾
    const r = writeProbeResult(content, "test-pass", "COMPLETED", "ok");
    expect(r.checkedSteps).toEqual([2]);
    expect(r.content).toMatch(/^- \[x\] 2\. step 2$/m);
  });

  it("frontmatter 注释维护 completed probes 列表", () => {
    let content = makeManual();
    content = writeProbeResult(content, "ts-compiles", "COMPLETED", "ok").content;
    expect(content).toContain("<!-- pt-verify-completed: ts-compiles -->");
    content = writeProbeResult(content, "test-pass", "COMPLETED", "ok").content;
    expect(content).toContain("<!-- pt-verify-completed: test-pass, ts-compiles -->");
  });

  it("probe 不匹配时不写回（matchCount=0, changed=false）", () => {
    const content = makeManual();
    const r = writeProbeResult(content, "fs-content-match", "COMPLETED", "no match");
    expect(r.matchCount).toBe(0);
    expect(r.changed).toBe(false);
    expect(r.content).toBe(content);
  });

  it("probe 不匹配时不追加 frontmatter 注释", () => {
    const content = makeManual();
    const r = writeProbeResult(content, "fs-content-match", "COMPLETED", "no match");
    expect(r.content).not.toContain("pt-verify-completed");
  });

  it("已勾选的 step 不再被改回 - [ ]", () => {
    let content = makeManual();
    // 完成 step 2 全部 observe
    content = writeProbeResult(content, "ts-compiles", "COMPLETED", "ok").content;
    content = writeProbeResult(content, "test-pass", "COMPLETED", "ok").content;
    expect(content).toMatch(/^- \[x\] 2\. step 2$/m);
    // 再跑一次 ts-compiles（幂等）
    const r = writeProbeResult(content, "ts-compiles", "COMPLETED", "ok2");
    expect(r.content).toMatch(/^- \[x\] 2\. step 2$/m);
    expect(r.checkedSteps).toEqual([]); // 没新增勾选
  });

  it("无 frontmatter 的 manual（异常情况）也能写回", () => {
    const content = [
      "- [ ] step 1",
      "  - 验证参照：ts-compiles",
      "## 执行状态",
      "| Step | Outcome | Message |",
      "|---|---|---|",
      "| 1 | — | |",
    ].join("\n");
    const r = writeProbeResult(content, "ts-compiles", "COMPLETED", "ok");
    expect(r.changed).toBe(true);
    expect(r.content).toContain("| 1 | COMPLETED | ok |");
    expect(r.content).toContain("<!-- pt-verify-completed: ts-compiles -->");
  });

  it("无 observe 的 step 不会被打勾（无对应 probe 可完成）", () => {
    const content = makeManual({
      observedSteps: [{ desc: "step 1", observe: [] }],
    });
    const r = writeProbeResult(content, "anything", "COMPLETED", "ok");
    expect(r.matchCount).toBe(0);
    expect(r.changed).toBe(false);
  });

  it("返回 completedProbes 列表（含历史 + 本次）", () => {
    let content = makeManual();
    content = writeProbeResult(content, "ts-compiles", "COMPLETED", "ok").content;
    const r = writeProbeResult(content, "test-pass", "COMPLETED", "ok");
    expect(r.completedProbes.sort()).toEqual(["test-pass", "ts-compiles"]);
  });

  it("INCONCLUSIVE outcome 也能写入", () => {
    const content = makeManual();
    const r = writeProbeResult(content, "ts-compiles", "INCONCLUSIVE", "缺少参数");
    expect(r.content).toContain("| 2 | INCONCLUSIVE | 缺少参数 |");
    // INCONCLUSIVE 也算 completed（注释列表收录）
    expect(r.content).toContain("<!-- pt-verify-completed: ts-compiles -->");
  });
});
