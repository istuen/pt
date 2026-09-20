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
import { resolve as pathResolve } from "node:path";
import {
  checkManualCompletion,
  isManualActive,
  manualProgressEqual,
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

/** v18.x（issue pt-turncontext-llm-call-trigger 决策 6）：lastTurnRef 持久化 entry。
 *  与 PT_MANUAL_ENTRY 同寿命周期——session_start 读恢复 / 调 pt_turn_inject + pt_make_manual 写。 */
const PT_LAST_TURN_REF_ENTRY = "pt:last-turn-ref";

/** TurnContext 线索结构（引用指针，非内容缓存）。 */
export interface LastTurnRef {
  turnInjectDomain: string;
  manualPath: string | null;
}

/** 从 session JSONL 读上次保存的 ActiveManual。读出后由 caller 校验（isManualActive）。
 *  静默 fallback：异常 / 无 entry → undefined。
 *  P3：加 issue 可选字段——读时用 typeof === "string" ? issue : undefined 兜底，
 *  旧 entry（P3 之前）无该字段仍能正常读出（activeManual.issue = undefined）。 */
interface PersistedManualEntry {
  filePath: string;
  procedure: string;
  args: string;
  issue?: string;
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
          const issue = d.issue;
          if (typeof filePath === "string" && filePath.trim() && typeof procedure === "string") {
            const entry: PersistedManualEntry = {
              filePath: filePath.trim(),
              procedure,
              args: typeof args === "string" ? args : "",
            };
            if (typeof issue === "string" && issue.trim()) {
              entry.issue = issue.trim();
            }
            return entry;
          }
        }
      }
    }
  } catch {}
  return undefined;
}

/** 把当前 ActiveManual 写入 session JSONL。
 *  失败静默（ephemeral session / 旧版 pi 无 appendEntry）——内存中 activeManual 仍可用本进程。
 *  P3：issue 字段透传到 entry——只在有值时写（undefined 不写），避免旧 entry 读出 undefined
 *  与"未填 issue"语义混淆。 */
function persistManualToSession(pi: ExtensionAPI, m: ActiveManual): void {
  try {
    if (typeof pi.appendEntry !== "function") return;
    const data: { filePath: string; procedure: string; args: string; issue?: string } = {
      filePath: m.filePath,
      procedure: m.procedure,
      args: m.args,
    };
    if (m.issue?.trim()) {
      data.issue = m.issue.trim();
    }
    pi.appendEntry(PT_MANUAL_ENTRY, data);
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
 *  renderInjectionFooter → footer 末尾追加 ⚠ N issues（染色）。
 *  v14.x（tagline）：从 cachedProfile.tagline 读，footer 拼 `: <tagline>`。
 *  P1：与上次 setStatus 字符串比较去重——tool_result + turn_end 双钩子刷新时，injectionState
 *  与 activeProfile 等字段通常未变，footer 文本也不会变，跳过 setStatus 避免无变化 IPC。
 *  字符串比较覆盖所有写入 base/suffix/healthCount/tagline 的字段。 */
function refreshInjectionFooter(ui: ExtensionUIContext, session: SessionState): void {
  const suffix = renderActiveManualSuffix(session);
  const healthCount = session.assetHealthIssues?.length ?? 0;
  const tagline = session.cachedProfile?.tagline ?? null;
  const base = renderInjectionFooter(
    session.injectionState,
    session.activeProfile,
    session.injectionError,
    healthCount,
    "auto",
    tagline
  );
  const text = suffix ? `${base} ${suffix}` : base;
  if (session.lastFooterText === text) {
    return; // 未变，跳过 setStatus IPC
  }
  session.lastFooterText = text;
  ui.setStatus("pt", text);
}

/** 刷新 widget（aboveEditor）。根据 session.activeManual 决定显示/撤掉。
 *  - 无 activeManual → 撤 widget
 *  - 文件不存在 / 真完成（status=completed + stepDone===stepTotal + 无 —/INCONCLUSIVE）→ 清 activeManual + 撤 widget
 *  - 伪完成（status=completed 但 step 未全勾或有 —/INCONCLUSIVE）→ 仍渲染 widget，加 ⚠ fake done 提示
 *  - in-progress → 渲染 3 行 widget + 更新 cachedManualProgress（footer 同步读）
 *  v12.x：state 全部从 session 参数读，不再读写 module-level 单例。
 *  v15.x（issue pt-manual-completion-check-too-loose）：用 checkManualCompletion 替代 `p.status === "completed"`,
 *  让伪完成的 manual 仍 active（widget 重新挂载，提示用户步骤未全完成）。
 *  P1：用 manualProgressEqual 浅比较去重——tool_result / turn_end 双钩子高频调用本函数，
 *  进度未变时只更新缓存不发 setWidget IPC（节省 ~70% 无效 IPC，见 pt-workspace-boundary-calibration §2.3）。 */
async function refreshManualWidget(ui: ExtensionUIContext, session: SessionState): Promise<void> {
  const m = session.activeManual;
  if (!m) {
    const prev = session.cachedManualProgress;
    session.cachedManualProgress = null;
    if (prev === null) {
      return; // 本来就是 null，不发 setWidget(undefined) IPC
    }
    session.lastFooterText = null; // 重置 footer 缓存，让下次 footer 刷新重写
    ui.setWidget("pt-manual", undefined);
    return;
  }
  const p = await parseManualProgress(m.filePath);
  if (!p || !checkManualCompletion(p)) {
    session.activeManual = null;
    const prev = session.cachedManualProgress;
    session.cachedManualProgress = null;
    if (prev !== null) {
      session.lastFooterText = null;
      ui.setWidget("pt-manual", undefined);
    }
    return;
  }
  const prev = session.cachedManualProgress;
  session.cachedManualProgress = p;
  if (manualProgressEqual(prev, p)) {
    return; // 进度未变，跳过 setWidget IPC（footer 由 caller 调，会自己走字符串去重）
  }
  session.lastFooterText = null; // widget 内容变了，footer 后缀也变了，重置 footer 缓存
  ui.setWidget("pt-manual", renderManualWidgetLines(m.filePath, p), {
    placement: "aboveEditor",
  });
}

/** v18.x（决策 6）：把 lastTurnRef 写入 session JSONL。
 *  resume / --session 启动时读出恢复（与 persistManualToSession 同机制）。
 *  失败静默（ephemeral session / 旧版 pi 无 appendEntry）。 */
function persistLastTurnRef(pi: ExtensionAPI, ref: LastTurnRef): void {
  try {
    if (typeof pi.appendEntry !== "function") return;
    pi.appendEntry(PT_LAST_TURN_REF_ENTRY, {
      turnInjectDomain: ref.turnInjectDomain,
      manualPath: ref.manualPath,
    });
  } catch (e) {
    slog("", "warn", "persistLastTurnRef failed", { err: errMsg(e) });
  }
}

/** v18.x（决策 6）：session_start 时试恢复 lastTurnRef。
 *  独立于 manual 恢复链——compaction 线索是 session lifecycle 维度，
 *  无 manual 时也能有线索（只调过 pt_turn_inject 没调 pt_make_manual）。 */
function tryRestoreLastTurnRef(ctx: ExtensionContext, session: SessionState): void {
  const sm = ctx.sessionManager;
  if (!sm || typeof sm.getEntries !== "function") return;
  try {
    const entries = sm.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e && e.type === "custom" && e.customType === PT_LAST_TURN_REF_ENTRY) {
        const data = (e as { data?: unknown }).data;
        if (data && typeof data === "object") {
          const d = data as Record<string, unknown>;
          const turnInjectDomain = typeof d.turnInjectDomain === "string" ? d.turnInjectDomain : "";
          const manualPath = typeof d.manualPath === "string" ? d.manualPath : null;
          // 只要 turnInjectDomain 或 manualPath 至少一个有效就恢复
          if (turnInjectDomain || manualPath) {
            session.lastTurnRef = { turnInjectDomain, manualPath };
            session.logger?.info("lastTurnRef:restored", {
              turnInjectDomain,
              manualPath,
            });
          }
        }
        return; // 取最近一条即可
      }
    }
  } catch (e) {
    slog("", "warn", "tryRestoreLastTurnRef failed", { err: errMsg(e) });
  }
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
    issue: entry.issue, // P3：恢复 issue 字段（可选，无值时 undefined）
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

/** 跨平台路径归一比较（resolve 后字符串比较）。
 *  - 绝对路径优先：path.resolve 解析 `..`/`./`/`~/` 与当前 cwd，等价字符串视为同一文件
 *  - resolve 抛错时退化为原字符串等比（极少触发，相对路径在某些 cwd 下解析失败）
 *  P1：tool_result 钩子按 filePath 过滤 edit/write 时调用，规避 edit 工具 input.path 给的是
 *  绝对/相对/cwd-相对混合形态时漏刷。 */
function pathEquals(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    return pathResolve(a) === pathResolve(b);
  } catch {
    return a === b;
  }
}

export {
  pathEquals,
  persistManualToSession,
  refreshInjectionFooter,
  refreshManualWidget,
  resetManualSession,
  tryRestoreManual,
  tryRestoreLastTurnRef,
  persistLastTurnRef,
  PT_LAST_TURN_REF_ENTRY,
};
