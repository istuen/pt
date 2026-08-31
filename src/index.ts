// src/index.ts — Pi 扩展入口
// Pi ExtensionAPI 用法见 pt-plugin-design.md §0 与 §5。
//
// v6 user 面命令：--scene（flag）/ /scene（命令），对应"激活 Scene struct → 注入 System Prompt"。
//   "blueprint" 在 v6 是 Struct.kind="blueprint"（动态结构，产 Manual），不是用户面入口名。
//
// Phase 7.1：从顶层 index.ts 迁入，import 路径改为相对 src/。

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { detectSingleScene, listScenes, readProjectSetting } from "./config.js";
import { loadAndTranspile } from "./transpile.js";
import { bindFlowTemplate, findFlowInBundle } from "./render/message.js";
import type { SchemaBundle, Struct } from "./schema.js";

// === per-session 内存态（每进程隔离 = 每会话隔离） ===
let activeScene: string | null = null;
let cachedSegment: string | null = null;
/** 缓存 SchemaBundle（含 domains/structs/flows），给 input handler 用 */
let cachedBundles: SchemaBundle[] | null = null;
let lastCwd: string = "";
/** 缓存上一次 before_agent_start 后的最终 systemPrompt（供 /pt full 读取） */
let lastBuiltPrompt: string | null = null;

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 转译当前选定的 Scene，结果写入 cachedSegment + cachedBundles；失败降级 */
async function transpileActive(cwd: string, sceneName: string): Promise<void> {
  const result = await loadAndTranspile(cwd, sceneName);
  cachedSegment = result.segment;
  cachedBundles = result.bundles;
  activeScene = sceneName;
}

/** 切换 Scene：重转译 + 通知 */
async function switchScene(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  name: string,
): Promise<void> {
  try {
    await transpileActive(ctx.cwd, name);
    ctx.ui.setStatus("pt", `pt: ${name}`);
    ctx.ui.notify(`已切换到 ${name}，下一轮生效`, "info");
  } catch (e) {
    ctx.ui.notify(`切换失败：${errMsg(e)}`, "error");
  }
}

/** 在 cachedBundles 里找指定名的 FlowTemplate（跨 bundle 查找，v6：从 workflow-Domain ## Blueprint 找） */
function findFlow(name: string) {
  if (!cachedBundles) return undefined;
  for (const b of cachedBundles) {
    const f = findFlowInBundle(b, name);
    if (f) return f;
  }
  return undefined;
}

/** 在 cachedBundles 里找指定 Scene 名对应的 Manual struct（同名成对约定） */
function findManualStruct(sceneName: string): Struct | undefined {
  if (!cachedBundles) return undefined;
  for (const b of cachedBundles) {
    const m = b.structs.find((s) => s.kind === "blueprint" && s.name === sceneName);
    if (m) return m;
  }
  return undefined;
}

export default function (pi: ExtensionAPI): void {
  // 启动时 flag（CLI 优先）
  pi.registerFlag("scene", {
    description: "启动时激活的 Scene struct 名（注入 System Prompt）",
    type: "string",
  });

  // ========== session_start：读默认 scene + 转译 + footer 状态 ==========
  pi.on("session_start", async (_event, ctx) => {
    lastCwd = ctx.cwd;
    try {
      const flag = pi.getFlag("scene");
      const flagVal = typeof flag === "string" && flag.trim() ? flag.trim() : undefined;

      // 兼容 v5 旧 setting key "au.blueprint"——v6 改用 "au.scene"。
      // 读顺序：新 key 优先；旧 key 兜底。
      const fromSettings =
        await readProjectSetting<string>(ctx.cwd, "au.scene") ??
        await readProjectSetting<string>(ctx.cwd, "au.blueprint");
      const auto = await detectSingleScene(ctx.cwd);

      const picked = flagVal ?? fromSettings ?? auto;

      if (!picked) {
        ctx.ui.setStatus("pt", "pt: 无 scene");
        ctx.ui.notify("Pt：未找到 Scene struct。用 /scene <name> 选择，或在 .pi/settings.json 设 au.scene。", "info");
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

  // ========== input（Phase 5）：Pt 接管 FlowTemplate 展开 ==========
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
    activeScene = null;
    lastBuiltPrompt = null;
  });

  // ========== /scene 命令：即时切换 ==========
  pi.registerCommand("scene", {
    description: "切换当前 Scene（注入 System Prompt），即时重转译（无参则弹出选择器）",
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
          ctx.ui.notify("未找到任何 Scene struct（.openxenon/assets/blueprints/*.scene.md）", "warning");
          return;
        }
        if (!ctx.hasUI) {
          ctx.ui.notify("/scene（无参）在非交互模式不可用，请指定名称", "warning");
          return;
        }
        const picked = await ctx.ui.select("选择 Scene struct", names);
        if (!picked) return;
        await switchScene(pi, ctx, picked);
        return;
      }
      await switchScene(pi, ctx, name);
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
          for (const d of b.domains) if (d.type === "workflow" && Array.isArray(d.blueprint)) n += d.blueprint.length;
          return acc + n;
        }, 0) ?? 0;
        const domainCount = cachedBundles?.reduce((acc, b) => acc + b.domains.length, 0) ?? 0;
        const structCount = cachedBundles?.reduce((acc, b) => acc + b.structs.length, 0) ?? 0;
        const lines = [
          `pt scene: ${activeScene ?? "(未激活)"}`,
          `pt domains: ${domainCount}, structs: ${structCount}, flows: ${flowCount}`,
          `pt segment length: ${cachedSegment?.length ?? 0} chars`,
          `pt last built prompt: ${lastBuiltPrompt ? `${lastBuiltPrompt.length} chars` : "(未跑过 turn)"}`,
          `pt cwd: ${lastCwd}`,
        ];
        ctx.ui.notify(lines.join(" | "), "info");
        if (sub === "" && cachedSegment) {
          ctx.ui.notify(cachedSegment, "info");
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

      ctx.ui.notify("用法: /pt [status|raw|full]", "warning");
    },
  });
}

// 暴露 activeScene 用于调试（未来可挂 /pt status）
export function _debugActive(): { scene: string | null; segmentLen: number; flowCount: number } {
  const flowCount = cachedBundles?.reduce((acc, b) => {
    let n = 0;
    for (const d of b.domains) if (d.type === "workflow" && Array.isArray(d.blueprint)) n += d.blueprint.length;
    return acc + n;
  }, 0) ?? 0;
  return { scene: activeScene, segmentLen: cachedSegment?.length ?? 0, flowCount };
}