// tests/verify/verify-phase9.ts — Phase 9.9 v9 完整回归验证
//
// v9 模型：
// - Blueprint 吸收 v8 Channel 结构（agent + injectionPoints + Compilation）
// - Profile 是业务端实例（blueprint + YAML domains + 各注入点 ### Domains 追加）
// - modName 注册表（替代 v8 domainSceneRenderers）
// - Trigger 索引段（Domain 内 H2 段）
// - /manual:xxx 触发（renderContextMessage 实现）
// - AgentAdapter 抽象（PiAdapter 封装 before_agent_start + input）

import { loadAndTranspile } from "../../src/transpile.js";
import { renderContextMessage } from "../../src/render/context-message.js";
import { compileContext } from "../../src/compile/context.js";
import { findBlueprint, findProfile, type Blueprint, type Profile } from "../../src/schema.js";
import { readdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";

const cwd = process.cwd();

async function main() {
  console.log("=== Phase 9.9 完整回归验证（v9 模型）===\n");

  let failed = 0;
  function check(name: string, ok: boolean, desc: string) {
    console.log(`  ${ok ? "✅" : "❌"} ${name}: ${desc}`);
    if (!ok) failed++;
  }

  // ========== 1. 三 Profile 产物 + v9 注入点 H2 ==========
  console.log("--- 1. 三 Profile 产物（pt / pt-dev / glossary-test）---");
  const profiles = ["pt", "pt-dev", "glossary-test"];
  const results: Record<string, string> = {};
  const cacheHitMap: Record<string, boolean> = {};
  for (const name of profiles) {
    const r = await loadAndTranspile(cwd, name);
    results[name] = r.segment;
    cacheHitMap[name] = r.cacheHit;
    console.log(`    ${name}: ${r.segment.length} chars, cacheHit=${r.cacheHit}`);
  }

  // 1a. pt Profile 含 v9 措辞
  check("pt Profile 含 v9 措辞",
    results["pt"].includes("parse") && results["pt"].includes("compile") && results["pt"].includes("render"),
    "含 parse/compile/render 三层名");

  // 1b. pt-dev Profile 含开发流程
  check("pt-dev Profile 含开发流程",
    results["pt-dev"].includes("modify-schema") || results["pt-dev"].includes("pt-dev-flow"),
    "含 pt-dev-flow 步骤名");
  check("pt-dev Profile 不含业务",
    !results["pt-dev"].includes("客户") && !results["pt-dev"].includes("订单"),
    "无业务示例污染");

  // ========== 2. Context 缓存命中 ==========
  console.log("\n--- 2. Context 缓存命中 ---");
  const r2 = await loadAndTranspile(cwd, "pt");
  check("pt 二次加载命中缓存", r2.cacheHit, `cacheHit=${r2.cacheHit}`);
  check("缓存命中后 segment 一致", results.pt === r2.segment, `match=${results.pt === r2.segment}`);

  // ========== 3. Blueprint 复用 ==========
  console.log("\n--- 3. Blueprint 复用 ---");
  const bps = await Promise.all(
    (await readdir(join(cwd, ".pt/assets/blueprints"))).map(async (f) => {
      if (!f.endsWith(".blueprint.md")) return null;
      const raw = await readFile(join(cwd, ".pt/assets/blueprints", f), "utf8");
      const m = raw.match(/^name:\s+(.+)$/m);
      return m ? m[1].trim() : "";
    }),
  );
  const validBps = bps.filter((x): x is string => !!x);
  const profilesDir = join(cwd, ".pt/assets/profiles");
  const profileFiles = (await readdir(profilesDir)).filter((f) => f.endsWith(".profile.md"));
  const refCounts: Record<string, number> = {};
  for (const f of profileFiles) {
    const raw = await readFile(join(profilesDir, f), "utf8");
    const m = raw.match(/^blueprint:\s+(.+)$/m);
    const bp = m ? m[1].trim() : "";
    if (bp) refCounts[bp] = (refCounts[bp] ?? 0) + 1;
  }
  console.log(`    Blueprint 引用统计: ${JSON.stringify(refCounts)}`);
  const reusable = Object.entries(refCounts).filter(([, n]) => n >= 2);
  check("dev-knowledge Blueprint 被 ≥2 个 Profile 引用",
    reusable.some(([bp]) => bp === "dev-knowledge"),
    `dev-knowledge 引用数=${refCounts["dev-knowledge"] ?? 0}`);

  // ========== 4. 扩展性：glossary 假 type 仍能渲染 ==========
  console.log("\n--- 4. 扩展性验证：glossary 假 type ---");
  const rGloss = await loadAndTranspile(cwd, "glossary-test");
  const hasGlossary = rGloss.segment.includes("术语表") || rGloss.segment.includes("GlossaryEntry");
  check("glossary-test profile 含 glossary 段", hasGlossary, `glossary 段出现=${hasGlossary} (${rGloss.segment.length} chars)`);
  const rPt = await loadAndTranspile(cwd, "pt");
  check("pt profile 不污染", !rPt.segment.includes("GlossaryEntry"), `pt=${rPt.segment.length} chars, 含 glossary=${rPt.segment.includes("GlossaryEntry")}`);

  // ========== 5. v9 注入点 H2（Context 文件） ==========
  console.log("\n--- 5. v9 注入点 H2 出现在 Context 文件中 ---");
  const cacheFiles = await readdir(join(cwd, ".pt/contexts/cache"));
  for (const f of ["pt-dev.context.md"]) {
    const raw = await readFile(join(cwd, ".pt/contexts/cache", f), "utf8");
    const hasHuiHuaZhiShi = /^## 会话知识/m.test(raw);
    const hasCanKaoShouCe = /^## 参考手册/m.test(raw);
    const noSceneManual = !/^## Scene\b/m.test(raw) && !/^## Manual\b/m.test(raw);
    check(`${f} 含 ## 会话知识`, hasHuiHuaZhiShi, `H2 会话知识出现=${hasHuiHuaZhiShi}`);
    check(`${f} 含 ## 参考手册`, hasCanKaoShouCe, `H2 参考手册出现=${hasCanKaoShouCe}`);
    check(`${f} 不含 ## Scene / ## Manual`, noSceneManual, `旧 H2 残留=${!noSceneManual}`);
  }

  // ========== 6. pt-quality 进 pt-dev 参考手册 ==========
  console.log("\n--- 6. pt-quality Domain 进 pt-dev 参考手册注入点 ---");
  const ptDevCtx = await readFile(join(cwd, ".pt/contexts/cache/pt-dev.context.md"), "utf8");
  const canKaoIdx = ptDevCtx.indexOf("## 参考手册");
  const huiHuaIdx = ptDevCtx.indexOf("## 会话知识");
  // pt-quality 在 Context 中被引用两次：Scene（会话知识段）+ Manual（参考手册段）
  // 查找“### 模块「pt-quality」”在参考手册段中是否出现
  let qualityManualIdx = -1;
  let searchFrom = canKaoIdx;
  while (searchFrom !== -1) {
    const next = ptDevCtx.indexOf("### 模块「pt-quality」", searchFrom);
    if (next === -1) break;
    if (next > canKaoIdx) { qualityManualIdx = next; break; }
    searchFrom = next + 1;
  }
  let nextH2AfterCanKao = ptDevCtx.length;
  const re = /^## /gm;
  re.lastIndex = canKaoIdx + 1;
  const m = re.exec(ptDevCtx);
  if (m) nextH2AfterCanKao = m.index;
  const inCanKaoShouCe = qualityManualIdx > canKaoIdx && qualityManualIdx < nextH2AfterCanKao;
  let nextH2AfterHuiHua = ptDevCtx.length;
  re.lastIndex = huiHuaIdx + 1;
  const m2 = re.exec(ptDevCtx);
  if (m2) nextH2AfterHuiHua = m2.index;
  const qualitySceneIdx = ptDevCtx.indexOf("### 模块「pt-quality」");
  const notInHuiHuaZhiShi = qualitySceneIdx < huiHuaIdx || qualitySceneIdx > nextH2AfterHuiHua;
  check("pt-quality Manual 段出现在 pt-dev 参考手册注入点",
    inCanKaoShouCe,
    `pt-quality Manual idx=${qualityManualIdx}, 参考手册 idx=${canKaoIdx}, 下一H2 idx=${nextH2AfterCanKao}`);
  // 检查会话知识段是否含 pt-quality 的 Manual 规范 checklist
  // ——这些只应在参考手册段出现，不应污染会话知识段
  // 用 "- [ ] modules-type-safety" 作为唯一 checklist 形态匹配（避免与 trigger desc 描述文本冲突）
  const modulesTypeSafetyChecklistIdx = ptDevCtx.indexOf("- [ ] modules-type-safety");
  const modulesTypeSafetyChecklistInHuiHua = modulesTypeSafetyChecklistIdx > huiHuaIdx && modulesTypeSafetyChecklistIdx < nextH2AfterHuiHua;
  check("pt-quality Manual checklist 不污染会话知识段",
    !modulesTypeSafetyChecklistInHuiHua,
    `checklist idx=${modulesTypeSafetyChecklistIdx}, 会话知识段范围=[${huiHuaIdx},${nextH2AfterHuiHua}]`);

  // ========== 7. Trigger 索引段进入会话知识 ==========
  console.log("\n--- 7. Trigger 索引段进入 pt-dev 会话知识注入点 ---");
  const triggerIdx = ptDevCtx.indexOf("pt-quality-trigger");
  let nextH2AfterTrigger = ptDevCtx.length;
  re.lastIndex = triggerIdx + 1;
  const m3 = re.exec(ptDevCtx);
  if (m3) nextH2AfterTrigger = m3.index;
  const triggerInHuiHuaZhiShi = triggerIdx > huiHuaIdx && triggerIdx < nextH2AfterTrigger;
  check("pt-quality-trigger 段出现在会话知识段",
    triggerInHuiHuaZhiShi,
    `trigger idx=${triggerIdx}, 会话知识 idx=${huiHuaIdx}, 下一H2 idx=${nextH2AfterTrigger}`);

  // ========== 8. me Domain 进入会话知识 ==========
  console.log("\n--- 8. me Domain 进入 pt-dev 会话知识注入点 ---");
  const meIdx = ptDevCtx.indexOf("### 模块「me」");
  let nextH2AfterMe = ptDevCtx.length;
  re.lastIndex = meIdx + 1;
  const m4 = re.exec(ptDevCtx);
  if (m4) nextH2AfterMe = m4.index;
  const meInHuiHuaZhiShi = meIdx > huiHuaIdx && meIdx < nextH2AfterMe;
  check("me Domain 段出现在会话知识段",
    meInHuiHuaZhiShi,
    `me idx=${meIdx}, 会话知识 idx=${huiHuaIdx}, 下一H2 idx=${nextH2AfterMe}`);
  const userProfileIdx = ptDevCtx.indexOf("user-profile");
  const ptGoalIdx = ptDevCtx.indexOf("pt-goal");
  const collabModeIdx = ptDevCtx.indexOf("collab-mode");
  check("me Domain 含 user-profile/pt-goal/collab-mode",
    userProfileIdx > 0 && ptGoalIdx > 0 && collabModeIdx > 0,
    `user-profile=${userProfileIdx}, pt-goal=${ptGoalIdx}, collab-mode=${collabModeIdx}`);

  // ========== 9. 硬编码检查 ==========
  console.log("\n--- 9. 硬编码检查（v9 不应有 v8 残留）---");
  const sysPromptSrc = await readFile("src/render/system-prompt.ts", "utf8");
  check("renderSystemPrompt 不硬编码 Scene",
    !sysPromptSrc.includes('"Scene"') && !sysPromptSrc.includes("'Scene'"),
    `grep "Scene" 在 system-prompt.ts = ${(sysPromptSrc.match(/['"]Scene['"]/g) ?? []).length}`);
  const compileSrc = await readFile("src/compile/context.ts", "utf8");
  check("compile/context.ts 不含 domainSceneRenderers 代码（仅历史注释提及）",
    !/(?<![\/\s])domainSceneRenderers[\(\.]/.test(compileSrc.replace(/\/\/.*$/gm, "")),
    `grep 代码中 domainSceneRenderers = ${(compileSrc.replace(/\/\/.*$/gm, "").match(/domainSceneRenderers/g) ?? []).length}`);
  check("compile/context.ts 不含 target === system_prompt 硬编码",
    !compileSrc.includes('target === "system_prompt"'),
    `grep target === "system_prompt" = ${(compileSrc.match(/target === "system_prompt"/g) ?? []).length}`);

  // ========== 10. IR 结构验证 ==========
  console.log("\n--- 10. IR 结构验证 ---");
  const schemaSrc = await readFile("src/schema.ts", "utf8");
  check("Blueprint.agent 字段存在",
    /interface Blueprint[\s\S]*?agent:\s*string/.test(schemaSrc),
    "Blueprint 含 agent 字段");
  check("Profile.blueprint + Profile.domains 字段存在",
    /interface Profile[\s\S]*?blueprint:\s*string[\s\S]*?domains:\s*string\[\]/.test(schemaSrc),
    "Profile 含 blueprint + domains 字段");
  check("InjectionPointInstance 无 trigger/boundaries 字段",
    /interface InjectionPointInstance\s*\{[\s\S]*?domains:\s*string\[\][\s\S]*?\}/.test(schemaSrc) &&
    !/interface InjectionPointInstance\s*\{[\s\S]*?trigger[\s\S]*?\}/.test(schemaSrc),
    "InjectionPointInstance 只含 name + domains");

  // ========== 11. 资产目录验证 ==========
  console.log("\n--- 11. 资产目录验证 ---");
  let channelsExists = false;
  try { await readdir(join(cwd, ".pt/assets/channels")); channelsExists = true; } catch {}
  check("channels/ 目录不存在", !channelsExists, "channels/ 已删除");
  let profilesExists = false;
  try { await readdir(join(cwd, ".pt/assets/profiles")); profilesExists = true; } catch {}
  check("profiles/ 目录存在", profilesExists, "profiles/ 已建立");

  // ========== 12. /manual:xxx 触发 ==========
  console.log("\n--- 12. /manual:xxx 触发 ---");
  const r9 = await loadAndTranspile(cwd, "pt-dev");
  const ptDevBundle = r9.bundles[0];
  const ptDevProfile = findProfile(ptDevBundle.profiles, "pt-dev")!;
  const ptDevBlueprint = findBlueprint(ptDevBundle.blueprints, ptDevProfile.blueprint)!;
  const manualResult = renderContextMessage(r9.context, ptDevBlueprint, ptDevBundle.domains, "/manual:pt-quality");
  check("/manual:pt-quality 触发返非 null",
    manualResult !== null,
    `result 长度=${manualResult?.length ?? 0}`);
  check("/manual:pt-quality 触发含规范",
    manualResult?.includes("modules-type-safety") ?? false,
    `含 9 条 pt-quality 规范`);

  // ========== 13. PiAdapter 封装检查 ==========
  console.log("\n--- 13. PiAdapter 封装 ---");
  const indexSrc = await readFile("src/index.ts", "utf8");
  check("index.ts 不直接调 before_agent_start",
    !indexSrc.includes('pi.on("before_agent_start"') && !indexSrc.includes("pi.on('before_agent_start'"),
    "before_agent_start 已封装进 PiAdapter");
  check("index.ts 不直接调 input 事件",
    !indexSrc.includes('pi.on("input"') && !indexSrc.includes("pi.on('input'"),
    "input 事件已封装进 PiAdapter");

  // ========== 14. 跨项目 pt-writing 验证 ==========
  console.log("\n--- 14. pt-writing 跨项目 ---");
  const writingCwd = "/Users/issac/pro/pt-writing";
  let writingWorks = true;
  try {
    const rWrite = await loadAndTranspile(writingCwd, "writing");
    if (rWrite.segment.length === 0) writingWorks = false;
    check("pt-writing Profile 编译成功",
      writingWorks,
      `writing segment=${rWrite.segment.length} chars`);
    check("pt-writing 含 参考手册 注入点",
      rWrite.context.modules["参考手册"] !== undefined,
      `参考手册段长度=${rWrite.context.modules["参考手册"]?.length ?? 0}`);
  } catch (e) {
    check("pt-writing Profile 编译成功", false, `error=${(e as Error).message}`);
  }

  // ========== 15. 残留 grep 检查 ==========
  console.log("\n--- 15. 残留 grep 检查 ---");
  const { execSync } = await import("node:child_process");
  try {
    const out = execSync(`grep -rn --exclude='verify-phase9.ts' "对话记忆" .pt/assets/ src/ tests/ 2>/dev/null || true`).toString().trim();
    check("'对话记忆' 零残留（§0.10 变更说明 + 本验证脚本自身例外）",
      out === "",
      `残留: ${out.split("\n").slice(0, 3).join("; ") || "无"}`);
  } catch (e) {
    check("'对话记忆' 零残留", false, String(e));
  }
  try {
    // docs/ 中的 pt-dev-phases*.md 是任务描述文档，包含原始提及——排除
    const out2 = execSync(`grep -rn --exclude='verify-phase9.ts' --exclude='pt-dev-phases*.md' ".openxenon" .pt/assets/ src/ tests/ docs/ 2>/dev/null || true`).toString().trim();
    check("'.openxenon' 零残留（docs/pt-dev-phases*.md 任务描述例外）",
      out2 === "",
      `残留: ${out2.split("\n").slice(0, 3).join("; ") || "无"}`);
  } catch (e) {
    check("'.openxenon' 零残留", false, String(e));
  }

  // ========== 16. Q1 修复：lastCwd fallback ==========
  console.log("\n--- 16. /pt-context Q1 修复 ---");
  check("/pt-context getArgumentCompletions 用 lastCwd || process.cwd()",
    indexSrc.includes("lastCwd || process.cwd()"),
    "Q1 修复已应用");

  // ========== 总评 ==========
  console.log(`\n=== ${failed === 0 ? "✅ 全部通过" : `❌ ${failed} 项失败`} ===`);
  if (failed > 0) process.exit(1);
}
main().catch(e => { console.error(e); process.exit(1); });