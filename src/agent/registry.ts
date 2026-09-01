// src/agent/registry.ts — AgentAdapter 注册表
//
// Phase 9.6：v9 新增 — 按 Agent 名取 Adapter 实例。
// 加新 Agent（如 Codex / OpenCode）只在这里加一行注册 + 实现 Adapter。

import type { AgentAdapter } from "../schema.js";
import { PiAdapter } from "./pi-adapter.js";

const agentAdapters: Record<string, AgentAdapter> = {
  pi: new PiAdapter(),
  // 未来：codex: new CodexAdapter(), opencode: new OpenCodeAdapter(), ...
};

/** 取指定名的 AgentAdapter。未找到返 pi（fallback）。 */
export function getAgentAdapter(name: string): AgentAdapter {
  return agentAdapters[name] ?? agentAdapters.pi;
}