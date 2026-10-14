// src/tools/pt-info.ts
// pt_info tool：Pt 自身运行时/调试查询（只读）。
// 从 index.ts 抽出（Step 7），逻辑零变更。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FULL_DIR, RAW_DIR } from "../constants.js";
import { LOG_DIR, PtLogger } from "../log.js";
import { getSessionById } from "../session.js";
import { buildFullPrompt, packsText, statusText } from "../commands.js";
import { loadAndTranspile } from "../transpile.js";
import { getSessionIdFromCtx } from "../shared/session-helpers.js";

/** 注册 pt_info tool。从 index.ts 抽出，逻辑零变更。 */
export function registerPtInfoTool(pi: ExtensionAPI): void {
  //   pt_doc 全 optional schema（Pi 对 discriminated union 支持不确定，安全落地）。

  // 根基 1：Pt 自身运行时/调试查询（只读）
  //   kind=status 等价原 pt_status；packs 等价 pt_packs；lint 合并 pt_check + pt_check_refs 走实时加载；
  //   logs/logs:clear/sessions/raw/full 路径查询，等价原 /pt 命令同名子命令。
  pi.registerTool({
    name: "pt_info",
    label: "Pt Info",
    description:
      "Query Pt itself (runtime state / compiled artifacts / debug file paths). Read-only. " +
      "Use kind=status for active profile + counts + cache hit; kind=packs for loaded pack details; " +
      "kind=lint for project asset misconfigurations (missing Modules / dangling refs / orphan H2 / empty segments / unknown modnames), " +
      "merges the previous pt_check + pt_check_refs into a single real-time scan; " +
      "kind=logs/logs:clear/sessions/raw/full for runtime log/session file paths (equivalent to /pt logs etc.). " +
      "Switch via the `kind` parameter.",
    promptSnippet: "Query Pt runtime state / assets / debug paths by kind",
    promptGuidelines: [
      "Use pt_info when you need to know Pt's current state, load details, or runtime paths.",
      "Pair pt_info {kind: lint} with /pt doc list manual — lint for asset config health, list manuals for runtime tracking.",
    ],
    parameters: Type.Object({
      kind: StringEnum(
        ["status", "packs", "lint", "logs", "logs:clear", "sessions", "raw", "full"],
        {
          description:
            "What to query: status/packs/lint for live state; logs/logs:clear/sessions for log paths; raw/full for compiled prompt artifacts.",
        }
      ),
      // lint 分支用：限定扫的 profile 名
      profile: Type.Optional(
        Type.String({
          description: "Lint only: limit scan to a single Profile name (e.g. 'ysl-developer').",
        })
      ),
      // lint 分支用：reserved for v2 fix mode（恒 false，仅显示 hint 不改文件）
      fix: Type.Optional(
        Type.Boolean({
          description:
            "Lint only: reserved for v2. Currently always false; output shows hints but does not modify files.",
        })
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = getSessionIdFromCtx(ctx);
      const s = sessionId ? getSessionById(sessionId) : null;
      const kind = params.kind ?? "status";

      if (kind === "status") {
        return {
          content: [{ type: "text", text: s ? statusText(s) : "no session" }],
          details: { kind },
        };
      }

      if (kind === "packs") {
        return {
          content: [{ type: "text", text: s ? packsText(s) : "no session" }],
          details: { kind },
        };
      }

      if (kind === "lint") {
        // v19（issue pt-llm-tool-consolidation）：pt_info {kind: lint} 合并 pt_check + pt_check_refs
        //   - 走 loadAndTranspile 实时加载（修 pt_check 读 session.assetHealthIssues 缓存的弱点）
        //   - scanProjectHealth 的 8 类检查项全保留 + checkAllRefs 独有的"未实例化聚合组"warning 保留
        const { checkAllRefs, formatRefCheckResult } = await import("../verify/ref-check.js");
        const { scanProjectHealth, formatHealthSummary } = await import("../asset-health.js");
        const r = await loadAndTranspile(ctx.cwd, s?.activeProfile ?? "");
        const b = r.bundles[0];
        // scan 部分
        const report = await scanProjectHealth(
          ctx.cwd,
          b.profiles,
          b.blueprints,
          b.domains,
          b.packs,
          b.activeProfilePack,
          b.workingSet,
          { log: s?.logger?.toWriter() }
        );
        // profileName 过滤（与原 /pt check --profile 行为对齐）
        const filteredReport = params.profile
          ? {
              ...report,
              issues: report.issues.filter((i) => i.name === params.profile),
              errors: report.issues.filter(
                (i) => i.name === params.profile && i.severity === "error"
              ).length,
              warnings: report.issues.filter(
                (i) => i.name === params.profile && i.severity === "warning"
              ).length,
            }
          : report;
        const scanOut = formatHealthSummary(filteredReport);
        // refs 部分（pt_check_refs 原行为）
        const refs = checkAllRefs(b.profiles, b.blueprints, b.domains, {
          domainWS: b.workingSet.domains,
          packNames: b.packs.map((p) => p.name),
        });
        const refsOut = formatRefCheckResult(refs);
        const merged = `${scanOut}\n\n${refsOut}`;
        return {
          content: [{ type: "text", text: merged }],
          details: {
            kind,
            scanErrors: filteredReport.errors,
            scanWarnings: filteredReport.warnings,
            scanIssues: filteredReport.issues.length,
            refErrors: refs.errors.length,
            refWarnings: refs.warnings.length,
          },
        };
      }

      // 以下 kind 走 /pt 命令同名子命令相同路径（共享 handlers）
      if (kind === "logs") {
        const files = await PtLogger.list(ctx.cwd);
        if (files.length === 0) {
          return {
            content: [{ type: "text", text: `无日志（${LOG_DIR}/ 不存在）` }],
            details: { kind },
          };
        }
        const targetFile = s?.sessionId ? `pt-${s.sessionId}.log` : files[files.length - 1];
        const lines = await PtLogger.tail(
          ctx.cwd,
          50,
          targetFile === "pt.log" ? undefined : targetFile.slice(3, -4)
        );
        const formatted = lines
          .map((e) => {
            const stamp = e.ts.slice(11, 23);
            const lvl = e.level.toUpperCase().padEnd(7);
            const ctxStr =
              e.ctx && Object.keys(e.ctx).length > 0 ? ` ${JSON.stringify(e.ctx)}` : "";
            return `[${stamp}] [${lvl}] ${e.msg}${ctxStr}`;
          })
          .join("\n");
        const header = `(${targetFile}，最近 ${lines.length} 条; 共 ${files.length} 个 session 文件)`;
        return { content: [{ type: "text", text: `${header}\n${formatted}` }], details: { kind } };
      }

      if (kind === "logs:clear") {
        await PtLogger.clear(ctx.cwd, s?.sessionId ?? undefined);
        return {
          content: [
            {
              type: "text",
              text: `已清空 .pt/logs/${s?.sessionId ? `pt-${s.sessionId}.log` : "pt.log"}`,
            },
          ],
          details: { kind },
        };
      }

      if (kind === "sessions") {
        const files = await PtLogger.list(ctx.cwd);
        if (files.length === 0) {
          return { content: [{ type: "text", text: "无 session 日志文件" }], details: { kind } };
        }
        const list = files
          .map((f) => `  ${f}${f === `pt-${s?.sessionId}.log` ? " (current)" : ""}`)
          .join("\n");
        return {
          content: [{ type: "text", text: `已存在的 session 日志:\n${list}` }],
          details: { kind },
        };
      }

      if (kind === "raw") {
        if (!s?.cachedSegment) {
          return {
            content: [{ type: "text", text: "无 segment 可显示" }],
            details: { kind, error: "no segment" },
          };
        }
        const dir = join(ctx.cwd, RAW_DIR);
        await mkdir(dir, { recursive: true });
        const file = join(dir, `segment-${Date.now()}.md`);
        await writeFile(file, s.cachedSegment, "utf8");
        return {
          content: [{ type: "text", text: `已写入 ${file}（${s.cachedSegment.length} chars）` }],
          details: { kind, path: file },
        };
      }

      if (kind === "full") {
        if (!s?.cachedSegment) {
          return {
            content: [{ type: "text", text: "警告：无 cachedSegment（未加载 Profile）" }],
            details: { kind, error: "no segment" },
          };
        }
        const full = buildFullPrompt(ctx.getSystemPrompt(), s.cachedSegment, s.lastBuiltPrompt);
        const dir = join(ctx.cwd, FULL_DIR);
        await mkdir(dir, { recursive: true });
        const file = join(dir, `prompt-${Date.now()}.md`);
        await writeFile(file, full, "utf8");
        return {
          content: [
            { type: "text", text: `完整 systemPrompt 已写入 ${file}（${full.length} chars）` },
          ],
          details: { kind, path: file },
        };
      }

      return {
        content: [{ type: "text", text: `unknown kind: ${kind}` }],
        details: { kind, error: "unknown kind" },
      };
    },
  });
}
