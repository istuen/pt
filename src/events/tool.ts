// src/events/tool.ts
// tool 事件 handler（tool_call / tool_result）。
// 从 index.ts 抽出（Step 4），逻辑零变更。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { slog } from "../slog.js";
import { getSessionById } from "../session.js";
import { pathEquals, refreshInjectionFooter, refreshManualWidget } from "../manual-session.js";
import { DEFAULT_TOOL_INPUT_LOG_MODE, shouldLogToolInput } from "../config.js";
import { getSessionIdFromCtx } from "../shared/session-helpers.js";
import type { PiToolCallEvent, PiToolResultEvent } from "../shared/pi-types.js";

/** 注册 tool 事件 handler。从 index.ts 抽出，逻辑零变更。 */
export function registerToolEvents(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    const e = event as PiToolCallEvent;
    const sessionId = getSessionIdFromCtx(ctx);
    const name = e.name ?? e.toolName;
    // v19（issue pt-adoption-observability Layer 1 F1.2）：按档位决定是否记 input。
    //   默认 "pt-only"——只记 Pt 自家工具（pt_inject / pt_doc / pt_info）的 input；
    //   其中 pt_inject 的 domain 参数是"查了哪本手册"的唯一信号（issue §根因 2）。
    //   开发/测试期可切 "all"（env PT_LOG_TOOL_INPUT=all 或 settings pt.log-tool-input="all"）；
    //   注意 write/edit 的 input 含完整文件内容，all 档日志体积显著变大。
    const mode = sessionId
      ? getSessionById(sessionId).toolInputLogMode
      : DEFAULT_TOOL_INPUT_LOG_MODE;
    slog(
      sessionId,
      "debug",
      "tool:call",
      shouldLogToolInput(mode, name) ? { name, input: e.input } : { name }
    );
  });
  pi.on("tool_result", async (event, ctx) => {
    const e = event as PiToolResultEvent;
    const toolName = e.name ?? e.toolName;
    slog(getSessionIdFromCtx(ctx), "debug", "tool:result", {
      name: toolName,
      isError: e.isError,
    });
    // P1：edit/write 命中 activeManual 文件 → 刷新 widget（精准过滤，不全量刷 edit/write）。
    // 设计文档：pt-workspace-boundary-calibration §1 / §2.3 方案 1a + 浅比较去重。
    // edit 工具 schema 含 `path` 字段（pi dist/core/tools/edit.d.ts EditSchema.path: TString），
    // write 工具同样含 path。
    const sessionId = getSessionIdFromCtx(ctx);
    const s = sessionId ? getSessionById(sessionId) : null;
    if (s?.activeManual && (toolName === "edit" || toolName === "write")) {
      const changedPath = e.input?.path;
      if (changedPath && pathEquals(changedPath, s.activeManual.filePath)) {
        await refreshManualWidget(ctx.ui, s);
        refreshInjectionFooter(ctx.ui, s);
      }
    }
  });
}
