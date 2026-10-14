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
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FULL_DIR, MANUAL_DIR, RAW_DIR } from "./constants.js";
import { errMsg } from "./diagnostics.js";
import { LOG_DIR, PtLogger } from "./log.js";
import { getSessionById } from "./session.js";
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
} from "./commands.js";
import { loadAndTranspile } from "./transpile.js";
import { renderTurnInject } from "./render/turn-inject.js";
import { filterDomainsByProfile } from "./schema.js";
import {
  persistManualToSession,
  refreshInjectionFooter,
  refreshManualWidget,
  persistLastTurnRef,
} from "./manual-session.js";
import { writeProbeResult } from "./manual-writeback.js";
import { slog } from "./slog.js";
import { getSessionIdFromCtx } from "./shared/session-helpers.js";
import { registerSessionEvents } from "./events/session.js";
import { registerTurnEvents } from "./events/turn.js";
import { registerToolEvents } from "./events/tool.js";
import { registerPtProfileCommand } from "./commands/pt-profile.js";

export default function (pi: ExtensionAPI): void {
  // 启动时 flag（CLI 优先）
  // Phase term-P2：pt-context → pt-profile（命令参数是 Profile 名，名该匹配操作目标）。
  //   向后兼容：--pt-context（flag）和 pt.pt-context/au.pt-context（settings key）作为 fallback 保留——
  //   用户升级 Pt 后旧配置仍能工作，新配置优先。
  pi.registerFlag("pt-profile", {
    description: "启动时激活的 Profile 名（编译成 AgentContext 注入 Session Inject）",
    type: "string",
  });
  registerSessionEvents(pi);
  registerTurnEvents(pi);
  registerToolEvents(pi);
  registerPtProfileCommand(pi);

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
          const { checkAllRefs, formatRefCheckResult } = await import("./verify/ref-check.js");
          const { scanProjectHealth, formatHealthSummary } = await import("./asset-health.js");
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

  // ========== tool 壳：LLM 可调（与 command 共享纯函数内核，.pt/docs/designs/pt-command-tool-dual-registration.md） ==========
  // 只读查询 + 手册实例化做 tool；pt-profile（改 system prompt）不做 tool（见设计文档 §2.4）
  //
  // v19（issue pt-llm-tool-consolidation）：8 tool 收敛到 3 根基 + 二级命令
  //   划分依据：作用对象正交（info=Pt 自身 / doc=项目文档 / inject=user message）。
  //   enum 字段用 StringEnum（from @earendil-works/pi-ai）跨 provider 兼容。
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
        const { checkAllRefs, formatRefCheckResult } = await import("./verify/ref-check.js");
        const { scanProjectHealth, formatHealthSummary } = await import("./asset-health.js");
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
        const { runVerify } = await import("./verify/index.js");
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

  // 根基 3：user message 注入（transform，无副作用）
  //   等价原 pt_turn_inject tool；execute 调 renderTurnInject 走统一内核。
  //   renderTurnInject 内部仍按 `/pt_turn_inject <target>` 字符串前缀解析（tool execute 拼前缀传入）——
  //   内部耦合保留，issue §边界纪律（不在本 scope 解耦）。
  pi.registerTool({
    name: "pt_inject",
    label: "Pt Inject",
    description:
      "Inject TurnContext (compiled manual detail) for a Domain on demand. " +
      "Returns the Rules/Flows/Checklists content of the Domain. " +
      "Use when reasoning needs a Domain's manual detail referenced in SessionContext's trigger-index. " +
      "Input: domain name (from /pt info /kind=flows output).",
    promptSnippet: "Inject a Domain's TurnContext (manual detail) on demand",
    promptGuidelines: [
      "Use pt_inject to fetch a Domain's manual detail (Rules/Flows/Checklists) on demand.",
      "Consult SessionContext's trigger-index or /pt info flows to decide which Domain to query.",
    ],
    parameters: Type.Object({
      domain: Type.String({
        description:
          "Domain name to inject, e.g. 'dev-process' or 'pt-quality'. Use /pt info flows to list available domains.",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!getSessionIdFromCtx(ctx)) {
        return {
          content: [{ type: "text", text: "no session" }],
          details: { error: "no session" },
        };
      }
      const s = getSessionById(getSessionIdFromCtx(ctx) as string);
      if (
        !s.cachedBundles ||
        s.cachedBundles.length === 0 ||
        !s.cachedAgentContext ||
        !s.cachedBlueprint
      ) {
        return {
          content: [{ type: "text", text: "无激活 Profile，先用 /pt-profile 激活" }],
          details: { error: "no active profile" },
        };
      }
      const scoped = filterDomainsByProfile(s.cachedBundles[0].domains, s.cachedProfile);
      // 内部耦合：renderTurnInject 按 `/pt_turn_inject <target>` 前缀解析
      // 保留该耦合（issue §边界纪律）——后续 issue 解耦
      const content = renderTurnInject(
        s.cachedAgentContext,
        s.cachedBlueprint,
        scoped,
        s.cachedProfile,
        `/pt_turn_inject ${params.domain}`
      );
      if (content === null) {
        return {
          content: [
            {
              type: "text",
              text: `未找到 Domain 或无手册段: ${params.domain}（用 /pt info flows 查可用手册）`,
            },
          ],
          details: { error: "not found", domain: params.domain },
        };
      }
      // v18.x（决策 6）：记录 compaction 重注入线索——TurnContext domain 名
      s.lastTurnRef = {
        turnInjectDomain: params.domain,
        manualPath: s.lastTurnRef?.manualPath ?? null,
      };
      persistLastTurnRef(pi, s.lastTurnRef);
      return { content: [{ type: "text", text: content }], details: { domain: params.domain } };
    },
  });
}
