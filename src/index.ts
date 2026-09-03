// src/index.ts — Pi 扩展入口（v9）
//
// v9 用户面命令：--pt-context（flag）/ /pt-context（命令），对应"激活 Profile → 编译 Context"。
//   "profile" 在 v9 是配置层概念（引用 Blueprint + 选 Domains），用户面命令强调产物是 Context。
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

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { FULL_DIR, MANUAL_DIR, MOD_MANUAL, PROFILES_DIR, RAW_DIR } from "./constants.js";
import { getAgentAdapter } from "./agent/index.js";
import { detectSingleProfile, listProfiles, readProjectSetting } from "./config.js";
import { LOG_DIR, PtLogger } from "./log.js";
import { findFlowInBlueprint } from "./render/context-message.js";
import { type ProfileLoadSource, resetSession, session } from "./session.js";
import {
  buildFullPrompt,
  buildManualDoc,
  filterDomainsByProfile,
  flowsText,
  statusText,
} from "./commands.js";
import { loadAndTranspile } from "./transpile.js";
import type { AgentAPI } from "./schema.js";

type AgentUIContext = NonNullable<AgentAPI["ui"]>;

/** session-scoped logger 快捷调用（session.logger 为 null 时静默——session_start 之前不可用）。 */
function slog(
  level: "debug" | "info" | "warn" | "error",
  msg: string,
  ctx?: Record<string, unknown>
): void {
  if (!session.logger) return;
  session.logger[level](msg, ctx);
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** v10.x：session JSONL 中用于持久化 activeProfile 的 custom entry customType。
 *  用 `pt:` 命名空间避免污染 pi 通用命名空间。 */
const PT_PROFILE_ENTRY = "pt:active-profile";

/** v10.x：从 session JSONL 读上次保存的 profile。
 *  - 反向遍历 entries，取最后一个 `pt:active-profile`（最新一次切换覆盖前一次）。
 *  - 静默 fallback：SessionManager 不可用 / ephemeral session / entry 损坏 → 返 undefined。
 *  - 不校验 profile 是否仍存在于 assets——校验留给 transpileActive（transpile 失败会被 session_start catch）。
 *  - 用结构类型而非 `ReadonlySessionManager`（该类型不在 pi 包顶层 export.d.ts 里）。 */
interface MinimalSessionManager {
  getEntries(): Array<{ type: string; customType?: string; data?: unknown }>;
}
function readProfileFromSession(sessionManager: MinimalSessionManager): string | undefined {
  try {
    const entries = sessionManager.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e && e.type === "custom" && e.customType === PT_PROFILE_ENTRY) {
        const data = (e as { data?: unknown }).data;
        if (data && typeof data === "object") {
          const profile = (data as { profile?: unknown }).profile;
          if (typeof profile === "string" && profile.trim()) {
            return profile.trim();
          }
        }
      }
    }
  } catch {
    // SessionManager 异常（如不存在 / 旧版 pi）→ 静默
  }
  return undefined;
}

/** v10.x：把当前 activeProfile 写入 session JSONL（Pi 自带持久化）。
 *  - 用 `pi.appendEntry()`（dist/core/extensions/types.d.ts:78 官方 API）。
 *  - 失败静默（ephemeral session / 旧版 pi 无此 API）——内存中 activeProfile 仍可用本进程。 */
function persistProfileToSession(pi: ExtensionAPI, name: string): void {
  try {
    if (typeof pi.appendEntry !== "function") return;
    pi.appendEntry(PT_PROFILE_ENTRY, { profile: name });
  } catch (e) {
    slog("warn", "persistProfileToSession failed", { profileName: name, err: errMsg(e) });
  }
}

/** 当前编译产物就绪时注册 Adapter 注入；session_start 与手动切换共用。 */
function registerInjectionIfReady(pi: ExtensionAPI, ctx: { ui: AgentUIContext }): boolean {
  const adapter = session.activeAdapter;
  const context = session.cachedContext;
  const blueprint = session.cachedBlueprint;
  if (!adapter || !context || !blueprint) return false;

  adapter.registerInject(toAgentAPI(pi, ctx), context, blueprint, session.cachedDomains);
  return true;
}

/** 转译当前选定的 Profile，结果写入 session；失败降级。
 *  v10.x：使用 session-scoped logger（不再 per-transpile 实例化）→ 多并发 session 隔离。 */
async function transpileActive(
  cwd: string,
  profileName: string,
  notify: (msg: string, level: "warning" | "error") => void
): Promise<void> {
  const t0 = Date.now();
  slog("info", "transpileActive:start", { profileName });

  try {
    const result = await loadAndTranspile(cwd, profileName, {
      notify,
      log: session.logger?.toWriter(),
    });
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

    slog("info", "transpileActive:done", {
      profileName,
      agent: result.blueprint.agent,
      domainCount: result.domains.length,
      segmentLen: result.segment.length,
      cacheHit: result.cacheHit,
      durationMs: Date.now() - t0,
    });
  } catch (e) {
    slog("error", "transpileActive:failed", {
      err: errMsg(e),
      profileName,
      durationMs: Date.now() - t0,
    });
    throw e;
  }
}

/** 切换 Profile：重转译 + 通知 + 持久化。
 *  v10.x：增 log entry，让会话 trace 能分辨"用户主动切换" vs "session_start 自动加载"。
 *  v10.x：成功后调 `persistProfileToSession(pi, name)` 把选择写到 session JSONL，下次进程启动自动恢复。 */
async function switchProfile(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  name: string
): Promise<void> {
  slog("info", "command:switchProfile start", { profileName: name });
  try {
    await transpileActive(ctx.cwd, name, (msg, level) => ctx.ui.notify(msg, level));
    session.loadedFrom = null; // 用户手动切换不属于 auto/flag/settings/session 任何源；null 表达"用户主动"
    persistProfileToSession(pi, name); // v10.x：session 持久化（issue pt-context-persist-lost）
    const injected = registerInjectionIfReady(pi, ctx);
    slog("info", "command:switchProfile inject", { profileName: name, injected });
    ctx.ui.setStatus("pt", `pt: ${name}`);
    const hint = session.lastCacheHit ? "（缓存命中）" : "（已重编译）";
    ctx.ui.notify(`已切换到 ${name}，下一轮生效 ${hint}`, "info");
    slog("info", "command:switchProfile done", {
      profileName: name,
      cacheHit: session.lastCacheHit,
    });
  } catch (e) {
    ctx.ui.notify(`切换失败：${errMsg(e)}`, "error");
    slog("error", "command:switchProfile failed", { profileName: name, err: errMsg(e) });
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

  // ========== session_start：生成 sessionId + 创 logger + 读默认 profile + 转译 + 注册 adapter ==========
  // v10.x（issue pt-context-persist-lost 修复）：fallback 链加第四源（session JSONL）。
  //   优先级：flag > settings > session > auto。
  //   session 优先于 auto——保留用户上次选择，避免项目级 auto（>1 project profile 时）抹除用户偏好。
  //   加载成功后调 `persistProfileToSession(pi, picked)` 把来源同步到 JSONL
  //     （flag/settings/session 任意来源加载的 profile 都写回 session，作为下次 fallback 的首选）。
  pi.on("session_start", async (_event, ctx) => {
    // v10.x：先生成 sessionId + logger，让后续事件 trace 有归属
    session.sessionId = randomUUID().slice(0, 8);
    session.logger = new PtLogger(ctx.cwd, "", session.sessionId);
    session.logger.info("session:start", { sessionId: session.sessionId, cwd: ctx.cwd });

    session.lastCwd = ctx.cwd;
    try {
      const flag = pi.getFlag("pt-context");
      const flagVal = typeof flag === "string" && flag.trim() ? flag.trim() : undefined;

      const fromSettings = await readProjectSetting<string>(ctx.cwd, "au.pt-context");
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
        ctx.ui.setStatus("pt", "pt: 无 context");
        ctx.ui.notify(
          "Pt：未找到 Profile。用 /pt-context <name> 选择，或在 .pi/settings.json 设 au.pt-context。",
          "info"
        );
        session.loadedFrom = null;
        session.logger.info("session:no profile picked", {
          flagVal,
          fromSettings,
          fromSession,
          auto,
        });
        return;
      }

      await transpileActive(ctx.cwd, picked, (msg, level) => ctx.ui.notify(msg, level));
      session.loadedFrom = pickedFrom; // v10.x：可观测性
      persistProfileToSession(pi, picked); // v10.x：把当前来源同步到 JSONL（下次进程默认走 session）
      // 注册 AgentAdapter 注入（封装 before_agent_start + input）
      const injected = registerInjectionIfReady(pi, ctx);
      ctx.ui.setStatus("pt", `pt: ${picked}`);
      session.logger.info("session:profile loaded", {
        profileName: picked,
        loadedFrom: pickedFrom,
        injected,
      });
    } catch (e) {
      ctx.ui.notify(`Pt 加载失败：${errMsg(e)}`, "error");
      ctx.ui.setStatus("pt", "pt: 加载失败");
      session.cachedSegment = null;
      session.cachedBundles = null;
      session.loadedFrom = null;
      session.logger?.error("session:start failed", { err: errMsg(e) });
    }
  });

  // ========== session_shutdown：flush logger + 清内存态 ==========
  // v10.x：先 flush 避免丢尾，再 reset 清状态
  pi.on("session_shutdown", async () => {
    if (session.logger) {
      session.logger.info("session:shutdown");
      await session.logger.flush();
    }
    // 同一运行时保留 Pi handler 绑定，但清除旧 session 的 segment/context，
    // 避免新 session 在尚未重新选择 Profile 时继续注入旧内容。
    session.activeAdapter?.resetInjection?.();
    resetSession();
  });

  // ========== turn 级 trace（P2: 覆盖 turn 生命周期） ==========
  // 任何 turn 异常都能从日志反查；不写入主要因为 UI 噪音，只到 file log。
  pi.on("turn_start", async (_event, _ctx) => {
    slog("debug", "turn:start");
  });
  pi.on("turn_end", async (event, _ctx) => {
    // v10.x：event 形态可能包含 token 用量，先取几个字段塞进 ctx
    const e = event as unknown as { reason?: string; messageCount?: number };
    slog("debug", "turn:end", { reason: e.reason, messageCount: e.messageCount });
  });
  pi.on("agent_settled", async (_event, _ctx) => {
    slog("debug", "agent:settled");
  });
  pi.on("tool_call", async (event, _ctx) => {
    const e = event as unknown as { name?: string; toolName?: string };
    slog("debug", "tool:call", { name: e.name ?? e.toolName });
  });
  pi.on("tool_result", async (event, _ctx) => {
    const e = event as unknown as { name?: string; toolName?: string; isError?: boolean };
    slog("debug", "tool:result", { name: e.name ?? e.toolName, isError: e.isError });
  });

  // ========== /pt-context 命令：即时切换 ==========
  pi.registerCommand("pt-context", {
    description:
      "切换当前 Profile（编译成 Context 注入 System Prompt），即时重转译（无参则弹出选择器）",
    getArgumentCompletions: async (prefix) => {
      const cwd = session.lastCwd || process.cwd(); // Q1 修复：fallback 到 process.cwd()
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
      slog("info", "command:/pt invoked", { sub }); // v10.x: P4 子命令 trace

      if (sub === "status" || sub === "") {
        ctx.ui.notify(statusText(), "info");
        if (sub === "" && session.cachedSegment) {
          ctx.ui.notify(session.cachedSegment, "info");
        }
        return;
      }

      if (sub === "flows") {
        ctx.ui.notify(flowsText(), "info");
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
        let targetFile = `pt-${session.sessionId}.log`;
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
        await PtLogger.clear(ctx.cwd, session.sessionId || undefined);
        ctx.ui.notify(
          `已清空 .pt/logs/${session.sessionId ? `pt-${session.sessionId}.log` : "pt.log"}`,
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
          `已存在的 session 日志:\n${files.map((f) => `  ${f}${f === `pt-${session.sessionId}.log` ? " (current)" : ""}`).join("\n")}`,
          "info"
        );
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
        // v10.x（fix pt-full-duplicate-segment）：用 lastBuiltPrompt 作 canonical source
        // 第一轮之后 = LLM 实际看到的；第一轮之前 fallback 到模拟注入（保留旧版语义）
        const full = buildFullPrompt(
          ctx.getSystemPrompt(),
          session.cachedSegment,
          session.lastBuiltPrompt
        );
        if (!session.cachedSegment) {
          ctx.ui.notify(
            "警告：无 cachedSegment（未加载 Profile）。用 /pt-context <name> 选择",
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
        const parts = args.trim().split(/\s+/);
        const procedureName = parts[0];
        const procedureArgs = parts.slice(1).join(" ");
        const r = buildManualDoc(ctx.cwd, procedureName, procedureArgs);
        if (r.error) {
          ctx.ui.notify(r.error, "warning");
          return;
        }
        await mkdir(join(ctx.cwd, MANUAL_DIR), { recursive: true });
        await writeFile(r.filePath, r.content, "utf8");
        ctx.ui.notify(`手册实例已创建: ${r.filePath}`, "info");
        return;
      }

      ctx.ui.notify("用法: /pt [status|flows|raw|full|manual|logs|logs:clear|sessions]", "warning");
    },
  });

  // ========== tool 壳：LLM 可调（与 command 共享纯函数内核，.pt/docs/designs/pt-command-tool-dual-registration.md） ==========
  // 只读查询 + 手册实例化做 tool；pt-context（改 system prompt）不做 tool（见设计文档 §2.4）

  pi.registerTool({
    name: "pt_status",
    label: "Pt Status",
    description:
      "Show Pt compilation status: active profile, domain/flow counts, segment length, cache hit. Read-only.",
    promptSnippet: "Show Pt status (profile, counts, cache)",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: statusText() }], details: {} };
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
    async execute() {
      return { content: [{ type: "text", text: flowsText() }], details: {} };
    },
  });

  pi.registerTool({
    name: "pt_manual",
    label: "Pt Manual",
    description:
      "Create a manual instance document (.pt/manuals/<procedure>-<ts>.md) with checklist + artifact log. Use when starting a multi-step procedure like deliver-feature. Returns the file path.",
    promptSnippet: "Instantiate a Pt manual document with checklist for tracking",
    promptGuidelines: [
      "Use pt_manual when starting a multi-step procedure (e.g., deliver-feature, modify-schema) to get a persistent checklist + artifact log.",
    ],
    parameters: Type.Object({
      procedure: Type.String({
        description: "FlowTemplate name, e.g. deliver-feature, modify-schema",
      }),
      args: Type.Optional(
        Type.String({
          description: "Arguments for the procedure, e.g. 'req-001' or 'term my-concept'",
        })
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const r = buildManualDoc(ctx.cwd, params.procedure, params.args ?? "");
      if (r.error) {
        return { content: [{ type: "text", text: r.error }], details: { error: r.error } };
      }
      return withFileMutationQueue(r.filePath, async () => {
        await mkdir(join(ctx.cwd, MANUAL_DIR), { recursive: true });
        await writeFile(r.filePath, r.content, "utf8");
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
      const r = await loadAndTranspile(ctx.cwd, session.activeProfile ?? "");
      const b = r.bundles[0];
      const result = checkAllRefs(b.profiles, b.blueprints, b.domains);
      return {
        content: [{ type: "text", text: formatRefCheckResult(result) }],
        details: result,
      };
    },
  });
}

/** 将 Pi ExtensionAPI 转换为 AgentAPI（结构类型子集，运行时透明）。
 *  Pi ExtensionAPI 是 AgentAPI 的超集，多余方法（registerCommand/registerFlag 等）不暴露给 Adapter。
 *  v9.1：提供 ui 能力，adapter 可走 ui.notify 报错 / ui.setStatus 设状态（不需 console）。
 *  v10.x：提供 log 能力，adapter 的 try/catch 异常走 session.logger（不再 swallow）。
 *  ctx 用 Pi 扩展的 ctx（ExtensionContext/ExtensionCommandContext 都含 ui）——子集够用。
 *
 *  同一个 Pi runtime 复用同一个 AgentAPI wrapper，否则 PiAdapter 每次 registerInject
 *  都会得到不同的对象身份，导致系统 prompt handler 被重复注册。 */
const agentApiCache = new WeakMap<
  ExtensionAPI,
  {
    api: AgentAPI;
    setContext: (ctx: { ui: AgentUIContext }) => void;
  }
>();

function toAgentAPI(pi: ExtensionAPI, ctx: { ui: AgentUIContext }): AgentAPI {
  let holder = agentApiCache.get(pi);
  if (!holder) {
    let currentCtx = ctx;
    const api: AgentAPI = {
      on: (event, handler) =>
        pi.on(
          event as Parameters<ExtensionAPI["on"]>[0],
          handler as Parameters<ExtensionAPI["on"]>[1]
        ),
      registerCommand: (name, spec) =>
        pi.registerCommand(name, spec as Parameters<ExtensionAPI["registerCommand"]>[1]),
      registerFlag: (name, spec) =>
        pi.registerFlag(name, spec as Parameters<ExtensionAPI["registerFlag"]>[1]),
      getFlag: (name) => pi.getFlag(name),
      ui: {
        notify: (msg, level) => currentCtx.ui.notify(msg, level),
        setStatus: (name, text) => currentCtx.ui.setStatus(name, text),
      },
      get log() {
        return session.logger?.toWriter();
      },
      onInjected: (systemPrompt) => {
        session.lastBuiltPrompt = systemPrompt;
      },
    };
    holder = {
      api,
      setContext: (nextCtx) => {
        currentCtx = nextCtx;
      },
    };
    agentApiCache.set(pi, holder);
  } else {
    holder.setContext(ctx);
  }
  return holder.api;
}

/** 暴露 activeProfile 用于调试（未来可挂 /pt status）。 */
export function _debugActive(): {
  profile: string | null;
  segmentLen: number;
  flowCount: number;
  cacheHit: boolean;
} {
  const flowCount =
    session.cachedBundles?.reduce((acc, b) => {
      let n = 0;
      for (const d of b.domains)
        if (d.type === "workflow") {
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
