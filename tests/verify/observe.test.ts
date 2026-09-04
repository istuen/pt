// tests/verify/observe.test.ts — P0：observe 字段解析 + 渲染 + Manual 实例文档
import { describe, it, expect } from "vitest";
import { loadAndTranspile } from "../../src/transpile.js";
import { bindFlowTemplate, findFlowInBlueprint } from "../../src/render/context-message.js";
import { buildManualDoc } from "../../src/commands.js";
import { s } from "./session-fixtures.js";

describe("P0: observe 字段", () => {
  it("FlowStep.observe 被正确解析", async () => {
    const r = await loadAndTranspile(process.cwd(), "pt-dev");
    const b = r.bundles[0];
    const tpl = findFlowInBlueprint(r.blueprint, b.domains, "issue-lifecycle");
    expect(tpl).toBeDefined();
    // issue-lifecycle 的某个 step 有 observe（fixture 加了 [test-pass] 与 [ts-compiles, test-pass]）
    const hasObserve = tpl?.steps.some((s) => s.observe && s.observe.length > 0);
    expect(hasObserve).toBe(true);
    // desc 字段类型正确（向后兼容）
    expect(tpl?.steps.every((s) => typeof s.desc === "string")).toBe(true);
  });

  it("bindFlowTemplate 渲染 observe 子行", async () => {
    const r = await loadAndTranspile(process.cwd(), "pt-dev");
    const b = r.bundles[0];
    const tpl = findFlowInBlueprint(r.blueprint, b.domains, "issue-lifecycle");
    if (!tpl) throw new Error("issue-lifecycle not found");
    const bound = bindFlowTemplate(tpl, "");
    const hasObserveStep = tpl.steps.some((s) => s.observe?.length);
    expect(hasObserveStep).toBe(true);
    expect(bound).toContain("验证参照：");
    expect(bound).toContain("test-pass");
  });

  it("buildManualDoc 生成执行状态表", async () => {
    const r = await loadAndTranspile(process.cwd(), "pt-dev");
    s().cachedBundles = r.bundles;
    s().cachedBlueprint = r.blueprint;
    s().cachedContext = r.context;

    const doc = buildManualDoc(process.cwd(), s(), "issue-lifecycle", "test-issue");
    expect(doc.error).toBeUndefined();
    expect(doc.content).toContain("## 执行状态");
    expect(doc.content).toContain("| Step | Outcome | Message |");
    expect(doc.content).toContain("| — |");
  });

  it("无 observe 的 step 向后兼容", async () => {
    const r = await loadAndTranspile(process.cwd(), "pt-dev");
    const b = r.bundles[0];
    const tpl = findFlowInBlueprint(r.blueprint, b.domains, "issue-lifecycle");
    if (!tpl) throw new Error("issue-lifecycle not found");
    expect(tpl.steps.length).toBeGreaterThan(0);
    expect(tpl.steps.every((s) => typeof s.desc === "string")).toBe(true);
    // 渲染时不报错，且无 observe 时不输出验证参照行
    const bound = bindFlowTemplate(tpl, "demo-issue");
    // 无 observe 的 step 不会渲染该行（除非其它 step 有 observe）
    const hasAnyObserve = tpl.steps.some((s) => s.observe?.length);
    if (!hasAnyObserve) {
      expect(bound).not.toContain("验证参照：");
    }
  });
});
