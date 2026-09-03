// src/slog.ts — session-scoped logger 快捷调用
//
// 设计动机：
//   - 入口代码（src/index.ts）和 session 交互层（src/manual-session.ts）共享同一 slog 快捷
//   - session.logger 为 null 时静默（session_start 之前不可用）
//   - 不依赖 file IO（持久化走 src/log.ts 的 PtLogger 类），仅作调用快捷
//
// v11.x：从 src/index.ts 抽出（与 manual-session 同次提交），统一两个调用点的快捷。
//
// v12.x（issue pt-session-singleton-pi-web-pollution 修复）：
//   - 移除 module-level `session` 单例访问
//   - `slog` 改接受 `sessionId` 参数，按 sessionId 取 per-session logger
//   - sessionId 为空时静默（与原 "session.logger 为 null 时静默" 行为一致）
//
// 类型说明：PtLogLevel 用 "warning"（与 ctx.ui.notify 兼容），PtLogger 方法用 "warn"。
//   此处使用 PtLogger 的方法名（debug/info/warn/error）作为调用 key，与原 slog 行为一致。

import { getSessionById } from "./session.js";

/** session-scoped logger 快捷调用（sessionId 空时静默——session_start 之前不可用）。
 *  level 用 PtLogger 的方法名（debug/info/warn/error），不是 PtLogLevel 的字面量。 */
export function slog(
  sessionId: string,
  level: "debug" | "info" | "warn" | "error",
  msg: string,
  ctx?: Record<string, unknown>
): void {
  if (!sessionId) return;
  const logger = getSessionById(sessionId).logger;
  if (!logger) return;
  logger[level](msg, ctx);
}
