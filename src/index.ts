// src/index.ts — Pi 扩展入口（v7）
// Pi ExtensionAPI 用法见 pt-plugin-design.md §0 与 §5。
//
// v7 user 面命令：--pt-context（flag）/ /pt-context（命令），对应"激活 Blueprint → 编译 Context"。
//   "blueprint" 在 v7 是配置层概念（Channel + Domains + trigger + boundaries），内部变量名保留 blueprint 字样；
//   用户面命令改名 pt-context，强调产物是 Context（编译后的上下文文件）。

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { detectSingleScene, listScenes, readProjectSetting } from "./config.js";
import { loadAndTranspile } from "./transpile.js";
import { bindFlowTemplate, findFlowInBundle } from "./render/index.js";
import type { SchemaBundle } from "./schema.js";

// === per-session 内存态（每进程隔离 = 每会话隔离） ===
let activeBlueprint: string | null = null;
let cachedSegment: string | null = null;
/** 缓存 SchemaBundle（含 domains/channels/blueprints），给 input handler 用 */
let cachedBundles: SchemaBundle[] | null = null;
let lastCwd: string = "";
/** 缓存上一次 before_agent_start 后的最终 systemPrompt（供 /pt full 读取） */
let lastBuiltPrompt: string | null = null;
/** 上一次编译是否命中缓存 */
let lastCacheHit: boolean = false;

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 转译当前选定的 Blueprint，结果写入 cachedSegment + cachedBundles；失败降级 */
async function transpileActive(cwd: string, blueprintName: string): Promise<void> {
  const result = await loadAndTranspile(cwd, blueprintName);
  cachedSegment = result.segment;
  cachedBundles = result.bundles;
  activeBlueprint = blueprintName;
  lastCacheHit = result.cacheHit;
}

/** 切换 Blueprint：重转译 + 通知 */
async function switchBlueprint(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  name: string,
): Promise<void> {
  try {
    await transpileActive(ctx.cwd, name);
    ctx.ui.setStatus("pt", `pt: ${name}`);
    const hint = lastCacheHit ? "（缓存命中）" : "（已重编译）";
    ctx.ui.notify(`已切换到 ${name}，下一轮生效 ${hint}`, "info");
  } catch (e) {
    ctx.ui.notify(`切换失败：${errMsg(e)}`, "error");
  }
}

/** 在 cachedBundles 里找指定名的 FlowTemplate（跨 bundle 查找）。 */
function findFlow(name: string) {
  if (!cachedBundles) return undefined;
  for (const b of cachedBundles) {
    const bp = b.blueprints.find((x) => x.name === b.activeBlueprint);
    if (!bp) continue;
    const tpl = findFlowInBundle(bp, b.domains, name);
    if (tpl) return tpl;
  }
  return undefined;
}

export default function (pi: ExtensionAPI): void {
  // 启动时 flag（CLI 优先）
  pi.registerFlag("pt-context", {
    description: "启动时激活的 Blueprint 名（编译成 Context 注入 System Prompt）",
    type: "string",
  });

  // ========== session_start：读默认 blueprint + 转译 + footer 状态 ==========
  pi.on("session_start", async (_event, ctx) => {
    lastCwd = ctx.cwd;
    try {
      const flag = pi.getFlag("pt-context");
      const flagVal = typeof flag === "string" && flag.trim() ? flag.trim() : undefined;

      const fromSettings = await readProjectSetting<string>(ctx.cwd, "au.pt-context");
      const auto = await detectSingleScene(ctx.cwd);

      const picked = flagVal ?? fromSettings ?? auto;

      if (!picked) {
        ctx.ui.setStatus("pt", "pt: 无 context");
        ctx.ui.notify("Pt：未找到 Blueprint。用 /pt-context <name> 选择，或在 .pi/settings.json 设 au.pt-context。", "info");
        return;
      }

      await transpileActive(ctx.cwd, picked);
      ctx.ui.setStatus("pt", `pt: ${picked}`);
    } catch (e) {
      ctx.ui.notify(`Pt 加载失败：${errMsg(e)}`, "error");
      ctx.ui.setStatus("pt", "pt: 加载失败");
      cachedSegment = null;
      cachedBundles = null;
    }
  });

  // ========== before_agent_start：每轮注入 cachedSegment + 缓存最终 prompt ==========
  pi.on("before_agent_start", async (event) => {
    if (!cachedSegment) return undefined;
    const finalPrompt = event.systemPrompt + "\n\n## 当前任务上下文\n\n" + cachedSegment;
    lastBuiltPrompt = finalPrompt;
    return { systemPrompt: finalPrompt };
  });

  // ========== input（Phase 7）：Pt 接管 FlowTemplate 展开 ==========
  // Pt 只拦截 cachedBundles 里声明过的 /name，其余 /name 放行给 Pi 原生 $1 $2。
  pi.on("input", async (event) => {
    const match = event.text.match(/^\/(\S+)\s*(.*)$/);
    if (!match) return { action: "continue" };
    const [, tplName, args] = match;

    const tpl = findFlow(tplName);
    if (!tpl) return { action: "continue" };  // 非 Pt 管的，放行给 Pi 原生

    const expanded = bindFlowTemplate(tpl, args);
    return { action: "transform", text: expanded };
  });

  // ========== session_shutdown：清内存态 ==========
  pi.on("session_shutdown", async () => {
    cachedSegment = null;
    cachedBundles = null;
    activeBlueprint = null;
    lastBuiltPrompt = null;
  });

  // ========== /pt-context 命令：即时切换 ==========
  pi.registerCommand("pt-context", {
    description: "切换当前 Blueprint（编译成 Context 注入 System Prompt），即时重转译（无参则弹出选择器）",
    getArgumentCompletions: async (prefix) => {
      const names = await listScenes(lastCwd);
      const items = names.map((n) => ({ value: n, label: n }));
      const hit = items.filter((i) => i.value.startsWith(prefix));
      return hit.length > 0 ? hit : null;
    },
    handler: async (args, ctx) => {
      const name = args.trim();
      if (!name) {
        const names = await listScenes(ctx.cwd);
        if (names.length === 0) {
          ctx.ui.notify("未找到任何 Blueprint（.pt/assets/blueprints/*.blueprint.md）", "warning");
          return;
        }
        if (!ctx.hasUI) {
          ctx.ui.notify("/pt-context（无参）在非交互模式不可用，请指定名称", "warning");
          return;
        }
        const picked = await ctx.ui.select("选择 Blueprint", names);
        if (!picked) return;
        await switchBlueprint(pi, ctx, picked);
        return;
      }
      await switchBlueprint(pi, ctx, name);
    },
  });

  // ========== /pt 命令：查看 Pt 编译产物 ==========
  pi.registerCommand("pt", {
    description: "查看 Pt 转译产物 / 状态（无参=显示当前 segment）",
    handler: async (args, ctx) => {
      const sub = args.trim().toLowerCase();

      if (sub === "status" || sub === "") {
        const flowCount = cachedBundles?.reduce((acc, b) => {
          let n = 0;
          for (const d of b.domains) if (d.type === "workflow") {
            const tpls = (d.modules["Manual"] as unknown[] | undefined) ?? [];
            n += tpls.length;
          }
          return acc + n;
        }, 0) ?? 0;
        const domainCount = cachedBundles?.reduce((acc, b) => acc + b.domains.length, 0) ?? 0;
        const channelCount = cachedBundles?.reduce((acc, b) => acc + b.channels.length, 0) ?? 0;
        const bpCount = cachedBundles?.reduce((acc, b) => acc + b.blueprints.length, 0) ?? 0;
        const lines = [
          `pt context: ${activeBlueprint ?? "(未激活)"}`,
          `pt domains: ${domainCount}, channels: ${channelCount}, blueprints: ${bpCount}, flows: ${flowCount}`,
          `pt segment length: ${cachedSegment?.length ?? 0} chars`,
          `pt cache hit: ${lastCacheHit ? "yes" : "no"}`,
          `pt last built prompt: ${lastBuiltPrompt ? `${lastBuiltPrompt.length} chars` : "(未跑过 turn)"}`,
          `pt cwd: ${lastCwd}`,
        ];
        ctx.ui.notify(lines.join(" | "), "info");
        if (sub === "" && cachedSegment) {
          ctx.ui.notify(cachedSegment, "info");
        }
        return;
      }

      if (sub === "flows") {
        if (!cachedBundles || cachedBundles.length === 0) {
          ctx.ui.notify("无激活 Blueprint，先用 /pt-context <name> 激活", "warning");
          return;
        }
        const flows: Array<{ name: string; hint?: string; domain: string }> = [];
        for (const b of cachedBundles) {
          const bp = b.blueprints.find((x) => x.name === b.activeBlueprint);
          if (!bp) continue;
          // v8：遍历 blueprint.injectionPoints 里 target=context_message 的注入点的 domains
          for (const ip of bp.injectionPoints) {
            for (const dn of ip.domains) {
              const d = b.domains.find((x) => x.name === dn);
              if (!d || d.type !== "workflow") continue;
              const tpls = (d.modules["Manual"] as Array<{ name: string; argumentHint?: string }> | undefined) ?? [];
              for (const t of tpls) {
                flows.push({ name: t.name, hint: t.argumentHint, domain: d.name });
              }
            }
          }
        }
        if (flows.length === 0) {
          ctx.ui.notify("当前 Blueprint 无可触发手册（target=context_message 注入点无 workflow-type Domain）", "info");
        } else {
          const lines = flows.map((f) => `  /${f.name} ${f.hint ?? ""}  ← ${f.domain}`);
          ctx.ui.notify(`可用手册（输入 /手册名 参数 触发 Context Message）:\n${lines.join("\n")}`, "info");
        }
        return;
      }

      if (sub === "raw") {
        if (!cachedSegment) {
          ctx.ui.notify("无 segment 可显示", "warning");
          return;
        }
        const dir = join(ctx.cwd, ".pt", "raws");
        await mkdir(dir, { recursive: true });
        const file = join(dir, `segment-${Date.now()}.md`);
        await writeFile(file, cachedSegment, "utf8");
        ctx.ui.notify(`已写入 ${file}（${cachedSegment.length} chars）`, "info");
        return;
      }

      if (sub === "full") {
        const full = lastBuiltPrompt ?? ctx.getSystemPrompt();
        if (!lastBuiltPrompt) {
          ctx.ui.notify("警告：尚无 agent turn 跑过，拿到的是 base prompt（无 Pt 段）。先发一条消息再 /pt full", "warning");
        }
        const dir = join(ctx.cwd, ".pt", "fulls");
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

// 暴露 activeBlueprint 用于调试（未来可挂 /pt status）
export function _debugActive(): { blueprint: string | null; segmentLen: number; flowCount: number; cacheHit: boolean } {
  const flowCount = cachedBundles?.reduce((acc, b) => {
    let n = 0;
    for (const d of b.domains) if (d.type === "workflow") {
      const tpls = (d.modules["Manual"] as unknown[] | undefined) ?? [];
      n += tpls.length;
    }
    return acc + n;
  }, 0) ?? 0;
  return { blueprint: activeBlueprint, segmentLen: cachedSegment?.length ?? 0, flowCount, cacheHit: lastCacheHit };
}