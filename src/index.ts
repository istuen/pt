// src/index.ts — Pi 扩展入口（v9）
//
// v9 用户面命令：--pt-context（flag）/ /pt-context（命令），对应"激活 Profile → 编译 Context"。
//   "profile" 在 v9 是配置层概念（引用 Blueprint + 选 Domains），用户面命令强调产物是 Context。
//
// 注入用 AgentAdapter（默认 Pi）封装 before_agent_start + input 事件。
//
// Tech Debt T11: per-session 状态收拢到 SessionState（src/session.ts），不再 10 个模块级 let。

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FULL_DIR, MOD_MANUAL, PROFILES_DIR, RAW_DIR } from "./constants.js";
import { getAgentAdapter } from "./agent/index.js";
import { detectSingleProfile, listProfiles, readProjectSetting } from "./config.js";
import { findFlowInBlueprint } from "./render/context-message.js";
import { resetSession, session } from "./session.js";
import { loadAndTranspile } from "./transpile.js";
import type { AgentAdapter, AgentAPI, Profile } from "./schema.js";

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 转译当前选定的 Profile，结果写入 session；失败降级。 */
async function transpileActive(
  cwd: string,
  profileName: string,
  notify: (msg: string, level: "warning" | "error") => void,
): Promise<void> {
  const result = await loadAndTranspile(cwd, profileName, { notify });
  session.cachedSegment = result.segment;
  session.cachedBundles = result.bundles;
  session.cachedContext = result.context;
  session.cachedBlueprint = result.blueprint;
  session.cachedDomains = result.domains;
  session.cachedProfile = result.profile;
  session.activeProfile = profileName;
  session.lastCacheHit = result.cacheHit;

  // 设置 AgentAdapter 的编译产物（默认 pi）
  session.activeAdapter = getAgentAdapter(result.blueprint.agent);
  session.activeAdapter.setContext(result.context, result.blueprint, result.domains);
}

/** 切换 Profile：重转译 + 通知。 */
async function switchProfile(
  _pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  name: string,
): Promise<void> {
  try {
    await transpileActive(ctx.cwd, name, (msg, level) => ctx.ui.notify(msg, level));
    ctx.ui.setStatus("pt", `pt: ${name}`);
    const hint = session.lastCacheHit ? "（缓存命中）" : "（已重编译）";
    ctx.ui.notify(`已切换到 ${name}，下一轮生效 ${hint}`, "info");
  } catch (e) {
    ctx.ui.notify(`切换失败：${errMsg(e)}`, "error");
  }
}

/** 在 session.cachedBundles 里找指定名的 FlowTemplate（跨 bundle 查找）。 */
function findFlow(name: string) {
  if (!session.cachedBundles) return undefined;
  for (const b of session.cachedBundles) {
    const bp = b.blueprints.find((x) => x.name === b.blueprints[0]?.name);
    if (!bp) continue;
    const tpl = findFlowInBlueprint(bp, b.domains, name);
    if (tpl) return tpl;
  }
  return undefined;
}

export default function (pi: ExtensionAPI): void {
  // 启动时 flag（CLI 优先）
  pi.registerFlag("pt-context", {
    description: "启动时激活的 Profile 名（编译成 Context 注入 System Prompt）",
    type: "string",
  });

  // ========== session_start：读默认 profile + 转译 + 注册 adapter ==========
  pi.on("session_start", async (_event, ctx) => {
    session.lastCwd = ctx.cwd;
    try {
      const flag = pi.getFlag("pt-context");
      const flagVal = typeof flag === "string" && flag.trim() ? flag.trim() : undefined;

      const fromSettings = await readProjectSetting<string>(ctx.cwd, "au.pt-context");
      const auto = await detectSingleProfile(ctx.cwd);

      const picked = flagVal ?? fromSettings ?? auto;

      if (!picked) {
        ctx.ui.setStatus("pt", "pt: 无 context");
        ctx.ui.notify("Pt：未找到 Profile。用 /pt-context <name> 选择，或在 .pi/settings.json 设 au.pt-context。", "info");
        return;
      }

      await transpileActive(ctx.cwd, picked, (msg, level) => ctx.ui.notify(msg, level));
      // 注册 AgentAdapter 注入（封装 before_agent_start + input）
      if (session.activeAdapter && session.cachedContext && session.cachedBlueprint) {
        session.activeAdapter.registerInject(toAgentAPI(pi, ctx), session.cachedContext, session.cachedBlueprint);
      }
      ctx.ui.setStatus("pt", `pt: ${picked}`);
    } catch (e) {
      ctx.ui.notify(`Pt 加载失败：${errMsg(e)}`, "error");
      ctx.ui.setStatus("pt", "pt: 加载失败");
      session.cachedSegment = null;
      session.cachedBundles = null;
    }
  });

  // ========== session_shutdown：清内存态 ==========
  pi.on("session_shutdown", async () => {
    resetSession();
  });

  // ========== /pt-context 命令：即时切换 ==========
  pi.registerCommand("pt-context", {
    description: "切换当前 Profile（编译成 Context 注入 System Prompt），即时重转译（无参则弹出选择器）",
    getArgumentCompletions: async (prefix) => {
      const cwd = session.lastCwd || process.cwd();  // Q1 修复：fallback 到 process.cwd()
      const names = await listProfiles(cwd);
      const items = names.map((n) => ({ value: n, label: n }));
      const hit = items.filter((i) => i.value.startsWith(prefix));
      return hit.length > 0 ? hit : null;
    },
    handler: async (args, ctx) => {
      const name = args.trim();
      if (!name) {
        const names = await listProfiles(ctx.cwd);
        if (names.length === 0) {
          ctx.ui.notify(`未找到任何 Profile（${PROFILES_DIR}/*.profile.md）`, "warning");
          return;
        }
        if (!ctx.hasUI) {
          ctx.ui.notify("/pt-context（无参）在非交互模式不可用，请指定名称", "warning");
          return;
        }
        const picked = await ctx.ui.select("选择 Profile", names);
        if (!picked) return;
        await switchProfile(pi, ctx, picked);
        return;
      }
      await switchProfile(pi, ctx, name);
    },
  });

  // ========== /pt 命令：查看 Pt 编译产物 ==========
  pi.registerCommand("pt", {
    description: "查看 Pt 转译产物 / 状态（无参=显示当前 segment）",
    handler: async (args, ctx) => {
      const sub = args.trim().toLowerCase();

      if (sub === "status" || sub === "") {
        const flowCount = session.cachedBundles?.reduce((acc, b) => {
          let n = 0;
          for (const d of b.domains) if (d.type === "workflow") {
            const tpls = Array.isArray(d.modules[MOD_MANUAL]) ? d.modules[MOD_MANUAL] : [];
            n += tpls.length;
          }
          return acc + n;
        }, 0) ?? 0;
        const domainCount = session.cachedBundles?.reduce((acc, b) => acc + b.domains.length, 0) ?? 0;
        const blueprintCount = session.cachedBundles?.reduce((acc, b) => acc + b.blueprints.length, 0) ?? 0;
        const profileCount = session.cachedBundles?.reduce((acc, b) => acc + b.profiles.length, 0) ?? 0;
        const lines = [
          `pt profile: ${session.activeProfile ?? "(未激活)"}`,
          `pt agent: ${session.activeAdapter?.name ?? "(none)"}`,
          `pt domains: ${domainCount}, blueprints: ${blueprintCount}, profiles: ${profileCount}, flows: ${flowCount}`,
          `pt segment length: ${session.cachedSegment?.length ?? 0} chars`,
          `pt cache hit: ${session.lastCacheHit ? "yes" : "no"}`,
          `pt last built prompt: ${session.lastBuiltPrompt ? `${session.lastBuiltPrompt.length} chars` : "(未跑过 turn)"}`,
          `pt cwd: ${session.lastCwd}`,
        ];
        ctx.ui.notify(lines.join(" | "), "info");
        if (sub === "" && session.cachedSegment) {
          ctx.ui.notify(session.cachedSegment, "info");
        }
        return;
      }

      if (sub === "flows") {
        if (!session.cachedBundles || session.cachedBundles.length === 0 || !session.activeAdapter) {
          ctx.ui.notify("无激活 Profile，先用 /pt-context <name> 激活", "warning");
          return;
        }
        // listManuals 需 Profile 范围过滤——用 session.cachedProfile 过滤
        const flows = session.activeAdapter.listManuals?.(
          session.cachedContext!,
          session.cachedBlueprint!,
          filterDomainsByProfile(session.cachedBundles[0].domains, session.cachedProfile),
        ) ?? [];
        if (flows.length === 0) {
          ctx.ui.notify("当前 Profile 无可触发手册（context_message 注入点无 workflow-type Domain）", "info");
        } else {
          const lines = flows.map((f) => `  /${f.name} ${f.hint ?? ""}  ← ${f.domain}`);
          ctx.ui.notify(`可用手册（输入 /手册名 参数 或 /manual:<domain-name> 触发 Context Message）:\n${lines.join("\n")}`, "info");
        }
        return;
      }

      if (sub === "raw") {
        if (!session.cachedSegment) {
          ctx.ui.notify("无 segment 可显示", "warning");
          return;
        }
        const dir = join(ctx.cwd, RAW_DIR);
        await mkdir(dir, { recursive: true });
        const file = join(dir, `segment-${Date.now()}.md`);
        await writeFile(file, session.cachedSegment, "utf8");
        ctx.ui.notify(`已写入 ${file}（${session.cachedSegment.length} chars）`, "info");
        return;
      }

      if (sub === "full") {
        const base = ctx.getSystemPrompt();
        const full = session.cachedSegment
          ? base + "\n\n## 当前任务上下文\n\n" + session.cachedSegment
          : base;
        if (!session.cachedSegment) {
          ctx.ui.notify("警告：无 cachedSegment（未加载 Profile）。用 /pt-context <name> 选择", "warning");
        }
        const dir = join(ctx.cwd, FULL_DIR);
        await mkdir(dir, { recursive: true });
        const file = join(dir, `prompt-${Date.now()}.md`);
        await writeFile(file, full, "utf8");
        ctx.ui.notify(`完整 systemPrompt 已写入 ${file}（${full.length} chars）`, "info");
        return;
      }

      ctx.ui.notify("用法: /pt [status|flows|raw|full]", "warning");
    },
  });
}

/** 按 Profile 范围过滤 domains（listManuals 需作用域）。 */
function filterDomainsByProfile<T extends { name: string }>(domains: T[], profile: Profile | null): T[] {
  if (!profile) return domains;
  return domains.filter((d) => {
    if (profile.domains.includes(d.name)) return true;
    return profile.injectionPoints.some((ip) => ip.domains.includes(d.name));
  });
}

/** 将 Pi ExtensionAPI 转换为 AgentAPI（结构类型子集，运行时透明）。
 *  Pi ExtensionAPI 是 AgentAPI 的超集，多余方法（registerCommand/registerFlag 等）不暴露给 Adapter。
 *  v9.1：提供 ui 能力，adapter 可走 ui.notify 报错 / ui.setStatus 设状态（不需 console）。
 *  ctx 用 Pi 扩展的 ctx（ExtensionContext/ExtensionCommandContext 都含 ui）——子集够用。 */
function toAgentAPI(pi: ExtensionAPI, ctx: { ui: { notify(msg: string, level: "info" | "warning" | "error"): void; setStatus(name: string, text: string): void } }): AgentAPI {
  return {
    on: (event, handler) => pi.on(event as Parameters<ExtensionAPI["on"]>[0], handler as Parameters<ExtensionAPI["on"]>[1]),
    registerCommand: (name, spec) => pi.registerCommand(name, spec as Parameters<ExtensionAPI["registerCommand"]>[1]),
    registerFlag: (name, spec) => pi.registerFlag(name, spec as Parameters<ExtensionAPI["registerFlag"]>[1]),
    getFlag: (name) => pi.getFlag(name),
    ui: {
      notify: (msg, level) => ctx.ui.notify(msg, level),
      setStatus: (name, text) => ctx.ui.setStatus(name, text),
    },
  };
}

/** 暴露 activeProfile 用于调试（未来可挂 /pt status）。 */
export function _debugActive(): { profile: string | null; segmentLen: number; flowCount: number; cacheHit: boolean } {
  const flowCount = session.cachedBundles?.reduce((acc, b) => {
    let n = 0;
    for (const d of b.domains) if (d.type === "workflow") {
      const tpls = Array.isArray(d.modules[MOD_MANUAL]) ? d.modules[MOD_MANUAL] : [];
      n += tpls.length;
    }
    return acc + n;
  }, 0) ?? 0;
  return {
    profile: session.activeProfile,
    segmentLen: session.cachedSegment?.length ?? 0,
    flowCount,
    cacheHit: session.lastCacheHit,
  };
}