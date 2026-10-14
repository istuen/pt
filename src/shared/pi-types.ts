// src/shared/pi-types.ts
// Pi 扩展本地类型定义（从 index.ts 抽出，P2.3）。
// Pi ExtensionAPI 的 on() 回调 event 参数是 unknown（pi 包顶层 export.d.ts 描述为 unknown[]）。
// 实际形状来自 pi runtime（@earendil-works/pi-coding-agent 的内部 emit 逻辑）。
// 这里定义本地结构接口——只用到的字段，消 index.ts ×3 双重 cast。

import type { AgentAPI } from "../schema.js";

export type AgentUIContext = NonNullable<AgentAPI["ui"]>;

/** pi.on("turn_end", handler) event 形状。 */
export interface PiTurnEndEvent {
  reason?: string;
  messageCount?: number;
}

/** pi.on("tool_call", handler) event 形状。 */
export interface PiToolCallEvent {
  name?: string;
  toolName?: string;
}

/** pi.on("tool_result", handler) event 形状。
 *  P1：扩展 input 字段（edit/write 工具含 `path`，详见 pi extensions.md tool_result 段）。 */
export interface PiToolResultEvent {
  name?: string;
  toolName?: string;
  isError?: boolean;
  input?: { path?: string; [k: string]: unknown };
}
