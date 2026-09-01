// tests/verify/verify-phase77.ts — Phase 8.8 v8 完整回归验证
//
// v8 资产重构：
// - Channel H2 = 注入点（会话知识/对话记忆）
// - Blueprint 按注入点选 Domain
// - Context 文件 H2 = 注入点名（不再 Scene/Manual）
// - 新增 pt-quality Domain（9 条技术规范）

import { loadAndTranspile } from "../../src/transpile.js";
import { readdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";

const cwd = process.cwd();

async function main() {
  console.log("=== Phase 8.8 完整回归验证（v8 模型）===\n");

  let failed = 0;
  function check(name: string, ok: boolean, desc: string) {
    console.log(`  ${ok ? "✅" : "❌"} ${name}: ${desc}`);
    if (!ok) failed++;
  }

  // ========== 1. 三个 Blueprint 产物 + v8 注入点 H2 ==========
  console.log("--- 1. 三 Blueprint 产物（pt / pt-dev / glossary-test）---");
  const scenes = ["pt", "pt-dev", "glossary-test"];
  const results: Record<string, string> = {};
  const cacheHitMap: Record<string, boolean> = {};
  for (const name of scenes) {
    const r = await loadAndTranspile(cwd, name);
    results[name] = r.segment;
    cacheHitMap[name] = r.cacheHit;
    console.log(`    ${name}: ${r.segment.length} chars, cacheHit=${r.cacheHit}`);
  }

  // 1a. pt Blueprint 产物的 Context 来自 system_prompt 注入点 → 拼到 segment
  check("pt Blueprint 含 v8 措辞",
    results["pt"].includes("parse") && results["pt"].includes("compile") && results["pt"].includes("render"),
    "含 parse/compile/render 三个 v7/v8 层名");

  // 1b. pt-dev Blueprint 含开发流程
  check("pt-dev Blueprint 含开发流程",
    results["pt-dev"].includes("modify-schema") || results["pt-dev"].includes("pt-dev-flow"),
    "含 pt-dev-flow 步骤名");
  check("pt-dev Blueprint 不含业务",
    !results["pt-dev"].includes("客户") && !results["pt-dev"].includes("订单"),
    "无业务示例污染");

  // ========== 2. Context 缓存命中 ==========
  console.log("\n--- 2. Context 缓存命中 ---");
  // 第二次加载（应命中）
  const r2 = await loadAndTranspile(cwd, "pt");
  check("pt 二次加载命中缓存", r2.cacheHit, `cacheHit=${r2.cacheHit}`);
  check("缓存命中后 segment 一致", results.pt === r2.segment, `match=${results.pt === r2.segment}`);

  // ========== 3. Channel 复用 ==========
  console.log("\n--- 3. Channel 复用 ---");
  const bpsWithChannel = await Promise.all(
    (await readdir(join(cwd, ".pt/assets/blueprints"))).map(async (f) => {
      if (!f.endsWith(".blueprint.md")) return null;
      const raw = await readFile(join(cwd, ".pt/assets/blueprints", f), "utf8");
      const m = raw.match(/^## Channel\r?\n\r?\n(.+)/m);
      return { name: f.replace(".blueprint.md", ""), channel: m ? m[1].trim() : "" };
    }),
  );
  const valid = bpsWithChannel.filter((x): x is { name: string; channel: string } => x !== null);
  const channelCount: Record<string, number> = {};
  for (const b of valid) {
    channelCount[b.channel] = (channelCount[b.channel] ?? 0) + 1;
  }
  console.log(`    Channel 引用统计: ${JSON.stringify(channelCount)}`);
  const reusable = Object.entries(channelCount).filter(([, n]) => n >= 2);
  check("dev-knowledge 被 ≥2 个 Blueprint 引用",
    reusable.some(([ch]) => ch === "dev-knowledge"),
    `dev-knowledge 引用数=${channelCount["dev-knowledge"] ?? 0}`);

  // ========== 4. 扩展性：glossary 假 type 仍能渲染 ==========
  console.log("\n--- 4. 扩展性验证：glossary 假 type ---");
  const rGloss = await loadAndTranspile(cwd, "glossary-test");
  const hasGlossary = rGloss.segment.includes("术语表") || rGloss.segment.includes("GlossaryEntry");
  check("glossary-test scene 含 glossary 段", hasGlossary, `glossary 段出现=${hasGlossary} (${rGloss.segment.length} chars)`);
  // 不污染 pt scene
  const rPt = await loadAndTranspile(cwd, "pt");
  check("pt scene 不污染", !rPt.segment.includes("GlossaryEntry"), `pt=${rPt.segment.length} chars, 含 glossary=${rPt.segment.includes("GlossaryEntry")}`);

  // ========== 5. v8 注入点 H2（Context 文件） ==========
  console.log("\n--- 5. v8 注入点 H2 出现在 Context 文件中 ---");
  const cacheFiles = await readdir(join(cwd, ".pt/contexts/cache"));
  for (const f of ["pt-dev.context.md"]) {
    const raw = await readFile(join(cwd, ".pt/contexts/cache", f), "utf8");
    const hasHuiHuaZhiShi = /^## 会话知识/m.test(raw);
    const hasDuiHuaJiYi = /^## 对话记忆/m.test(raw);
    const noSceneManual = !/^## Scene\b/m.test(raw) && !/^## Manual\b/m.test(raw);
    check(`${f} 含 ## 会话知识`, hasHuiHuaZhiShi, `H2 会话知识出现=${hasHuiHuaZhiShi}`);
    check(`${f} 含 ## 对话记忆`, hasDuiHuaJiYi, `H2 对话记忆出现=${hasDuiHuaJiYi}`);
    check(`${f} 不含 ## Scene / ## Manual`, noSceneManual, `旧 H2 残留=${!noSceneManual}`);
  }

  // ========== 6. pt-quality 进 pt-dev 对话记忆 ==========
  console.log("\n--- 6. pt-quality Domain 进 pt-dev 对话记忆注入点 ---");
  const ptDevCtx = await readFile(join(cwd, ".pt/contexts/cache/pt-dev.context.md"), "utf8");
  const duiHuaIdx = ptDevCtx.indexOf("## 对话记忆");
  const huiHuaIdx = ptDevCtx.indexOf("## 会话知识");
  const qualityIdx = ptDevCtx.indexOf("pt-quality」");
  // 找 ## 对话记忆 之后的下一个 H2（行首的 ## ）
  let nextH2AfterDuihua = ptDevCtx.length;
  const re = /^## /gm;
  re.lastIndex = duiHuaIdx + 1;
  const m = re.exec(ptDevCtx);
  if (m) nextH2AfterDuihua = m.index;
  const inContextMemory = qualityIdx > duiHuaIdx && qualityIdx < nextH2AfterDuihua;
  // 找 ## 会话知识 之后的下一个 H2，pt-quality 必须不在其中
  let nextH2AfterHuihua = ptDevCtx.length;
  re.lastIndex = huiHuaIdx + 1;
  const m2 = re.exec(ptDevCtx);
  if (m2) nextH2AfterHuihua = m2.index;
  const notInSystemPrompt = qualityIdx < huiHuaIdx || qualityIdx > nextH2AfterHuihua;
  check("pt-quality 段出现在 pt-dev 对话记忆注入点",
    inContextMemory,
    `pt-quality idx=${qualityIdx}, 对话记忆 idx=${duiHuaIdx}, 下一H2 idx=${nextH2AfterDuihua}`);
  check("pt-quality 不污染 pt-dev 会话知识注入点",
    notInSystemPrompt,
    `pt-quality 仅贡献对话记忆`);

  // ========== 7. 三 mode 验证（用 dev-knowledge channel） ==========
  console.log("\n--- 7. 三 mode 产物结构差异（byDomain / byType / hybrid）---");
  const channelPath = join(cwd, ".pt/assets/channels/dev-knowledge.channel.md");
  const channelOrig = await readFile(channelPath, "utf8");
  const modes = ["byDomain", "byType", "hybrid"] as const;
  const modeResults: Record<string, string> = {};
  try {
    for (const mode of modes) {
      // 替换 ## 会话知识 下的 mode: <...>
      const replaced = channelOrig.replace(/(## 会话知识[\s\S]*?mode:\s*)\w+/m, `$1${mode}`);
      await writeFile(channelPath, replaced, "utf8");
      // 强制重编译：删 pt 的 cache
      try { await writeFile(join(cwd, ".pt/contexts/cache/pt.context.md"), ""); } catch {}
      const r = await loadAndTranspile(cwd, "pt");
      modeResults[mode] = r.segment;
      console.log(`    ${mode}: ${r.segment.length} chars`);
    }
  } finally {
    await writeFile(channelPath, channelOrig, "utf8");
  }
  const byDomainHasModule = modeResults.byDomain.includes("模块「");
  const byTypeHasAggregated = modeResults.byType.includes("业务术语") || modeResults.byType.includes("业务规则");
  const hybridHasGlobal = modeResults.hybrid.includes("全局约束");
  check("byDomain 含 ### 模块 段", byDomainHasModule, "byDomain 段存在");
  check("byType 含 ### 业务术语/业务规则", byTypeHasAggregated, "byType 聚合段存在");
  check("hybrid 含 ### 全局约束 段", hybridHasGlobal, "hybrid 全局段存在");

  // ========== 8. Context 缓存文件落盘 ==========
  console.log("\n--- 8. Context 缓存文件落盘 ---");
  const finalCacheFiles = await readdir(join(cwd, ".pt/contexts/cache"));
  const expectedCaches = ["pt.context.md", "pt-dev.context.md", "glossary-test.context.md"];
  for (const f of expectedCaches) {
    check(`${f} 已落盘`, finalCacheFiles.includes(f), `cache dir has ${f}`);
  }

  // ========== 总评 ==========
  console.log(`\n=== ${failed === 0 ? "✅ 全部通过" : `❌ ${failed} 项失败`} ===`);
  if (failed > 0) process.exit(1);
}
main().catch(e => { console.error(e); process.exit(1); });
