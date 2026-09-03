// src/session.ts — Pt Session 状态封装（pt-quality #2 / P2.6）
//
// 替代 index.ts 10 个模块级 let 变量——收拢到单 state 对象，便于维护和单元测试。
//
// 设计：
// - 单例 state（per-process = per-session，因为 Pi Extension 是模块单例）
// - 所有 setter 都通过 state 字段赋值（不解构）
// - resetSession 暴露给测试 / session_shutdown
//
// v10.x：session-state 升级为 session-scoped daemon 级——
//   - sessionId：crypto 生成的 8-hex 短 id（多并发 `pi` 进程的日志隔离键）
//   - logger   ：per-session 单例 PtLogger（替代 per-transpile 实例化）
//
// v10.x（issue pt-context-persist-lost 修复）：loadedFrom 记录当前 activeProfile 的来源，
//   用于 /pt status 可观测性 + 排查"为什么没选到我预期的 profile"。

import type { AgentAdapter, Blueprint, Context, Domain, Profile, SchemaBundle } from "./schema.js";
import type { PtLogger } from "./log.js";

/** activeProfile 的来源（session_start fallback 命中点）。 */
export type ProfileLoadSource = "flag" | "settings" | "session" | "auto" | null;

/** pt 注入到 System Prompt 的状态（自报，非检测 Pi）。
 *  - idle：未激活 / 无 segment
 *  - pending：Profile 已加载但还没轮到下一轮 before_agent_start
 *  - injected：本轮 before_agent_start 成功返回注入结果
 *  - failed：本轮 before_agent_start catch 异常 */
export type InjectionState = "idle" | "pending" | "injected" | "failed";

/** 当前追踪的 Manual 实例（LLM 调 pt_manual 写入后触发）。
 *  进度（stepDone/stepTotal）不存 session——文件是 single source of truth，
 *  每次 widget 渲染时 parse 文件重新计算。 */
export interface ActiveManual {
  filePath: string; // .pt/manuals/<procedure>-<ts>.md
  procedure: string;
  args: string;
  activatedAt: number; // Date.now()，排序/去重用
}

/** Session 全量状态。 */
export interface SessionState {
  activeProfile: string | null;
  cachedSegment: string | null;
  cachedBundles: SchemaBundle[] | null;
  cachedContext: Context | null;
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
  /** pt 注入到 System Prompt 的状态（footer 三态文字 + widget 依据）。 */
  injectionState: InjectionState;
  /** failed 时存错误消息（footer 追加）。其它状态 null。 */
  injectionError: string | null;
  /** 当前追踪的 Manual 实例（widget + footer 后缀 + 持久化恢复）。 */
  activeManual: ActiveManual | null;
}

/** 默认空 SessionState。 */
export const createSessionState = (): SessionState => ({
  activeProfile: null,
  cachedSegment: null,
  cachedBundles: null,
  cachedContext: null,
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
});

/** Module-level singleton（Pi Extension 是单例模块）。 */
export const session: SessionState = createSessionState();

/** 清空 session（session_shutdown 调用）。 */
export function resetSession(): void {
  Object.assign(session, createSessionState());
}
