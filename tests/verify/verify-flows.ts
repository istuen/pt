// tests/verify/verify-flows.ts — v9 适配：用 activeAdapter.listManuals() 列 Profile 引用域的手册
//
// Phase 9.9：v9 适配。
//   - 用户面是 Profile（不是 Blueprint）—— Profile 引用 Blueprint + 选 Domains
//   - /pt flows 用 activeAdapter.listManuals()——更通用，无需直接遍历 IR

import { loadAndTranspile } from "../../src/transpile.js";
import { getAgentAdapter } from "../../src/agent/index.js";

for (const name of ["pt", "pt-dev", "glossary-test"]) {
  const r = await loadAndTranspile(process.cwd(), name);
  const b = r.bundles[0];
  if (!b) {
    console.log(`=== ${name} Profile 可触发手册 ===`);
    console.log("  (无 bundle)");
    console.log();
    continue;
  }

  // listManuals 需 Profile 范围过滤：只取 Profile.domains + Profile.injectionPoints[].domains 里的域
  const profile = r.profile;
  const filteredDomains = b.domains.filter((d) => {
    if (profile.domains.includes(d.name)) return true;
    return profile.injectionPoints.some((ip) => ip.domains.includes(d.name));
  });

  const adapter = getAgentAdapter(r.blueprint.agent);
  const flows = adapter.listManuals?.(r.context, r.blueprint, filteredDomains) ?? [];
  console.log(`=== ${name} Profile 可触发手册 ===`);
  if (flows.length === 0) {
    console.log("  (无 workflow-type Domain，无可触发手册)");
  } else {
    for (const f of flows) {
      console.log(`  /${f.name} ${f.hint ?? ""}  ← ${f.domain}`);
    }
  }
  console.log();
}