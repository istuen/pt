// tests/verify/flows.test.ts — v9 适配：用 activeAdapter.listManuals() 列 Profile 引用域的手册（vitest）
//
// Phase 9.9：v9 适配。
//   - 用户面是 Profile（不是 Blueprint）—— Profile 引用 Blueprint + 选 Domains
//   - /pt flows 用 activeAdapter.listManuals()——更通用，无需直接遍历 IR

import { describe, it, expect } from "vitest";
import { loadAndTranspile } from "../../src/transpile.js";
import { getAgentAdapter } from "../../src/agent/index.js";

describe("Profile 触发手册（listManuals）", () => {
  it("pt-chat Profile 可触发手册", async () => {
    const r = await loadAndTranspile(process.cwd(), "pt-chat");
    const b = r.bundles[0];
    expect(b).toBeDefined();

    const profile = r.profile;
    const filteredDomains = b.domains.filter((d) => {
      if (profile.domains.includes(d.name)) return true;
      return profile.injectionPoints.some((ip) => ip.domains.includes(d.name));
    });

    const adapter = getAgentAdapter(r.blueprint.agent);
    const flows = adapter.listManuals?.(r.context, r.blueprint, filteredDomains) ?? [];
    expect(flows.length).toBeGreaterThan(0);
  });

  it("pt-dev Profile 可触发手册", async () => {
    const r = await loadAndTranspile(process.cwd(), "pt-dev");
    const b = r.bundles[0];
    expect(b).toBeDefined();

    const profile = r.profile;
    const filteredDomains = b.domains.filter((d) => {
      if (profile.domains.includes(d.name)) return true;
      return profile.injectionPoints.some((ip) => ip.domains.includes(d.name));
    });

    const adapter = getAgentAdapter(r.blueprint.agent);
    const flows = adapter.listManuals?.(r.context, r.blueprint, filteredDomains) ?? [];
    expect(flows.length).toBeGreaterThan(0);
  });
});
