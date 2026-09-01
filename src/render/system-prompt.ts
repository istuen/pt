// src/render/system-prompt.ts — Context 注入点 → System Prompt 字符串
//
// Phase 8.5：v8 后端通用化——不再硬编码 ctx.modules["Scene"]，
//   改为按 Channel.injectionPoints 遍历所有 target=system_prompt 的注入点聚合内容。
//
// renderSystemPrompt(ctx, channel) → string
// 设计上保留函数包装，便于将来在渲染阶段做最终修整（如日志、注入标记）。

import type { Channel, Context } from "../schema.js";

/** Context 注入点聚合 → System Prompt 字符串。
 *  v8：遍历 Channel.injectionPoints，聚合所有 target=system_prompt 的注入点内容。 */
export function renderSystemPrompt(ctx: Context, channel: Channel): string {
  const parts: string[] = [];
  for (const ip of channel.injectionPoints) {
    if (ip.target === "system_prompt") {
      const content = ctx.modules[ip.name];
      if (content) parts.push(content);
    }
  }
  return parts.join("\n\n");
}
