// src/events/turn.ts
// turn 生命周期事件 handler（turn_start / turn_end / agent_settled）。
// 从 index.ts 抽出（Step 3），逻辑零变更。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { slog } from "../slog.js";
import { getSessionById } from "../session.js";
import { refreshInjectionFooter, refreshManualWidget } from "../manual-session.js";
import { getSessionIdFromCtx } from "../shared/session-helpers.js";
import type { PiTurnEndEvent } from "../shared/pi-types.js";

/** 注册 turn 生命周期事件 handler。从 index.ts 抽出，逻辑零变更。 */
export function registerTurnEvents(pi: ExtensionAPI): void {
  // ========== turn 级 trace（P2: 覆盖 turn 生命周期） ==========
  // 任何 turn 异常都能从日志反查；不写入主要因为 UI 噪音，只到 file log。
  pi.on("turn_start", async (_event, ctx) => {
    slog(getSessionIdFromCtx(ctx), "debug", "turn:start");
  });
  pi.on("turn_end", async (event, ctx) => {
    // v10.x：event 形态可能包含 token 用量，先取几个字段塞进 ctx
    const e = event as PiTurnEndEvent;
    slog(getSessionIdFromCtx(ctx), "debug", "turn:end", {
      reason: e.reason,
      messageCount: e.messageCount,
    });
    // P1 兜底：turn 结束时刷 manual（捕获 bash/powershell 改 manual + tool_result 漏检场景）。
    // refreshManualWidget 内部浅比较去重，进度未变时不发 IPC。频率 ~60/h，远低于 tool_result，
    // 作为兜底可接受。
    const sessionId = getSessionIdFromCtx(ctx);
    const s = sessionId ? getSessionById(sessionId) : null;
    if (s?.activeManual) {
      await refreshManualWidget(ctx.ui, s);
      refreshInjectionFooter(ctx.ui, s);
    }
  });
  pi.on("agent_settled", async (_event, ctx) => {
    slog(getSessionIdFromCtx(ctx), "debug", "agent:settled");
  });
}
