// src/tools/pt-doc.ts
// pt_doc tool：项目文档管理（CRUD + 索引 + 校验，有副作用）。
// 从 index.ts 抽出（Step 7），逻辑零变更。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MANUAL_DIR } from "../constants.js";
import { errMsg } from "../diagnostics.js";
import { getSessionById } from "../session.js";
import { buildManualDoc, checkDocsText, flowsText, formatsList } from "../commands.js";
import {
  persistManualToSession,
  refreshInjectionFooter,
  refreshManualWidget,
  persistLastTurnRef,
} from "../manual-session.js";
import { writeProbeResult } from "../manual-writeback.js";
import { getSessionIdFromCtx } from "../shared/session-helpers.js";

/** 注册 pt_doc tool。从 index.ts 抽出，逻辑零变更。 */
export function registerPtDocTool(pi: ExtensionAPI): void {
  // 根基 2：项目文档管理（CRUD + 索引 + 校验，有副作用）
  //   action=list 等价原 pt_flows/issues/manuals/designs；start 等价原 pt_make_manual；
  //   verify 等价原 pt_verify；check 校验 docs/ 文档 schema。
  //   全 optional schema：Pi 对 discriminated union（oneOf/anyOf）支持不确定，安全落地（issue §关键合并点 6）。
  pi.registerTool({
    name: "pt_doc",
    label: "Pt Doc",
    description:
      "Manage project documents (issue/manual/design/flow + FlowTemplate manual instances). " +
      "Use action=list with type=flows|issues|manuals|designs to index the corresponding document set; " +
      "action=start with procedure (+ optional args + optional issue) to instantiate a FlowTemplate manual; " +
      "action=verify with probe (+ optional params) to run a verification probe; " +
      "action=check to validate docs/ schema.",
    promptSnippet: "List / start / verify / check Pt project documents by action",
    promptGuidelines: [
      "Use pt_doc when managing project document lifecycles (issue/manual/design instances, verification probes).",
      "For action=start, procedure is required. For action=verify, probe is required. For action=list, type is optional (defaults to all).",
    ],
    parameters: Type.Object({
      action: StringEnum(["list", "start", "verify", "check"], {
        description:
          "action=list indexes documents; action=start instantiates a manual; action=verify runs a probe; action=check validates docs/ schema.",
      }),
      // list 分支：type 可选（缺省列全部）；status 可选（按 frontmatter.status 过滤）
      type: Type.Optional(
        Type.String({
          description:
            "list branch: filter by document kind — issues | manuals | designs | flows (omit = all).",
        })
      ),
      status: Type.Optional(
        Type.String({
          description:
            "list branch (issues/manuals/designs only): filter by frontmatter status (e.g. open / in-progress / resolved / completed).",
        })
      ),
      profile: Type.Optional(
        Type.String({
          description:
            "list branch: limit index to this profile's documents (omit = active profile / all).",
        })
      ),
      // start 分支：procedure 必填；args / issue 可选
      procedure: Type.Optional(
        Type.String({
          description:
            "start branch: FlowTemplate name (e.g. feature-lifecycle, issue-lifecycle, regression-verify). Required when action=start.",
        })
      ),
      args: Type.Optional(
        Type.String({
          description:
            "start branch: arguments for the procedure, e.g. 'req-001' or 'term my-concept'.",
        })
      ),
      issue: Type.Optional(
        Type.String({
          description:
            "start branch: optional issue name this manual instance serves. Written to frontmatter `issue:` field.",
        })
      ),
      // verify 分支：probe 必填；params 可选
      probe: Type.Optional(
        Type.String({
          description:
            "verify branch: probe name from observe field (e.g. fs-content-match, ts-compiles, test-pass, git-status-clean). Required when action=verify.",
        })
      ),
      params: Type.Optional(
        Type.Record(Type.String(), Type.String(), {
          description:
            "verify branch: probe parameters, e.g. { path: 'src/foo.ts', pattern: 'export' }.",
        })
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = getSessionIdFromCtx(ctx);
      if (!sessionId) {
        return {
          content: [{ type: "text", text: "no session" }],
          details: { error: "no session" },
        };
      }
      const s = getSessionById(sessionId);
      const action = params.action ?? "list";

      // ==================== action=list ====================
      if (action === "list") {
        const profile = params.profile ?? s.activeProfile ?? null;
        const type = params.type;
        // type 缺省或 "all" / "any" → 聚合所有类型
        if (!type || type === "all") {
          const out: string[] = [];
          // flowsText 需 session（adepter 已注入），与其他类型路径不同——
          // 拿 session 后直接走专属路径
          out.push(flowsText(s));
          out.push(await formatsList(ctx.cwd, profile, "issues", params.status));
          out.push(await formatsList(ctx.cwd, profile, "manuals", params.status));
          out.push(await formatsList(ctx.cwd, profile, "designs", params.status));
          return {
            content: [{ type: "text", text: out.join("\n\n") }],
            details: { action, type: "all" },
          };
        }
        if (type === "flows") {
          // flowsText 需 session（adepter 已注入）——拿 s 后调
          return { content: [{ type: "text", text: flowsText(s) }], details: { action, type } };
        }
        if (type === "issues" || type === "manuals" || type === "designs") {
          const text = await formatsList(ctx.cwd, profile, type, params.status);
          return { content: [{ type: "text", text }], details: { action, type } };
        }
        return {
          content: [
            {
              type: "text",
              text: `unknown type "${type}" (allowed: flows|issues|manuals|designs)`,
            },
          ],
          details: { action, type, error: "unknown type" },
        };
      }

      // ==================== action=start ====================
      if (action === "start") {
        if (!params.procedure) {
          return {
            content: [{ type: "text", text: "action=start requires procedure" }],
            details: { action, error: "missing procedure" },
          };
        }
        const r = buildManualDoc(ctx.cwd, s, params.procedure, params.args ?? "", params.issue);
        if (r.error) {
          return {
            content: [{ type: "text", text: r.error }],
            details: { action, error: r.error },
          };
        }
        return withFileMutationQueue(r.filePath, async () => {
          await mkdir(join(ctx.cwd, MANUAL_DIR), { recursive: true });
          await writeFile(r.filePath, r.content, "utf8");
          // v11.x：手动跟踪实例 + widget + footer + 持久化
          s.activeManual = {
            filePath: r.filePath,
            procedure: params.procedure as string,
            args: params.args ?? "",
            issue: params.issue, // P3：透传 issue 字段（可选，undefined 时不写 frontmatter）
            activatedAt: Date.now(),
          };
          // v18.x（决策 6）：记录 compaction 重注入线索——Manual 文件路径
          // 保留已有 turnInjectDomain（若之前已调 pt_inject，不覆盖）
          s.lastTurnRef = {
            turnInjectDomain: s.lastTurnRef?.turnInjectDomain ?? "",
            manualPath: r.filePath,
          };
          persistLastTurnRef(pi, s.lastTurnRef);
          persistManualToSession(pi, s.activeManual);
          await refreshManualWidget(ctx.ui, s);
          refreshInjectionFooter(ctx.ui, s);
          return {
            content: [{ type: "text", text: `手册实例已创建: ${r.filePath}` }],
            details: { action, procedure: params.procedure, path: r.filePath },
          };
        });
      }

      // ==================== action=verify ====================
      if (action === "verify") {
        if (!params.probe) {
          return {
            content: [{ type: "text", text: "action=verify requires probe" }],
            details: { action, error: "missing probe" },
          };
        }
        const { runVerify } = await import("../verify/index.js");
        const probeParams = (params.params ?? {}) as Record<string, string>;
        const result = await runVerify(ctx.cwd, params.probe, probeParams);
        const text =
          result.outcome === "COMPLETED"
            ? `✓ ${result.message}`
            : result.outcome === "DEVIATED"
              ? `✗ ${result.message}${result.actual ? `\n${result.actual}` : ""}`
              : `? ${result.message}`;
        // v15.x（issue pt-verify-result-not-written-back-to-manual）：自动写回 manual 文件
        let writebackNote = "";
        if (s?.activeManual) {
          const filePath = s.activeManual.filePath;
          try {
            await withFileMutationQueue(filePath, async () => {
              const before = await readFile(filePath, "utf8");
              const wb = writeProbeResult(
                before,
                params.probe as string,
                result.outcome,
                result.message
              );
              if (wb.changed) {
                await writeFile(filePath, wb.content, "utf8");
                const checked =
                  wb.checkedSteps.length > 0 ? `，勾选 ${wb.checkedSteps.length} 个 checklist` : "";
                writebackNote = `\n↳ 已写回 manual step ${wb.stepIndexes.join(", ")}${checked}`;
              } else if (wb.matchCount === 0) {
                writebackNote = `\n? probe "${params.probe}" 未匹配 activeManual 任何 step 的 observe（${filePath}）`;
              }
            });
          } catch (e) {
            writebackNote = `\n! 写回 manual 失败: ${errMsg(e)}`;
          }
          await refreshManualWidget(ctx.ui, s);
          refreshInjectionFooter(ctx.ui, s);
        }
        return {
          content: [{ type: "text", text: text + writebackNote }],
          details: {
            action,
            probe: params.probe,
            ...result,
            writeback: writebackNote || undefined,
          },
        };
      }

      // ==================== action=check ====================
      if (action === "check") {
        const profile = params.profile ?? s.activeProfile ?? null;
        const text = await checkDocsText(ctx.cwd, profile, { profile });
        return { content: [{ type: "text", text }], details: { action } };
      }

      return {
        content: [{ type: "text", text: `unknown action: ${action}` }],
        details: { action, error: "unknown action" },
      };
    },
  });
}
