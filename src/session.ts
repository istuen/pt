// src/session.ts — Pt Session 状态封装（pt-quality #2 / P2.6）
//
// 替代 index.ts 10 个模块级 let 变量——收拢到单 state 对象，便于维护和单元测试。
//
// 设计：
// - Map<sessionId, SessionState>（v12.x）—— key 用 pi SessionManager.getSessionId()
//   支持 pi-web 多 session 并发：不同 session 各自一份 SessionState。
//   TUI 模式下只有一个 session，Map 只有一个 entry，等同 module-level 单例行为。
// - 所有 setter 都通过 state 字段赋值（不解构）
// - clearSessionById 暴露给 session_shutdown / 测试
//
// v10.x：session-state 升级为 session-scoped daemon 级——
//   - sessionId：crypto 生成的 8-hex 短 id（多并发 `pi` 进程的日志隔离键）
//   - logger   ：per-session 单例 PtLogger（替代 per-transpile 实例化）
//
// v10.x（issue pt-context-persist-lost 修复，现 /pt-profile）：loadedFrom 记录当前 activeProfile 的来源，
//   用于 /pt status 可观测性 + 排查"为什么没选到我预期的 profile"。
//
// v12.x（issue pt-session-singleton-pi-web-pollution 修复）：
//   - 移除 module-level `session` 单例（设计假设 per-process = per-session 在 pi-web 下不成立）
//   - state 容器改为 Map<sessionId, SessionState>，key 用 pi SessionManager.getSessionId()
//   - 调用方通过 `getSessionById(ctx.sessionManager.getSessionId())` 取 state
//   - 对应 `src/agent/registry.ts` 把 Adapter 注册表也改成 WeakMap<ExtensionAPI, ...>，
//     保证 Adapter 实例 per-pi，避免"单例 PiAdapter.this.segment 被其他 session 覆盖"。
//   - `cachedManualProgress` 从 module-level let 搬到 SessionState 字段。

import type { AssetHealthIssue } from "./asset-health.js";
import type { ValidationResult } from "./asset-pack/validate.js";
import type {
  AgentAdapter,
  AgentContext,
  Blueprint,
  Domain,
  Profile,
  SchemaBundle,
} from "./schema.js";
import type { PtLogger } from "./log.js";
import type { ManualProgress } from "./manual-track.js";

/** activeProfile 的来源（session_start fallback 命中点）。 */
export type ProfileLoadSource =
  | "flag"
  | "settings"
  | "session"
  | "auto"
  | "default"
  // v15.x PR6（fix pt-active-profile-fallback-mismatch）：显式 fallback 标识
  | "fallback"
  | null;

/** pt 注入到 Session Inject 的状态（自报，非检测 Pi）。
 *  - idle：未激活 / 无 segment
 *  - pending：Profile 已加载但还没轮到下一轮 before_agent_start
 *  - injected：本轮 before_agent_start 成功返回注入结果
 *  - failed：本轮 before_agent_start catch 异常 */
export type InjectionState = "idle" | "pending" | "injected" | "failed";

/** 当前追踪的 Manual 实例（LLM 调 pt_make_manual 写入后触发）。
 *  进度（stepDone/stepTotal）不存 session——文件是 single source of truth，
 *  每次 widget 渲染时 parse 文件重新计算。 */
export interface ActiveManual {
  filePath: string; // .pt/manuals/<procedure>-<ts>.md
  procedure: string;
  args: string;
  /** v16.x（P3）：manual 关联的 issue 名（可选）。单向引用——manual 自描述"为哪个 issue 服务"，
   *  不反向改 issue 文档。LLM 读 manual frontmatter 知道关联，用 bash/grep 查 issue 文件即可。
   *  未传时 undefined，frontmatter 无 issue 行（back-compat）。 */
  issue?: string;
  activatedAt: number; // Date.now()，排序/去重用
}

/** Session 全量状态。 */
export interface SessionState {
  activeProfile: string | null;
  cachedSegment: string | null;
  cachedBundles: SchemaBundle[] | null;
  cachedAgentContext: AgentContext | null;
  cachedBlueprint: Blueprint | null;
  cachedDomains: Domain[];
  cachedProfile: Profile | null;
  lastCwd: string;
  lastBuiltPrompt: string | null;
  lastCacheHit: boolean;
  activeAdapter: AgentAdapter | null;
  /** v10.x：session 唯一短 id，8 hex（4.3B 组合空间，足够区分并发 pi 进程）。 */
  sessionId: string;
  /** v10.x：per-session 单例 logger（替代 per-transpile 实例化）。 */
  logger: PtLogger | null;
  /** v10.x：当前 activeProfile 的来源（可观测性）。null 表示未加载。 */
  loadedFrom: ProfileLoadSource;
  /** pt 注入到 Session Inject 的状态（footer 三态文字 + widget 依据）。 */
  injectionState: InjectionState;
  /** failed 时存错误消息（footer 追加）。其它状态 null。 */
  injectionError: string | null;
  /** 当前追踪的 Manual 实例（widget + footer 后缀 + 持久化恢复）。 */
  activeManual: ActiveManual | null;
  /** v18.x（issue pt-turncontext-llm-call-trigger 决策 6）：compaction 后重注入线索。
   *  引用指针（domain 名 + 文件路径），非内容缓存——Manual 文件在磁盘（compaction 不影响），
   *  TurnContext 内容靠 domain 名重新触发 pt_turn_inject 获取。
   *  compaction 只裁 messages 不裁 extension state（sessionMap 不进 messages），自然存活。 */
  lastTurnRef: { turnInjectDomain: string; manualPath: string | null } | null;
  /** v12.x：当前 manual widget 的 async parse 缓存（替代原 module-level `cachedManualProgress`）。 */
  cachedManualProgress: ManualProgress | null;
  /** P1：上次 setStatus("pt", ...) 写入的字符串（refreshInjectionFooter 字符串去重缓存）。
   *  进度/injection/profile 都未变时跳过 setStatus IPC，null 表示待首次写入或刚重置。 */
  lastFooterText: string | null;
  /** v14.x（issue pt-asset-migration-visibility Layer 2）：
   *  session_start 批量体检结果——footer 追加 ⚠ N issues + /pt status 暴露。
   *  null = 未扫描（用户加载内置 profile 后才扫描过项目 profile）。 */
  assetHealthIssues: AssetHealthIssue[] | null;
  /** v15.x PR1（§6.7.1）：session_start 一次性 pack 校验结果——/pt status 展示用。 */
  packValidation: ValidationResult[] | null;
  /** v15.x PR1（§6.7.3）：project pack 校验失败时标 true，transpileActive 强制回 guide。 */
  projectPackDegraded: boolean;
}

/** 默认空 SessionState。 */
export function createSessionState(): SessionState {
  return {
    activeProfile: null,
    cachedSegment: null,
    cachedBundles: null,
    cachedAgentContext: null,
    cachedBlueprint: null,
    cachedDomains: [],
    cachedProfile: null,
    lastCwd: "",
    lastBuiltPrompt: null,
    lastCacheHit: false,
    activeAdapter: null,
    sessionId: "",
    logger: null,
    loadedFrom: null,
    injectionState: "idle",
    injectionError: null,
    activeManual: null,
    lastTurnRef: null,
    cachedManualProgress: null,
    lastFooterText: null,
    assetHealthIssues: null,
    packValidation: null,
    projectPackDegraded: false,
  };
}

/** v12.x：Map<sessionId, SessionState> 容器，key = pi SessionManager.getSessionId()。
 *  对外不导出（避免外部直接 mutate 绕过懒加载）。 */
const sessionMap = new Map<string, SessionState>();

/** 重置编译产物字段（catch 路径用）。
 *  v13.x（issue pt-no-agent-context-reset-session-state 修复）：
 *  - transpile/session_start/switchProfile 三处 catch 调用本函数
 *  - 避免 stale cachedAgentContext/cachedBlueprint/cachedDomains/cachedProfile/activeAdapter
 *    误导 /pt flows / /pt make-manual 返回旧 Profile 的手册列表（掩盖真实失败）
 *  - 不清 sessionId/logger/lastCwd/activeProfile/loadedFrom/activeManual（生命周期不同：
 *    session_id 标识当前会话、logger 持续写日志、lastCwd 是项目根、activeProfile 是用户意图、
 *    loadedFrom 是来源、activeManual 是手动追踪）
 */
export function resetSessionState(s: SessionState): void {
  s.cachedSegment = null;
  s.cachedBundles = null;
  s.cachedAgentContext = null;
  s.cachedBlueprint = null;
  s.cachedDomains = [];
  s.cachedProfile = null;
  s.activeAdapter?.resetInjection?.();
  s.activeAdapter = null;
  s.lastCacheHit = false;
  s.injectionState = "idle";
  s.injectionError = null;
  // v18.x（issue pt-footer-status-stale-cache）：清 lastFooterText 让下次
  // refreshInjectionFooter 必写 setStatus，避免 stale 缓存导致 footer 不更新。
  s.lastFooterText = null;
}

/** 取指定 sessionId 的 state（lazy create）。TUI 模式下只有一个 entry。 */
export function getSessionById(sessionId: string): SessionState {
  let s = sessionMap.get(sessionId);
  if (!s) {
    s = createSessionState();
    sessionMap.set(sessionId, s);
  }
  return s;
}

/** 列表所有 session state（debug / 诊断用，如 /pt sessions 列表）。 */
export function listAllSessions(): SessionState[] {
  return [...sessionMap.values()];
}

/** 清空指定 sessionId 的 state（session_shutdown 调用）。 */
export function clearSessionById(sessionId: string): void {
  sessionMap.delete(sessionId);
}

/** 清空所有 session state（仅测试 / 重启进程等需要）。 */
export function clearAllSessions(): void {
  sessionMap.clear();
}

/** 测试 / 诊断：Map 的当前大小。 */
export function sessionCount(): number {
  return sessionMap.size;
}
