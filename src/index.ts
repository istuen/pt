// src/index.ts — Pi 扩展入口（v9）
//
// v9 用户面命令：--pt-profile（flag）/ /pt-profile（命令），对应"激活 Profile → 编译 AgentContext"。
//   "profile" 在 v9 是配置层概念（引用 Blueprint + 选 Domains），用户面命令强调产物是 AgentContext。
//
// 注入用 AgentAdapter（默认 Pi）封装 before_agent_start + input 事件。
//
// Tech Debt T11: per-session 状态收拢到 SessionState（src/session.ts），不再 10 个模块级 let。
//
// v10.x（issue pt-context-persist-lost 修复）：
//   - session_start fallback 链加第四源：session JSONL（`pi.appendEntry()` 持久化）。
//     优先级：flag > settings > session > auto。session 优先于 auto，保留用户上次选择。
//   - switchProfile / session_start 加载成功后调 `pi.appendEntry()` 把 activeProfile 写回 session。
//     session entry 与 Pi Session 生命周期对齐（resume/--session/--fork 继承；/new/ephemeral 不继承）。
//
// v12.x（issue pt-session-singleton-pi-web-pollution 修复）：
//   - 移除 module-level `session` 单例访问，state 容器改为 Map<sessionId, SessionState>
//   - 所有 handler 入口从 `ctx.sessionManager.getSessionId()` 拿 sessionId，传给 per-session 函数
//   - `getAgentAdapter(pi, ...)` 返回 per-pi adapter（每个 session 一个 PiAdapter 实例）
//   - tool handler 通过 `ctx.sessionManager.getSessionId()` 取 per-session state
//   - `session_shutdown` 调 `clearSessionById(sessionId)` 精确清本 session

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { FULL_DIR, MANUAL_DIR, PROFILES_DIR, RAW_DIR } from "./constants.js";
import { toAgentAPI } from "./agent/api-bridge.js";
import { getAgentAdapter } from "./agent/index.js";
import { detectSingleProfile, listProfiles, readProjectSetting } from "./config.js";
import { errMsg } from "./diagnostics.js";
import { readProfileFromSession, persistProfileToSession } from "./profile-persist.js";
import { LOG_DIR, PtLogger } from "./log.js";
import { type ProfileLoadSource, clearSessionById, getSessionById } from "./session.js";
import { buildFullPrompt, buildManualDoc, flowsText, statusText } from "./commands.js";
import { loadAndTranspile } from "./transpile.js";
import type { AgentAPI } from "./schema.js";
import {
  persistManualToSession,
  refreshInjectionFooter,
  refreshManualWidget,
  tryRestoreManual,
} from "./manual-session.js";
import { slog } from "./slog.js";

type AgentUIContext = NonNullable<AgentAPI["ui"]>;

// ==================== Pi 事件本地接口（P2.3 抽出） ====================
//
// Pi ExtensionAPI 的 on() 回调 event 参数是 unknown（pi 包顶层 export.d.ts 描述为 unknown[]）。
// 实际形状来自 pi runtime（@earendil-works/pi-coding-agent 的内部 emit 逻辑）。
// 为消 index.ts ×3 双重 cast，定义本地结构接口——只用到的字段。

/** pi.on("turn_end", handler) event 形状。 */
interface PiTurnEndEvent {
  reason?: string;
  messageCount?: number;
}

/** pi.on("tool_call", handler) event 形状。 */
interface PiToolCallEvent {
  name?: string;
  toolName?: string;
}

/** pi.on("tool_result", handler) event 形状。 */
interface PiToolResultEvent {
  name?: string;
  toolName?: string;
  isError?: boolean;
}

/** 从 ExtensionContext 拿 sessionId（tool / command handler ctx 形态）。 */
function getSessionIdFromCtx(ctx: { sessionManager?: { getSessionId?: () => string } }): string {
  return ctx.sessionManager?.getSessionId?.() ?? "";
}

/** 当前编译产物就绪时注册 Adapter 注入；session_start 与手动切换共用。
 *  v12.x：传 pi + sessionId，按 sessionId 拿 per-session state，按 pi 拿 per-pi adapter。 */
function registerInjectionIfReady(
  pi: ExtensionAPI,
  ctx: { ui: AgentUIContext },
  sessionId: string
): boolean {
  if (!sessionId) return false;
  const sessionState = getSessionById(sessionId);
  const adapter = sessionState.activeAdapter;
  const context = sessionState.cachedAgentContext;
  const blueprint = sessionState.cachedBlueprint;
  if (!adapter || !context || !blueprint) return false;

  adapter.registerInject(toAgentAPI(pi, ctx), context, blueprint, sessionState.cachedDomains);
  return true;
}

/** 转译当前选定的 Profile，结果写入 per-session state；失败降级。
 *  v12.x：pi + sessionId 参数，按 sessionId 写 per-session state，按 pi 拿 per-pi adapter。 */
async function transpileActive(
  pi: ExtensionAPI,
  cwd: string,
  profileName: string,
  sessionId: string,
  notify: (msg: string, level: "warning" | "error") => void
): Promise<void> {
  const t0 = Date.now();
  slog(sessionId, "info", "transpileActive:start", { profileName });

  try {
    const result = await loadAndTranspile(cwd, profileName, {
      notify,
      log: getSessionById(sessionId).logger?.toWriter(),
    });
    const s = getSessionById(sessionId);
    s.cachedSegment = result.segment;
    s.cachedBundles = result.bundles;
    s.cachedAgentContext = result.agentContext;
    s.cachedBlueprint = result.blueprint;
    s.cachedDomains = result.domains;
    s.cachedProfile = result.profile;
    s.activeProfile = profileName;
    s.lastCacheHit = result.cacheHit;

    // v12.x：per-pi adapter——registry.ts 给每个 pi 一个新 PiAdapter 实例，
    // 单例字段 this.segment 不会被其他 session 覆盖。
    s.activeAdapter = getAgentAdapter(pi, result.blueprint.agent);
    s.activeAdapter.setAgentContext(result.agentContext, result.blueprint, result.domains);

    slog(sessionId, "info", "transpileActive:done", {
      profileName,
      agent: result.blueprint.agent,
      domainCount: result.domains.length,
      segmentLen: result.segment.length,
      cacheHit: result.cacheHit,
      durationMs: Date.now() - t0,
    });
  } catch (e) {
    slog(sessionId, "error", "transpileActive:failed", {
      err: errMsg(e),
      profileName,
      durationMs: Date.now() - t0,
    });
    throw e;
  }
}

/** 切换 Profile：重转译 + 通知 + 持久化。
 *  v12.x：sessionId 参数。 */
async function switchProfile(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  name: string
): Promise<void> {
  const sessionId = getSessionIdFromCtx(ctx);
  slog(sessionId, "info", "command:switchProfile start", { profileName: name });
  try {
    await transpileActive(pi, ctx.cwd, name, sessionId, (msg, level) => ctx.ui.notify(msg, level));
    const s = getSessionById(sessionId);
    s.loadedFrom = null; // 用户手动切换不属于 auto/flag/settings/session 任何源；null 表达"用户主动"
    persistProfileToSession(pi, name); // v10.x：session 持久化（issue pt-context-persist-lost）
    const injected = registerInjectionIfReady(pi, ctx, sessionId);
    // v11.x：切换后立即标 pending，等下一轮 before_agent_start 翻成 injected
    s.injectionState = "pending";
    s.injectionError = null;
    refreshInjectionFooter(ctx.ui, s);
    await refreshManualWidget(ctx.ui, s);
    slog(sessionId, "info", "command:switchProfile inject", { profileName: name, injected });
    const hint = s.lastCacheHit ? "（缓存命中）" : "（已重编译）";
    ctx.ui.notify(`已切换到 ${name}，下一轮生效 ${hint}`, "info");
    slog(sessionId, "info", "command:switchProfile done", {
      profileName: name,
      cacheHit: s.lastCacheHit,
    });
  } catch (e) {
    ctx.ui.notify(`切换失败：${errMsg(e)}`, "error");
    slog(sessionId, "error", "command:switchProfile failed", {
      profileName: name,
      err: errMsg(e),
    });
  }
}

export default function (pi: ExtensionAPI): void {
  // 启动时 flag（CLI 优先）
  // Phase term-P2：pt-context → pt-profile（命令参数是 Profile 名，名该匹配操作目标）。
  //   向后兼容：--pt-context（flag）和 pt.pt-context/au.pt-context（settings key）作为 fallback 保留——
  //   用户升级 Pt 后旧配置仍能工作，新配置优先。
  pi.registerFlag("pt-profile", {
    description: "启动时激活的 Profile 名（编译成 AgentContext 注入 System Prompt）",
    type: "string",
  });

  // ========== session_start：生成 sessionId + 创 logger + 读默认 profile + 转译 + 注册 adapter ==========
  // v10.x（issue pt-context-persist-lost 修复）：fallback 链加第四源（session JSONL）。
  //   优先级：flag > settings > session > auto。
  //   session 优先于 auto——保留用户上次选择，避免项目级 auto（>1 project profile 时）抹除用户偏好。
  //   加载成功后调 `persistProfileToSession(pi, picked)` 把来源同步到 JSONL
  //     （flag/settings/session 任意来源加载的 profile 都写回 session，作为下次 fallback 的首选）。
  // v11.x：fallback 链额外加 manual 恢复（独立于 profile 链——profile 失败不影响 manual 恢复）。
  //   manual 读出后校验文件存在 + status !== completed；满足才挂载 widget。
  // v12.x：从 ctx.sessionManager.getSessionId() 拿 sessionId，按 sessionId 写 per-session state。
  pi.on("session_start", async (_event, ctx) => {
    const sessionId = getSessionIdFromCtx(ctx);
    if (!sessionId) {
      ctx.ui.notify("Pt：无法获取 session id（pi 版本不兼容）", "error");
      return;
    }
    const s = getSessionById(sessionId);
    s.sessionId = randomUUID().slice(0, 8); // 短期 ID for logger
    s.logger = new PtLogger(ctx.cwd, "", sessionId);
    s.logger.info("session:start", { sessionId: s.sessionId, cwd: ctx.cwd });

    s.lastCwd = ctx.cwd;
    try {
      // Phase term-P2：flag/settings 链主读新名（pt-profile），旧名（pt-context）作 fallback 兼容。
      const flag = pi.getFlag("pt-profile") ?? pi.getFlag("pt-context");
      const flagVal = typeof flag === "string" && flag.trim() ? flag.trim() : undefined;

      const fromSettings =
        (await readProjectSetting<string>(ctx.cwd, "pt.pt-profile")) ??
        (await readProjectSetting<string>(ctx.cwd, "au.pt-profile")) ??
        (await readProjectSetting<string>(ctx.cwd, "pt.pt-context")) ?? // 向后兼容：旧 settings key
        (await readProjectSetting<string>(ctx.cwd, "au.pt-context"));
      const fromSession = readProfileFromSession(ctx.sessionManager); // v10.x
      const auto = await detectSingleProfile(ctx.cwd);

      // 显式分支记录来源（便于 /pt status 展示 + trace）
      let picked: string | undefined;
      let pickedFrom: ProfileLoadSource;
      if (flagVal) {
        picked = flagVal;
        pickedFrom = "flag";
      } else if (fromSettings) {
        picked = fromSettings;
        pickedFrom = "settings";
      } else if (fromSession) {
        picked = fromSession;
        pickedFrom = "session";
      } else if (auto) {
        picked = auto;
        pickedFrom = "auto";
      } else {
        picked = undefined;
        pickedFrom = null;
      }

      if (!picked) {
        s.injectionState = "idle";
        s.injectionError = null;
        refreshInjectionFooter(ctx.ui, s);
        ctx.ui.notify(
          "Pt：未找到 Profile。用 /pt-profile <name> 选择，或在 .pi/settings.json 设 pt.pt-profile。",
          "info"
        );
        s.loadedFrom = null;
        s.logger.info("session:no profile picked", {
          flagVal,
          fromSettings,
          fromSession,
          auto,
        });
        // v11.x：manual fallback 即使无 profile 也要试（手动追踪可独立于 profile）
        await tryRestoreManual(ctx, s);
        return;
      }

      await transpileActive(pi, ctx.cwd, picked, sessionId, (msg, level) =>
        ctx.ui.notify(msg, level)
      );
      s.loadedFrom = pickedFrom; // v10.x：可观测性
      persistProfileToSession(pi, picked); // v10.x：把当前来源同步到 JSONL（下次进程默认走 session）
      // 注册 AgentAdapter 注入（封装 before_agent_start + input）
      const injected = registerInjectionIfReady(pi, ctx, sessionId);
      // v11.x：profile 已加载但还没轮到下一轮 before_agent_start → pending
      s.injectionState = "pending";
      s.injectionError = null;
      refreshInjectionFooter(ctx.ui, s);
      s.logger.info("session:profile loaded", {
        profileName: picked,
        loadedFrom: pickedFrom,
        injected,
      });

      // v11.x：profile 加载后试恢复 manual（独立于 profile 链）
      await tryRestoreManual(ctx, s);
    } catch (e) {
      ctx.ui.notify(`Pt 加载失败：${errMsg(e)}`, "error");
      s.injectionState = "failed";
      s.injectionError = errMsg(e);
      refreshInjectionFooter(ctx.ui, s);
      s.cachedSegment = null;
      s.cachedBundles = null;
      s.loadedFrom = null;
      s.logger?.error("session:start failed", { err: errMsg(e) });
      // v11.x：profile 失败但 manual 仍可能独立恢复（手动追踪不依赖 profile）
      await tryRestoreManual(ctx, s);
    }
  });

  // ========== session_shutdown：flush logger + 清内存态 ==========
  // v10.x：先 flush 避免丢尾，再 reset 清状态
  // v11.x：resetSession 覆盖 injectionState / activeManual / cachedManualProgress（widget 不持久）
  // v12.x：调 clearSessionById(sessionId) 精确清本 session state，pi-web 多 session 互不污染
  pi.on("session_shutdown", async (_event, ctx) => {
    const sessionId = getSessionIdFromCtx(ctx);
    if (!sessionId) return;
    const s = getSessionById(sessionId);
    if (s.logger) {
      s.logger.info("session:shutdown");
      await s.logger.flush();
    }
    // 同一运行时保留 Pi handler 绑定，但清除旧 session 的 segment/context，
    // 避免新 session 在尚未重新选择 Profile 时继续注入旧内容。
    s.activeAdapter?.resetInjection?.();
    clearSessionById(sessionId);
  });

  // ========== turn 级 trace（P2: 覆盖 turn 生命周期） ==========
  // 任何 turn 异常都能从日志反查；不写入主要因为 UI 噪音，只到 file log。
  pi.on("turn_start", async (_event, ctx) => {
    slog(getSessionIdFromCtx(ctx), "debug", "turn:start");
  });
  pi.on("turn_end", async (event, ctx) => {
    // v10.x：event 形态可能包含 token 用量，先取几个字段塞进 ctx
    const e = event as PiTurnEndEvent;
    slog(getSessionIdFromCtx(ctx), "debug", "turn:end", {
      reason: e.reason,
      messageCount: e.messageCount,
    });
  });
  pi.on("agent_settled", async (_event, ctx) => {
    slog(getSessionIdFromCtx(ctx), "debug", "agent:settled");
  });
  pi.on("tool_call", async (event, ctx) => {
    const e = event as PiToolCallEvent;
    slog(getSessionIdFromCtx(ctx), "debug", "tool:call", { name: e.name ?? e.toolName });
  });
  pi.on("tool_result", async (event, ctx) => {
    const e = event as PiToolResultEvent;
    slog(getSessionIdFromCtx(ctx), "debug", "tool:result", {
      name: e.name ?? e.toolName,
      isError: e.isError,
    });
  });

  // ========== /pt-profile 命令：即时切换 ==========
  // Phase term-P2：/pt-context → /pt-profile（命令参数是 Profile 名，名该匹配操作目标）。
  pi.registerCommand("pt-profile", {
    description:
      "切换当前 Profile（编译成 AgentContext 注入 System Prompt），即时重转译（无参则弹出选择器）",
    getArgumentCompletions: async (prefix) => {
      const sessionId = getSessionIdFromCtx({
        sessionManager: undefined,
      });
      const cwd = (sessionId && getSessionById(sessionId).lastCwd) || process.cwd(); // Q1 修复：fallback 到 process.cwd()
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
          ctx.ui.notify("/pt-profile（无参）在非交互模式不可用，请指定名称", "warning");
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
      // v11.x 修复：原来 `sub = args.trim()` 会把整个 args 作为 sub，导致 `/pt manual <proc>` 时
      //   `sub === "manual"` 永远不成立。改为：sub = 第一词，subArgs = 剩余。
      //   兼容现有 logs:clear / status / flows 等单子命令（不带额外参数）行为不变。
      const firstSpace = args.indexOf(" ");
      const head = firstSpace === -1 ? args : args.slice(0, firstSpace);
      const tail = firstSpace === -1 ? "" : args.slice(firstSpace + 1);
      const sub = head.trim().toLowerCase();
      const subArgs = tail;
      const sessionId = getSessionIdFromCtx(ctx);
      slog(sessionId, "info", "command:/pt invoked", { sub }); // v10.x: P4 子命令 trace

      if (!sessionId) {
        ctx.ui.notify("Pt：无法获取 session id（pi 版本不兼容）", "error");
        return;
      }
      const s = getSessionById(sessionId);

      if (sub === "status" || sub === "") {
        ctx.ui.notify(statusText(s), "info");
        if (sub === "" && s.cachedSegment) {
          ctx.ui.notify(s.cachedSegment, "info");
        }
        return;
      }

      if (sub === "flows") {
        ctx.ui.notify(flowsText(s), "info");
        return;
      }

      if (sub === "logs") {
        // v10.x：默认查当前 session 的日志（sessionId = 8-hex 短 id）。
        // 如无 session_id（极早期未走 session_start），fallback 到 pt.log。
        const files = await PtLogger.list(ctx.cwd);
        if (files.length === 0) {
          ctx.ui.notify(`无日志（${LOG_DIR}/ 不存在）`, "info");
          return;
        }
        // 优先当前 session，其次最近修改的 session file，最后 fallback 主文件
        let targetFile = `pt-${s.sessionId}.log`;
        if (!files.includes(targetFile)) {
          if (files.includes("pt.log")) targetFile = "pt.log";
          else targetFile = files[files.length - 1];
        }
        // 简化: 直接读 targetFile
        const lines = await PtLogger.tail(
          ctx.cwd,
          50,
          targetFile === "pt.log" ? undefined : targetFile.slice(3, -4)
        );
        if (lines.length === 0) {
          ctx.ui.notify(`日志为空（${targetFile}）`, "info");
          return;
        }
        const formatted = lines
          .map((e) => {
            const stamp = e.ts.slice(11, 23); // HH:MM:SS.mmm
            const lvl = e.level.toUpperCase().padEnd(7);
            const ctxStr =
              e.ctx && Object.keys(e.ctx).length > 0 ? ` ${JSON.stringify(e.ctx)}` : "";
            return `[${stamp}] [${lvl}] ${e.msg}${ctxStr}`;
          })
          .join("\n");
        const header = `(${targetFile}，最近 ${lines.length} 条; 共 ${files.length} 个 session 文件)`;
        ctx.ui.notify(`${header}\n${formatted}`, "info");
        return;
      }

      if (sub === "logs:clear") {
        await PtLogger.clear(ctx.cwd, s.sessionId || undefined);
        ctx.ui.notify(
          `已清空 .pt/logs/${s.sessionId ? `pt-${s.sessionId}.log` : "pt.log"}`,
          "info"
        );
        return;
      }

      if (sub === "sessions") {
        // v10.x：列出所有 session 的日志文件（多并发 pi 调试用）。
        const files = await PtLogger.list(ctx.cwd);
        if (files.length === 0) {
          ctx.ui.notify("无 session 日志文件", "info");
          return;
        }
        ctx.ui.notify(
          `已存在的 session 日志:\n${files.map((f) => `  ${f}${f === `pt-${s.sessionId}.log` ? " (current)" : ""}`).join("\n")}`,
          "info"
        );
        return;
      }

      if (sub === "raw") {
        if (!s.cachedSegment) {
          ctx.ui.notify("无 segment 可显示", "warning");
          return;
        }
        const dir = join(ctx.cwd, RAW_DIR);
        await mkdir(dir, { recursive: true });
        const file = join(dir, `segment-${Date.now()}.md`);
        await writeFile(file, s.cachedSegment, "utf8");
        ctx.ui.notify(`已写入 ${file}（${s.cachedSegment.length} chars）`, "info");
        return;
      }

      if (sub === "full") {
        // v10.x（fix pt-full-duplicate-segment）：用 lastBuiltPrompt 作 canonical source
        // 第一轮之后 = LLM 实际看到的；第一轮之前 fallback 到模拟注入（保留旧版语义）
        const full = buildFullPrompt(ctx.getSystemPrompt(), s.cachedSegment, s.lastBuiltPrompt);
        if (!s.cachedSegment) {
          ctx.ui.notify(
            "警告：无 cachedSegment（未加载 Profile）。用 /pt-profile <name> 选择",
            "warning"
          );
        }
        const dir = join(ctx.cwd, FULL_DIR);
        await mkdir(dir, { recursive: true });
        const file = join(dir, `prompt-${Date.now()}.md`);
        await writeFile(file, full, "utf8");
        ctx.ui.notify(`完整 systemPrompt 已写入 ${file}（${full.length} chars）`, "info");
        return;
      }

      if (sub === "manual") {
        // v11.x 修复：subArgs 才是 procedure 参数（原 code 会拿到 "manual"）
        const procedureParts = subArgs.trim().split(/\s+/);
        const procedureName = procedureParts[0] ?? "";
        const procedureArgs = procedureParts.slice(1).join(" ");
        const r = buildManualDoc(ctx.cwd, s, procedureName, procedureArgs);
        if (r.error) {
          ctx.ui.notify(r.error, "warning");
          return;
        }
        await mkdir(join(ctx.cwd, MANUAL_DIR), { recursive: true });
        await writeFile(r.filePath, r.content, "utf8");
        // v11.x：手动跟踪实例 + widget + footer + 持久化
        s.activeManual = {
          filePath: r.filePath,
          procedure: procedureName,
          args: procedureArgs,
          activatedAt: Date.now(),
        };
        persistManualToSession(pi, s.activeManual);
        await refreshManualWidget(ctx.ui, s);
        refreshInjectionFooter(ctx.ui, s);
        ctx.ui.notify(`手册实例已创建: ${r.filePath}`, "info");
        return;
      }

      ctx.ui.notify("用法: /pt [status|flows|raw|full|manual|logs|logs:clear|sessions]", "warning");
    },
  });

  // ========== tool 壳：LLM 可调（与 command 共享纯函数内核，.pt/docs/designs/pt-command-tool-dual-registration.md） ==========
  // 只读查询 + 手册实例化做 tool；pt-profile（改 system prompt）不做 tool（见设计文档 §2.4）

  pi.registerTool({
    name: "pt_status",
    label: "Pt Status",
    description:
      "Show Pt compilation status: active profile, domain/flow counts, segment length, cache hit. Read-only.",
    promptSnippet: "Show Pt status (profile, counts, cache)",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const sessionId = getSessionIdFromCtx(ctx);
      const s = sessionId ? getSessionById(sessionId) : null;
      return {
        content: [{ type: "text", text: s ? statusText(s) : "no session" }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "pt_flows",
    label: "Pt Flows",
    description:
      "List available FlowTemplate manuals in the active Profile. Call before starting a procedure to see what's available. Read-only.",
    promptSnippet: "List available Pt manuals (FlowTemplates)",
    promptGuidelines: [
      "Use pt_flows when you need to know which Pt manuals are available before starting a multi-step procedure.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const sessionId = getSessionIdFromCtx(ctx);
      const s = sessionId ? getSessionById(sessionId) : null;
      return {
        content: [{ type: "text", text: s ? flowsText(s) : "no session" }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "pt_manual",
    label: "Pt Manual",
    description:
      "Create a manual instance document (.pt/manuals/<procedure>-<ts>.md) with checklist + artifact log. Use when starting a multi-step procedure like feature-lifecycle. Returns the file path.",
    promptSnippet: "Instantiate a Pt manual document with checklist for tracking",
    promptGuidelines: [
      "Use pt_manual when starting a multi-step procedure (e.g., feature-lifecycle, issue-lifecycle, regression-verify) to get a persistent checklist + artifact log.",
    ],
    parameters: Type.Object({
      procedure: Type.String({
        description:
          "FlowTemplate name, e.g. feature-lifecycle, issue-lifecycle, regression-verify",
      }),
      args: Type.Optional(
        Type.String({
          description: "Arguments for the procedure, e.g. 'req-001' or 'term my-concept'",
        })
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = getSessionIdFromCtx(ctx);
      if (!sessionId) {
        return {
          content: [{ type: "text", text: "no session" }],
          details: { error: "no session" },
        };
      }
      const s = getSessionById(sessionId);
      const r = buildManualDoc(ctx.cwd, s, params.procedure, params.args ?? "");
      if (r.error) {
        return { content: [{ type: "text", text: r.error }], details: { error: r.error } };
      }
      return withFileMutationQueue(r.filePath, async () => {
        await mkdir(join(ctx.cwd, MANUAL_DIR), { recursive: true });
        await writeFile(r.filePath, r.content, "utf8");
        // v11.x：手动跟踪实例 + widget + footer + 持久化
        s.activeManual = {
          filePath: r.filePath,
          procedure: params.procedure,
          args: params.args ?? "",
          activatedAt: Date.now(),
        };
        persistManualToSession(pi, s.activeManual);
        await refreshManualWidget(ctx.ui, s);
        refreshInjectionFooter(ctx.ui, s);
        return {
          content: [{ type: "text", text: `手册实例已创建: ${r.filePath}` }],
          details: { path: r.filePath },
        };
      });
    },
  });

  pi.registerTool({
    name: "pt_verify",
    label: "Pt Verify",
    description:
      "Run a verification probe to check if a Manual step was executed correctly. Returns COMPLETED/DEVIATED/INCONCLUSIVE. Use after completing a step that has an observe field.",
    promptSnippet: "Verify a Manual step execution result",
    promptGuidelines: [
      "Use pt_verify after completing a Manual step that has an observe field, to verify the execution result.",
    ],
    parameters: Type.Object({
      probe: Type.String({
        description:
          "Probe name from observe field (e.g. fs-content-match, ts-compiles, test-pass, git-status-clean)",
      }),
      params: Type.Optional(
        Type.Record(Type.String(), Type.String(), {
          description: "Probe parameters, e.g. { path: 'src/foo.ts', pattern: 'export' }",
        })
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { runVerify } = await import("./verify/index.js");
      const probeParams = (params.params ?? {}) as Record<string, string>;
      const result = await runVerify(ctx.cwd, params.probe, probeParams);
      const text =
        result.outcome === "COMPLETED"
          ? `✓ ${result.message}`
          : result.outcome === "DEVIATED"
            ? `✗ ${result.message}${result.actual ? `\n${result.actual}` : ""}`
            : `? ${result.message}`;
      // v11.x：verify 后重读文件刷新 widget（用户可能手动 tick 了 checklist）
      // 不改 session.activeManual，只 refresh 派生数据（widget + cachedManualProgress）
      const sessionId = getSessionIdFromCtx(ctx);
      const s = sessionId ? getSessionById(sessionId) : null;
      if (s?.activeManual) {
        await refreshManualWidget(ctx.ui, s);
        refreshInjectionFooter(ctx.ui, s);
      }
      return {
        content: [{ type: "text", text }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "pt_check_refs",
    label: "Pt Check Refs",
    description:
      "Check Profile→Blueprint→Domain reference integrity. Detects dangling references (Profile references non-existent Blueprint or Domain). Read-only.",
    promptSnippet: "Check Pt reference integrity",
    promptGuidelines: [
      "Use pt_check_refs to detect dangling references in Profile/Blueprint/Domain before committing asset changes.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const { checkAllRefs, formatRefCheckResult } = await import("./verify/ref-check.js");
      const sessionId = getSessionIdFromCtx(ctx);
      const s = sessionId ? getSessionById(sessionId) : null;
      const r = await loadAndTranspile(ctx.cwd, s?.activeProfile ?? "");
      const b = r.bundles[0];
      const result = checkAllRefs(b.profiles, b.blueprints, b.domains);
      return {
        content: [{ type: "text", text: formatRefCheckResult(result) }],
        details: result,
      };
    },
  });
}
