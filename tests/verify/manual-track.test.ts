// tests/verify/manual-track.test.ts — manual-track.ts 单测
//
// 配套 .pt/docs/designs/pt-injection-status-manual-track.md §2.4：
//   - parseManualProgress：文件不存在 / 无 frontmatter / in-progress / completed
//   - renderManualWidgetLines：标题行 / next 行 / file 行 + completed 加 ✓
//   - renderManualFooterSuffix：in-progress "3/6" vs completed "done"
//   - isManualActive：文件不存在 false / completed false / in-progress true

import { describe, it, expect } from "vitest";
import { join } from "node:path";
import {
  isManualActive,
  parseManualProgress,
  parseManualProgressFromContent,
  renderManualFooterSuffix,
  renderManualWidgetLines,
} from "../../src/manual-track.js";

const FIX = join(process.cwd(), "tests/fixtures/manuals");

describe("parseManualProgressFromContent（纯函数）", () => {
  it("标准 in-progress 文件：done=2, total=6, nextStep=第三个未完成", () => {
    const content = `---
procedure: deliver-feature
domain: development
created: 2026-09-02T09:36:46.251Z
status: in-progress
args: p1-verify
---
# deliver-feature 实例
- [x] plan-implementation p1-verify — 规划路径
- [x] 按计划走 modify-* — 每步一个 commit
- [ ] 每个改动文件走 testing#add-test-for-change — 补回归测试
- [ ] testing#regression-verify — 全量回归
- [ ] testing#regression-verify — 全量回归（含发版就绪检查）
- [ ] ci-cd#release <version>
`;
    const p = parseManualProgressFromContent(content);
    expect(p).not.toBeNull();
    expect(p?.procedure).toBe("deliver-feature");
    expect(p?.status).toBe("in-progress");
    expect(p?.stepDone).toBe(2);
    expect(p?.stepTotal).toBe(6);
    expect(p?.nextStep).toBe("每个改动文件走 testing#add-test-for-change — 补回归测试");
  });

  it("completed 文件：done=total, nextStep=null", () => {
    const content = `---
procedure: deliver-feature
status: completed
---
- [x] step1
- [x] step2
- [x] step3
`;
    const p = parseManualProgressFromContent(content);
    expect(p?.status).toBe("completed");
    expect(p?.stepDone).toBe(3);
    expect(p?.stepTotal).toBe(3);
    expect(p?.nextStep).toBeNull();
  });

  it("无 frontmatter：procedure 兜底 (unknown)", () => {
    const content = `# 无 frontmatter
- [x] step1
- [ ] step2
`;
    const p = parseManualProgressFromContent(content);
    expect(p?.procedure).toBe("(unknown)");
    expect(p?.status).toBe("unknown");
    expect(p?.stepDone).toBe(1);
    expect(p?.stepTotal).toBe(2);
    expect(p?.nextStep).toBe("step2");
  });

  it("无任何 checklist：stepDone=0, stepTotal=0, nextStep=null", () => {
    const content = `---
procedure: empty
status: in-progress
---
# 无 step
`;
    const p = parseManualProgressFromContent(content);
    expect(p?.stepDone).toBe(0);
    expect(p?.stepTotal).toBe(0);
    expect(p?.nextStep).toBeNull();
  });
});

describe("parseManualProgress（文件 IO）", () => {
  it("in-progress fixture：done=2 total=6", async () => {
    const p = await parseManualProgress(join(FIX, "in-progress.md"));
    expect(p?.procedure).toBe("deliver-feature");
    expect(p?.status).toBe("in-progress");
    expect(p?.stepDone).toBe(2);
    expect(p?.stepTotal).toBe(6);
    expect(p?.nextStep).toBeTruthy();
  });

  it("completed fixture：done=total, nextStep=null", async () => {
    const p = await parseManualProgress(join(FIX, "completed.md"));
    expect(p?.status).toBe("completed");
    expect(p?.stepDone).toBe(p?.stepTotal);
    expect(p?.stepTotal).toBeGreaterThan(0);
    expect(p?.nextStep).toBeNull();
  });

  it("no-frontmatter fixture：procedure 兜底 (unknown)", async () => {
    const p = await parseManualProgress(join(FIX, "no-frontmatter.md"));
    expect(p?.procedure).toBe("(unknown)");
  });

  it("文件不存在 → null", async () => {
    const p = await parseManualProgress(join(FIX, "does-not-exist.md"));
    expect(p).toBeNull();
  });
});

describe("renderManualWidgetLines", () => {
  it("in-progress：3 行 + next 行", () => {
    const lines = renderManualWidgetLines("/x.md", {
      procedure: "deliver-feature",
      stepDone: 3,
      stepTotal: 6,
      status: "in-progress",
      nextStep: "step4 — 接下来",
    });
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("pt ▶ deliver-feature  step 3/6  (in-progress)");
    expect(lines[1]).toBe("  next: step4 — 接下来");
    expect(lines[2]).toBe("  file: /x.md");
  });

  it("completed：✓ done + 不显示 next 行", () => {
    const lines = renderManualWidgetLines("/x.md", {
      procedure: "deliver-feature",
      stepDone: 4,
      stepTotal: 4,
      status: "completed",
      nextStep: null,
    });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("pt ▶ deliver-feature  step 4/4  ✓ done");
    expect(lines[1]).toBe("  file: /x.md");
  });

  it("in-progress + nextStep=null：不显示 next 行", () => {
    const lines = renderManualWidgetLines("/x.md", {
      procedure: "deliver-feature",
      stepDone: 5,
      stepTotal: 5,
      status: "in-progress",
      nextStep: null,
    });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("pt ▶ deliver-feature  step 5/5  (in-progress)");
  });
});

describe("renderManualFooterSuffix", () => {
  it("in-progress → '· manual: <procedure> <done>/<total>'", () => {
    const s = renderManualFooterSuffix({
      procedure: "deliver-feature",
      stepDone: 3,
      stepTotal: 6,
      status: "in-progress",
      nextStep: null,
    });
    expect(s).toBe("· manual: deliver-feature 3/6");
  });

  it("completed → '· manual: <procedure> done'", () => {
    const s = renderManualFooterSuffix({
      procedure: "deliver-feature",
      stepDone: 4,
      stepTotal: 4,
      status: "completed",
      nextStep: null,
    });
    expect(s).toBe("· manual: deliver-feature done");
  });
});

describe("isManualActive", () => {
  it("文件存在 + in-progress → true", async () => {
    expect(await isManualActive(join(FIX, "in-progress.md"))).toBe(true);
  });

  it("文件存在 + completed → false", async () => {
    expect(await isManualActive(join(FIX, "completed.md"))).toBe(false);
  });

  it("文件不存在 → false", async () => {
    expect(await isManualActive(join(FIX, "nope.md"))).toBe(false);
  });
});
