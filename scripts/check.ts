// /pt check 复刻：与 src/commands/pt.ts 中 /pt info lint 分支同路径
import { loadAndTranspile } from "../src/transpile.js";
import { scanProjectHealth, formatHealthSummary } from "../src/asset-health.js";
import { checkAllRefs, formatRefCheckResult } from "../src/verify/ref-check.js";

const cwd = process.argv[2];
if (!cwd) throw new Error("usage: tsx scripts/check.ts <cwd>");

const r = await loadAndTranspile(cwd, "");
const b = r.bundles[0];
const report = await scanProjectHealth(
  cwd,
  b.profiles,
  b.blueprints,
  b.domains,
  b.packs,
  b.activeProfilePack,
  b.workingSet,
  {}
);
const refs = checkAllRefs(b.profiles, b.blueprints, b.domains, {
  domainWS: b.workingSet.domains,
  packNames: b.packs.map((p) => p.name),
});
const merged = `${formatHealthSummary(report)}\n\n${formatRefCheckResult(refs)}`;
console.log(merged);
if (report.errors > 0 || refs.errors.length > 0) process.exitCode = 1;
