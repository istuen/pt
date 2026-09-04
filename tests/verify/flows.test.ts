// tests/verify/flows.test.ts — v9 适配：用 activeAdapter.listManuals() 列 Profile 引用域的手册（vitest）
//
// Phase 9.9：v9 适配。
//   - 用户面是 Profile（不是 Blueprint）—— Profile 引用 Blueprint + 选 Domains
//   - /pt flows 用 activeAdapter.listManuals()——更通用，无需直接遍历 IR

import { describe, it, expect } from "vitest";
import { loadAndTranspile } from "../../src/transpile.js";
import { getAgentAdapter } from "../../src/agent/index.js";

describe("Profile 触发手册（listManuals）", () => {
  it("pt-chat Profile 包含参考手册注入点（Phase term-P9.2：Rules/Flows/Checklists 三段）", async () => {
    // pt-chat 是会话型 profile（me + product-design + asset-workflow）—— 当前未含 Rules/Flows/Checklists
    // 段内容，但 Blueprint 的"参考手册"注入点已声明三段 schema。
    // 验证：listManuals 返空（domain 没装手册内容时） + 注入点结构完整。
    const r = await loadAndTranspile(process.cwd(), "pt-chat");
    const b = r.bundles[0];
    expect(b).toBeDefined();

    const profile = r.profile;
    const filteredDomains = b.domains.filter((d) => {
      if (profile.domains.includes(d.name)) return true;
      return profile.injectionPoints.some((ip) => ip.domains.includes(d.name));
    });

    const adapter = getAgentAdapter({} as never, "pi");
    const flows = adapter.listManuals?.(r.agentContext, r.blueprint, filteredDomains) ?? [];
    // pt-chat 当前 domains 不含 Rules/Flows/Checklists 段内容——返空是预期
    expect(flows).toEqual([]);

    // Blueprint 注入点声明三段 schema（Phase term-P9.2）
    const manualIp = r.blueprint.injectionPoints.find((ip) => ip.name === "参考手册");
    expect(manualIp?.modules).toContain("Rules");
    expect(manualIp?.modules).toContain("Flows");
    expect(manualIp?.modules).toContain("Checklists");
  });

  it("pt-dev Profile 可触发手册（含 dev-workflow/issue-workflow/release-workflow/testing-workflow 的 Flows + pt-quality 的 Rules + pt-collab 的 Checklists）", async () => {
    const r = await loadAndTranspile(process.cwd(), "pt-dev");
    const b = r.bundles[0];
    expect(b).toBeDefined();

    const profile = r.profile;
    const filteredDomains = b.domains.filter((d) => {
      if (profile.domains.includes(d.name)) return true;
      return profile.injectionPoints.some((ip) => ip.domains.includes(d.name));
    });

    const adapter = getAgentAdapter({} as never, "pi");
    const flows = adapter.listManuals?.(r.agentContext, r.blueprint, filteredDomains) ?? [];
    // pt-dev 包含 dev-workflow（Flows）+ pt-quality（Rules）+ pt-collab（Checklists）—— 至少 3 个手册项
    expect(flows.length).toBeGreaterThanOrEqual(3);
  });
});
