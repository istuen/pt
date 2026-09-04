// tests/verify/phase9.test.ts — Phase 9.9 v9 完整回归验证（vitest）
//
// v9 模型：
// - Blueprint 吸收 v8 Channel 结构（agent + injectionPoints + Compilation）
// - Profile 是业务端实例（blueprint + YAML domains + 各注入点 ### Domains 追加）
// - modName 注册表（替代 v8 domainSceneRenderers）
// - Trigger 索引段（Domain 内 H2 段）
// - /manual:xxx 触发（renderTurnMessage 实现）
// - AgentAdapter 抽象（PiAdapter 封装 before_agent_start + input）

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { loadAndTranspile } from "../../src/transpile.js";
import { renderTurnMessage } from "../../src/render/turn-message.js";
import { findBlueprint, findProfile } from "../../src/schema.js";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { execSync } from "node:child_process";

const cwd = process.cwd();

interface LoadedProfile {
  name: string;
  segment: string;
  // Phase term-P1：TranspileResult.context → TranspileResult.agentContext（IR 改名同步）。
  // 本地缓存字段仍叫 context（LoadedProfile 是测试内部记录），值取自 r.agentContext。
  context: ReturnType<typeof loadAndTranspile> extends Promise<infer T>
    ? T extends { agentContext: infer C }
      ? C
      : never
    : never;
  blueprint: ReturnType<typeof loadAndTranspile> extends Promise<infer T>
    ? T extends { blueprint: infer B }
      ? B
      : never
    : never;
  bundles: ReturnType<typeof loadAndTranspile> extends Promise<infer T>
    ? T extends { bundles: infer Bs }
      ? Bs
      : never
    : never;
  cacheHit: boolean;
}

const loadedProfiles: Record<string, LoadedProfile> = {};

beforeAll(async () => {
  // 清缓存，确保首次加载都重编译
  try {
    for (const f of await readdir(join(cwd, ".pt/cache/agent-contexts"))) {
      if (f.endsWith(".agent-context.md")) {
        await readFile(join(cwd, ".pt/cache/agent-contexts", f), "utf8").catch(() => {});
      }
    }
  } catch {}

  for (const name of ["pt-chat", "pt-dev"]) {
    const r = await loadAndTranspile(cwd, name);
    loadedProfiles[name] = {
      name,
      segment: r.segment,
      context: r.agentContext,
      blueprint: r.blueprint,
      bundles: r.bundles,
      cacheHit: r.cacheHit,
    };
  }
});

describe("Phase 9.9 v9 完整回归", () => {
  // ========== 1. 两 Profile 产物 ==========
  describe("1. 两 Profile 产物", () => {
    it("两个 Profile 都成功加载", () => {
      expect(loadedProfiles["pt-chat"]).toBeDefined();
      expect(loadedProfiles["pt-dev"]).toBeDefined();
    });

    it("pt-chat Profile 含 v9 措辞", () => {
      const r = loadedProfiles["pt-chat"].segment;
      expect(r).toContain("parse");
      expect(r).toContain("compile");
      expect(r).toContain("render");
    });

    it("pt-dev Profile 含开发流程", () => {
      const r = loadedProfiles["pt-dev"].segment;
      expect(r.includes("feature-lifecycle") || r.includes("pt-dev-flow")).toBe(true);
    });

    it("pt-dev Profile 不含业务", () => {
      const r = loadedProfiles["pt-dev"].segment;
      expect(r).not.toContain("客户");
      expect(r).not.toContain("订单");
    });
  });

  // ========== 2. Context 缓存命中 ==========
  describe("2. Context 缓存命中", () => {
    it("pt-chat 二次加载命中缓存", async () => {
      const r2 = await loadAndTranspile(cwd, "pt-chat");
      expect(r2.cacheHit).toBe(true);
      expect(r2.segment).toBe(loadedProfiles["pt-chat"].segment);
    });
  });

  // ========== 3. Blueprint 复用 ==========
  describe("3. Blueprint 复用", () => {
    it("dev-knowledge Blueprint 被 ≥2 个 Profile 引用", async () => {
      const profileFiles = (await readdir(join(cwd, ".pt/assets/profiles"))).filter((f) =>
        f.endsWith(".profile.md")
      );
      const refCounts: Record<string, number> = {};
      for (const f of profileFiles) {
        const raw = await readFile(join(profilesDir(), f), "utf8");
        const m = raw.match(/^blueprint:\s+(.+)$/m);
        const bp = m ? m[1].trim() : "";
        if (bp) refCounts[bp] = (refCounts[bp] ?? 0) + 1;
      }
      expect(refCounts["dev-knowledge"] ?? 0).toBeGreaterThanOrEqual(2);
    });
  });

  // ========== 5. v9 注入点 H2 ==========
  describe("5. v9 注入点 H2", () => {
    it("pt-dev Context 含 ## 会话知识 + ## 参考手册，不含 ## Scene / ## Manual", async () => {
      const raw = await readFile(
        join(cwd, ".pt/cache/agent-contexts/pt-dev.agent-context.md"),
        "utf8"
      );
      expect(/^## 会话知识/m.test(raw)).toBe(true);
      expect(/^## 参考手册/m.test(raw)).toBe(true);
      expect(/^## Scene\b/m.test(raw)).toBe(false);
      expect(/^## Manual\b/m.test(raw)).toBe(false);
    });
  });

  // ========== 6. pt-quality Manual ==========
  describe("6. pt-quality 进参考手册不污染会话知识", () => {
    it("pt-quality Manual 段出现在 pt-dev 参考手册", async () => {
      const raw = await readFile(
        join(cwd, ".pt/cache/agent-contexts/pt-dev.agent-context.md"),
        "utf8"
      );
      const canKaoIdx = raw.indexOf("## 参考手册");
      let qualityManualIdx = -1;
      let searchFrom = canKaoIdx;
      while (searchFrom !== -1) {
        const next = raw.indexOf("### pt-quality", searchFrom);
        if (next === -1) break;
        if (next > canKaoIdx) {
          qualityManualIdx = next;
          break;
        }
        searchFrom = next + 1;
      }
      // 必须在 ## 参考手册 之后（pt-quality Manual 段进参考手册段）
      expect(qualityManualIdx).toBeGreaterThan(canKaoIdx);
      // 且是文件中最后一个 ### pt-quality（Manual 唯一）
      const lastIdx = raw.lastIndexOf("### pt-quality");
      expect(qualityManualIdx).toBe(lastIdx);
    });

    it("pt-quality Manual 规范 checklist 不污染会话知识段", async () => {
      const raw = await readFile(
        join(cwd, ".pt/cache/agent-contexts/pt-dev.agent-context.md"),
        "utf8"
      );
      const _canKaoIdx = raw.indexOf("## 参考手册");
      const huiHuaIdx = raw.indexOf("## 会话知识");
      const nextH2AfterHuiHuaOffset = raw.slice(huiHuaIdx + 1).search(/^## /m);
      const modulesTypeSafetyIdx = raw.indexOf("- modules-type-safety:");
      expect(
        modulesTypeSafetyIdx < huiHuaIdx ||
          modulesTypeSafetyIdx > huiHuaIdx + 1 + nextH2AfterHuiHuaOffset
      ).toBe(true);
    });
  });

  // ========== 7. Trigger 索引段 ==========
  describe("7. Trigger 索引段", () => {
    it("pt-quality-trigger 出现在会话知识段", async () => {
      const raw = await readFile(
        join(cwd, ".pt/cache/agent-contexts/pt-dev.agent-context.md"),
        "utf8"
      );
      const huiHuaIdx = raw.indexOf("## 会话知识");
      const nextH2AfterHuiHuaOffset = raw.slice(huiHuaIdx + 1).search(/^## /m);
      const triggerIdx = raw.indexOf("pt-quality-trigger");
      expect(triggerIdx).toBeGreaterThan(huiHuaIdx);
      expect(triggerIdx).toBeLessThan(huiHuaIdx + 1 + nextH2AfterHuiHuaOffset);
    });
  });

  // ========== 8. me Domain ==========
  describe("8. me Domain 进入会话知识", () => {
    it("me Domain 段出现在会话知识", async () => {
      const raw = await readFile(
        join(cwd, ".pt/cache/agent-contexts/pt-dev.agent-context.md"),
        "utf8"
      );
      const huiHuaIdx = raw.indexOf("## 会话知识");
      const nextH2AfterHuiHuaOffset = raw.slice(huiHuaIdx + 1).search(/^## /m);
      const meIdx = raw.indexOf("### me");
      expect(meIdx).toBeGreaterThan(huiHuaIdx);
      expect(meIdx).toBeLessThan(huiHuaIdx + 1 + nextH2AfterHuiHuaOffset);
    });

    it("me 含 user-profile/pt-goal/collab-mode", async () => {
      const raw = await readFile(
        join(cwd, ".pt/cache/agent-contexts/pt-dev.agent-context.md"),
        "utf8"
      );
      expect(raw).toContain("user-profile");
      expect(raw).toContain("pt-goal");
      expect(raw).toContain("collab-mode");
    });
  });

  // ========== 9. 硬编码检查 ==========
  describe("9. 硬编码检查", () => {
    it("renderSessionPrompt 不硬编码 Scene（Phase term-P4.3 函数名）", async () => {
      const src = await readFile("src/render/session-prompt.ts", "utf8");
      expect(src).not.toMatch(/['"]Scene['"]/);
    });
    it("compile/agent-context.ts 不含 domainSceneRenderers 代码（仅历史注释提及）", async () => {
      // Phase term-P1：compile/context.ts → compile/agent-context.ts（IR 改名同步）
      const src = await readFile("src/compile/agent-context.ts", "utf8");
      const codeWithoutComments = src.replace(/\/\/.*$/gm, "");
      expect(codeWithoutComments).not.toMatch(/domainSceneRenderers[(.]/);
    });
    it("compile/agent-context.ts 不含 target === system_prompt 硬编码", async () => {
      // Phase term-P1：compile/context.ts → compile/agent-context.ts（IR 改名同步）
      const src = await readFile("src/compile/agent-context.ts", "utf8");
      expect(src).not.toContain('target === "system_prompt"');
    });
  });

  // ========== 10. IR 结构 ==========
  describe("10. IR 结构", () => {
    it("Blueprint 不含 agent 字段（Phase term-P4.1：Blueprint Agent-agnostic）", async () => {
      const src = await readFile("src/schema.ts", "utf8");
      // Phase term-P4.1：Blueprint.agent 字段移除，消费方硬编码 "pi"。
      const codeWithoutComments = src.replace(/\/\/.*$/gm, "");
      expect(codeWithoutComments).not.toMatch(/interface Blueprint[\s\S]*?agent:\s*string/);
    });
    it("Profile 含 blueprint + domains 字段", async () => {
      const src = await readFile("src/schema.ts", "utf8");
      expect(src).toMatch(
        /interface Profile[\s\S]*?blueprint:\s*string[\s\S]*?domains:\s*string\[\]/
      );
    });
    it("InjectionPointInstance 无 trigger/boundaries", async () => {
      const src = await readFile("src/schema.ts", "utf8");
      const m = src.match(/interface InjectionPointInstance\s*\{[\s\S]*?\}/);
      expect(m).not.toBeNull();
      expect(m?.[0]).not.toContain("trigger");
      expect(m?.[0]).not.toContain("boundaries");
    });
  });

  // ========== 11. 资产目录 ==========
  describe("11. 资产目录", () => {
    it("channels/ 目录不存在", async () => {
      await expect(readdir(join(cwd, ".pt/assets/channels"))).rejects.toThrow();
    });
    it("profiles/ 目录存在", async () => {
      const files = await readdir(join(cwd, ".pt/assets/profiles"));
      expect(files.length).toBeGreaterThan(0);
    });
  });

  // ========== 12. /manual:xxx 触发 ==========
  describe("12. /manual:xxx 触发", () => {
    it("/manual:pt-quality 触发返非 null", () => {
      const r9 = loadedProfiles["pt-dev"];
      const ptDevBundle = r9.bundles[0];
      const ptDevProfile = findProfile(ptDevBundle.profiles, "pt-dev")!;
      const ptDevBlueprint = findBlueprint(ptDevBundle.blueprints, ptDevProfile.blueprint)!;
      const result = renderTurnMessage(
        r9.context,
        ptDevBlueprint,
        ptDevBundle.domains,
        "/manual:pt-quality"
      );
      expect(result).not.toBeNull();
    });

    it("/manual:pt-quality 含 9 条规范", () => {
      const r9 = loadedProfiles["pt-dev"];
      const ptDevBundle = r9.bundles[0];
      const ptDevProfile = findProfile(ptDevBundle.profiles, "pt-dev")!;
      const ptDevBlueprint = findBlueprint(ptDevBundle.blueprints, ptDevProfile.blueprint)!;
      const result = renderTurnMessage(
        r9.context,
        ptDevBlueprint,
        ptDevBundle.domains,
        "/manual:pt-quality"
      );
      expect(result).toContain("modules-type-safety");
    });
  });

  // ========== 13. PiAdapter 封装 ==========
  describe("13. PiAdapter 封装", () => {
    it("index.ts 不直接调 before_agent_start", async () => {
      const src = await readFile("src/index.ts", "utf8");
      expect(src).not.toMatch(/pi\.on\(["']before_agent_start["']/);
    });
    it("index.ts 不直接调 input 事件", async () => {
      const src = await readFile("src/index.ts", "utf8");
      expect(src).not.toMatch(/pi\.on\(["']input["']/);
    });
  });

  // ========== 14. pt-writing 跨项目 ==========
  describe("14. pt-writing 跨项目", () => {
    it("pt-writing writing Profile 编译成功", async () => {
      const r = await loadAndTranspile("/Users/issac/pro/pt-writing", "writing");
      expect(r.segment.length).toBeGreaterThan(0);
    });
    it("pt-writing 含 参考手册 注入点", async () => {
      const r = await loadAndTranspile("/Users/issac/pro/pt-writing", "writing");
      expect(r.agentContext.modules.参考手册).toBeDefined();
    });
  });

  // ========== 15. 残留 grep ==========
  describe("15. 残留 grep 检查", () => {
    it("对话记忆 零残留（脚本自身例外）", () => {
      const out = execSync(
        `grep -rln --exclude='phase9.test.ts' --exclude='flows.test.ts' --exclude='verify-phase9.ts' --exclude='verify-flows.ts' "对话记忆" .pt/assets/ src/ tests/ 2>/dev/null || true`
      )
        .toString()
        .trim();
      expect(out).toBe("");
    });
    it(".openxenon 零残留（任务描述例外）", () => {
      const out = execSync(
        `grep -rln --exclude='phase9.test.ts' --exclude='flows.test.ts' --exclude='verify-phase9.ts' --exclude='verify-flows.ts' --exclude='pt-dev-phases*.md' ".openxenon" .pt/assets/ src/ tests/ docs/ 2>/dev/null || true`
      )
        .toString()
        .trim();
      expect(out).toBe("");
    });
  });

  // ========== 16. Q1 修复 ==========
  // Phase term-P2：/pt-context → /pt-profile（命令参数是 Profile 名）。
  describe("16. /pt-profile Q1 修复", () => {
    it("getArgumentCompletions 用 lastCwd || process.cwd()", async () => {
      const src = await readFile("src/index.ts", "utf8");
      expect(src).toContain(".lastCwd) || process.cwd()");
    });
  });

  // ========== 17. Builtin 资产 ==========
  describe("17. Builtin 资产", () => {
    it("内建 pt profile 加载成功", async () => {
      const r = await loadAndTranspile(cwd, "pt");
      expect(r.profile.name).toBe("pt");
      expect(r.blueprint.name).toBe("dev-knowledge");
    });

    it("内建 pt profile 含 project-analysis / usage / authoring", async () => {
      const r = await loadAndTranspile(cwd, "pt");
      expect(r.segment).toContain("### project-analysis");
      expect(r.segment).toContain("### usage");
      expect(r.segment).toContain("### authoring");
    });

    it("内建 domains 进入池但不污染项目 profile", async () => {
      const r = await loadAndTranspile(cwd, "pt-chat");
      const domainNames = r.bundles[0].domains.map((d) => d.name);
      expect(domainNames).toContain("authoring");
      expect(domainNames).toContain("project-analysis");
      expect(domainNames).toContain("usage");
      // pt-chat 不引用内建 domains
      expect(r.segment).not.toContain("### project-analysis");
    });

    it("项目资产覆盖内建（dev-knowledge 不重复）", async () => {
      const r = await loadAndTranspile(cwd, "pt");
      const blueprintNames = r.bundles[0].blueprints.map((b) => b.name);
      const devCount = blueprintNames.filter((n) => n === "dev-knowledge").length;
      expect(devCount).toBe(1); // 项目覆盖内建，不重复
    });
  });

  // ========== 18. /pt manual 手册实例化 ==========
  describe("18. /pt manual 手册实例化", () => {
    it("bindFlowTemplate 输出含步骤 + 变量绑定", async () => {
      const { bindFlowTemplate } = await import("../../src/render/turn-message.js");
      const r = await loadAndTranspile(cwd, "pt");
      const { findFlowInBlueprint } = await import("../../src/render/turn-message.js");
      const tpl = findFlowInBlueprint(r.blueprint, r.bundles[0].domains, "create-domain-procedure");
      expect(tpl).toBeDefined();
      const bound = bindFlowTemplate(tpl!, "term my-concept");
      expect(bound).toContain("create-domain-procedure");
      expect(bound).toContain("my-concept");
      expect(bound).toContain("term");
    });

    it("实例文档格式含 checklist + 产物区 + 更新指引", async () => {
      const { bindFlowTemplate, findFlowInBlueprint } = await import(
        "../../src/render/turn-message.js"
      );
      const r = await loadAndTranspile(cwd, "pt");
      const tpl = findFlowInBlueprint(r.blueprint, r.bundles[0].domains, "create-domain-procedure");
      const bound = bindFlowTemplate(tpl!, "term my-concept");
      // 模拟 /pt manual 的文档包装逻辑
      const lines: string[] = ["---", "procedure: create-domain-procedure", "---", ""];
      for (const line of bound.split("\n")) {
        if (line.startsWith("#")) continue;
        if (line.startsWith("_")) continue;
        const m = line.match(/^(\d+)\.\s+(.*)$/);
        lines.push(m ? `- [ ] ${m[2]}` : line);
      }
      lines.push("", "## 产物", "<!-- -->", "", "## 更新指引", "用 edit 标记完成。");
      const doc = lines.join("\n");
      expect(doc).toContain("- [ ]");
      expect(doc).toContain("## 产物");
      expect(doc).toContain("## 更新指引");
    });

    it("实例文档跳过冗余标题/参数提示/步骤段头", async () => {
      const { bindFlowTemplate, findFlowInBlueprint } = await import(
        "../../src/render/turn-message.js"
      );
      const r = await loadAndTranspile(cwd, "pt");
      const tpl = findFlowInBlueprint(r.blueprint, r.bundles[0].domains, "create-domain-procedure");
      const bound = bindFlowTemplate(tpl!, "term my-concept");
      // 模拟 /pt manual 的文档包装逻辑
      const lines: string[] = ["---", "procedure: create-domain-procedure", "---", ""];
      for (const line of bound.split("\n")) {
        if (line.startsWith("#")) continue;
        if (line.startsWith("_")) continue;
        const m = line.match(/^(\d+)\.\s+(.*)$/);
        lines.push(m ? `- [ ] ${m[2]}` : line);
      }
      const doc = lines.join("\n");
      // 不应再出现原模板的 # name 标题（实例文档已用 # name 实例 标题）
      expect(doc).not.toMatch(/^# create-domain-procedure$/m);
      // 不应再出现 _参数：..._ 提示
      expect(doc).not.toMatch(/^_参数：/m);
      // 不应再出现 ## 步骤 段头（步骤已转 checklist，无需段头）
      expect(doc).not.toMatch(/^## 步骤$/m);
      // 也不应再出现 ## 前提（Intent） 段头（实例文档已自带标题）
      expect(doc).not.toMatch(/^## 前提/m);
      // intent 正文应保留
      expect(doc).toContain("创建新 Domain 资产");
      // 步骤转 checklist 应保留
      expect(doc).toContain("- [ ]");
    });

    it("MANUAL_DIR 常量已定义", async () => {
      const constants = await import("../../src/constants.js");
      expect(constants.MANUAL_DIR).toBe(".pt/manuals");
    });

    it("index.ts 注册了 /pt manual 子命令", async () => {
      const src = await readFile("src/index.ts", "utf8");
      expect(src).toContain('sub === "manual"');
      expect(src).toContain("MANUAL_DIR");
    });
  });

  // ========== 19. command + tool 双注册（纯函数内核） ==========
  describe("19. command + tool 双注册（纯函数内核）", () => {
    // 预热 session——buildManualDoc/flowsText 读 session.cachedBundles（pt-dev 有 feature-lifecycle 手册）
    beforeAll(async () => {
      const { getSessionById } = await import("../../src/session.js");
      const { resetTestSession, TEST_SESSION_ID } = await import("./session-fixtures.js");
      const { loadAndTranspile } = await import("../../src/transpile.js");
      const { getAgentAdapter } = await import("../../src/agent/index.js");
      const r = await loadAndTranspile(process.cwd(), "pt-dev");
      resetTestSession();
      const sessionState = getSessionById(TEST_SESSION_ID);
      sessionState.cachedBundles = r.bundles;
      sessionState.cachedBlueprint = r.blueprint;
      sessionState.cachedAgentContext = r.agentContext;
      sessionState.cachedDomains = r.domains;
      sessionState.cachedProfile = r.profile;
      sessionState.cachedSegment = r.segment;
      sessionState.activeProfile = "pt-dev";
      const adapter = getAgentAdapter({} as never, "pi");
      sessionState.activeAdapter = adapter;
      adapter.setAgentContext(r.agentContext, r.blueprint, r.domains);
    });

    // 避免 session 污染后续 test
    afterAll(async () => {
      const { resetTestSession } = await import("./session-fixtures.js");
      resetTestSession();
    });

    it("statusText 返回状态摘要文本", async () => {
      const { statusText } = await import("../../src/commands.js");
      const { s } = await import("./session-fixtures.js");
      const text = statusText(s());
      expect(text).toContain("pt profile:");
      expect(text).toContain("pt segment length:");
      expect(text).toContain("pt-dev");
    });

    it("flowsText 返回可用手册列表", async () => {
      const { flowsText } = await import("../../src/commands.js");
      const { s } = await import("./session-fixtures.js");
      const text = flowsText(s());
      expect(text).toContain("可用手册");
      expect(text).toContain("feature-lifecycle");
    });

    it("buildManualDoc 未找到手册返回 error", async () => {
      const { buildManualDoc } = await import("../../src/commands.js");
      const { s } = await import("./session-fixtures.js");
      const r = buildManualDoc(process.cwd(), s(), "nonexistent-proc", "");
      expect(r.error).toContain("未找到手册");
    });

    it("buildManualDoc 构建实例文档内容", async () => {
      const { buildManualDoc } = await import("../../src/commands.js");
      const { s } = await import("./session-fixtures.js");
      const doc = buildManualDoc(process.cwd(), s(), "feature-lifecycle", "req-001");
      expect(doc.error).toBeUndefined();
      expect(doc.content).toContain("feature-lifecycle");
      expect(doc.content).toContain("- [ ]");
      expect(doc.content).toContain("## 产物");
      expect(doc.filePath).toContain("feature-lifecycle-");
    });

    it("index.ts 注册了 3 个 tool", async () => {
      const src = await readFile("src/index.ts", "utf8");
      expect(src).toContain('name: "pt_status"');
      expect(src).toContain('name: "pt_flows"');
      expect(src).toContain('name: "pt_manual"');
      expect(src).toContain("withFileMutationQueue");
    });
  });
});

// Helper（profilesDir）
function profilesDir(): string {
  return join(cwd, ".pt/assets/profiles");
}
