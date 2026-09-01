import { loadAndTranspile } from "../../src/transpile.js";
for (const name of ["pt", "pt-dev", "glossary-test"]) {
  const r = await loadAndTranspile(process.cwd(), name);
  const b = r.bundles[0];
  const bp = b.blueprints.find(x => x.name === b.activeBlueprint);
  // v8：遍历 blueprint.injectionPoints 里所有含 domains 的注入点
  //     （一个 workflow-Domain 可能出现在多个注入点下，去重）
  const seen = new Set<string>();
  const flows: string[] = [];
  for (const ip of bp.injectionPoints) {
    for (const dn of ip.domains) {
      const d = b.domains.find(x => x.name === dn);
      if (!d || d.type !== "workflow") continue;
      const tpls = (d.modules["Manual"] ?? []) as Array<{ name: string; argumentHint?: string }>;
      for (const t of tpls) {
        if (seen.has(t.name)) continue;
        seen.add(t.name);
        flows.push(`  /${t.name} ${t.argumentHint ?? ""}  ← ${d.name}`);
      }
    }
  }
  console.log(`=== ${name} Blueprint 可触发手册 ===`);
  console.log(flows.length ? flows.join("\n") : "  (无 workflow-type Domain，无可触发手册)");
  console.log();
}
