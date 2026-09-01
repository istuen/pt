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

import type { AgentAdapter, Blueprint, Context, Domain, Profile, SchemaBundle } from "./schema.js";
import type { PtLogger } from "./log.js";

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
});

/** Module-level singleton（Pi Extension 是单例模块）。 */
export const session: SessionState = createSessionState();

/** 清空 session（session_shutdown 调用）。 */
export function resetSession(): void {
  Object.assign(session, createSessionState());
}