// src/checks.ts — 主动检查（A2）：Pt 自己在 agent 跑完时执行声明的探针
//
// 问题（issue pt-asset-verifiable-norm §三 A2）：规范写了、Agent 大概率照做了（实测 80pp
// 因果效应），但**没人验证**——遵从只能事后从日志里看。`pt_doc verify` 是**被动**的：
// 模型不主动调，就没有信号。
//
// 本模块让 Pt 主动跑：
//   声明来源 ① 项目 settings `pt.checks`（配置层，不动资产 schema）
//            ② 激活 Manual 的 step observe 探针（资产已有，`pt.auto-checks: "on+manual"` 时纳入）
//   执行时机 agent_settled（agent 跑完一轮、等待用户输入时）
//            session_end（session 关闭时）
//   结果处理 DEVIATED → notify + 日志；COMPLETED / INCONCLUSIVE → 只记日志（不刷屏）
//            命中 activeManual 的 step observe → 复用 writeProbeResult 写回 manual
//
// 边界：
//   - 不改 parse/compile/资产 schema（纯 agent + 配置层扩展）。
//   - 显式声明才跑（没声明 = 零成本）；重探针（lint/tsc/test）代价由声明者承担。
//   - 一次执行内同探针只跑一次（去重）。

import { readFile, writeFile } from "node:fs/promises";
import { readProjectSetting } from "./config.js";
import { runVerify } from "./verify/index.js";
import { getSessionById } from "./session.js";
import { writeProbeResult } from "./manual-writeback.js";
import { errMsg } from "./diagnostics.js";
import type { ProbeOutcome } from "./schema.js";

/** 何时跑。 */
export type CheckWhen = "agent_settled" | "session_end";

/** 声明的一条检查。 */
export interface DeclaredCheck {
  /** 探针名（src/verify 注册表里的 key）。 */
  probe: string;
  /** 探针参数。 */
  params?: Record<string, string>;
  /** 何时跑（默认 agent_settled）。 */
  when?: CheckWhen;
}

/** 检查执行模式。 */
export type AutoCheckMode = "off" | "on" | "on+manual";

/** 默认模式：只跑 settings 显式声明的（不声明 = 零成本）。 */
export const DEFAULT_AUTO_CHECK_MODE: AutoCheckMode = "on";

/** 解析检查模式（非法值回退默认）。 */
export function parseAutoCheckMode(raw: unknown): AutoCheckMode {
  if (typeof raw !== "string") return DEFAULT_AUTO_CHECK_MODE;
  const v = raw.trim().toLowerCase();
  if (v === "off" || v === "false") return "off";
  if (v === "on+manual" || v === "on_manual" || v === "manual") return "on+manual";
  return "on";
}

/** 读项目声明的检查（宽松解析——坏条目跳过，不抛）。 */
export async function readDeclaredChecks(cwd: string): Promise<DeclaredCheck[]> {
  const raw = await readProjectSetting<unknown>(cwd, "pt.checks");
  if (!Array.isArray(raw)) return [];
  const out: DeclaredCheck[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const probe = typeof o.probe === "string" ? o.probe.trim() : "";
    if (!probe) continue;
    const params: Record<string, string> = {};
    if (o.params && typeof o.params === "object") {
      for (const [k, v] of Object.entries(o.params as Record<string, unknown>)) {
        if (typeof v === "string") params[k] = v;
      }
    }
    const when: CheckWhen = o.when === "session_end" ? "session_end" : "agent_settled";
    out.push({ probe, params, when });
  }
  return out;
}

/** 从 manual 文档内容里收集 step 的 observe 探针名。
 *  格式：step 子项行 `  - 验证参照：probe1, probe2`（manual-writeback 的同一约定）。 */
export function collectManualObserveProbes(content: string): string[] {
  const out: string[] = [];
  for (const line of content.split("\n")) {
    const m = line.match(/^ {2}- 验证参照：(.+)$/);
    if (!m) continue;
    for (const name of (m[1] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)) {
      if (!out.includes(name)) out.push(name);
    }
  }
  return out;
}

/** 读 manual 文件里的 observe 探针（读失败 → 空）。 */
export async function readManualObserveProbes(manualPath: string): Promise<string[]> {
  try {
    return collectManualObserveProbes(await readFile(manualPath, "utf8"));
  } catch {
    return [];
  }
}

/** 单条检查的执行结果。 */
export interface CheckRunResult {
  probe: string;
  when: CheckWhen;
  outcome: ProbeOutcome["outcome"];
  message: string;
  actual?: string;
}

/** 执行一组检查（去重：同探针 + 同参数只跑一次——不同参数的同名探针是不同检查）。
 *  任一探针抛错不中断整组（runVerify 内部已兜底为 INCONCLUSIVE）。 */
export async function runChecks(cwd: string, checks: DeclaredCheck[]): Promise<CheckRunResult[]> {
  const seen = new Set<string>();
  const results: CheckRunResult[] = [];
  for (const c of checks) {
    const key = `${c.probe}::${JSON.stringify(c.params ?? {})}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const r = await runVerify(cwd, c.probe, c.params ?? {});
    results.push({
      probe: c.probe,
      when: c.when ?? "agent_settled",
      outcome: r.outcome,
      message: r.message,
      actual: r.actual,
    });
  }
  return results;
}

/** 主动检查需要的最小 ctx（不绑 Pi 完整 API，便于测试）。 */
export interface AutoCheckCtx {
  cwd: string;
  ui?: { notify?: (msg: string, level: "info" | "warning" | "error") => void };
}

/** 跑本会话在指定时机的自动检查。
 *
 *  - 模式开关：settings `pt.auto-checks`（off | on | on+manual；默认 on）
 *  - 检查来源：settings `pt.checks` 声明 +（on+manual 时）activeManual 的 step observe 探针
 *  - 结果：DEVIATED → notify(warning) + 日志；其余只记日志
 *  - 命中 activeManual 的 observe → 写回 manual（复用 manual-writeback 的 writeProbeResult）
 */
export async function runAutoChecks(
  ctx: AutoCheckCtx,
  sessionId: string,
  when: CheckWhen,
  log?: (msg: string, ctx?: Record<string, unknown>) => void
): Promise<CheckRunResult[]> {
  const mode: AutoCheckMode = parseAutoCheckMode(
    await readProjectSetting<string>(ctx.cwd, "pt.auto-checks")
  );
  if (mode === "off") return [];

  const declared = await readDeclaredChecks(ctx.cwd);
  const checks: DeclaredCheck[] = declared.filter((c) => (c.when ?? "agent_settled") === when);

  if (mode === "on+manual") {
    const s = getSessionById(sessionId);
    const manualPath = s.activeManual?.filePath;
    if (manualPath) {
      for (const probe of await readManualObserveProbes(manualPath)) {
        if (!checks.some((c) => c.probe === probe)) {
          checks.push({ probe, when });
        }
      }
    }
  }

  if (checks.length === 0) return [];

  const results = await runChecks(ctx.cwd, checks);
  const s = getSessionById(sessionId);
  for (const r of results) {
    log?.("check:run", {
      probe: r.probe,
      when: r.when,
      outcome: r.outcome,
      message: r.message,
    });
    // 写回 manual（命中 step observe 时）
    if (s.activeManual) {
      try {
        const filePath = s.activeManual.filePath;
        const before = await readFile(filePath, "utf8");
        const wb = writeProbeResult(before, r.probe, r.outcome, r.message);
        if (wb.changed) await writeFile(filePath, wb.content, "utf8");
      } catch (e) {
        log?.("check:writeback failed", { probe: r.probe, err: errMsg(e) });
      }
    }
    if (r.outcome === "DEVIATED") {
      ctx.ui?.notify?.(
        `⚠ Pt 自动检查未通过：${r.probe} — ${r.message}${r.actual ? `\n${r.actual}` : ""}`,
        "warning"
      );
    }
  }
  return results;
}
