// scripts/verify-narrative.ts — 定位改写验收：核验新叙事真实进入 Session Inject 产物
//
// 用法：npx tsx scripts/verify-narrative.ts [profile]
// 验收依据：docs/issues/pt-repositioning-context-configurator.md §四 第 5 条

import { loadAndTranspile } from "../src/transpile.js";

const profile = process.argv[2] ?? "pt-design";
const r = await loadAndTranspile(process.cwd(), profile);
const seg = r.segment ?? "";

// builtin guide/mentor profile 不聚合项目级 product-design 域（无「三段式」H3），
// 故依赖该域的两组断言仅在聚合了该项目域的 profile 上生效
const hasProductDesign = seg.includes("三段式");

const checks: [string, boolean][] = [
  ["pt-goal 定位句 = 异构上下文配置器", seg.includes("异构上下文配置器")],
  ["旧定位「异构上下文编译器」已消失", !seg.includes("异构上下文编译器")],
  ["H3 已改名 = 三段式装配流水线", !hasProductDesign || seg.includes("三段式装配流水线")],
  ["H3 旧名「三段式编译架构」已消失", !seg.includes("三段式编译架构")],
  ["phase9 token：parse 保留", !hasProductDesign || seg.includes("parse")],
  ["phase9 token：compile 保留", !hasProductDesign || seg.includes("compile")],
  ["phase9 token：render 保留", !hasProductDesign || seg.includes("render")],
];

console.log(`profile=${profile}  segment 长度=${seg.length}  含 product-design 域=${hasProductDesign}`);
for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
const bad = checks.filter(([, ok]) => !ok);
console.log(bad.length === 0 ? "\n全部通过" : `\n失败 ${bad.length} 项`);
process.exit(bad.length === 0 ? 0 : 1);
