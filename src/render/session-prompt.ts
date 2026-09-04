// src/render/session-prompt.ts — AgentContext 注入点 → Session Prompt 字符串
//
// Phase 9.5：v9 后端通用化——遍历 Blueprint.injectionPoints（不再 Channel.injectionPoints），
//   聚合所有 target=session 的注入点内容。
//
// renderSessionPrompt(ctx, blueprint) → string
// 设计上保留函数包装，便于将来在渲染阶段做最终修整（如日志、注入标记）。
//
// Phase term-P1：参数类型 Context → AgentContext（IR 改名同步）。
// Phase term-P4.3：函数名 renderSystemPrompt → renderSessionPrompt；target 语义值 system_prompt → session。

import type { AgentContext, Blueprint } from "../schema.js";

/** AgentContext 注入点聚合 → Session Prompt 字符串。
 *  v9：遍历 Blueprint.injectionPoints，聚合所有 target=session 的注入点内容。
 *  AgentAdapter 内部把 Session Prompt 注入到 Agent 的 session 级（Pi: system_prompt 事件）。 */
export function renderSessionPrompt(ctx: AgentContext, blueprint: Blueprint): string {
  const parts: string[] = [];
  for (const ip of blueprint.injectionPoints) {
    if (ip.target === "session") {
      const content = ctx.modules[ip.name];
      if (content) parts.push(content);
    }
  }
  return parts.join("\n\n");
}
