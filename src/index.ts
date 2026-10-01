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
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { FULL_DIR, MANUAL_DIR, PROFILES_DIR, RAW_DIR } from "./constants.js";
import {
  computeHealthHash,
  readPersistedHealthHash,
  writePersistedHealthHash,
} from "./health-state.js";
import { toAgentAPI } from "./agent/api-bridge.js";
import { getAgentAdapter } from "./agent/index.js";
import { scanProjectHealth, formatHealthSummary } from "./asset-health.js";
import {
  applyProjectPackDegrade,
  loadBuiltinPack,
  loadProjectPack,
  loadSettingsPacks,
} from "./asset-pack/loader.js";
import { validatePack } from "./asset-pack/validate.js";
import {
  detectDefaultProfile,
  detectSingleProfile,
  formatProfileLabels,
  listProfiles,
  listProfilesWithTagline,
  readProjectSetting,
} from "./config.js";
import { errMsg } from "./diagnostics.js";
import { readProfileFromSession, persistProfileToSession } from "./profile-persist.js";
import { LOG_DIR, PtLogger } from "./log.js";
import {
  type ProfileLoadSource,
  clearSessionById,
  getSessionById,
  resetSessionState,
} from "./session.js";
import {
  buildFullPrompt,
  buildManualDoc,
  checkDocsText,
  checkText,
  designsText,
  flowsText,
  formatsList,
  issuesText,
  manualsText,
  packsText,
  parseListFlags,
  statusText,
} from "./commands.js";
import { loadAndTranspile } from "./transpile.js";
import { renderTurnInject } from "./render/turn-inject.js";
import { filterDomainsByProfile, type AgentAPI } from "./schema.js";
import {
  pathEquals,
  persistManualToSession,
  refreshInjectionFooter,
  refreshManualWidget,
  tryRestoreManual,
  tryRestoreLastTurnRef,
  persistLastTurnRef,
} from "./manual-session.js";
import { writeProbeResult } from "./manual-writeback.js";
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

/** pi.on("tool_result", handler) event 形状。
 *  P1：扩展 input 字段（edit/write 工具含 `path`，详见 pi extensions.md tool_result 段）。 */
interface PiToolResultEvent {
  name?: string;
  toolName?: string;
  isError?: boolean;
  input?: { path?: string; [k: string]: unknown };
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

  adapter.registerInject(
    toAgentAPI(pi, ctx),
    context,
    blueprint,
    sessionState.cachedDomains,
    sessionState.cachedProfile
  );
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

  // v15.x PR1（§6.7.3）：project pack 降级时强制回 guide——必须前置覆盖，
  // 否则用户请求的 profile 会先加载失败才降级（前置覆盖，不是失败后兜底）。
  const sForDegrade = getSessionById(sessionId);
  const originalProfile = profileName;
  profileName = applyProjectPackDegrade(sForDegrade.projectPackDegraded, profileName);
  if (profileName !== originalProfile) {
    slog(sessionId, "warn", "transpileActive:project-pack-degraded", {
      requested: originalProfile,
      forced: profileName,
    });
    notify(
      `Pt: project pack 降级中，强制使用 builtin guide（请求的 "${originalProfile}" 被覆盖）。修复后重启。`,
      "warning"
    );
  }

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
    // v15.x PR6（fix pt-active-profile-fallback-mismatch）：若 loadAndTranspile fallback 了
    // （user 请求的 profile 找不到），同步改写 s.activeProfile + notify。
    // 这样 s.activeProfile / loadedFrom / 注入路径 三者与产物保持一致。
    if (
      result.activeProfileOrigin === "fallback" &&
      result.originalProfileName &&
      result.profile.name !== profileName
    ) {
      slog(sessionId, "warn", "transpileActive:profile-fallback", {
        requested: result.originalProfileName,
        forced: result.profile.name,
      });
      notify(
        `Pt: profile "${result.originalProfileName}" not found, fallback to "${result.profile.name}". 运行 /pt-profile <correct> 修复。`,
        "warning"
      );
      profileName = result.profile.name;
    }
    s.activeProfile = profileName;
    s.lastCacheHit = result.cacheHit;

    // v12.x：per-pi adapter——registry.ts 给每个 pi 一个新 PiAdapter 实例，
    // 单例字段 this.segment 不会被其他 session 覆盖。
    // Phase term-P4.1：Blueprint.agent 字段移除，暂硬编码 "pi"；待 OpenCodeAdapter 后改 transpile(profile, agent)
    s.activeAdapter = getAgentAdapter(pi, "pi");
    s.activeAdapter.setAgentContext(
      result.agentContext,
      result.blueprint,
      result.domains,
      result.profile
    );

    slog(sessionId, "info", "transpileActive:done", {
      profileName,
      agent: "pi", // P4.1：硬编码，待 §11 多 Adapter 后改成参数化
      domainCount: result.domains.length,
      segmentLen: result.segment.length,
      cacheHit: result.cacheHit,
      origin: result.activeProfileOrigin, // v15.x PR6：记录 fallback 由来便于 debug
      durationMs: Date.now() - t0,
    });
  } catch (e) {
    slog(sessionId, "error", "transpileActive:failed", {
      err: errMsg(e),
      profileName,
      durationMs: Date.now() - t0,
    });
    // v13.x（issue pt-no-agent-context-reset-session-state 修复）：
    // throw 前重置编译产物字段，避免 stale state 让后续 /pt flows 返回旧 Profile 手册
    resetSessionState(getSessionById(sessionId));
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
    // v15.x PR6（fix pt-active-profile-fallback-mismatch）：transpileActive 可能 fallback
    // （s.activeProfile 已被改写）。此时 s.loadedFrom = "fallback" 表达"用户手动请求但
    // 实际 fallback"，比 null 更准确反映状态。
    s.loadedFrom = s.activeProfile !== name ? "fallback" : null;
    persistProfileToSession(pi, s.activeProfile ?? name); // v10.x：session 持久化（issue pt-context-persist-lost）
    // ^ v15.x PR6：持久化用 s.activeProfile（fallback 名）而非原请求名，下次不再 stale
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
    // v13.x（issue pt-no-agent-context-reset-session-state 修复）：
    // 重置编译产物 + injection 状态，避免 stale state 让后续 /pt flows 返回旧 Profile 手册
    const s2 = getSessionById(sessionId);
    resetSessionState(s2);
    s2.injectionState = "failed";
    s2.injectionError = errMsg(e);
    refreshInjectionFooter(ctx.ui, s2);
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
    description: "启动时激活的 Profile 名（编译成 AgentContext 注入 Session Inject）",
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
    // v18.x（issue pt-footer-status-stale-cache）：session 重建时（pi-web wrapper 重建 /
    // idle timeout / reload）clearSessionById 可能未到达（shutdown event 丢失），导致
    // SessionState 残留 stale lastFooterText。session_start 是 pt 唯一可靠的 session
    // 边界感知入口——重置缓存确保首次 refreshInjectionFooter 必写 setStatus。
    s.lastFooterText = null;
    s.sessionId = randomUUID().slice(0, 8); // 短期 ID for logger
    s.logger = new PtLogger(ctx.cwd, "", sessionId);
    s.logger.info("session:start", { sessionId: s.sessionId, cwd: ctx.cwd });

    s.lastCwd = ctx.cwd;

    // v18.x（决策 6）：先试恢复 lastTurnRef——compaction 线索是 session lifecycle 维度，
    // 独立于 profile 链（profile 失败也能恢复）。即使从未调过 pt_inject / pt_doc start
    // 也会快速返回（无 entry）。
    tryRestoreLastTurnRef(ctx, s);

    // v15.x PR4（§6.7.1 + §6.7.5）：pack 校验 + settings pack 接通
    // 两段独立 try/catch 兑底——任一异常都不能阻塞 session_start。
    // v15.x PR7（issue pt-remove-global-pack 移除）：globalPack 槽位删除，3 类 pack。
    // issue pt-cold-start-warning-noise（§短期方案 3）：transient validation 静默化——
    //   同 pack 名连续失败 N 次才 notify，避免 cache miss + reload race 弹窗轰炸。
    //   - 本次失败 → 增计数，连续 < TRANSIENT_NOTIFY_THRESHOLD 仅 log
    //   - 达到阈值 → notify "这真有问题"
    //   - 本次成功 → 清零计数（连续失败终止）
    const TRANSIENT_NOTIFY_THRESHOLD = 3;
    try {
      const projectPack = await loadProjectPack(ctx.cwd);
      const settingsPacks = await loadSettingsPacks(ctx.cwd); // PR4 接通
      const builtinPack = await loadBuiltinPack();
      // settings 包保持声明顺序（不 reverse）——校验顺序不影响结果（每个 pack 独立校验）
      const packsForValidate = [projectPack, ...settingsPacks, builtinPack];

      const results = await Promise.all(packsForValidate.map(validatePack));
      s.packValidation = results;

      // 更新 transientValidationFailures 计数——validation 结果中能定位到原始 pack 实例的
      // 只有 manifestWarnings 这类静态信息（assets 已加载），与 validation 状态独立。
      // 计数仅跟踪 validation 成功/失败（ok=true/false），与 manifest warnings 无关。
      const seenPackNames = new Set<string>();
      for (const r of results) {
        seenPackNames.add(r.pack);
        const prevCount = s.transientValidationFailures.get(r.pack) ?? 0;
        if (r.ok) {
          // 本次成功 → 清零（连续失败终止）
          if (prevCount > 0) {
            s.transientValidationFailures.set(r.pack, 0);
            s.logger?.debug("transientValidation:cleared", {
              pack: r.pack,
              source: r.source,
            });
          }
        } else {
          // 本次失败 → 增计数
          const newCount = prevCount + 1;
          s.transientValidationFailures.set(r.pack, newCount);
          s.logger?.warn("transientValidation:failed", {
            pack: r.pack,
            source: r.source,
            count: newCount,
            firstErr: r.errors[0]?.msg ?? "unknown",
          });
        }
      }
      // 清除已不存在的 pack 计数（settings pack 被项目移除后不增长）
      for (const k of [...s.transientValidationFailures.keys()]) {
        if (!seenPackNames.has(k)) s.transientValidationFailures.delete(k);
      }

      // project pack 降级（§6.7.3）—— 行为变化必须保留（强制回 guide），
      // 但通知受 transient threshold 控制（issue §短期方案 3）。
      const projectResult = results.find((r) => r.source === "project");
      if (projectResult && !projectResult.ok) {
        s.projectPackDegraded = true;
        const firstErr = projectResult.errors[0];
        const projectFailCount = s.transientValidationFailures.get(projectResult.pack) ?? 0;
        if (projectFailCount >= TRANSIENT_NOTIFY_THRESHOLD) {
          // 达到阈值才 notify——前 N-1 次仅 log（已在 transientValidation:failed 记录）
          ctx.ui.notify(
            `⚠ Pt: project pack 连续 ${projectFailCount} 次校验失败（${firstErr?.msg ?? "未知错误"}）。已降级到 builtin guide。`,
            "warning"
          );
          // issue pt-pack-repair-cwd-home-edge-case：cwd=~ 时附加决策引导
          const isCwdHome = ctx.cwd === homedir();
          if (isCwdHome) {
            ctx.ui.notify(
              `  ⚠ 检测到 cwd=~（${homedir()}）—— project pack 在 home 无项目上下文。建议：1) 切到项目目录后再跑；2) 临时调试可 mkdir -p ${projectPack.rootDir}/{domains,blueprints,profiles}；3) 啥都不做（builtin guide 已可用）`,
              "info"
            );
          } else {
            ctx.ui.notify(`  修复：调 pt_inject tool 获取 pack-repair 手册`, "info");
          }
        }
      }

      // v15.x PR4（§6.7.5）：settings pack 校验失败预警——跳过该 pack，不阻断其他
      // issue pt-cold-start-warning-noise（§短期方案 3）：同样受 transient threshold 控制。
      for (const r of results) {
        if (r.source === "settings" && !r.ok) {
          const failCount = s.transientValidationFailures.get(r.pack) ?? 0;
          if (failCount >= TRANSIENT_NOTIFY_THRESHOLD) {
            const firstErr = r.errors[0];
            ctx.ui.notify(
              `⚠ Pt: settings pack [@${r.pack}] 连续 ${failCount} 次校验失败（${firstErr?.msg ?? "未知"}）。已跳过该 pack。`,
              "warning"
            );
            ctx.ui.notify(`  修复：调 pt_inject tool 获取 pack-repair 手册`, "info");
          }
        }
      }

      s.logger?.info("session:pack validation", {
        projectOk: projectResult?.ok ?? false,
        results: results.map((r) => ({
          pack: r.pack,
          source: r.source,
          ok: r.ok,
          errorCount: r.errors.length,
          transientFailCount: s.transientValidationFailures.get(r.pack) ?? 0,
        })),
      });
    } catch (e) {
      // 校验异常仅 log，不阻塞 session_start（陷阱 3：不能阻塞）
      s.logger?.warn("session:pack validation failed", { err: errMsg(e) });
    }

    // v15.x PR7（issue pt-remove-global-pack 移除）：删除全局 Pack 初始化引导——
    //   全局 pack 不再存在（被 settings pack 替代）。settings pack 显式声明在
    //   .pi/settings.json 的 pt.asset-packs[]，无"首次创建"隐式引导。

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
      const defaultProfile = auto ?? (await detectDefaultProfile(ctx.cwd));

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
      } else if (defaultProfile) {
        picked = defaultProfile;
        pickedFrom = "default";
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
      // v15.x PR6（fix pt-active-profile-fallback-mismatch）：transpileActive 可能 fallback
      // （s.activeProfile 已被改写为 fallback 名）。此处用 s.activeProfile 同步 downstream。
      // - s.loadedFrom 设为 "fallback" 覆盖原 pickedFrom（如 "session"）——用户能看到
      // - persistProfileToSession 持久化 fallback 名（避免下次仍走 stale 路径）
      const finalProfileName = s.activeProfile ?? picked;
      s.loadedFrom = s.activeProfile !== picked ? "fallback" : pickedFrom; // v10.x：可观测性
      persistProfileToSession(pi, finalProfileName); // v10.x：把当前来源同步到 JSONL（下次进程默认走 session）
      // 注册 AgentAdapter 注入（封装 before_agent_start + input）
      const injected = registerInjectionIfReady(pi, ctx, sessionId);
      // v11.x：profile 已加载但还没轮到下一轮 before_agent_start → pending
      s.injectionState = "pending";
      s.injectionError = null;
      refreshInjectionFooter(ctx.ui, s);
      s.logger.info("session:profile loaded", {
        profileName: finalProfileName,
        requested: picked, // v15.x PR6：用户原始请求（与 finalProfileName 不同 = fallback 发生）
        loadedFrom: s.loadedFrom,
        injected,
      });

      // v14.x（issue pt-asset-migration-visibility Layer 2）：
      //   session_start 末尾批量体检项目所有 profile——主动告知存量项目 schema 错误，
      //   避免"切换才暴露"。失败降级（不阻塞 session 启动）——scan 内部已 try/catch。
      // issue pt-cold-start-warning-noise（§短期方案 1）：hash 去重 + 跨 session 持久化——
      //   项目存量 issues 不变时不 notify，仅 footer 染色 + /pt check 查详情。
      //   user 反馈"我没改任何东西却反复被警告轰炸"——这里根治。
      const bundles = s.cachedBundles ?? [];
      const healthBundle = bundles[0];
      if (healthBundle) {
        const report = await scanProjectHealth(
          ctx.cwd,
          healthBundle.profiles,
          healthBundle.blueprints,
          healthBundle.domains,
          healthBundle.packs,
          healthBundle.activeProfilePack,
          healthBundle.workingSet,
          { log: s.logger?.toWriter() }
        );
        s.assetHealthIssues = report.issues;

        // 计算新 hash，与上次跨 session 持久化的 hash 比较——
        // 不同才 notify（变化告知）。同时刷新 footer（footer 数字变化才染色，刷新本身无害）。
        const newHash = computeHealthHash(report.issues);
        const lastHash = s.lastHealthHash ?? (await readPersistedHealthHash(ctx.cwd));
        const hashChanged = newHash !== lastHash;
        if (report.errors > 0 || report.warnings > 0) {
          if (hashChanged) {
            // 仅在 hash 变化时 notify——否则仅 footer 染色（表示"持续问题"但不消费通知额度）
            // v0.3.0（issue pt-asset-health-diag-report-format）：用 formatHealthSummary 输出分类 + 路径
            // 取代原“纯计数 + 运行 /pt check”的冷冰冰文案。
            const summary = formatHealthSummary(report);
            ctx.ui.notify(
              summary ||
                `[pt] 项目有 ${report.issues.length} 项配置问题（运行 /pt check 查看详情）`,
              "warning"
            );
          }
          // 体检结果（不论 hash 是否变）都刷新 footer 染色（statusText / footer 会显示 issue 数）
          refreshInjectionFooter(ctx.ui, s);
        }
        s.lastHealthHash = newHash;
        // 跨 session 持久化——next session_start 时能正确去重
        await writePersistedHealthHash(
          ctx.cwd,
          newHash,
          report.issues.length,
          s.logger?.toWriter()
        );
        s.logger?.info("session:health scan done", {
          issueCount: report.issues.length,
          errors: report.errors,
          warnings: report.warnings,
          hashChanged,
          hash: newHash || "(empty)",
        });
      }

      // v11.x：profile 加载后试恢复 manual（独立于 profile 链）
      await tryRestoreManual(ctx, s);
    } catch (e) {
      ctx.ui.notify(`Pt 加载失败：${errMsg(e)}`, "error");
      // v13.x（issue pt-no-agent-context-reset-session-state 修复）：
      // 统一调 resetSessionState 清编译产物 + loadedFrom；保留 activeProfile（便于用户重试）
      resetSessionState(s);
      s.loadedFrom = null;
      s.injectionState = "failed";
      s.injectionError = errMsg(e);
      refreshInjectionFooter(ctx.ui, s);
      s.logger?.error("session:start failed", { err: errMsg(e) });
      // v11.x：profile 失败但 manual 仍可能独立恢复（手动追踪不依赖 profile）
      await tryRestoreManual(ctx, s);
    }
  });

  // ========== session_compact：compaction 后重注入 TurnContext 线索 ==========
  // v18.x（issue pt-turncontext-llm-call-trigger 决策 6）：
  //  线索 = TurnContext domain 名 + Manual 路径（引用指针，非内容缓存）。
  //  session_compact 事件触发 → 读 s.lastTurnRef → 通过 pi.sendMessage({ triggerTurn: true })
  //  注入固定线索作为 custom message → LLM 读到后据线索重新调 pt_inject / read Manual。
  //  v19（issue pt-llm-tool-consolidation）：线索文本改写——`pt_turn_inject` tool 名 → `pt_inject` tool 名。
  //  无条件重注入——线索很轻（domain 名 + 路径），多注一次不撑窗口，简化逻辑。
  //  session_compact 事件在 src/index.ts 注册而非 pi-adapter.ts——因为：
  //   1) pi.sendMessage 是 Pi 专属 API，AgentAPI 不暴露（保持 AgentAdapter 抽象纯净）
  //   2) 与 session_start / session_shutdown 同寿命周期事件归位一致
  pi.on("session_compact", async (event, ctx) => {
    const sessionId = getSessionIdFromCtx(ctx);
    if (!sessionId) return;
    const s = getSessionById(sessionId);
    if (!s.lastTurnRef) return; // 无线索可重注入（从未调过 pt_inject / pt_doc start）
    const { turnInjectDomain, manualPath } = s.lastTurnRef;
    // 空 lastTurnRef（两字段都空）也不注入
    if (!turnInjectDomain && !manualPath) return;
    const lines: string[] = [
      "[pt] 上次 TurnContext 线索（compaction 后恢复）：",
      `- TurnContext Domain: ${turnInjectDomain || "(未调 pt_inject)"}（调 pt_inject tool domain=${turnInjectDomain || "<domain>"} 重新获取详情）`,
    ];
    if (manualPath) {
      lines.push(`- Manual 实例: ${manualPath}（用 read 工具读取继续执行）`);
    }
    try {
      await pi.sendMessage(
        {
          customType: "pt-compaction-clue",
          content: lines.join("\n"),
          display: true,
        },
        { triggerTurn: true }
      );
      s.logger?.info("compaction:clue-injected", {
        turnInjectDomain,
        manualPath,
        reason: event.reason,
      });
    } catch (e) {
      s.logger?.warn("compaction:sendMessage failed", { err: String(e) });
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
    // P1 兜底：turn 结束时刷 manual（捕获 bash/powershell 改 manual + tool_result 漏检场景）。
    // refreshManualWidget 内部浅比较去重，进度未变时不发 IPC。频率 ~60/h，远低于 tool_result，
    // 作为兜底可接受。
    const sessionId = getSessionIdFromCtx(ctx);
    const s = sessionId ? getSessionById(sessionId) : null;
    if (s?.activeManual) {
      await refreshManualWidget(ctx.ui, s);
      refreshInjectionFooter(ctx.ui, s);
    }
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
    const toolName = e.name ?? e.toolName;
    slog(getSessionIdFromCtx(ctx), "debug", "tool:result", {
      name: toolName,
      isError: e.isError,
    });
    // P1：edit/write 命中 activeManual 文件 → 刷新 widget（精准过滤，不全量刷 edit/write）。
    // 设计文档：pt-workspace-boundary-calibration §1 / §2.3 方案 1a + 浅比较去重。
    // edit 工具 schema 含 `path` 字段（pi dist/core/tools/edit.d.ts EditSchema.path: TString），
    // write 工具同样含 path。
    const sessionId = getSessionIdFromCtx(ctx);
    const s = sessionId ? getSessionById(sessionId) : null;
    if (s?.activeManual && (toolName === "edit" || toolName === "write")) {
      const changedPath = e.input?.path;
      if (changedPath && pathEquals(changedPath, s.activeManual.filePath)) {
        await refreshManualWidget(ctx.ui, s);
        refreshInjectionFooter(ctx.ui, s);
      }
    }
  });

  // ========== /pt-profile 命令：即时切换 ==========
  // Phase term-P2：/pt-context → /pt-profile（命令参数是 Profile 名，名该匹配操作目标）。
  pi.registerCommand("pt-profile", {
    description:
      "切换当前 Profile（编译成 AgentContext 注入 Session Inject），即时重转译（无参则弹出选择器）",
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
        // v14.x（tagline）：选择器展示 `name — tagline`，返回 label → 反查 name 走 switchProfile
        const profiles = await listProfilesWithTagline(ctx.cwd);
        const labels = formatProfileLabels(profiles);
        const pickedLabel = await ctx.ui.select("选择 Profile", labels);
        if (!pickedLabel) return;
        // 反查：精确匹配 profile 的 label 拿 name；fallback 到 split " — " 取首段（防格式漂移）
        const matched = profiles.find((p) => formatProfileLabels([p])[0] === pickedLabel);
        const picked = matched?.name ?? pickedLabel.split(" — ")[0] ?? pickedLabel;
        await switchProfile(pi, ctx, picked);
        return;
      }
      await switchProfile(pi, ctx, name);
    },
  });

  // ========== /pt 命令：查看 Pt 编译产物 / 管理项目文档 ==========
  // v19（issue pt-llm-tool-consolidation）：
  //   - 子命令重构为 info / doc 两根基 + 旧命令别名转发（back-compat）。
  //   - /pt info <kind>：status / packs / lint / logs / logs:clear / sessions / raw / full
  //   - /pt doc list [type] | start <procedure> [args] [--issue X] | check
  //   - 旧命令（status/packs/check/logs/logs:clear/sessions/raw/full/flows/issues/manuals/designs/check-docs/make-manual）转发
  //   - inject 无人类命令（见 issue §人类命令统一方案）
  //   - /pt 无参行为不变（statusText + cachedSegment）
  pi.registerCommand("pt", {
    description:
      "查看 Pt 转译产物 / 管理项目文档（无参=status + segment；子命令 info/doc；旧命令别名兼容）",
    handler: async (args, ctx) => {
      // v11.x 修复：sub = 第一词，subArgs = 剩余。兼容 logs:clear / status / flows 等单子命令。
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

      // ===== /pt 无参 = 默认 status + segment（保留原行为） =====
      if (sub === "") {
        ctx.ui.notify(statusText(s), "info");
        if (s.cachedSegment) {
          ctx.ui.notify(s.cachedSegment, "info");
        }
        return;
      }

      // ==================== /pt info <kind> ====================
      // status/packs/lint/logs/logs:clear/sessions/raw/full 八种
      if (sub === "info") {
        // subArgs 形如 "status" / "logs" / "lint --profile X" / "logs:clear" 等
        const infoFirstSpace = subArgs.indexOf(" ");
        const kindHead = infoFirstSpace === -1 ? subArgs : subArgs.slice(0, infoFirstSpace);
        const kindTail = infoFirstSpace === -1 ? "" : subArgs.slice(infoFirstSpace + 1);
        const kind = kindHead.trim().toLowerCase() || "status";
        const k = kindTail.trim();

        if (kind === "status") {
          ctx.ui.notify(statusText(s), "info");
          return;
        }
        if (kind === "packs") {
          ctx.ui.notify(packsText(s), "info");
          return;
        }
        if (kind === "lint") {
          // 解析 --profile X / --fix
          const parts = k.split(/\s+/).filter((p) => p.length > 0);
          let profileName: string | undefined;
          let fix = false;
          for (let i = 0; i < parts.length; i++) {
            const p = parts[i];
            if (p === "--fix") {
              fix = true;
              continue;
            }
            if (p === "--profile" || p === "-p") {
              const next = parts[i + 1];
              if (next && !next.startsWith("--")) {
                profileName = next;
                i++;
              }
              continue;
            }
            if (p.startsWith("--profile=")) {
              profileName = p.slice("--profile=".length);
              continue;
            }
            if (!profileName) profileName = p;
          }
          // 复用 pt_info {kind: lint} 的逻辑：实时加载 + scanProjectHealth + checkAllRefs
          const { checkAllRefs, formatRefCheckResult } = await import("./verify/ref-check.js");
          const { scanProjectHealth, formatHealthSummary } = await import("./asset-health.js");
          const r = await loadAndTranspile(ctx.cwd, s.activeProfile ?? "");
          const b = r.bundles[0];
          const report = await scanProjectHealth(
            ctx.cwd,
            b.profiles,
            b.blueprints,
            b.domains,
            b.packs,
            b.activeProfilePack,
            b.workingSet,
            { log: s.logger?.toWriter() }
          );
          const filtered = profileName
            ? {
                ...report,
                issues: report.issues.filter((i) => i.name === profileName),
                errors: report.issues.filter(
                  (i) => i.name === profileName && i.severity === "error"
                ).length,
                warnings: report.issues.filter(
                  (i) => i.name === profileName && i.severity === "warning"
                ).length,
              }
            : report;
          const refs = checkAllRefs(b.profiles, b.blueprints, b.domains, {
            domainWS: b.workingSet.domains,
            packNames: b.packs.map((p) => p.name),
          });
          const merged = `${formatHealthSummary(filtered)}\n\n${formatRefCheckResult(refs)}`;
          ctx.ui.notify(merged, filtered.errors > 0 || refs.errors.length > 0 ? "warning" : "info");
          // 旧 /pt check 兼容性：--fix 时显示迁移提示（v2 范围，本 v1 不实现）
          if (fix) {
            ctx.ui.notify(
              "提示：fix 模式 v2 范围，本 v1 不自动修改文件（运行 /pt info lint 查看 hint）",
              "info"
            );
          }
          return;
        }
        if (kind === "logs") {
          const files = await PtLogger.list(ctx.cwd);
          if (files.length === 0) {
            ctx.ui.notify(`无日志（${LOG_DIR}/ 不存在）`, "info");
            return;
          }
          let targetFile = `pt-${s.sessionId}.log`;
          if (!files.includes(targetFile)) {
            if (files.includes("pt.log")) targetFile = "pt.log";
            else targetFile = files[files.length - 1];
          }
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
              const stamp = e.ts.slice(11, 23);
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
        if (kind === "logs:clear") {
          await PtLogger.clear(ctx.cwd, s.sessionId || undefined);
          ctx.ui.notify(
            `已清空 .pt/logs/${s.sessionId ? `pt-${s.sessionId}.log` : "pt.log"}`,
            "info"
          );
          return;
        }
        if (kind === "sessions") {
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
        if (kind === "raw") {
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
        if (kind === "full") {
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
        ctx.ui.notify(
          `用法: /pt info <status|packs|lint|logs|logs:clear|sessions|raw|full>`,
          "warning"
        );
        return;
      }

      // ==================== /pt doc <action> ====================
      if (sub === "doc") {
        const docFirstSpace = subArgs.indexOf(" ");
        const actionHead = docFirstSpace === -1 ? subArgs : subArgs.slice(0, docFirstSpace);
        const actionTail = docFirstSpace === -1 ? "" : subArgs.slice(docFirstSpace + 1);
        const action = actionHead.trim().toLowerCase();
        const actionArgs = actionTail.trim();

        if (action === "" || action === "list") {
          // /pt doc list [type] —— type=flows/issues/manuals/designs，缺省列全部
          // 第一个词作为 type，其余作为 --profile / --status flags
          const listParts = actionArgs.split(/\s+/).filter((p) => p.length > 0);
          const type = listParts.shift() ?? "";
          const flags = parseListFlags(listParts.join(" "));
          const profile = flags.profile ?? s.activeProfile ?? null;

          if (type === "" || type === "all") {
            const out: string[] = [];
            out.push(flowsText(s));
            out.push(await formatsList(ctx.cwd, profile, "issues", flags.status));
            out.push(await formatsList(ctx.cwd, profile, "manuals", flags.status));
            out.push(await formatsList(ctx.cwd, profile, "designs", flags.status));
            ctx.ui.notify(out.join("\n\n"), "info");
            return;
          }
          if (type === "flows") {
            ctx.ui.notify(flowsText(s), "info");
            return;
          }
          if (type === "issues" || type === "manuals" || type === "designs") {
            ctx.ui.notify(await formatsList(ctx.cwd, profile, type, flags.status), "info");
            return;
          }
          ctx.ui.notify(
            `用法: /pt doc list [flows|issues|manuals|designs] [--profile X] [--status X]`,
            "warning"
          );
          return;
        }

        if (action === "start") {
          // /pt doc start <procedure> [args] [--issue X]
          const procedureParts = actionArgs.split(/\s+/).filter((p) => p.length > 0);
          let issueName: string | undefined;
          for (let i = 0; i < procedureParts.length; i++) {
            const p = procedureParts[i];
            if (p === "--issue") {
              const next = procedureParts[i + 1];
              if (next) issueName = next;
              procedureParts.splice(i, 2);
              break;
            }
            if (p.startsWith("--issue=")) {
              issueName = p.slice("--issue=".length);
              procedureParts.splice(i, 1);
              break;
            }
          }
          const procedureName = procedureParts[0] ?? "";
          const procedureArgs = procedureParts.slice(1).join(" ");
          const r = buildManualDoc(ctx.cwd, s, procedureName, procedureArgs, issueName);
          if (r.error) {
            ctx.ui.notify(r.error, "warning");
            return;
          }
          await mkdir(join(ctx.cwd, MANUAL_DIR), { recursive: true });
          await writeFile(r.filePath, r.content, "utf8");
          s.activeManual = {
            filePath: r.filePath,
            procedure: procedureName,
            args: procedureArgs,
            issue: issueName,
            activatedAt: Date.now(),
          };
          persistManualToSession(pi, s.activeManual);
          await refreshManualWidget(ctx.ui, s);
          refreshInjectionFooter(ctx.ui, s);
          ctx.ui.notify(`手册实例已创建: ${r.filePath}`, "info");
          return;
        }

        if (action === "check") {
          // /pt doc check —— 校验 docs/ 文档 schema（等价原 /pt check-docs）
          const profile = s.activeProfile ?? null;
          const text = await checkDocsText(ctx.cwd, profile, { profile });
          ctx.ui.notify(text, "info");
          return;
        }

        ctx.ui.notify("用法: /pt doc <list|start|check>", "warning");
        return;
      }

      // ==================== 旧命令别名（back-compat 转发） ====================
      // 等价 /pt info status
      if (sub === "status") {
        ctx.ui.notify(statusText(s), "info");
        return;
      }
      // 等价 /pt info packs
      if (sub === "packs") {
        ctx.ui.notify(packsText(s), "info");
        return;
      }
      // 等价 /pt info lint（保留原 /pt check 行为）
      if (sub === "check") {
        const checkParts = subArgs
          .trim()
          .split(/\s+/)
          .filter((s) => s.length > 0);
        let profileName: string | undefined;
        let fix = false;
        for (let i = 0; i < checkParts.length; i++) {
          const p = checkParts[i];
          if (p === undefined) continue;
          if (p === "--fix") {
            fix = true;
            continue;
          }
          if (p === "--profile" || p === "-p") {
            const next = checkParts[i + 1];
            if (next && !next.startsWith("--")) {
              profileName = next;
              i++;
            }
            continue;
          }
          if (p.startsWith("--profile=")) {
            profileName = p.slice("--profile=".length);
            continue;
          }
          if (!profileName) profileName = p;
        }
        const r = checkText(s, { profileName, fix });
        ctx.ui.notify(r.output, r.errors > 0 ? "warning" : "info");
        return;
      }
      // 等价 /pt info logs / logs:clear / sessions / raw / full
      if (
        sub === "logs" ||
        sub === "logs:clear" ||
        sub === "sessions" ||
        sub === "raw" ||
        sub === "full"
      ) {
        // 转发到 /pt info 同名 kind（复用上面 info handler）—— 简单重呼一次
        // 通过递归调用 cmd handler 不便（已注册），改用直接派发：
        // 这里复用 /pt info 同名 kind 实现——直接调用 info 分支内联（再次走 loadAndTranspile 等）
        // 为避免重复代码，refactor：用 helper 抽离；本期先转发。
        // 简化：直接调对应 handler 内联（info 分支 + raw/full/logs/sessions/logs:clear 各有 small block）
        // 这里选用与 /pt info logs 同等的代码路径——走子命令 inlined：
        const fakeInfoArgs =
          sub === "raw" ||
          sub === "full" ||
          sub === "sessions" ||
          sub === "logs" ||
          sub === "logs:clear"
            ? `${sub} ${subArgs}`
            : subArgs;
        // 递归调子命令——直接复用上面的 info 分支代码块即可（重复但保留可读性）
        // 此处直接复用 /pt info 逻辑：避免复制粘贴，用 wrapper
        // 简化：把 info 分支抽到命令级 helper —— 本期先 inlined 二次：
        if (sub === "logs") {
          const files = await PtLogger.list(ctx.cwd);
          if (files.length === 0) {
            ctx.ui.notify(`无日志（${LOG_DIR}/ 不存在）`, "info");
            return;
          }
          let targetFile = `pt-${s.sessionId}.log`;
          if (!files.includes(targetFile)) {
            if (files.includes("pt.log")) targetFile = "pt.log";
            else targetFile = files[files.length - 1];
          }
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
              const stamp = e.ts.slice(11, 23);
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
        return;
      }
      // 等价 /pt doc list flows
      if (sub === "flows") {
        ctx.ui.notify(flowsText(s), "info");
        return;
      }
      // 等价 /pt doc list issues/manuals/designs
      if (sub === "issues" || sub === "manuals" || sub === "designs") {
        const flags = parseListFlags(subArgs);
        const profile = flags.profile ?? s.activeProfile ?? null;
        const text =
          sub === "issues"
            ? await issuesText(ctx.cwd, profile, { status: flags.status })
            : sub === "manuals"
              ? await manualsText(ctx.cwd, profile, { status: flags.status })
              : await designsText(ctx.cwd, profile, { status: flags.status });
        ctx.ui.notify(text, "info");
        return;
      }
      // 等价 /pt doc start <proc>
      if (sub === "make-manual") {
        // 直接转发到 /pt doc start 逻辑——subArgs
        const procedureParts = subArgs.trim().split(/\s+/);
        let issueName: string | undefined;
        for (let i = 0; i < procedureParts.length; i++) {
          const p = procedureParts[i];
          if (p === "--issue") {
            const next = procedureParts[i + 1];
            if (next) issueName = next;
            procedureParts.splice(i, 2);
            break;
          }
          if (p?.startsWith("--issue=")) {
            issueName = p.slice("--issue=".length);
            procedureParts.splice(i, 1);
            break;
          }
        }
        const procedureName = procedureParts[0] ?? "";
        const procedureArgs = procedureParts.slice(1).join(" ");
        const r = buildManualDoc(ctx.cwd, s, procedureName, procedureArgs, issueName);
        if (r.error) {
          ctx.ui.notify(r.error, "warning");
          return;
        }
        await mkdir(join(ctx.cwd, MANUAL_DIR), { recursive: true });
        await writeFile(r.filePath, r.content, "utf8");
        s.activeManual = {
          filePath: r.filePath,
          procedure: procedureName,
          args: procedureArgs,
          issue: issueName,
          activatedAt: Date.now(),
        };
        persistManualToSession(pi, s.activeManual);
        await refreshManualWidget(ctx.ui, s);
        refreshInjectionFooter(ctx.ui, s);
        ctx.ui.notify(`手册实例已创建: ${r.filePath}`, "info");
        return;
      }
      // 等价 /pt doc check（校验 docs/ 文档 schema）
      if (sub === "check-docs") {
        const flags = parseListFlags(subArgs);
        const profile = flags.profile ?? s.activeProfile ?? null;
        const allowedKind = flags.kind;
        const kind =
          allowedKind === "issue" || allowedKind === "manual" || allowedKind === "design"
            ? allowedKind
            : undefined;
        const text = await checkDocsText(ctx.cwd, profile, kind ? { kind } : { profile });
        ctx.ui.notify(text, "info");
        return;
      }

      ctx.ui.notify(
        "用法: /pt [info <kind>|doc <action>] （旧命令 status/packs/check/logs/logs:clear/sessions/raw/full/flows/issues/manuals/designs/check-docs/make-manual 仍兼容）",
        "warning"
      );
    },
  });

  // ========== tool 壳：LLM 可调（与 command 共享纯函数内核，.pt/docs/designs/pt-command-tool-dual-registration.md） ==========
  // 只读查询 + 手册实例化做 tool；pt-profile（改 system prompt）不做 tool（见设计文档 §2.4）
  //
  // v19（issue pt-llm-tool-consolidation）：8 tool 收敛到 3 根基 + 二级命令
  //   划分依据：作用对象正交（info=Pt 自身 / doc=项目文档 / inject=user message）。
  //   enum 字段用 StringEnum（from @earendil-works/pi-ai）跨 provider 兼容。
  //   pt_doc 全 optional schema（Pi 对 discriminated union 支持不确定，安全落地）。

  // 根基 1：Pt 自身运行时/调试查询（只读）
  //   kind=status 等价原 pt_status；packs 等价 pt_packs；lint 合并 pt_check + pt_check_refs 走实时加载；
  //   logs/logs:clear/sessions/raw/full 路径查询，等价原 /pt 命令同名子命令。
  pi.registerTool({
    name: "pt_info",
    label: "Pt Info",
    description:
      "Query Pt itself (runtime state / compiled artifacts / debug file paths). Read-only. " +
      "Use kind=status for active profile + counts + cache hit; kind=packs for loaded pack details; " +
      "kind=lint for project asset misconfigurations (missing Modules / dangling refs / orphan H2 / empty segments / unknown modnames), " +
      "merges the previous pt_check + pt_check_refs into a single real-time scan; " +
      "kind=logs/logs:clear/sessions/raw/full for runtime log/session file paths (equivalent to /pt logs etc.). " +
      "Switch via the `kind` parameter.",
    promptSnippet: "Query Pt runtime state / assets / debug paths by kind",
    promptGuidelines: [
      "Use pt_info when you need to know Pt's current state, load details, or runtime paths.",
      "Pair pt_info {kind: lint} with /pt doc list manual — lint for asset config health, list manuals for runtime tracking.",
    ],
    parameters: Type.Object({
      kind: StringEnum(
        ["status", "packs", "lint", "logs", "logs:clear", "sessions", "raw", "full"],
        {
          description:
            "What to query: status/packs/lint for live state; logs/logs:clear/sessions for log paths; raw/full for compiled prompt artifacts.",
        }
      ),
      // lint 分支用：限定扫的 profile 名
      profile: Type.Optional(
        Type.String({
          description: "Lint only: limit scan to a single Profile name (e.g. 'ysl-developer').",
        })
      ),
      // lint 分支用：reserved for v2 fix mode（恒 false，仅显示 hint 不改文件）
      fix: Type.Optional(
        Type.Boolean({
          description:
            "Lint only: reserved for v2. Currently always false; output shows hints but does not modify files.",
        })
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = getSessionIdFromCtx(ctx);
      const s = sessionId ? getSessionById(sessionId) : null;
      const kind = params.kind ?? "status";

      if (kind === "status") {
        return {
          content: [{ type: "text", text: s ? statusText(s) : "no session" }],
          details: { kind },
        };
      }

      if (kind === "packs") {
        return {
          content: [{ type: "text", text: s ? packsText(s) : "no session" }],
          details: { kind },
        };
      }

      if (kind === "lint") {
        // v19（issue pt-llm-tool-consolidation）：pt_info {kind: lint} 合并 pt_check + pt_check_refs
        //   - 走 loadAndTranspile 实时加载（修 pt_check 读 session.assetHealthIssues 缓存的弱点）
        //   - scanProjectHealth 的 8 类检查项全保留 + checkAllRefs 独有的"未实例化聚合组"warning 保留
        const { checkAllRefs, formatRefCheckResult } = await import("./verify/ref-check.js");
        const { scanProjectHealth, formatHealthSummary } = await import("./asset-health.js");
        const r = await loadAndTranspile(ctx.cwd, s?.activeProfile ?? "");
        const b = r.bundles[0];
        // scan 部分
        const report = await scanProjectHealth(
          ctx.cwd,
          b.profiles,
          b.blueprints,
          b.domains,
          b.packs,
          b.activeProfilePack,
          b.workingSet,
          { log: s?.logger?.toWriter() }
        );
        // profileName 过滤（与原 /pt check --profile 行为对齐）
        const filteredReport = params.profile
          ? {
              ...report,
              issues: report.issues.filter((i) => i.name === params.profile),
              errors: report.issues.filter(
                (i) => i.name === params.profile && i.severity === "error"
              ).length,
              warnings: report.issues.filter(
                (i) => i.name === params.profile && i.severity === "warning"
              ).length,
            }
          : report;
        const scanOut = formatHealthSummary(filteredReport);
        // refs 部分（pt_check_refs 原行为）
        const refs = checkAllRefs(b.profiles, b.blueprints, b.domains, {
          domainWS: b.workingSet.domains,
          packNames: b.packs.map((p) => p.name),
        });
        const refsOut = formatRefCheckResult(refs);
        const merged = `${scanOut}\n\n${refsOut}`;
        return {
          content: [{ type: "text", text: merged }],
          details: {
            kind,
            scanErrors: filteredReport.errors,
            scanWarnings: filteredReport.warnings,
            scanIssues: filteredReport.issues.length,
            refErrors: refs.errors.length,
            refWarnings: refs.warnings.length,
          },
        };
      }

      // 以下 kind 走 /pt 命令同名子命令相同路径（共享 handlers）
      if (kind === "logs") {
        const files = await PtLogger.list(ctx.cwd);
        if (files.length === 0) {
          return {
            content: [{ type: "text", text: `无日志（${LOG_DIR}/ 不存在）` }],
            details: { kind },
          };
        }
        const targetFile = s?.sessionId ? `pt-${s.sessionId}.log` : files[files.length - 1];
        const lines = await PtLogger.tail(
          ctx.cwd,
          50,
          targetFile === "pt.log" ? undefined : targetFile.slice(3, -4)
        );
        const formatted = lines
          .map((e) => {
            const stamp = e.ts.slice(11, 23);
            const lvl = e.level.toUpperCase().padEnd(7);
            const ctxStr =
              e.ctx && Object.keys(e.ctx).length > 0 ? ` ${JSON.stringify(e.ctx)}` : "";
            return `[${stamp}] [${lvl}] ${e.msg}${ctxStr}`;
          })
          .join("\n");
        const header = `(${targetFile}，最近 ${lines.length} 条; 共 ${files.length} 个 session 文件)`;
        return { content: [{ type: "text", text: `${header}\n${formatted}` }], details: { kind } };
      }

      if (kind === "logs:clear") {
        await PtLogger.clear(ctx.cwd, s?.sessionId ?? undefined);
        return {
          content: [
            {
              type: "text",
              text: `已清空 .pt/logs/${s?.sessionId ? `pt-${s.sessionId}.log` : "pt.log"}`,
            },
          ],
          details: { kind },
        };
      }

      if (kind === "sessions") {
        const files = await PtLogger.list(ctx.cwd);
        if (files.length === 0) {
          return { content: [{ type: "text", text: "无 session 日志文件" }], details: { kind } };
        }
        const list = files
          .map((f) => `  ${f}${f === `pt-${s?.sessionId}.log` ? " (current)" : ""}`)
          .join("\n");
        return {
          content: [{ type: "text", text: `已存在的 session 日志:\n${list}` }],
          details: { kind },
        };
      }

      if (kind === "raw") {
        if (!s?.cachedSegment) {
          return {
            content: [{ type: "text", text: "无 segment 可显示" }],
            details: { kind, error: "no segment" },
          };
        }
        const dir = join(ctx.cwd, RAW_DIR);
        await mkdir(dir, { recursive: true });
        const file = join(dir, `segment-${Date.now()}.md`);
        await writeFile(file, s.cachedSegment, "utf8");
        return {
          content: [{ type: "text", text: `已写入 ${file}（${s.cachedSegment.length} chars）` }],
          details: { kind, path: file },
        };
      }

      if (kind === "full") {
        if (!s?.cachedSegment) {
          return {
            content: [{ type: "text", text: "警告：无 cachedSegment（未加载 Profile）" }],
            details: { kind, error: "no segment" },
          };
        }
        const full = buildFullPrompt(ctx.getSystemPrompt(), s.cachedSegment, s.lastBuiltPrompt);
        const dir = join(ctx.cwd, FULL_DIR);
        await mkdir(dir, { recursive: true });
        const file = join(dir, `prompt-${Date.now()}.md`);
        await writeFile(file, full, "utf8");
        return {
          content: [
            { type: "text", text: `完整 systemPrompt 已写入 ${file}（${full.length} chars）` },
          ],
          details: { kind, path: file },
        };
      }

      return {
        content: [{ type: "text", text: `unknown kind: ${kind}` }],
        details: { kind, error: "unknown kind" },
      };
    },
  });

  // 根基 2：项目文档管理（CRUD + 索引 + 校验，有副作用）
  //   action=list 等价原 pt_flows/issues/manuals/designs；start 等价原 pt_make_manual；
  //   verify 等价原 pt_verify；check 校验 docs/ 文档 schema。
  //   全 optional schema：Pi 对 discriminated union（oneOf/anyOf）支持不确定，安全落地（issue §关键合并点 6）。
  pi.registerTool({
    name: "pt_doc",
    label: "Pt Doc",
    description:
      "Manage project documents (issue/manual/design/flow + FlowTemplate manual instances). " +
      "Use action=list with type=flows|issues|manuals|designs to index the corresponding document set; " +
      "action=start with procedure (+ optional args + optional issue) to instantiate a FlowTemplate manual; " +
      "action=verify with probe (+ optional params) to run a verification probe; " +
      "action=check to validate docs/ schema.",
    promptSnippet: "List / start / verify / check Pt project documents by action",
    promptGuidelines: [
      "Use pt_doc when managing project document lifecycles (issue/manual/design instances, verification probes).",
      "For action=start, procedure is required. For action=verify, probe is required. For action=list, type is optional (defaults to all).",
    ],
    parameters: Type.Object({
      action: StringEnum(["list", "start", "verify", "check"], {
        description:
          "action=list indexes documents; action=start instantiates a manual; action=verify runs a probe; action=check validates docs/ schema.",
      }),
      // list 分支：type 可选（缺省列全部）；status 可选（按 frontmatter.status 过滤）
      type: Type.Optional(
        Type.String({
          description:
            "list branch: filter by document kind — issues | manuals | designs | flows (omit = all).",
        })
      ),
      status: Type.Optional(
        Type.String({
          description:
            "list branch (issues/manuals/designs only): filter by frontmatter status (e.g. open / in-progress / resolved / completed).",
        })
      ),
      profile: Type.Optional(
        Type.String({
          description:
            "list branch: limit index to this profile's documents (omit = active profile / all).",
        })
      ),
      // start 分支：procedure 必填；args / issue 可选
      procedure: Type.Optional(
        Type.String({
          description:
            "start branch: FlowTemplate name (e.g. feature-lifecycle, issue-lifecycle, regression-verify). Required when action=start.",
        })
      ),
      args: Type.Optional(
        Type.String({
          description:
            "start branch: arguments for the procedure, e.g. 'req-001' or 'term my-concept'.",
        })
      ),
      issue: Type.Optional(
        Type.String({
          description:
            "start branch: optional issue name this manual instance serves. Written to frontmatter `issue:` field.",
        })
      ),
      // verify 分支：probe 必填；params 可选
      probe: Type.Optional(
        Type.String({
          description:
            "verify branch: probe name from observe field (e.g. fs-content-match, ts-compiles, test-pass, git-status-clean). Required when action=verify.",
        })
      ),
      params: Type.Optional(
        Type.Record(Type.String(), Type.String(), {
          description:
            "verify branch: probe parameters, e.g. { path: 'src/foo.ts', pattern: 'export' }.",
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
      const action = params.action ?? "list";

      // ==================== action=list ====================
      if (action === "list") {
        const profile = params.profile ?? s.activeProfile ?? null;
        const type = params.type;
        // type 缺省或 "all" / "any" → 聚合所有类型
        if (!type || type === "all") {
          const out: string[] = [];
          // flowsText 需 session（adepter 已注入），与其他类型路径不同——
          // 拿 session 后直接走专属路径
          out.push(flowsText(s));
          out.push(await formatsList(ctx.cwd, profile, "issues", params.status));
          out.push(await formatsList(ctx.cwd, profile, "manuals", params.status));
          out.push(await formatsList(ctx.cwd, profile, "designs", params.status));
          return {
            content: [{ type: "text", text: out.join("\n\n") }],
            details: { action, type: "all" },
          };
        }
        if (type === "flows") {
          // flowsText 需 session（adepter 已注入）——拿 s 后调
          return { content: [{ type: "text", text: flowsText(s) }], details: { action, type } };
        }
        if (type === "issues" || type === "manuals" || type === "designs") {
          const text = await formatsList(ctx.cwd, profile, type, params.status);
          return { content: [{ type: "text", text }], details: { action, type } };
        }
        return {
          content: [
            {
              type: "text",
              text: `unknown type "${type}" (allowed: flows|issues|manuals|designs)`,
            },
          ],
          details: { action, type, error: "unknown type" },
        };
      }

      // ==================== action=start ====================
      if (action === "start") {
        if (!params.procedure) {
          return {
            content: [{ type: "text", text: "action=start requires procedure" }],
            details: { action, error: "missing procedure" },
          };
        }
        const r = buildManualDoc(ctx.cwd, s, params.procedure, params.args ?? "", params.issue);
        if (r.error) {
          return {
            content: [{ type: "text", text: r.error }],
            details: { action, error: r.error },
          };
        }
        return withFileMutationQueue(r.filePath, async () => {
          await mkdir(join(ctx.cwd, MANUAL_DIR), { recursive: true });
          await writeFile(r.filePath, r.content, "utf8");
          // v11.x：手动跟踪实例 + widget + footer + 持久化
          s.activeManual = {
            filePath: r.filePath,
            procedure: params.procedure as string,
            args: params.args ?? "",
            issue: params.issue, // P3：透传 issue 字段（可选，undefined 时不写 frontmatter）
            activatedAt: Date.now(),
          };
          // v18.x（决策 6）：记录 compaction 重注入线索——Manual 文件路径
          // 保留已有 turnInjectDomain（若之前已调 pt_inject，不覆盖）
          s.lastTurnRef = {
            turnInjectDomain: s.lastTurnRef?.turnInjectDomain ?? "",
            manualPath: r.filePath,
          };
          persistLastTurnRef(pi, s.lastTurnRef);
          persistManualToSession(pi, s.activeManual);
          await refreshManualWidget(ctx.ui, s);
          refreshInjectionFooter(ctx.ui, s);
          return {
            content: [{ type: "text", text: `手册实例已创建: ${r.filePath}` }],
            details: { action, procedure: params.procedure, path: r.filePath },
          };
        });
      }

      // ==================== action=verify ====================
      if (action === "verify") {
        if (!params.probe) {
          return {
            content: [{ type: "text", text: "action=verify requires probe" }],
            details: { action, error: "missing probe" },
          };
        }
        const { runVerify } = await import("./verify/index.js");
        const probeParams = (params.params ?? {}) as Record<string, string>;
        const result = await runVerify(ctx.cwd, params.probe, probeParams);
        const text =
          result.outcome === "COMPLETED"
            ? `✓ ${result.message}`
            : result.outcome === "DEVIATED"
              ? `✗ ${result.message}${result.actual ? `\n${result.actual}` : ""}`
              : `? ${result.message}`;
        // v15.x（issue pt-verify-result-not-written-back-to-manual）：自动写回 manual 文件
        let writebackNote = "";
        if (s?.activeManual) {
          const filePath = s.activeManual.filePath;
          try {
            await withFileMutationQueue(filePath, async () => {
              const before = await readFile(filePath, "utf8");
              const wb = writeProbeResult(
                before,
                params.probe as string,
                result.outcome,
                result.message
              );
              if (wb.changed) {
                await writeFile(filePath, wb.content, "utf8");
                const checked =
                  wb.checkedSteps.length > 0 ? `，勾选 ${wb.checkedSteps.length} 个 checklist` : "";
                writebackNote = `\n↳ 已写回 manual step ${wb.stepIndexes.join(", ")}${checked}`;
              } else if (wb.matchCount === 0) {
                writebackNote = `\n? probe "${params.probe}" 未匹配 activeManual 任何 step 的 observe（${filePath}）`;
              }
            });
          } catch (e) {
            writebackNote = `\n! 写回 manual 失败: ${errMsg(e)}`;
          }
          await refreshManualWidget(ctx.ui, s);
          refreshInjectionFooter(ctx.ui, s);
        }
        return {
          content: [{ type: "text", text: text + writebackNote }],
          details: {
            action,
            probe: params.probe,
            ...result,
            writeback: writebackNote || undefined,
          },
        };
      }

      // ==================== action=check ====================
      if (action === "check") {
        const profile = params.profile ?? s.activeProfile ?? null;
        const text = await checkDocsText(ctx.cwd, profile, { profile });
        return { content: [{ type: "text", text }], details: { action } };
      }

      return {
        content: [{ type: "text", text: `unknown action: ${action}` }],
        details: { action, error: "unknown action" },
      };
    },
  });

  // 根基 3：user message 注入（transform，无副作用）
  //   等价原 pt_turn_inject tool；execute 调 renderTurnInject 走统一内核。
  //   renderTurnInject 内部仍按 `/pt_turn_inject <target>` 字符串前缀解析（tool execute 拼前缀传入）——
  //   内部耦合保留，issue §边界纪律（不在本 scope 解耦）。
  pi.registerTool({
    name: "pt_inject",
    label: "Pt Inject",
    description:
      "Inject TurnContext (compiled manual detail) for a Domain on demand. " +
      "Returns the Rules/Flows/Checklists content of the Domain. " +
      "Use when reasoning needs a Domain's manual detail referenced in SessionContext's trigger-index. " +
      "Input: domain name (from /pt info /kind=flows output).",
    promptSnippet: "Inject a Domain's TurnContext (manual detail) on demand",
    promptGuidelines: [
      "Use pt_inject to fetch a Domain's manual detail (Rules/Flows/Checklists) on demand.",
      "Consult SessionContext's trigger-index or /pt info flows to decide which Domain to query.",
    ],
    parameters: Type.Object({
      domain: Type.String({
        description:
          "Domain name to inject, e.g. 'dev-process' or 'pt-quality'. Use /pt info flows to list available domains.",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!getSessionIdFromCtx(ctx)) {
        return {
          content: [{ type: "text", text: "no session" }],
          details: { error: "no session" },
        };
      }
      const s = getSessionById(getSessionIdFromCtx(ctx) as string);
      if (
        !s.cachedBundles ||
        s.cachedBundles.length === 0 ||
        !s.cachedAgentContext ||
        !s.cachedBlueprint
      ) {
        return {
          content: [{ type: "text", text: "无激活 Profile，先用 /pt-profile 激活" }],
          details: { error: "no active profile" },
        };
      }
      const scoped = filterDomainsByProfile(s.cachedBundles[0].domains, s.cachedProfile);
      // 内部耦合：renderTurnInject 按 `/pt_turn_inject <target>` 前缀解析
      // 保留该耦合（issue §边界纪律）——后续 issue 解耦
      const content = renderTurnInject(
        s.cachedAgentContext,
        s.cachedBlueprint,
        scoped,
        s.cachedProfile,
        `/pt_turn_inject ${params.domain}`
      );
      if (content === null) {
        return {
          content: [
            {
              type: "text",
              text: `未找到 Domain 或无手册段: ${params.domain}（用 /pt info flows 查可用手册）`,
            },
          ],
          details: { error: "not found", domain: params.domain },
        };
      }
      // v18.x（决策 6）：记录 compaction 重注入线索——TurnContext domain 名
      s.lastTurnRef = {
        turnInjectDomain: params.domain,
        manualPath: s.lastTurnRef?.manualPath ?? null,
      };
      persistLastTurnRef(pi, s.lastTurnRef);
      return { content: [{ type: "text", text: content }], details: { domain: params.domain } };
    },
  });
}
