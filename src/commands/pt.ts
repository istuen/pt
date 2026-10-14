// src/commands/pt.ts
// /pt 命令：查看 Pt 编译产物 / 管理项目文档。
// 从 index.ts 抽出（Step 6），逻辑零变更。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FULL_DIR, MANUAL_DIR, RAW_DIR } from "../constants.js";
import { LOG_DIR, PtLogger } from "../log.js";
import { getSessionById } from "../session.js";
import {
  buildFullPrompt,
  buildManualDoc,
  checkDocsText,
  checkText,
  designsText,
  flowsText,
  formatsList,
  issuesText,
  manualsText,
  packsText,
  parseListFlags,
  statusText,
} from "../commands.js";
import { loadAndTranspile } from "../transpile.js";
import {
  persistManualToSession,
  refreshInjectionFooter,
  refreshManualWidget,
} from "../manual-session.js";
import { slog } from "../slog.js";
import { getSessionIdFromCtx } from "../shared/session-helpers.js";

/** 注册 /pt 命令。从 index.ts 抽出，逻辑零变更。 */
export function registerPtCommand(pi: ExtensionAPI): void {
  // ========== /pt 命令：查看 Pt 编译产物 / 管理项目文档 ==========
  // v19（issue pt-llm-tool-consolidation）：
  //   - 子命令重构为 info / doc 两根基 + 旧命令别名转发（back-compat）。
  //   - /pt info <kind>：status / packs / lint / logs / logs:clear / sessions / raw / full
  //   - /pt doc list [type] | start <procedure> [args] [--issue X] | check
  //   - 旧命令（status/packs/check/logs/logs:clear/sessions/raw/full/flows/issues/manuals/designs/check-docs/make-manual）转发
  //   - inject 无人类命令（见 issue §人类命令统一方案）
  //   - /pt 无参行为不变（statusText + cachedSegment）
  pi.registerCommand("pt", {
    description:
      "查看 Pt 转译产物 / 管理项目文档（无参=status + segment；子命令 info/doc；旧命令别名兼容）",
    handler: async (args, ctx) => {
      // v11.x 修复：sub = 第一词，subArgs = 剩余。兼容 logs:clear / status / flows 等单子命令。
      const firstSpace = args.indexOf(" ");
      const head = firstSpace === -1 ? args : args.slice(0, firstSpace);
      const tail = firstSpace === -1 ? "" : args.slice(firstSpace + 1);
      const sub = head.trim().toLowerCase();
      const subArgs = tail;
      const sessionId = getSessionIdFromCtx(ctx);
      slog(sessionId, "info", "command:/pt invoked", { sub }); // v10.x: P4 子命令 trace

      if (!sessionId) {
        ctx.ui.notify("Pt：无法获取 session id（pi 版本不兼容）", "error");
        return;
      }
      const s = getSessionById(sessionId);

      // ===== /pt 无参 = 默认 status + segment（保留原行为） =====
      if (sub === "") {
        ctx.ui.notify(statusText(s), "info");
        if (s.cachedSegment) {
          ctx.ui.notify(s.cachedSegment, "info");
        }
        return;
      }

      // ==================== /pt info <kind> ====================
      // status/packs/lint/logs/logs:clear/sessions/raw/full 八种
      if (sub === "info") {
        // subArgs 形如 "status" / "logs" / "lint --profile X" / "logs:clear" 等
        const infoFirstSpace = subArgs.indexOf(" ");
        const kindHead = infoFirstSpace === -1 ? subArgs : subArgs.slice(0, infoFirstSpace);
        const kindTail = infoFirstSpace === -1 ? "" : subArgs.slice(infoFirstSpace + 1);
        const kind = kindHead.trim().toLowerCase() || "status";
        const k = kindTail.trim();

        if (kind === "status") {
          ctx.ui.notify(statusText(s), "info");
          return;
        }
        if (kind === "packs") {
          ctx.ui.notify(packsText(s), "info");
          return;
        }
        if (kind === "lint") {
          // 解析 --profile X / --fix
          const parts = k.split(/\s+/).filter((p) => p.length > 0);
          let profileName: string | undefined;
          let fix = false;
          for (let i = 0; i < parts.length; i++) {
            const p = parts[i];
            if (p === "--fix") {
              fix = true;
              continue;
            }
            if (p === "--profile" || p === "-p") {
              const next = parts[i + 1];
              if (next && !next.startsWith("--")) {
                profileName = next;
                i++;
              }
              continue;
            }
            if (p.startsWith("--profile=")) {
              profileName = p.slice("--profile=".length);
              continue;
            }
            if (!profileName) profileName = p;
          }
          // 复用 pt_info {kind: lint} 的逻辑：实时加载 + scanProjectHealth + checkAllRefs
          const { checkAllRefs, formatRefCheckResult } = await import("../verify/ref-check.js");
          const { scanProjectHealth, formatHealthSummary } = await import("../asset-health.js");
          const r = await loadAndTranspile(ctx.cwd, s.activeProfile ?? "");
          const b = r.bundles[0];
          const report = await scanProjectHealth(
            ctx.cwd,
            b.profiles,
            b.blueprints,
            b.domains,
            b.packs,
            b.activeProfilePack,
            b.workingSet,
            { log: s.logger?.toWriter() }
          );
          const filtered = profileName
            ? {
                ...report,
                issues: report.issues.filter((i) => i.name === profileName),
                errors: report.issues.filter(
                  (i) => i.name === profileName && i.severity === "error"
                ).length,
                warnings: report.issues.filter(
                  (i) => i.name === profileName && i.severity === "warning"
                ).length,
              }
            : report;
          const refs = checkAllRefs(b.profiles, b.blueprints, b.domains, {
            domainWS: b.workingSet.domains,
            packNames: b.packs.map((p) => p.name),
          });
          const merged = `${formatHealthSummary(filtered)}\n\n${formatRefCheckResult(refs)}`;
          ctx.ui.notify(merged, filtered.errors > 0 || refs.errors.length > 0 ? "warning" : "info");
          // 旧 /pt check 兼容性：--fix 时显示迁移提示（v2 范围，本 v1 不实现）
          if (fix) {
            ctx.ui.notify(
              "提示：fix 模式 v2 范围，本 v1 不自动修改文件（运行 /pt info lint 查看 hint）",
              "info"
            );
          }
          return;
        }
        if (kind === "logs") {
          const files = await PtLogger.list(ctx.cwd);
          if (files.length === 0) {
            ctx.ui.notify(`无日志（${LOG_DIR}/ 不存在）`, "info");
            return;
          }
          let targetFile = `pt-${s.sessionId}.log`;
          if (!files.includes(targetFile)) {
            if (files.includes("pt.log")) targetFile = "pt.log";
            else targetFile = files[files.length - 1];
          }
          const lines = await PtLogger.tail(
            ctx.cwd,
            50,
            targetFile === "pt.log" ? undefined : targetFile.slice(3, -4)
          );
          if (lines.length === 0) {
            ctx.ui.notify(`日志为空（${targetFile}）`, "info");
            return;
          }
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
          ctx.ui.notify(`${header}\n${formatted}`, "info");
          return;
        }
        if (kind === "logs:clear") {
          await PtLogger.clear(ctx.cwd, s.sessionId || undefined);
          ctx.ui.notify(
            `已清空 .pt/logs/${s.sessionId ? `pt-${s.sessionId}.log` : "pt.log"}`,
            "info"
          );
          return;
        }
        if (kind === "sessions") {
          const files = await PtLogger.list(ctx.cwd);
          if (files.length === 0) {
            ctx.ui.notify("无 session 日志文件", "info");
            return;
          }
          ctx.ui.notify(
            `已存在的 session 日志:\n${files.map((f) => `  ${f}${f === `pt-${s.sessionId}.log` ? " (current)" : ""}`).join("\n")}`,
            "info"
          );
          return;
        }
        if (kind === "raw") {
          if (!s.cachedSegment) {
            ctx.ui.notify("无 segment 可显示", "warning");
            return;
          }
          const dir = join(ctx.cwd, RAW_DIR);
          await mkdir(dir, { recursive: true });
          const file = join(dir, `segment-${Date.now()}.md`);
          await writeFile(file, s.cachedSegment, "utf8");
          ctx.ui.notify(`已写入 ${file}（${s.cachedSegment.length} chars）`, "info");
          return;
        }
        if (kind === "full") {
          const full = buildFullPrompt(ctx.getSystemPrompt(), s.cachedSegment, s.lastBuiltPrompt);
          if (!s.cachedSegment) {
            ctx.ui.notify(
              "警告：无 cachedSegment（未加载 Profile）。用 /pt-profile <name> 选择",
              "warning"
            );
          }
          const dir = join(ctx.cwd, FULL_DIR);
          await mkdir(dir, { recursive: true });
          const file = join(dir, `prompt-${Date.now()}.md`);
          await writeFile(file, full, "utf8");
          ctx.ui.notify(`完整 systemPrompt 已写入 ${file}（${full.length} chars）`, "info");
          return;
        }
        ctx.ui.notify(
          `用法: /pt info <status|packs|lint|logs|logs:clear|sessions|raw|full>`,
          "warning"
        );
        return;
      }

      // ==================== /pt doc <action> ====================
      if (sub === "doc") {
        const docFirstSpace = subArgs.indexOf(" ");
        const actionHead = docFirstSpace === -1 ? subArgs : subArgs.slice(0, docFirstSpace);
        const actionTail = docFirstSpace === -1 ? "" : subArgs.slice(docFirstSpace + 1);
        const action = actionHead.trim().toLowerCase();
        const actionArgs = actionTail.trim();

        if (action === "" || action === "list") {
          // /pt doc list [type] —— type=flows/issues/manuals/designs，缺省列全部
          // 第一个词作为 type，其余作为 --profile / --status flags
          const listParts = actionArgs.split(/\s+/).filter((p) => p.length > 0);
          const type = listParts.shift() ?? "";
          const flags = parseListFlags(listParts.join(" "));
          const profile = flags.profile ?? s.activeProfile ?? null;

          if (type === "" || type === "all") {
            const out: string[] = [];
            out.push(flowsText(s));
            out.push(await formatsList(ctx.cwd, profile, "issues", flags.status));
            out.push(await formatsList(ctx.cwd, profile, "manuals", flags.status));
            out.push(await formatsList(ctx.cwd, profile, "designs", flags.status));
            ctx.ui.notify(out.join("\n\n"), "info");
            return;
          }
          if (type === "flows") {
            ctx.ui.notify(flowsText(s), "info");
            return;
          }
          if (type === "issues" || type === "manuals" || type === "designs") {
            ctx.ui.notify(await formatsList(ctx.cwd, profile, type, flags.status), "info");
            return;
          }
          ctx.ui.notify(
            `用法: /pt doc list [flows|issues|manuals|designs] [--profile X] [--status X]`,
            "warning"
          );
          return;
        }

        if (action === "start") {
          // /pt doc start <procedure> [args] [--issue X]
          const procedureParts = actionArgs.split(/\s+/).filter((p) => p.length > 0);
          let issueName: string | undefined;
          for (let i = 0; i < procedureParts.length; i++) {
            const p = procedureParts[i];
            if (p === "--issue") {
              const next = procedureParts[i + 1];
              if (next) issueName = next;
              procedureParts.splice(i, 2);
              break;
            }
            if (p.startsWith("--issue=")) {
              issueName = p.slice("--issue=".length);
              procedureParts.splice(i, 1);
              break;
            }
          }
          const procedureName = procedureParts[0] ?? "";
          const procedureArgs = procedureParts.slice(1).join(" ");
          const r = buildManualDoc(ctx.cwd, s, procedureName, procedureArgs, issueName);
          if (r.error) {
            ctx.ui.notify(r.error, "warning");
            return;
          }
          await mkdir(join(ctx.cwd, MANUAL_DIR), { recursive: true });
          await writeFile(r.filePath, r.content, "utf8");
          s.activeManual = {
            filePath: r.filePath,
            procedure: procedureName,
            args: procedureArgs,
            issue: issueName,
            activatedAt: Date.now(),
          };
          persistManualToSession(pi, s.activeManual);
          await refreshManualWidget(ctx.ui, s);
          refreshInjectionFooter(ctx.ui, s);
          ctx.ui.notify(`手册实例已创建: ${r.filePath}`, "info");
          return;
        }

        if (action === "check") {
          // /pt doc check —— 校验 docs/ 文档 schema（等价原 /pt check-docs）
          const profile = s.activeProfile ?? null;
          const text = await checkDocsText(ctx.cwd, profile, { profile });
          ctx.ui.notify(text, "info");
          return;
        }

        ctx.ui.notify("用法: /pt doc <list|start|check>", "warning");
        return;
      }

      // ==================== 旧命令别名（back-compat 转发） ====================
      // 等价 /pt info status
      if (sub === "status") {
        ctx.ui.notify(statusText(s), "info");
        return;
      }
      // 等价 /pt info packs
      if (sub === "packs") {
        ctx.ui.notify(packsText(s), "info");
        return;
      }
      // 等价 /pt info lint（保留原 /pt check 行为）
      if (sub === "check") {
        const checkParts = subArgs
          .trim()
          .split(/\s+/)
          .filter((s) => s.length > 0);
        let profileName: string | undefined;
        let fix = false;
        for (let i = 0; i < checkParts.length; i++) {
          const p = checkParts[i];
          if (p === undefined) continue;
          if (p === "--fix") {
            fix = true;
            continue;
          }
          if (p === "--profile" || p === "-p") {
            const next = checkParts[i + 1];
            if (next && !next.startsWith("--")) {
              profileName = next;
              i++;
            }
            continue;
          }
          if (p.startsWith("--profile=")) {
            profileName = p.slice("--profile=".length);
            continue;
          }
          if (!profileName) profileName = p;
        }
        const r = checkText(s, { profileName, fix });
        ctx.ui.notify(r.output, r.errors > 0 ? "warning" : "info");
        return;
      }
      // 等价 /pt info logs / logs:clear / sessions / raw / full
      if (
        sub === "logs" ||
        sub === "logs:clear" ||
        sub === "sessions" ||
        sub === "raw" ||
        sub === "full"
      ) {
        // 转发到 /pt info 同名 kind（复用上面 info handler）—— 简单重呼一次
        // 通过递归调用 cmd handler 不便（已注册），改用直接派发：
        // 这里复用 /pt info 同名 kind 实现——直接调用 info 分支内联（再次走 loadAndTranspile 等）
        // 为避免重复代码，refactor：用 helper 抽离；本期先转发。
        // 简化：直接调对应 handler 内联（info 分支 + raw/full/logs/sessions/logs:clear 各有 small block）
        // 这里选用与 /pt info logs 同等的代码路径——走子命令 inlined：
        const fakeInfoArgs =
          sub === "raw" ||
          sub === "full" ||
          sub === "sessions" ||
          sub === "logs" ||
          sub === "logs:clear"
            ? `${sub} ${subArgs}`
            : subArgs;
        // 递归调子命令——直接复用上面的 info 分支代码块即可（重复但保留可读性）
        // 此处直接复用 /pt info 逻辑：避免复制粘贴，用 wrapper
        // 简化：把 info 分支抽到命令级 helper —— 本期先 inlined 二次：
        if (sub === "logs") {
          const files = await PtLogger.list(ctx.cwd);
          if (files.length === 0) {
            ctx.ui.notify(`无日志（${LOG_DIR}/ 不存在）`, "info");
            return;
          }
          let targetFile = `pt-${s.sessionId}.log`;
          if (!files.includes(targetFile)) {
            if (files.includes("pt.log")) targetFile = "pt.log";
            else targetFile = files[files.length - 1];
          }
          const lines = await PtLogger.tail(
            ctx.cwd,
            50,
            targetFile === "pt.log" ? undefined : targetFile.slice(3, -4)
          );
          if (lines.length === 0) {
            ctx.ui.notify(`日志为空（${targetFile}）`, "info");
            return;
          }
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
          ctx.ui.notify(`${header}\n${formatted}`, "info");
          return;
        }
        if (sub === "logs:clear") {
          await PtLogger.clear(ctx.cwd, s.sessionId || undefined);
          ctx.ui.notify(
            `已清空 .pt/logs/${s.sessionId ? `pt-${s.sessionId}.log` : "pt.log"}`,
            "info"
          );
          return;
        }
        if (sub === "sessions") {
          const files = await PtLogger.list(ctx.cwd);
          if (files.length === 0) {
            ctx.ui.notify("无 session 日志文件", "info");
            return;
          }
          ctx.ui.notify(
            `已存在的 session 日志:\n${files.map((f) => `  ${f}${f === `pt-${s.sessionId}.log` ? " (current)" : ""}`).join("\n")}`,
            "info"
          );
          return;
        }
        if (sub === "raw") {
          if (!s.cachedSegment) {
            ctx.ui.notify("无 segment 可显示", "warning");
            return;
          }
          const dir = join(ctx.cwd, RAW_DIR);
          await mkdir(dir, { recursive: true });
          const file = join(dir, `segment-${Date.now()}.md`);
          await writeFile(file, s.cachedSegment, "utf8");
          ctx.ui.notify(`已写入 ${file}（${s.cachedSegment.length} chars）`, "info");
          return;
        }
        if (sub === "full") {
          const full = buildFullPrompt(ctx.getSystemPrompt(), s.cachedSegment, s.lastBuiltPrompt);
          if (!s.cachedSegment) {
            ctx.ui.notify(
              "警告：无 cachedSegment（未加载 Profile）。用 /pt-profile <name> 选择",
              "warning"
            );
          }
          const dir = join(ctx.cwd, FULL_DIR);
          await mkdir(dir, { recursive: true });
          const file = join(dir, `prompt-${Date.now()}.md`);
          await writeFile(file, full, "utf8");
          ctx.ui.notify(`完整 systemPrompt 已写入 ${file}（${full.length} chars）`, "info");
          return;
        }
        return;
      }
      // 等价 /pt doc list flows
      if (sub === "flows") {
        ctx.ui.notify(flowsText(s), "info");
        return;
      }
      // 等价 /pt doc list issues/manuals/designs
      if (sub === "issues" || sub === "manuals" || sub === "designs") {
        const flags = parseListFlags(subArgs);
        const profile = flags.profile ?? s.activeProfile ?? null;
        const text =
          sub === "issues"
            ? await issuesText(ctx.cwd, profile, { status: flags.status })
            : sub === "manuals"
              ? await manualsText(ctx.cwd, profile, { status: flags.status })
              : await designsText(ctx.cwd, profile, { status: flags.status });
        ctx.ui.notify(text, "info");
        return;
      }
      // 等价 /pt doc start <proc>
      if (sub === "make-manual") {
        // 直接转发到 /pt doc start 逻辑——subArgs
        const procedureParts = subArgs.trim().split(/\s+/);
        let issueName: string | undefined;
        for (let i = 0; i < procedureParts.length; i++) {
          const p = procedureParts[i];
          if (p === "--issue") {
            const next = procedureParts[i + 1];
            if (next) issueName = next;
            procedureParts.splice(i, 2);
            break;
          }
          if (p?.startsWith("--issue=")) {
            issueName = p.slice("--issue=".length);
            procedureParts.splice(i, 1);
            break;
          }
        }
        const procedureName = procedureParts[0] ?? "";
        const procedureArgs = procedureParts.slice(1).join(" ");
        const r = buildManualDoc(ctx.cwd, s, procedureName, procedureArgs, issueName);
        if (r.error) {
          ctx.ui.notify(r.error, "warning");
          return;
        }
        await mkdir(join(ctx.cwd, MANUAL_DIR), { recursive: true });
        await writeFile(r.filePath, r.content, "utf8");
        s.activeManual = {
          filePath: r.filePath,
          procedure: procedureName,
          args: procedureArgs,
          issue: issueName,
          activatedAt: Date.now(),
        };
        persistManualToSession(pi, s.activeManual);
        await refreshManualWidget(ctx.ui, s);
        refreshInjectionFooter(ctx.ui, s);
        ctx.ui.notify(`手册实例已创建: ${r.filePath}`, "info");
        return;
      }
      // 等价 /pt doc check（校验 docs/ 文档 schema）
      if (sub === "check-docs") {
        const flags = parseListFlags(subArgs);
        const profile = flags.profile ?? s.activeProfile ?? null;
        const allowedKind = flags.kind;
        const kind =
          allowedKind === "issue" || allowedKind === "manual" || allowedKind === "design"
            ? allowedKind
            : undefined;
        const text = await checkDocsText(ctx.cwd, profile, kind ? { kind } : { profile });
        ctx.ui.notify(text, "info");
        return;
      }

      ctx.ui.notify(
        "用法: /pt [info <kind>|doc <action>] （旧命令 status/packs/check/logs/logs:clear/sessions/raw/full/flows/issues/manuals/designs/check-docs/make-manual 仍兼容）",
        "warning"
      );
    },
  });
}
