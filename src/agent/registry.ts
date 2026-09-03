// src/agent/registry.ts — AgentAdapter 注册表
//
// Phase 9.6：v9 新增 — 按 Agent 名取 Adapter 实例。
// 加新 Agent（如 Codex / OpenCode）只在这里加一行注册 + 实现 Adapter。
//
// v12.x（issue pt-session-singleton-pi-web-pollution 修复）：
//   - 原设计 `agentAdapters: Record<string, AgentAdapter>` 是 module-level 单例
//     → 所有 session 共享同一个 PiAdapter 实例 → 单例 `this.segment / this.ctx /
//       this.blueprint / this.domains / this.injectedApi` 跨 session 被覆盖
//     → tab B 调 setContext 覆盖 this.segment → tab A 的 before_agent_start handler
//       读到 tab B 的 segment → LLM 拿到错业务上下文（业务上下文级污染）
//   - 改造为 `WeakMap<ExtensionAPI, Record<string, AgentAdapter>>`：
//     - 每 session 一份 `Record<name, Adapter>` 缓存
//     - pi 实例销毁时（pi-web session 退出）WeakMap 自动 GC
//     - TUI 模式只有一个 pi 实例，行为等同 module-level 单例
//   - getAgentAdapter 签名改成 `(pi, name)`：调用方传 pi 作 key
//     - `src/index.ts:105` `transpileActive` 改 `getAgentAdapter(pi, ...)`
//     - `src/index.ts:70-77` `registerInjectionIfReady` 调 `adapter.registerInject(...)`
//       时拿到的 adapter 已是 per-pi 实例，handler 闭包持 this（per-pi），this.segment
//       不被其他 session 覆盖

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentAdapter } from "../schema.js";
import { PiAdapter } from "./pi-adapter.js";

/** v12.x：per-pi Adapter 缓存（弱引用，pi 实例销毁后自动 GC）。 */
const adapterCache = new WeakMap<ExtensionAPI, Record<string, AgentAdapter>>();

/** 取指定 pi + name 的 AgentAdapter。未找到返 pi 的 per-pi 实例（fallback）。 */
export function getAgentAdapter(pi: ExtensionAPI, name: string): AgentAdapter {
  let cache = adapterCache.get(pi);
  if (!cache) {
    cache = {};
    adapterCache.set(pi, cache);
  }
  let adapter = cache[name];
  if (!adapter) {
    // 当前只支持 pi；未来 codex/opencode 在这里 switch name
    adapter = new PiAdapter();
    cache[name] = adapter;
    if (!cache.pi) cache.pi = adapter; // 把 fallback 也指到同一实例
  }
  return adapter;
}
