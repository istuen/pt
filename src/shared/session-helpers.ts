// src/shared/session-helpers.ts
// 4 个共享 helper（从 index.ts 抽出，Step 1）。
// 签名零变化——已是参数化形态（非闭包变量），原样搬出，只加 export。

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { toAgentAPI } from "../agent/api-bridge.js";
import { getAgentAdapter } from "../agent/index.js";
import { applyProjectPackDegrade } from "../asset-pack/loader.js";
import { errMsg } from "../diagnostics.js";
import { persistProfileToSession } from "../profile-persist.js";
import { getSessionById, resetSessionState } from "../session.js";
import { loadAndTranspile } from "../transpile.js";
import { refreshInjectionFooter, refreshManualWidget } from "../manual-session.js";
import { slog } from "../slog.js";
import type { AgentUIContext } from "./pi-types.js";

/** 从 ExtensionContext 拿 sessionId（tool / command handler ctx 形态）。 */
export function getSessionIdFromCtx(ctx: {
  sessionManager?: { getSessionId?: () => string };
}): string {
  return ctx.sessionManager?.getSessionId?.() ?? "";
}

/** 当前编译产物就绪时注册 Adapter 注入；session_start 与手动切换共用。
 *  v12.x：传 pi + sessionId，按 sessionId 拿 per-session state，按 pi 拿 per-pi adapter。 */
export function registerInjectionIfReady(
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
export async function transpileActive(
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
export async function switchProfile(
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
