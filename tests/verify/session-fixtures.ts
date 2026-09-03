// tests/verify/_session-helpers.ts — 共享测试 helper
//
// v12.x：pt state 容器从 module-level 单例改为 Map<sessionId, SessionState>。
// 单元测试需要稳定 sessionId 作 key；定义一个常量避免散落。

import { clearSessionById, getSessionById, type SessionState } from "../../src/session.js";

/** 所有 v12.x 单元测试用的固定 sessionId。
 *  不依赖真实 pi SessionManager——纯单进程测试场景，所有测试共享同一 sessionId。
 *  这模拟"一个 pi 进程只有一个 session"的 TUI 模式场景。 */
export const TEST_SESSION_ID = "test-session";

/** 测试 helper：取当前 session state（懒加载）。 */
export function s(): SessionState {
  return getSessionById(TEST_SESSION_ID);
}

/** 测试 helper：清空当前测试 session state（等价于 v10.x 的 resetSession()）。 */
export function resetTestSession(): void {
  clearSessionById(TEST_SESSION_ID);
}
