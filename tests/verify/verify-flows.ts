import { loadAndTranspile } from "../../src/transpile.js";
for (const name of ["pt", "pt-dev", "glossary-test"]) {
  const r = await loadAndTranspile(process.cwd(), name);
  const b = r.bundles[0];
  const bp = b.blueprints.find(x => x.name === b.activeBlueprint);
  const flows: string[] = [];
  for (const dn of bp.domains) {
    const d = b.domains.find(x => x.name === dn);
    if (!d || d.type !== "workflow") continue;
    const tpls = (d.modules["Manual"] ?? []) as Array<{ name: string; argumentHint?: string }>;
    for (const t of tpls) flows.push(`  /${t.name} ${t.argumentHint ?? ""}  ← ${d.name}`);
  }
  console.log(`=== ${name} Blueprint 可触发手册 ===`);
  console.log(flows.length ? flows.join("\n") : "  (无 workflow-type Domain，无可触发手册)");
  console.log();
}
