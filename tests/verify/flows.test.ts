// tests/verify/flows.test.ts — v9 适配：用 activeAdapter.listManuals() 列 Profile 引用域的手册（vitest）
//
// Phase 9.9：v9 适配。
//   - 用户面是 Profile（不是 Blueprint）—— Profile 引用 Blueprint + 选 Domains
//   - /pt flows 用 activeAdapter.listManuals()——更通用，无需直接遍历 IR

import { describe, it, expect } from "vitest";
import { loadAndTranspile } from "../../src/transpile.js";
import { getAgentAdapter } from "../../src/agent/index.js";

describe("Profile 触发手册（listManuals）", () => {
  it("pt-design Profile 包含reference-manual注入点（Phase term-P9.2：Rules/Flows/Checklists 三段）", async () => {
    // pt-design 是设计型 profile（user-info + agent-info + product-design + asset-workflow + pt-collab + good-design）
    // —— 引用域含 good-design（有 ## Rules 段，16 条规范），Blueprint 的"reference-manual"注入点声明三段 schema。
    // 验证：listManuals 返非空（pt-design 引了含 Rules/Flows/Checklists 段的 domain）+ 注入点结构完整。
    // 不锁"返空"——profile domains 追加是正常演进，测试应跟资产走（issue pt-flows-test-brittle-empty-assertion）。
    const r = await loadAndTranspile(process.cwd(), "pt-design");
    const b = r.bundles[0];
    expect(b).toBeDefined();

    // v13.x（issue pt-turn-inject-not-profile-scoped）：adapter 持有 profile 后内部自过滤，
    // 测试传全集 domains + setAgentContext 存 profile，不再测试内联预过滤
    const adapter = getAgentAdapter({} as never, "pi");
    adapter.setAgentContext(r.agentContext, r.blueprint, b.domains, r.profile);
    const flows = adapter.listManuals?.(r.agentContext, r.blueprint, b.domains) ?? [];

    // 结构不变式：pt-design 至少引了一个含 Rules/Flows/Checklists 段的 domain
    expect(flows.length).toBeGreaterThan(0);

    // good-design 项的 name 格式契约（v18.x #7 防 regression）—— listManuals 的 term-Domain name 格式是 /pt_turn_inject <domain>
    // 找不到不 fail（profile 可能换 domain），跳过格式校验；找到则校验 name 格式
    const goodDesign = flows.find((f) => f.domain === "good-design");
    if (goodDesign) {
      expect(goodDesign.name).toMatch(/^\/pt_turn_inject good-design$/);
    }

    // Blueprint 注入点声明 inject=turn——modules 由 ProfileGroup 提供（v9.1）
    const manualIp = r.blueprint.groups.find((ip) => ip.name === "reference-manual");
    expect(manualIp?.inject).toBe("turn");
  });

  it("pt-dev Profile 可触发手册（含 dev-workflow/issue-workflow/release-workflow/testing-workflow 的 Flows + pt-quality 的 Rules + pt-collab 的 Checklists）", async () => {
    const r = await loadAndTranspile(process.cwd(), "pt-dev");
    const b = r.bundles[0];
    expect(b).toBeDefined();

    // v13.x（issue pt-turn-inject-not-profile-scoped）：adapter 持有 profile 后内部自过滤
    const adapter = getAgentAdapter({} as never, "pi");
    adapter.setAgentContext(r.agentContext, r.blueprint, b.domains, r.profile);
    const flows = adapter.listManuals?.(r.agentContext, r.blueprint, b.domains) ?? [];
    // pt-dev 包含 dev-workflow（Flows）+ pt-quality（Rules）+ pt-collab（Checklists）—— 至少 3 个手册项
    expect(flows.length).toBeGreaterThanOrEqual(3);
  });

  // v18.x（#7）：listManuals 的 term-Domain name 格式是 /pt_turn_inject <domain>（非 /manual:<domain>）
  // #1 改名遗留：原 code name 字段是 /manual:xxx，与 renderTurnInject dispatch 命令名 /pt_turn_inject 不一致——
  // 用户/LLM 看 /pt flows 输出 /manual:xxx 打这个命令会 passthrough 不触发注入。此断言防 regression（#7 闭合）。
  it("v18.x（#7）：listManuals 的 term-Domain name 格式是 /pt_turn_inject <domain>", async () => {
    const r = await loadAndTranspile(process.cwd(), "pt-dev");
    const b = r.bundles[0];
    expect(b).toBeDefined();

    const adapter = getAgentAdapter({} as never, "pi");
    adapter.setAgentContext(r.agentContext, r.blueprint, b.domains, r.profile);
    const flows = adapter.listManuals?.(r.agentContext, r.blueprint, b.domains) ?? [];

    // 找 term-Domain 项（hint 含"条规范"——pt-quality 的 Rules 段）
    const termDomain = flows.find((f) => typeof f.hint === "string" && f.hint.includes("条规范"));
    expect(termDomain).toBeDefined();
    expect(termDomain?.name).toMatch(/^\/pt_turn_inject \S+$/);
    expect(termDomain?.name).not.toMatch(/^\/manual:/); // 防回退

    // 全 listManuals 输出无 /manual: 残留
    const anyManual = flows.find((f) => f.name.startsWith("/manual:"));
    expect(anyManual).toBeUndefined();
  });
});
