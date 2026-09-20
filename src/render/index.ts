// src/render/index.ts — Render 后端入口
//
// Phase 9.5：v9 后端入口。
//   - session-inject.ts : AgentContext 聚合组 → Session Inject 字符串（按 Blueprint inject=session 聚合）
//   - turn-inject.ts    : FlowTemplate + 参数 → Turn Inject（/pt_turn_inject 触发）
//                          AgentAdapter 内部映射到 Pi 的 system_prompt/context_message
//   - cache.ts          : AgentContext 文件读写 + hash 校验（用 constants.CACHE_DIR 常量，P4.2）
//
// Phase term-P1：Context IR → AgentContext 改名同步——
//   - saveContext/loadContext → saveAgentContext/loadAgentContext
// Phase term-P4.3：render 函数名 + 文件名对齐 session/turn。
export { renderSessionInject } from "./session-inject.js";
export { bindFlowTemplate, findFlowInBlueprint, renderTurnInject } from "./turn-inject.js";
export { saveAgentContext, loadAgentContext } from "./cache.js";
