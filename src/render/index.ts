// src/render/index.ts — Render 后端入口
//
// Phase 7.6：后端三个职责：
//   - system-prompt.ts  : Context.## Scene → System Prompt 字符串
//   - context-message.ts: FlowTemplate + 参数 → Context Message（binder 展开）
//   - cache.ts          : Context 文件读写 + hash 校验
export { renderSystemPrompt } from "./system-prompt.js";
export { bindFlowTemplate, findFlowInBundle } from "./context-message.js";
export { saveContext, loadContext } from "./cache.js";

// 兼容 v6 旧 import 路径（transpile.ts/index.ts 可能仍 import generateV6Prompt 等）
// Phase 7.6 后这些不再被使用，保留空 export 以便逐步迁移。
export function generateV6Prompt(_bundle: unknown): string { return ""; }
export function generateManual(_bundle: unknown, _manualStruct: unknown, _args: string): string | null { return null; }