// src/render/system-prompt.ts — Context.## Scene → System Prompt 字符串
//
// Phase 7.6：后端只渲染，不编排。Context IR 的 ## Scene 模块内容就是 System Prompt。
//
// renderSystemPrompt(ctx) → string（直接返回 ctx.modules["Scene"]）。
// 设计上保留函数包装，便于将来在渲染阶段做最终修整（如日志、注入标记）。

import type { Context } from "../schema.js";

/** Context.## Scene → System Prompt 字符串。 */
export function renderSystemPrompt(ctx: Context): string {
  return ctx.modules["Scene"] ?? "";
}