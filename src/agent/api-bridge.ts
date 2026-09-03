// src/agent/api-bridge.ts — Pi ExtensionAPI ↔ AgentAPI 桥接（P1.3 抽出）
//
// 把 Pi ExtensionAPI 转换成 AgentAPI（结构类型子集）供 AgentAdapter 使用。
// 同一个 Pi runtime 复用同一个 AgentAPI wrapper——否则 PiAdapter 每次 registerInject
// 都会得到不同的对象身份，导致 system prompt handler 被重复注册。
//
// v12.x（issue pt-session-singleton-pi-web-pollution 修复）：
//   - 原设计 `api.log` getter / `onInjected` 直接读写 module-level `session` 单例
//     → tab B 的 wrapper.onInjected 写 tab B 的 lastBuiltPrompt 但走的是 module 单例
//     → tab A 跑 turn 时 `lastBuiltPrompt` 也是 tab B 的（被覆盖）
//   - 改造为 per-pi wrapper 内部维护 `currentSessionId` 闭包变量：
//     - wrapper 的 `api.on` 包装函数在每个 handler 触发前自动从 `args[1]?.sessionManager`
//       拿 sessionId 写入 `currentSessionId`
//     - `api.log` getter / `onInjected` 通过 `currentSessionId` 走 `getSessionById(...)`
//       取 per-session state
//   - TUI 模式下只有一个 pi 实例，行为等同 module-level 单例（同一 sessionId 始终）

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentAPI, AgentUI } from "../schema.js";
import { getSessionById } from "../session.js";

/** AgentAPI 的 ui 字段类型（NonNullable<AgentAPI["ui"]>）。 */
type AgentUIContext = AgentUI;

/** 将 Pi ExtensionAPI 转换为 AgentAPI（结构类型子集，运行时透明）。
 *  Pi ExtensionAPI 是 AgentAPI 的超集，多余方法（registerCommand/registerFlag 等）不暴露给 Adapter。
 *  v9.1：提供 ui 能力，adapter 可走 ui.notify 报错 / ui.setStatus 设状态（不需 console）。
 *  v10.x：提供 log 能力，adapter 的 try/catch 异常走 session.logger（不再 swallow）。
 *  ctx 用 Pi 扩展的 ctx（ExtensionContext/ExtensionCommandContext 都含 ui）——子集够用。
 *
 *  同一个 Pi runtime 复用同一个 AgentAPI wrapper，否则 PiAdapter 每次 registerInject
 *  都会得到不同的对象身份，导致系统 prompt handler 被重复注册。 */
const agentApiCache = new WeakMap<
  ExtensionAPI,
  {
    api: AgentAPI;
    setContext: (ctx: { ui: AgentUIContext }) => void;
    /** v12.x：当前触发中的 sessionId（wrapper.on 包装在 handler 触发前写入）。
     *  api.log / api.onInjected 通过此字段拿 per-session state。 */
    currentSessionId: string | undefined;
  }
>();

export function toAgentAPI(pi: ExtensionAPI, ctx: { ui: AgentUIContext }): AgentAPI {
  let holder = agentApiCache.get(pi);
  if (!holder) {
    let currentCtx = ctx;
    // v12.x：closure 捕获 currentSessionId，供 api.log/onInjected 拿 per-session state
    const stateRef: { currentSessionId: string | undefined } = { currentSessionId: undefined };

    // v12.x：on 包装——handler 触发前自动从 args[1] ctx 拿 sessionId 注入 stateRef
    const onWrapped = (event: string, handler: (...args: unknown[]) => unknown): void => {
      pi.on(
        event as Parameters<ExtensionAPI["on"]>[0],
        ((event: unknown, extCtx: unknown) => {
          // 提取 sessionId：extCtx 是 ExtensionContext
          const c = extCtx as { sessionManager?: { getSessionId?: () => string } } | undefined;
          stateRef.currentSessionId = c?.sessionManager?.getSessionId?.();
          return handler(event, extCtx as unknown);
        }) as Parameters<ExtensionAPI["on"]>[1]
      );
    };

    const api: AgentAPI = {
      on: onWrapped,
      registerCommand: (name, spec) =>
        pi.registerCommand(name, spec as Parameters<ExtensionAPI["registerCommand"]>[1]),
      registerFlag: (name, spec) =>
        pi.registerFlag(name, spec as Parameters<ExtensionAPI["registerFlag"]>[1]),
      getFlag: (name) => pi.getFlag(name),
      ui: {
        notify: (msg, level) => currentCtx.ui.notify(msg, level),
        setStatus: (name, text) => currentCtx.ui.setStatus(name, text),
      },
      // v12.x：api.log 走 per-session logger（避免 tab A 写到 tab B 的日志文件）
      get log() {
        const sid = stateRef.currentSessionId;
        return sid ? getSessionById(sid).logger?.toWriter() : undefined;
      },
      // v12.x：onInjected 写 per-session lastBuiltPrompt
      onInjected: (systemPrompt) => {
        const sid = stateRef.currentSessionId;
        if (sid) getSessionById(sid).lastBuiltPrompt = systemPrompt;
      },
    };
    holder = {
      api,
      setContext: (nextCtx) => {
        currentCtx = nextCtx;
      },
      currentSessionId: undefined,
    };
    // 把 stateRef 同步到 holder（保持单一来源）
    Object.defineProperty(holder, "currentSessionId", {
      get: () => stateRef.currentSessionId,
      set: (v: string | undefined) => {
        stateRef.currentSessionId = v;
      },
    });
    agentApiCache.set(pi, holder);
  } else {
    holder.setContext(ctx);
  }
  return holder.api;
}
