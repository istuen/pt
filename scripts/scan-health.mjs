// scripts/scan-health.mjs — 发版前 multi-pack scan 健康检查
//
// 用法：npm run build && node scripts/scan-health.mjs
// 验证：对所有主要 profile 跑 scanProjectHealth，全 0 错误才算稳定。
//
// 解决：scan 是 verify 之外的体检层（commands.ts 的 /pt check tool 用）。
// verify 通过 ≠ scan 通过——scan 报 asset 配置问题，verify 报单测逻辑。
// 发版前两者都要过。

import { scanProjectHealth } from "../dist/asset-health.js";
import { loadAndTranspile } from "../dist/transpile.js";

const PROFILES = ["pt-dev", "pt-arch", "pt-devops", "pt-design", "guide"];
const cwd = process.cwd();

let totalIssues = 0;
const failedProfiles = [];

for (const profileName of PROFILES) {
  try {
    const r = await loadAndTranspile(cwd, profileName);
    const b = r.bundles[0];
    if (!b) {
      console.error(`❌ ${profileName}: loadAndTranspile 返回空`);
      failedProfiles.push(profileName);
      continue;
    }
    const report = await scanProjectHealth(
      cwd,
      b.profiles,
      b.blueprints,
      b.domains,
      b.packs,
      b.activeProfilePack || "prj",
      b.workingSet,
    );
    if (report.errors > 0 || report.warnings > 0) {
      console.error(`❌ ${profileName}: ${report.errors} errors, ${report.warnings} warnings`);
      for (const i of report.issues.filter((i) => i.severity !== "info")) {
        console.error(`   [${i.severity}] ${i.scope}「${i.name}」: ${i.msg}`);
      }
      failedProfiles.push(profileName);
      totalIssues += report.issues.length;
    } else {
      console.log(`✓ ${profileName}: clean (${report.issues.length} issues)`);
    }
  } catch (e) {
    console.error(`❌ ${profileName}: scan 抛错 — ${e instanceof Error ? e.message : String(e)}`);
    failedProfiles.push(profileName);
  }
}

console.log("");
if (failedProfiles.length === 0) {
  console.log(`✓ 所有 ${PROFILES.length} 个 profile scan 干净，可发版`);
  process.exit(0);
} else {
  console.error(`✗ ${failedProfiles.length} 个 profile scan 有问题（见上）`);
  process.exit(1);
}
