// src/render/session-inject.ts — AgentContext 聚合组 → Session Inject 字符串
//
// Phase 9.5：v9 后端通用化——遍历 Blueprint.groups（不再 Channel.groups），
//   聚合所有 inject=session 的聚合组内容。
//
// renderSessionInject(ctx, blueprint) → string
// 设计上保留函数包装，便于将来在渲染阶段做最终修整（如日志、注入标记）。
//
// Phase term-P1：参数类型 Context → AgentContext（IR 改名同步）。
// Phase term-P4.3：函数名 renderSystemPrompt → renderSessionInject；inject 语义值 system_prompt → session。

import type { AgentContext, Blueprint } from "../schema.js";

/** AgentContext 聚合组聚合 → Session Inject 字符串。
 *  v9：遍历 Blueprint.groups，聚合所有 inject=session 的聚合组内容。
 *  AgentAdapter 内部把 Session Inject 注入到 Agent 的 session 级（Pi: system_prompt 事件）。 */
export function renderSessionInject(ctx: AgentContext, blueprint: Blueprint): string {
  const parts: string[] = [];
  for (const group of blueprint.groups) {
    if (group.inject === "session") {
      const content = ctx.modules[group.name];
      if (content) parts.push(content);
    }
  }
  return parts.join("\n\n");
}
