// src/agent/api-bridge.ts — Pi ExtensionAPI ↔ AgentAPI 桥接（P1.3 抽出）
//
// 把 Pi ExtensionAPI 转换成 AgentAPI（结构类型子集）供 AgentAdapter 使用。
// 同一个 Pi runtime 复用同一个 AgentAPI wrapper——否则 PiAdapter 每次 registerInject
// 都会得到不同的对象身份，导致 system prompt handler 被重复注册。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentAPI, AgentUI } from "../schema.js";
import { session } from "../session.js";

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
  }
>();

export function toAgentAPI(pi: ExtensionAPI, ctx: { ui: AgentUIContext }): AgentAPI {
  let holder = agentApiCache.get(pi);
  if (!holder) {
    let currentCtx = ctx;
    const api: AgentAPI = {
      on: (event, handler) =>
        pi.on(
          event as Parameters<ExtensionAPI["on"]>[0],
          handler as Parameters<ExtensionAPI["on"]>[1]
        ),
      registerCommand: (name, spec) =>
        pi.registerCommand(name, spec as Parameters<ExtensionAPI["registerCommand"]>[1]),
      registerFlag: (name, spec) =>
        pi.registerFlag(name, spec as Parameters<ExtensionAPI["registerFlag"]>[1]),
      getFlag: (name) => pi.getFlag(name),
      ui: {
        notify: (msg, level) => currentCtx.ui.notify(msg, level),
        setStatus: (name, text) => currentCtx.ui.setStatus(name, text),
      },
      get log() {
        return session.logger?.toWriter();
      },
      onInjected: (systemPrompt) => {
        session.lastBuiltPrompt = systemPrompt;
      },
    };
    holder = {
      api,
      setContext: (nextCtx) => {
        currentCtx = nextCtx;
      },
    };
    agentApiCache.set(pi, holder);
  } else {
    holder.setContext(ctx);
  }
  return holder.api;
}
