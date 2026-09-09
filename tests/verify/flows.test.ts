// tests/verify/flows.test.ts — v9 适配：用 activeAdapter.listManuals() 列 Profile 引用域的手册（vitest）
//
// Phase 9.9：v9 适配。
//   - 用户面是 Profile（不是 Blueprint）—— Profile 引用 Blueprint + 选 Domains
//   - /pt flows 用 activeAdapter.listManuals()——更通用，无需直接遍历 IR

import { describe, it, expect } from "vitest";
import { loadAndTranspile } from "../../src/transpile.js";
import { getAgentAdapter } from "../../src/agent/index.js";

describe("Profile 触发手册（listManuals）", () => {
  it("pt-design Profile 包含参考手册注入点（Phase term-P9.2：Rules/Flows/Checklists 三段）", async () => {
    // pt-design 是设计型 profile（user-info + agent-info + product-design + asset-workflow + pt-collab）
    // —— 当前未含 Rules/Flows/Checklists 段内容，但 Blueprint 的"参考手册"注入点已声明三段 schema。
    // 验证：listManuals 返空（domain 没装手册内容时） + 注入点结构完整。
    const r = await loadAndTranspile(process.cwd(), "pt-design");
    const b = r.bundles[0];
    expect(b).toBeDefined();

    // v13.x（issue pt-turn-inject-not-profile-scoped）：adapter 持有 profile 后内部自过滤，
    // 测试传全集 domains + setAgentContext 存 profile，不再测试内联预过滤
    const adapter = getAgentAdapter({} as never, "pi");
    adapter.setAgentContext(r.agentContext, r.blueprint, b.domains, r.profile);
    const flows = adapter.listManuals?.(r.agentContext, r.blueprint, b.domains) ?? [];
    // pt-design 当前 domains 不含 Rules/Flows/Checklists 段内容——返空是预期
    expect(flows).toEqual([]);

    // Blueprint 注入点声明 inject=turn——modules 由 ProfileGroup 提供（v9.1）
    const manualIp = r.blueprint.groups.find((ip) => ip.name === "参考手册");
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
});
