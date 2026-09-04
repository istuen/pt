// src/compile/index.ts — Compile 中端入口
//
// Phase 9.4：v9 中端导出——compileAgentContext(profile, blueprint, domains) → AgentContext IR。
// Phase term-P1：compileContext → compileAgentContext（IR 改名同步）。
export { compileAgentContext, computeSourceHash, registerModuleRenderer } from "./agent-context.js";
