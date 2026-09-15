// tests/verify/manual-track-completion.test.ts — manual 完成判定硬校验（v15.x）
//
// 覆盖 src/manual-track.ts 的硬校验逻辑：
//   - parseManualProgressFromContent 抽 ## 执行状态 表的 Outcome 列
//   - ManualProgress.pseudoComplete 字段
//   - checkManualCompletion / isManualActive 硬校验
//   - renderManualWidgetLines / renderManualFooterSuffix 显示伪完成 ⚠ 提示

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseManualProgressFromContent,
  checkManualCompletion,
  isManualActive,
  renderManualWidgetLines,
  renderManualFooterSuffix,
} from "../../src/manual-track.js";

/** 构造一个 minimal manual 文件 fixture（带 frontmatter + checklist + 执行状态表）。 */
function makeManual(
  opts: {
    status?: "in-progress" | "completed";
    /** checklist 行：每项 [x] 表示勾选 */
    checklist?: boolean[];
    /** 执行状态表 outcome 列表（长度 = checklist 长度）；undefined → 不生成表 */
    outcomes?: Array<"—" | "COMPLETED" | "DEVIATED" | "INCONCLUSIVE">;
  } = {}
): string {
  const status = opts.status ?? "in-progress";
  const checklist = opts.checklist ?? [false, false];
  const outcomes = opts.outcomes;
  const lines: string[] = ["---", "procedure: test", `status: ${status}`, "---", ""];
  checklist.forEach((checked, i) => {
    lines.push(`- [${checked ? "x" : " "}] step ${i + 1}`);
  });
  if (outcomes) {
    lines.push("");
    lines.push("## 执行状态");
    lines.push("| Step | Outcome | Message |");
    lines.push("|---|---|---|");
    outcomes.forEach((o, i) => {
      lines.push(`| ${i + 1} | ${o} | msg |`);
    });
  }
  return lines.join("\n");
}

describe("parseManualProgressFromContent — stepOutcomes 抽取", () => {
  it("从 ## 执行状态 表抽每行 outcome + stepIndex", () => {
    const content = makeManual({
      outcomes: ["COMPLETED", "DEVIATED", "INCONCLUSIVE", "—"],
    });
    const p = parseManualProgressFromContent(content);
    expect(p).not.toBeNull();
    expect(p!.stepOutcomes).toEqual([
      { stepIndex: 1, outcome: "COMPLETED" },
      { stepIndex: 2, outcome: "DEVIATED" },
      { stepIndex: 3, outcome: "INCONCLUSIVE" },
      { stepIndex: 4, outcome: "—" },
    ]);
  });

  it("未识别的 outcome 字符串归 INCONCLUSIVE", () => {
    const content = makeManual({ outcomes: ["TODO", "PENDING", "COMPLETED"] });
    const p = parseManualProgressFromContent(content);
    expect(p!.stepOutcomes.map((o) => o.outcome)).toEqual([
      "INCONCLUSIVE",
      "INCONCLUSIVE",
      "COMPLETED",
    ]);
  });

  it("## 执行状态 表缺行时不抛错（stepOutcomes 长度 < stepTotal）", () => {
    const content = [
      "---",
      "status: in-progress",
      "---",
      "- [x] step 1",
      "- [ ] step 2",
      "- [ ] step 3",
      "## 执行状态",
      "| Step | Outcome | Message |",
      "|---|---|---|",
      "| 1 | COMPLETED | ok |",
      // 缺 step 2 / 3 的行
    ].join("\n");
    const p = parseManualProgressFromContent(content);
    expect(p!.stepTotal).toBe(3);
    expect(p!.stepOutcomes).toEqual([{ stepIndex: 1, outcome: "COMPLETED" }]);
    expect(p!.hasUnfinishedOutcome).toBe(false); // 仅看表里有 outcome 的行
  });

  it("无 ## 执行状态 表时 stepOutcomes=[] + hasUnfinishedOutcome=false", () => {
    const content = makeManual({ outcomes: undefined });
    const p = parseManualProgressFromContent(content);
    expect(p!.stepOutcomes).toEqual([]);
    expect(p!.hasUnfinishedOutcome).toBe(false);
  });

  it("hasUnfinishedOutcome：任一 outcome 是 — 或 INCONCLUSIVE → true", () => {
    const p1 = parseManualProgressFromContent(makeManual({ outcomes: ["COMPLETED", "—"] }));
    expect(p1!.hasUnfinishedOutcome).toBe(true);
    const p2 = parseManualProgressFromContent(
      makeManual({ outcomes: ["COMPLETED", "INCONCLUSIVE"] })
    );
    expect(p2!.hasUnfinishedOutcome).toBe(true);
  });

  it("全 COMPLETED/DEVIATED → hasUnfinishedOutcome=false", () => {
    const p = parseManualProgressFromContent(
      makeManual({ outcomes: ["COMPLETED", "DEVIATED", "COMPLETED"] })
    );
    expect(p!.hasUnfinishedOutcome).toBe(false);
  });

  it("pseudoComplete：status=completed 但 stepDone<stepTotal → true", () => {
    const p = parseManualProgressFromContent(
      makeManual({
        status: "completed",
        checklist: [true, false], // 1/2 勾
        outcomes: ["COMPLETED", "COMPLETED"],
      })
    );
    expect(p!.pseudoComplete).toBe(true);
  });

  it("pseudoComplete：status=completed + 全勾 + hasUnfinishedOutcome → true", () => {
    const p = parseManualProgressFromContent(
      makeManual({
        status: "completed",
        checklist: [true, true],
        outcomes: ["COMPLETED", "INCONCLUSIVE"],
      })
    );
    expect(p!.pseudoComplete).toBe(true);
  });

  it("pseudoComplete：status=completed + 全勾 + 全 COMPLETED → false", () => {
    const p = parseManualProgressFromContent(
      makeManual({
        status: "completed",
        checklist: [true, true],
        outcomes: ["COMPLETED", "DEVIATED"],
      })
    );
    expect(p!.pseudoComplete).toBe(false);
  });

  it("pseudoComplete：status=in-progress → false（无论 stepDone）", () => {
    const p = parseManualProgressFromContent(
      makeManual({
        status: "in-progress",
        checklist: [false, false],
        outcomes: ["—", "—"],
      })
    );
    expect(p!.pseudoComplete).toBe(false);
  });
});

describe("checkManualCompletion", () => {
  it("status=in-progress → true（active）", () => {
    const p = parseManualProgressFromContent(makeManual({ status: "in-progress" }));
    expect(checkManualCompletion(p!)).toBe(true);
  });

  it("status=completed + 全勾 + 全 COMPLETED → false（真完成）", () => {
    const p = parseManualProgressFromContent(
      makeManual({
        status: "completed",
        checklist: [true, true],
        outcomes: ["COMPLETED", "COMPLETED"],
      })
    );
    expect(checkManualCompletion(p!)).toBe(false);
  });

  it("status=completed + 全勾 + 全 DEVIATED → false（DEVIATED 算完成）", () => {
    const p = parseManualProgressFromContent(
      makeManual({
        status: "completed",
        checklist: [true, true],
        outcomes: ["DEVIATED", "DEVIATED"],
      })
    );
    expect(checkManualCompletion(p!)).toBe(false);
  });

  it("status=completed + 全勾 + 有 INCONCLUSIVE → true（伪完成）", () => {
    const p = parseManualProgressFromContent(
      makeManual({
        status: "completed",
        checklist: [true, true],
        outcomes: ["COMPLETED", "INCONCLUSIVE"],
      })
    );
    expect(checkManualCompletion(p!)).toBe(true);
  });

  it("status=completed + 全勾 + 有 — 残留 → true（伪完成）", () => {
    const p = parseManualProgressFromContent(
      makeManual({
        status: "completed",
        checklist: [true, true],
        outcomes: ["COMPLETED", "—"],
      })
    );
    expect(checkManualCompletion(p!)).toBe(true);
  });

  it("status=completed + step 未全勾 → true（伪完成）", () => {
    const p = parseManualProgressFromContent(
      makeManual({
        status: "completed",
        checklist: [true, false],
        outcomes: ["COMPLETED", "COMPLETED"],
      })
    );
    expect(checkManualCompletion(p!)).toBe(true);
  });
});

describe("isManualActive", () => {
  let tmpDir: string;
  const cleanup: string[] = [];

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "pt-manual-active-"));
    cleanup.push(tmpDir);
  });

  afterEach(async () => {
    while (cleanup.length > 0) {
      const d = cleanup.pop()!;
      await rm(d, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("文件不存在 → false", async () => {
    const fake = join(tmpDir, "no-such.md");
    expect(await isManualActive(fake)).toBe(false);
  });

  it("status=in-progress → true", async () => {
    const f = join(tmpDir, "inprog.md");
    await writeFile(f, makeManual({ status: "in-progress" }), "utf8");
    expect(await isManualActive(f)).toBe(true);
  });

  it("status=completed + 全勾 + 全 COMPLETED → false", async () => {
    const f = join(tmpDir, "done.md");
    await writeFile(
      f,
      makeManual({
        status: "completed",
        checklist: [true, true],
        outcomes: ["COMPLETED", "COMPLETED"],
      }),
      "utf8"
    );
    expect(await isManualActive(f)).toBe(false);
  });

  it("status=completed 但 step 未全勾 → true（伪完成仍 active）", async () => {
    const f = join(tmpDir, "fake.md");
    await writeFile(
      f,
      makeManual({
        status: "completed",
        checklist: [true, false],
        outcomes: ["COMPLETED", "COMPLETED"],
      }),
      "utf8"
    );
    expect(await isManualActive(f)).toBe(true);
  });

  it("status=completed + 全勾 + 有 — 残留 → true（伪完成仍 active）", async () => {
    const f = join(tmpDir, "fake-residue.md");
    await writeFile(
      f,
      makeManual({
        status: "completed",
        checklist: [true, true],
        outcomes: ["COMPLETED", "—"],
      }),
      "utf8"
    );
    expect(await isManualActive(f)).toBe(true);
  });
});

describe("renderManualWidgetLines — 伪完成显示 ⚠ fake done", () => {
  it("真完成：status=completed + 全勾 + 全 COMPLETED → ✓ done", () => {
    const p = parseManualProgressFromContent(
      makeManual({
        status: "completed",
        checklist: [true, true],
        outcomes: ["COMPLETED", "COMPLETED"],
      })
    );
    const lines = renderManualWidgetLines("/fake/path.md", p!);
    expect(lines[0]).toContain("✓ done");
    expect(lines[0]).not.toContain("⚠ fake done");
  });

  it("伪完成：status=completed + step 未全勾 → ⚠ fake done", () => {
    const p = parseManualProgressFromContent(
      makeManual({
        status: "completed",
        checklist: [true, false],
        outcomes: ["COMPLETED", "COMPLETED"],
      })
    );
    const lines = renderManualWidgetLines("/fake/path.md", p!);
    expect(lines[0]).toContain("⚠ fake done");
  });

  it("伪完成：status=completed + 全勾 + 有 — 残留 → ⚠ fake done", () => {
    const p = parseManualProgressFromContent(
      makeManual({
        status: "completed",
        checklist: [true, true],
        outcomes: ["COMPLETED", "—"],
      })
    );
    const lines = renderManualWidgetLines("/fake/path.md", p!);
    expect(lines[0]).toContain("⚠ fake done");
  });

  it("伪完成时不显示 next 行（所有 step 都勾了）", () => {
    const p = parseManualProgressFromContent(
      makeManual({
        status: "completed",
        checklist: [true, true],
        outcomes: ["COMPLETED", "—"],
      })
    );
    const lines = renderManualWidgetLines("/fake/path.md", p!);
    expect(lines.some((l) => l.includes("next:"))).toBe(false);
  });

  it("in-progress + nextStep → 显示 next 行", () => {
    const p = parseManualProgressFromContent(
      makeManual({
        status: "in-progress",
        checklist: [false, false],
        outcomes: ["—", "—"],
      })
    );
    const lines = renderManualWidgetLines("/fake/path.md", p!);
    expect(lines.some((l) => l.includes("next: step 1"))).toBe(true);
  });
});

describe("renderManualFooterSuffix — 伪完成显示 ⚠ fake done", () => {
  it("真完成 → '· manual: <procedure> done'", () => {
    const p = parseManualProgressFromContent(
      makeManual({
        status: "completed",
        checklist: [true, true],
        outcomes: ["COMPLETED", "COMPLETED"],
      })
    );
    expect(renderManualFooterSuffix(p!)).toBe("· manual: test done");
  });

  it("伪完成（step 未全勾）→ '· manual: <procedure> ⚠ fake done'", () => {
    const p = parseManualProgressFromContent(
      makeManual({
        status: "completed",
        checklist: [true, false],
        outcomes: ["COMPLETED", "COMPLETED"],
      })
    );
    expect(renderManualFooterSuffix(p!)).toBe("· manual: test ⚠ fake done");
  });

  it("伪完成（有 — 残留）→ '· manual: <procedure> ⚠ fake done'", () => {
    const p = parseManualProgressFromContent(
      makeManual({
        status: "completed",
        checklist: [true, true],
        outcomes: ["COMPLETED", "—"],
      })
    );
    expect(renderManualFooterSuffix(p!)).toBe("· manual: test ⚠ fake done");
  });

  it("in-progress → '· manual: <procedure> <done>/<total>'", () => {
    const p = parseManualProgressFromContent(
      makeManual({ status: "in-progress", checklist: [true, false] })
    );
    expect(renderManualFooterSuffix(p!)).toBe("· manual: test 1/2");
  });
});
