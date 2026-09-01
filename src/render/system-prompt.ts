// src/render/system-prompt.ts — Context 注入点 → System Prompt 字符串
//
// Phase 9.5：v9 后端通用化——遍历 Blueprint.injectionPoints（不再 Channel.injectionPoints），
//   聚合所有 target=system_prompt 的注入点内容。
//
// renderSystemPrompt(ctx, blueprint) → string
// 设计上保留函数包装，便于将来在渲染阶段做最终修整（如日志、注入标记）。

import type { Blueprint, Context } from "../schema.js";

/** Context 注入点聚合 → System Prompt 字符串。
 *  v9：遍历 Blueprint.injectionPoints，聚合所有 target=system_prompt 的注入点内容。 */
export function renderSystemPrompt(ctx: Context, blueprint: Blueprint): string {
  const parts: string[] = [];
  for (const ip of blueprint.injectionPoints) {
    if (ip.target === "system_prompt") {
      const content = ctx.modules[ip.name];
      if (content) parts.push(content);
    }
  }
  return parts.join("\n\n");
}