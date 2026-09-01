// src/render/index.ts — Render 后端入口
//
// Phase 8.5：v8 后端入口。
//   - system-prompt.ts  : Context 注入点 → System Prompt 字符串（按 Channel target 聚合）
//   - context-message.ts: FlowTemplate + 参数 → Context Message（binder 展开）
//   - cache.ts          : Context 文件读写 + hash 校验（cacheDir 从 CompilationConfig 取）

export { renderSystemPrompt } from "./system-prompt.js";
export { bindFlowTemplate, findFlowInBundle, renderContextMessage } from "./context-message.js";
export { saveContext, loadContext } from "./cache.js";
