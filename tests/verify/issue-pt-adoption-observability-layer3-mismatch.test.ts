// tests/verify/issue-pt-adoption-observability-layer3-mismatch.test.ts
// Layer 3 一致性校验的**故意改坏**路径（issue pt-adoption-observability §五 Layer 3）
//
// 验收标准（pt-layer3-plan §2.7）：「故意改坏注入（测试用）→ 校验能报出不一致」
//   —— 本测试用**真实捕获的 provider 请求体**（来自 lab 真机 run 的 system prompt 原文）
//      模拟三类破坏：截断 / 改写 / 段被移除，各自必须报 mismatch 或 not-found。
//
// 判据：
//   - 截断（段被腰斩）  → mismatch（expectedSha ≠ actualSha）
//   - 改写（段被替换）  → mismatch
//   - 段被移除          → not-found
//   - 完整（对照组）    → matched

import { describe, expect, it } from "vitest";
import {
  checkInjectionConsistency,
  extractInjectedSegment,
  locateInjectedSegment,
  PT_INJECT_MARKER,
  sha256,
} from "../../src/provider-trace.js";

/** 真实形状的 provider 请求体（baiduqianfan / openai-completions 形状，developer 角色）。 */
const REAL_SYSTEM = `You are a helpful assistant.

${PT_INJECT_MARKER}

- pt-quality-trigger: 改 schema 契约 / 增删字段或类型 / 改签名 / 重命名导出前，先查规范
  调 pt_inject tool domain=pt-quality 查看完整规范
  anti: 非 Pt 代码改动时（不触发 pt-quality 手册注入）

## 上一轮产出（Pt 记录）

- 涉及文件：src/schema.ts`;

/** Pt 侧记录的"我注入的内容"（= 标记后到下一个 H2 之前）。 */
const EXPECTED_SEGMENT = extractInjectedSegment(
  REAL_SYSTEM.slice(REAL_SYSTEM.indexOf(PT_INJECT_MARKER) + PT_INJECT_MARKER.length)
);

describe("L3-mismatch 故意改坏注入 → 校验能报出不一致", () => {
  it("对照组：完整未改 → matched", () => {
    const c = checkInjectionConsistency(EXPECTED_SEGMENT, REAL_SYSTEM);
    expect(c.status).toBe("matched");
    expect(c.expectedSha).toBe(c.actualSha);
  });

  it("截断：段被腰斩 → mismatch（expectedSha ≠ actualSha）", () => {
    const broken = REAL_SYSTEM.replace(
      "- pt-quality-trigger: 改 schema 契约 / 增删字段或类型 / 改签名 / 重命名导出前，先查规范",
      "- pt-quality-trigger: 改 schema 契约"
    );
    const c = checkInjectionConsistency(EXPECTED_SEGMENT, broken);
    expect(c.status).toBe("mismatch");
    expect(c.actualSha).not.toBe(c.expectedSha);
  });

  it("改写：段被替换成别的内容 → mismatch", () => {
    const broken = REAL_SYSTEM.replace(
      "先查规范（modules-type-safety、no-duplicate-type、naming-consistency、parse-extension-registry）",
      "先查规范（别的内容）"
    );
    const broken2 = broken.replace(
      "- pt-quality-trigger: 改 schema 契约 / 增删字段或类型 / 改签名 / 重命名导出前，先查规范\n  调 pt_inject tool domain=pt-quality 查看完整规范\n  anti: 非 Pt 代码改动时（不触发 pt-quality 手册注入）",
      "- 别的内容"
    );
    const c = checkInjectionConsistency(EXPECTED_SEGMENT, broken2);
    expect(c.status).toBe("mismatch");
  });

  it("段被移除（标记还在但内容空）→ not-found 或 mismatch", () => {
    const broken = REAL_SYSTEM.replace(
      `- pt-quality-trigger: 改 schema 契约 / 增删字段或类型 / 改签名 / 重命名导出前，先查规范
  调 pt_inject tool domain=pt-quality 查看完整规范
  anti: 非 Pt 代码改动时（不触发 pt-quality 手册注入）`,
      ""
    );
    const c = checkInjectionConsistency(EXPECTED_SEGMENT, broken);
    expect(["mismatch", "not-found"]).toContain(c.status);
  });

  it("整段连标记一起被删 → not-found", () => {
    const broken = REAL_SYSTEM.slice(0, REAL_SYSTEM.indexOf(PT_INJECT_MARKER));
    const c = checkInjectionConsistency(EXPECTED_SEGMENT, broken);
    expect(c.status).toBe("not-found");
    expect(c.actualSha).toBeNull();
    expect(c.expectedSha).toBe(sha256(EXPECTED_SEGMENT));
  });

  it("provider 改写 system prompt（整体替换）→ not-found", () => {
    const c = checkInjectionConsistency(EXPECTED_SEGMENT, "PROVIDER REPLACED EVERYTHING");
    expect(c.status).toBe("not-found");
  });

  it("段定位边界：H2 之后的回注段不计入 Pt 注入段", () => {
    const located = locateInjectedSegment(REAL_SYSTEM);
    expect(located).toBe(EXPECTED_SEGMENT);
    // 回注段（## 上一轮产出）不污染 sha
    expect(located).not.toContain("上一轮产出");
  });
});
