// src/events/tool.ts
// tool 事件 handler（tool_call / tool_result）。
// 从 index.ts 抽出（Step 4），逻辑零变更。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { slog } from "../slog.js";
import { getSessionById } from "../session.js";
import { pathEquals, refreshInjectionFooter, refreshManualWidget } from "../manual-session.js";
import { DEFAULT_TOOL_INPUT_LOG_MODE, shouldLogToolInput } from "../config.js";
import { extractBashWritePaths } from "../turn-output.js";
import { isLightweightProbe, runVerify } from "../verify/index.js";
import { getSessionIdFromCtx } from "../shared/session-helpers.js";
import type { PiToolCallEvent, PiToolResultEvent } from "../shared/pi-types.js";

/** 注册 tool 事件 handler。从 index.ts 抽出，逻辑零变更。 */
export function registerToolEvents(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    const e = event as PiToolCallEvent;
    const sessionId = getSessionIdFromCtx(ctx);
    const name = e.name ?? e.toolName;
    // v19（A3，issue pt-asset-verifiable-norm）：硬约束阻断——
    //   有 `on: block` 的检查未通过时，阻断**写操作**（edit/write），让模型先修好再写。
    //   安全边界：① 默认关（settings `pt.check-block`）② 只阻断写操作，bash/read 放行
    //   （模型可能需要 bash 去修）③ reason 说清怎么解（否则模型会卡死）。
    if (sessionId) {
      const s = getSessionById(sessionId);
      // v19（A3）：绕过可观测——bash 放行是刻意的（模型可能需要 bash 去修），
      //   但"模型用 bash 绕过硬约束"必须看得见（作者要知道这条规范被反复违反）。
      if (s.checkBlockEnabled && s.blockingFailures.length > 0 && name === "bash") {
        const cmd = typeof e.input?.command === "string" ? e.input.command : "";
        const targets = extractBashWritePaths(cmd);
        if (targets.length > 0) {
          s.summary.bypassCount += 1;
          s.logger?.info("check:bypassed", {
            probe: s.blockingFailures[0]?.probe,
            paths: targets.slice(0, 3),
            cmd: cmd.slice(0, 120),
          });
        }
      }
      if (s.checkBlockEnabled && s.blockingFailures.length > 0) {
        // v19（A3）：阻断前**即时复核**——失败项可能已被本轮修好（上轮记录的失败是陈旧的）。
        //   只对轻量探针复核（毫秒级）；重探针（lint/tsc/test）用陈旧状态，避免写操作被拖慢。
        const first = s.blockingFailures[0];
        if (first && isLightweightProbe(first.probe)) {
          // ⚠️ 必须用失败项自带的 params——丢了参数探针就判不出来（会误放行）
          const re = await runVerify(ctx.cwd, first.probe, first.params ?? {});
          s.logger?.info("check:revalidated", {
            probe: first.probe,
            outcome: re.outcome,
          });
          // ⚠️ 只有 COMPLETED 才解除阻断——INCONCLUSIVE 是"判不出来"（探针没参数/执行异常），
          //   不能当作"已修好"（否则会误放行）。
          if (re.outcome === "COMPLETED") {
            s.blockingFailures = s.blockingFailures.filter((f) => f.probe !== first.probe);
            s.checkFailures = s.checkFailures.filter((f) => f.probe !== first.probe);
          }
        }
      }
      if (s.checkBlockEnabled && s.blockingFailures.length > 0) {
        if (name === "edit" || name === "write") {
          const f = s.blockingFailures[0];
          const reason =
            `Pt 硬约束检查未通过，已阻断本次${name === "edit" ? "编辑" : "写入"}：` +
            `${f?.probe} — ${f?.message}。先修复该问题（可读文件/跑命令）再重试；` +
            `如需临时放行，把 settings 的 pt.check-block 设为 off。`;
          s.summary.blockedCount += 1;
          s.logger?.info("check:blocked", { tool: name, probe: f?.probe });
          return { block: true, reason };
        }
      }
    }
    // v19（issue pt-adoption-observability Layer 1 F1.2）：按档位决定是否记 input。
    //   默认 "pt-only"——只记 Pt 自家工具（pt_inject / pt_doc / pt_info）的 input；
    //   其中 pt_inject 的 domain 参数是"查了哪本手册"的唯一信号（issue §根因 2）。
    //   开发/测试期可切 "all"（env PT_LOG_TOOL_INPUT=all 或 settings pt.log-tool-input="all"）；
    //   注意 write/edit 的 input 含完整文件内容，all 档日志体积显著变大。
    const mode = sessionId
      ? getSessionById(sessionId).toolInputLogMode
      : DEFAULT_TOOL_INPUT_LOG_MODE;
    // v19（Layer 2）：工具调用计数 + 查阅/文件维度入汇总
    if (sessionId) {
      const sum = getSessionById(sessionId).summary;
      sum.toolCalls += 1;
      if (name === "read") {
        const p = typeof e.input?.path === "string" ? e.input.path : "";
        if (p && !sum.filesRead.includes(p)) sum.filesRead.push(p);
      } else if (name === "edit" || name === "write") {
        const p = typeof e.input?.path === "string" ? e.input.path : "";
        if (p && !sum.filesModified.includes(p)) sum.filesModified.push(p);
      } else if (name === "pt_inject") {
        const d = typeof e.input?.domain === "string" ? e.input.domain : "";
        if (d) sum.ptInjectCalls.push({ domain: d, turn: getSessionById(sessionId).summary.turns });
      } else if (name === "bash") {
        // shell 写入也算"改动"（agent 常用 `bash >> file`）——否则汇总会漏掉真实产出
        const cmd = typeof e.input?.command === "string" ? e.input.command : "";
        for (const p of extractBashWritePaths(cmd)) {
          if (!sum.filesModified.includes(p)) sum.filesModified.push(p);
        }
      }
    }
    // v19（issue pt-asset-verifiable-norm §三 B3）：收集本轮产出——
    //   改/建的文件（edit/write 的 path） + 查过的手册（pt_inject 的 domain）。
    //   这些不依赖日志档位（即使 input 不入日志也照收）——它服务"输出→下轮输入"回注。
    if (sessionId) {
      const s = getSessionById(sessionId);
      const input = e.input ?? {};
      if (name === "edit" || name === "write") {
        const p = typeof input.path === "string" ? input.path : "";
        if (p && !s.currentTurnFiles.includes(p)) s.currentTurnFiles.push(p);
      } else if (name === "bash") {
        // shell 写入（`> file` / `sed -i` / `tee`）——agent 常用 shell 改文件，
        // 只跟 edit/write 会漏掉真实产出。启发式抽取（保守，见 turn-output.ts）。
        const cmd = typeof input.command === "string" ? input.command : "";
        for (const p of extractBashWritePaths(cmd)) {
          if (!s.currentTurnFiles.includes(p)) s.currentTurnFiles.push(p);
        }
      } else if (name === "pt_inject") {
        const d = typeof input.domain === "string" ? input.domain : "";
        if (d && !s.currentTurnDomains.includes(d)) s.currentTurnDomains.push(d);
      }
    }
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
