// src/index.ts — Pi 扩展入口（v9）
//
// v9 用户面命令：--pt-profile（flag）/ /pt-profile（命令），对应"激活 Profile → 编译 AgentContext"。
//   "profile" 在 v9 是配置层概念（引用 Blueprint + 选 Domains），用户面命令强调产物是 AgentContext。
//
// 注入用 AgentAdapter（默认 Pi）封装 before_agent_start + input 事件。
//
// Tech Debt T11: per-session 状态收拢到 SessionState（src/session.ts），不再 10 个模块级 let。
//
// v10.x（issue pt-context-persist-lost 修复）：
//   - session_start fallback 链加第四源：session JSONL（`pi.appendEntry()` 持久化）。
//     优先级：flag > settings > session > auto。session 优先于 auto，保留用户上次选择。
//   - switchProfile / session_start 加载成功后调 `pi.appendEntry()` 把 activeProfile 写回 session。
//     session entry 与 Pi Session 生命周期对齐（resume/--session/--fork 继承；/new/ephemeral 不继承）。
//
// v12.x（issue pt-session-singleton-pi-web-pollution 修复）：
//   - 移除 module-level `session` 单例访问，state 容器改为 Map<sessionId, SessionState>
//   - 所有 handler 入口从 `ctx.sessionManager.getSessionId()` 拿 sessionId，传给 per-session 函数
//   - `getAgentAdapter(pi, ...)` 返回 per-pi adapter（每个 session 一个 PiAdapter 实例）
//   - tool handler 通过 `ctx.sessionManager.getSessionId()` 取 per-session state
//   - `session_shutdown` 调 `clearSessionById(sessionId)` 精确清本 session

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSessionEvents } from "./events/session.js";
import { registerTurnEvents } from "./events/turn.js";
import { registerToolEvents } from "./events/tool.js";
import { registerPtProfileCommand } from "./commands/pt-profile.js";
import { registerPtCommand } from "./commands/pt.js";
import { registerAllTools } from "./tools/index.js";

export default function (pi: ExtensionAPI): void {
  // 启动时 flag（CLI 优先）
  // Phase term-P2：pt-context → pt-profile（命令参数是 Profile 名，名该匹配操作目标）。
  //   向后兼容：--pt-context（flag）和 pt.pt-context/au.pt-context（settings key）作为 fallback 保留——
  //   用户升级 Pt 后旧配置仍能工作，新配置优先。
  pi.registerFlag("pt-profile", {
    description: "启动时激活的 Profile 名（编译成 AgentContext 注入 Session Inject）",
    type: "string",
  });
  // v19（Layer 2，issue pt-adoption-observability）：per-session 汇总开关。
  //   开启后每个 session 结束产出一条可分析的一行（查了 AND 改了 AND 改的是哪个文件）
  //   + headless/CI 可读的结构化摘要（.pt/logs/summary.ndjson）。
  pi.registerFlag("pt-observe", {
    description: "产出 per-session 汇总记录（Layer 2）——CI / 漂移诊断用",
    type: "boolean",
  });
  registerSessionEvents(pi);
  registerTurnEvents(pi);
  registerToolEvents(pi);
  registerPtProfileCommand(pi);
  registerPtCommand(pi);
  registerAllTools(pi);
}
