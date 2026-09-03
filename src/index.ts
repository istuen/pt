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
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { FULL_DIR, MANUAL_DIR, MOD_MANUAL, PROFILES_DIR, RAW_DIR } from "./constants.js";
import { toAgentAPI } from "./agent/api-bridge.js";
import { getAgentAdapter } from "./agent/index.js";
import { detectSingleProfile, listProfiles, readProjectSetting } from "./config.js";
import { errMsg } from "./diagnostics.js";
import {
  readProfileFromSession,
  persistProfileToSession,
  type MinimalSessionManager,
} from "./profile-persist.js";
import { renderInjectionFooter } from "./injection-status.js";
import { LOG_DIR, PtLogger } from "./log.js";
import {
  isManualActive,
  parseManualProgress,
  renderManualFooterSuffix,
  renderManualWidgetLines,
} from "./manual-track.js";

import { type ActiveManual, type ProfileLoadSource, resetSession, session } from "./session.js";
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

/** session-scoped logger 快捷调用（session.logger 为 null 时静默——session_start 之前不可用）。 */
function slog(
  level: "debug" | "info" | "warn" | "error",
  msg: string,
  ctx?: Record<string, unknown>
): void {
  if (!session.logger) return;
  session.logger[level](msg, ctx);
}

/** v11.x：手动跟踪的 ActiveManual 持久化 + widget 刷新。 */

/** session JSONL 中持久化 ActiveManual 的 custom entry customType。 */
const PT_MANUAL_ENTRY = "pt:active-manual";

/** 从 session JSONL 读上次保存的 ActiveManual。读出后由 caller 校验（isManualActive）。
 *  静默 fallback：异常 / 无 entry → undefined。 */
interface PersistedManualEntry {
  filePath: string;
  procedure: string;
  args: string;
}
function readManualFromSession(
  sessionManager: MinimalSessionManager
): PersistedManualEntry | undefined {
  try {
    const entries = sessionManager.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e && e.type === "custom" && e.customType === PT_MANUAL_ENTRY) {
        const data = (e as { data?: unknown }).data;
        if (data && typeof data === "object") {
          const d = data as Record<string, unknown>;
          const filePath = d.filePath;
          const procedure = d.procedure;
          const args = d.args;
          if (typeof filePath === "string" && filePath.trim() && typeof procedure === "string") {
            return {
              filePath: filePath.trim(),
              procedure,
              args: typeof args === "string" ? args : "",
            };
          }
        }
      }
    }
  } catch {}
  return undefined;
}

/** 把当前 ActiveManual 写入 session JSONL。
 *  失败静默（ephemeral session / 旧版 pi 无 appendEntry）——内存中 activeManual 仍可用本进程。 */
function persistManualToSession(pi: ExtensionAPI, m: ActiveManual): void {
  try {
    if (typeof pi.appendEntry !== "function") return;
    pi.appendEntry(PT_MANUAL_ENTRY, {
      filePath: m.filePath,
      procedure: m.procedure,
      args: m.args,
    });
  } catch (e) {
    slog("warn", "persistManualToSession failed", { procedure: m.procedure, err: errMsg(e) });
  }
}

/** 刷新 footer 注入状态 + manual 后缀（合并写一次 setStatus）。 */
function refreshInjectionFooter(ui: ExtensionUIContext): void {
  const suffix = renderActiveManualSuffix();
  const base = renderInjectionFooter(
    session.injectionState,
    session.activeProfile,
    session.injectionError
  );
  ui.setStatus("pt", suffix ? `${base} ${suffix}` : base);
}

/** 计算 active manual 的 footer 后缀（空字符串 = 无 activeManual 或 completed）。 */
function renderActiveManualSuffix(): string {
  if (!session.activeManual) return "";
  // 同步快速读（无 IO）—— widget 刷新会走 async parseManualProgress
  // footer 只显示 procedure 名 + done/total，避免 IO 阻塞 setStatus
  // 但 stepDone/total 是派生数据，需要同步可读——
  // 这里走同步取缓存策略：保留 widget 异步 parse 的最新结果
  if (!cachedManualProgress) return "";
  return renderManualFooterSuffix(cachedManualProgress);
}

/** cachedManualProgress：refreshManualWidget 异步 parse 后写入，footer 同步读。
 *  单字段缓存，不需要 broadcast channel。 */
let cachedManualProgress: import("./manual-track.js").ManualProgress | null = null;

/** 刷新 widget（aboveEditor）。根据 session.activeManual 决定显示/撤掉。
 *  - 无 activeManual → 撤 widget
 *  - 文件不存在 / 已 completed → 清 activeManual + 撤 widget
 *  - in-progress → 渲染 3 行 widget + 更新 cachedManualProgress（footer 同步读） */
async function refreshManualWidget(ui: ExtensionUIContext): Promise<void> {
  const m = session.activeManual;
  if (!m) {
    cachedManualProgress = null;
    ui.setWidget("pt-manual", undefined);
    return;
  }
  const p = await parseManualProgress(m.filePath);
  if (!p || p.status === "completed") {
    session.activeManual = null;
    cachedManualProgress = null;
    ui.setWidget("pt-manual", undefined);
    return;
  }
  cachedManualProgress = p;
  ui.setWidget("pt-manual", renderManualWidgetLines(m.filePath, p), {
    placement: "aboveEditor",
  });
}

/** session_start 时试恢复 manual：读 pt:active-manual entry → 校验文件存在 + status !== completed。
 *  独立于 profile 加载链——profile 失败 / 无 profile 也能恢复 manual 追踪。 */
async function tryRestoreManual(ctx: ExtensionContext): Promise<void> {
  const entry = readManualFromSession(ctx.sessionManager);
  if (!entry) return;
  const active = await isManualActive(entry.filePath);
  if (!active) {
    session.logger?.debug("manual:restore skipped (inactive)", {
      filePath: entry.filePath,
    });
    return;
  }
  session.activeManual = {
    filePath: entry.filePath,
    procedure: entry.procedure,
    args: entry.args,
    activatedAt: Date.now(),
  };
  await refreshManualWidget(ctx.ui);
  // widget 设置后才调 footer（refreshManualWidget 写 cachedManualProgress）
  refreshInjectionFooter(ctx.ui);
  session.logger?.info("manual:restored", {
    filePath: entry.filePath,
    procedure: entry.procedure,
  });
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
 *  v10.x：成功后调 `persistProfileToSession(pi, name)` 把选择写到 session JSONL，下次进程启动自动恢复。
 *  v11.x：成功后调 `refreshInjectionFooter`（pending 状态）+ `refreshManualWidget`（保留 manual 追踪）。 */
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
    // v11.x：切换后立即标 pending，等下一轮 before_agent_start 翻成 injected
    session.injectionState = "pending";
    session.injectionError = null;
    refreshInjectionFooter(ctx.ui);
    await refreshManualWidget(ctx.ui);
    slog("info", "command:switchProfile inject", { profileName: name, injected });
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
  // v11.x：fallback 链额外加 manual 恢复（独立于 profile 链——profile 失败不影响 manual 恢复）。
  //   manual 读出后校验文件存在 + status !== completed；满足才挂载 widget。
  pi.on("session_start", async (_event, ctx) => {
    // v10.x：先生成 sessionId + logger，让后续事件 trace 有归属
    session.sessionId = randomUUID().slice(0, 8);
    session.logger = new PtLogger(ctx.cwd, "", session.sessionId);
    session.logger.info("session:start", { sessionId: session.sessionId, cwd: ctx.cwd });

    session.lastCwd = ctx.cwd;
    try {
      const flag = pi.getFlag("pt-context");
      const flagVal = typeof flag === "string" && flag.trim() ? flag.trim() : undefined;

      const fromSettings =
        (await readProjectSetting<string>(ctx.cwd, "pt.pt-context")) ??
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
        session.injectionState = "idle";
        session.injectionError = null;
        refreshInjectionFooter(ctx.ui);
        ctx.ui.notify(
          "Pt：未找到 Profile。用 /pt-context <name> 选择，或在 .pi/settings.json 设 pt.pt-context。",
          "info"
        );
        session.loadedFrom = null;
        session.logger.info("session:no profile picked", {
          flagVal,
          fromSettings,
          fromSession,
          auto,
        });
        // v11.x：manual fallback 即使无 profile 也要试（手动追踪可独立于 profile）
        await tryRestoreManual(ctx);
        return;
      }

      await transpileActive(ctx.cwd, picked, (msg, level) => ctx.ui.notify(msg, level));
      session.loadedFrom = pickedFrom; // v10.x：可观测性
      persistProfileToSession(pi, picked); // v10.x：把当前来源同步到 JSONL（下次进程默认走 session）
      // 注册 AgentAdapter 注入（封装 before_agent_start + input）
      const injected = registerInjectionIfReady(pi, ctx);
      // v11.x：profile 已加载但还没轮到下一轮 before_agent_start → pending
      session.injectionState = "pending";
      session.injectionError = null;
      refreshInjectionFooter(ctx.ui);
      session.logger.info("session:profile loaded", {
        profileName: picked,
        loadedFrom: pickedFrom,
        injected,
      });

      // v11.x：profile 加载后试恢复 manual（独立于 profile 链）
      await tryRestoreManual(ctx);
    } catch (e) {
      ctx.ui.notify(`Pt 加载失败：${errMsg(e)}`, "error");
      session.injectionState = "failed";
      session.injectionError = errMsg(e);
      refreshInjectionFooter(ctx.ui);
      session.cachedSegment = null;
      session.cachedBundles = null;
      session.loadedFrom = null;
      session.logger?.error("session:start failed", { err: errMsg(e) });
      // v11.x：profile 失败但 manual 仍可能独立恢复（手动追踪不依赖 profile）
      await tryRestoreManual(ctx);
    }
  });

  // ========== session_shutdown：flush logger + 清内存态 ==========
  // v10.x：先 flush 避免丢尾，再 reset 清状态
  // v11.x：resetSession 覆盖 injectionState / activeManual / cachedManualProgress（widget 不持久）
  pi.on("session_shutdown", async () => {
    if (session.logger) {
      session.logger.info("session:shutdown");
      await session.logger.flush();
    }
    // 同一运行时保留 Pi handler 绑定，但清除旧 session 的 segment/context，
    // 避免新 session 在尚未重新选择 Profile 时继续注入旧内容。
    session.activeAdapter?.resetInjection?.();
    resetSession();
    cachedManualProgress = null; // module-level 缓存，resetSession 不包含
  });

  // ========== turn 级 trace（P2: 覆盖 turn 生命周期） ==========
  // 任何 turn 异常都能从日志反查；不写入主要因为 UI 噪音，只到 file log。
  pi.on("turn_start", async (_event, _ctx) => {
    slog("debug", "turn:start");
  });
  pi.on("turn_end", async (event, _ctx) => {
    // v10.x：event 形态可能包含 token 用量，先取几个字段塞进 ctx
    const e = event as PiTurnEndEvent;
    slog("debug", "turn:end", { reason: e.reason, messageCount: e.messageCount });
  });
  pi.on("agent_settled", async (_event, _ctx) => {
    slog("debug", "agent:settled");
  });
  pi.on("tool_call", async (event, _ctx) => {
    const e = event as PiToolCallEvent;
    slog("debug", "tool:call", { name: e.name ?? e.toolName });
  });
  pi.on("tool_result", async (event, _ctx) => {
    const e = event as PiToolResultEvent;
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
      // v11.x 修复：原来 `sub = args.trim()` 会把整个 args 作为 sub，导致 `/pt manual <proc>` 时
      //   `sub === "manual"` 永远不成立。改为：sub = 第一词，subArgs = 剩余。
      //   兼容现有 logs:clear / status / flows 等单子命令（不带额外参数）行为不变。
      const firstSpace = args.indexOf(" ");
      const head = firstSpace === -1 ? args : args.slice(0, firstSpace);
      const tail = firstSpace === -1 ? "" : args.slice(firstSpace + 1);
      const sub = head.trim().toLowerCase();
      const subArgs = tail;
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
        // v11.x 修复：subArgs 才是 procedure 参数（原 code 会拿到 "manual"）
        const procedureParts = subArgs.trim().split(/\s+/);
        const procedureName = procedureParts[0] ?? "";
        const procedureArgs = procedureParts.slice(1).join(" ");
        const r = buildManualDoc(ctx.cwd, procedureName, procedureArgs);
        if (r.error) {
          ctx.ui.notify(r.error, "warning");
          return;
        }
        await mkdir(join(ctx.cwd, MANUAL_DIR), { recursive: true });
        await writeFile(r.filePath, r.content, "utf8");
        // v11.x：手动跟踪实例 + widget + footer + 持久化
        session.activeManual = {
          filePath: r.filePath,
          procedure: procedureName,
          args: procedureArgs,
          activatedAt: Date.now(),
        };
        persistManualToSession(pi, session.activeManual);
        await refreshManualWidget(ctx.ui);
        refreshInjectionFooter(ctx.ui);
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
        // v11.x：手动跟踪实例 + widget + footer + 持久化
        session.activeManual = {
          filePath: r.filePath,
          procedure: params.procedure,
          args: params.args ?? "",
          activatedAt: Date.now(),
        };
        persistManualToSession(pi, session.activeManual);
        await refreshManualWidget(ctx.ui);
        refreshInjectionFooter(ctx.ui);
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
      if (session.activeManual) {
        await refreshManualWidget(ctx.ui);
        refreshInjectionFooter(ctx.ui);
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
