// src/render/index.ts — Render 后端入口
//
// Phase 9.5：v9 后端入口。
//   - system-prompt.ts   : AgentContext 注入点 → System Prompt 字符串（按 Blueprint target 聚合）
//   - context-message.ts : FlowTemplate + 参数 → Context Message（/manual:xxx + /<flow-name>）
//                          （Context Message 是 Pi 概念，文件名不变；P4 会改→turn-message.ts）
//   - cache.ts           : AgentContext 文件读写 + hash 校验（cacheDir 从 CompilationConfig 取）
//
// Phase term-P1：Context IR → AgentContext 改名同步——
//   - saveContext/loadContext → saveAgentContext/loadAgentContext
export { renderSystemPrompt } from "./system-prompt.js";
export { bindFlowTemplate, findFlowInBlueprint, renderContextMessage } from "./context-message.js";
export { saveAgentContext, loadAgentContext } from "./cache.js";
