// src/manual-session.ts — manual 跟踪的 session/JSONL/widget 交互层
//
// v11.x：从 src/index.ts 抽出的 6 个函数 + 模块级缓存 + 常量。
//
// 职责分层（vs 已抽出的 manual-track.ts）：
//   - manual-track.ts：纯函数渲染（renderManualFooterSuffix / renderManualWidgetLines / isManualActive / parseManualProgress）
//   - manual-session.ts：session JSONL 读写 + widget/footer 交互 + ActiveManual 状态机
//
// v12.x（issue pt-session-singleton-pi-web-pollution 修复）：
//   - 函数全部接受 `session: SessionState` 参数，调用方传 per-session state
//   - `cachedManualProgress` 从 module-level let 搬到 SessionState 字段（session.cachedManualProgress）
//   - 不再 import module-level `session` 单例
//
// 调用方：src/index.ts session_start / session_shutdown / 命令 + tool
//
// 依赖梳理：
//   - Pi 类型：ExtensionAPI / ExtensionContext / ExtensionUIContext / AgentUIContext
//   - session 单例 → SessionState 参数
//   - manual-track 纯函数：parseManualProgress / renderManualWidgetLines / renderManualFooterSuffix / isManualActive / ManualProgress
//   - injection-status：renderInjectionFooter
//   - profile-persist：MinimalSessionManager
//   - slog：slog（session-scoped logger 快捷）
//   - diagnostics：errMsg

import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import {
  isManualActive,
  parseManualProgress,
  renderManualFooterSuffix,
  renderManualWidgetLines,
} from "./manual-track.js";
import { renderInjectionFooter } from "./injection-status.js";
import type { MinimalSessionManager } from "./profile-persist.js";
import { errMsg } from "./diagnostics.js";
import { slog } from "./slog.js";
import type { ActiveManual, SessionState } from "./session.js";

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
    slog("", "warn", "persistManualToSession failed", { procedure: m.procedure, err: errMsg(e) });
  }
}

/** 计算 active manual 的 footer 后缀（空字符串 = 无 activeManual 或 completed）。 */
function renderActiveManualSuffix(session: SessionState): string {
  if (!session.activeManual) return "";
  // 同步快速读（无 IO）—— widget 刷新会走 async parseManualProgress
  // footer 只显示 procedure 名 + done/total，避免 IO 阻塞 setStatus
  // 但 stepDone/total 是派生数据，需要同步可读——
  // 这里走同步取缓存策略：保留 widget 异步 parse 的最新结果
  if (!session.cachedManualProgress) return "";
  return renderManualFooterSuffix(session.cachedManualProgress);
}

/** 刷新 footer 注入状态 + manual 后缀（合并写一次 setStatus）。
 *  v14.x（issue pt-asset-migration-visibility Layer 2）：assetHealthIssues.length 透传给
 *  renderInjectionFooter → footer 末尾追加 ⚠ N issues（染色）。 */
function refreshInjectionFooter(ui: ExtensionUIContext, session: SessionState): void {
  const suffix = renderActiveManualSuffix(session);
  const healthCount = session.assetHealthIssues?.length ?? 0;
  const base = renderInjectionFooter(
    session.injectionState,
    session.activeProfile,
    session.injectionError,
    healthCount
  );
  ui.setStatus("pt", suffix ? `${base} ${suffix}` : base);
}

/** 刷新 widget（aboveEditor）。根据 session.activeManual 决定显示/撤掉。
 *  - 无 activeManual → 撤 widget
 *  - 文件不存在 / 已 completed → 清 activeManual + 撤 widget
 *  - in-progress → 渲染 3 行 widget + 更新 cachedManualProgress（footer 同步读）
 *  v12.x：state 全部从 session 参数读，不再读写 module-level 单例。 */
async function refreshManualWidget(ui: ExtensionUIContext, session: SessionState): Promise<void> {
  const m = session.activeManual;
  if (!m) {
    session.cachedManualProgress = null;
    ui.setWidget("pt-manual", undefined);
    return;
  }
  const p = await parseManualProgress(m.filePath);
  if (!p || p.status === "completed") {
    session.activeManual = null;
    session.cachedManualProgress = null;
    ui.setWidget("pt-manual", undefined);
    return;
  }
  session.cachedManualProgress = p;
  ui.setWidget("pt-manual", renderManualWidgetLines(m.filePath, p), {
    placement: "aboveEditor",
  });
}

/** session_start 时试恢复 manual：读 pt:active-manual entry → 校验文件存在 + status !== completed。
 *  独立于 profile 加载链——profile 失败 / 无 profile 也能恢复 manual 追踪。 */
async function tryRestoreManual(ctx: ExtensionContext, session: SessionState): Promise<void> {
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
  await refreshManualWidget(ctx.ui, session);
  // widget 设置后才调 footer（refreshManualWidget 写 cachedManualProgress）
  refreshInjectionFooter(ctx.ui, session);
  session.logger?.info("manual:restored", {
    filePath: entry.filePath,
    procedure: entry.procedure,
  });
}

/** 重置 module-level 缓存（session_shutdown 时调，避免新 session 残留旧 manual 状态）。
 *  v12.x：改 no-op——cachedManualProgress / activeManual 都搬到 SessionState，
 *  session_shutdown 时由 `clearSessionById(sessionId)` 整体删除 entry 即可。 */
function resetManualSession(_session: SessionState): void {
  // no-op: state 已在 session_shutdown 时通过 clearSessionById 删除
}

export {
  persistManualToSession,
  refreshInjectionFooter,
  refreshManualWidget,
  resetManualSession,
  tryRestoreManual,
};
