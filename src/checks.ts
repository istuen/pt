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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile, writeFile } from "node:fs/promises";
import { readProjectSetting } from "./config.js";
import { MOD_CHECKLISTS, MOD_RULES } from "./constants.js";
import type { MinimalSessionManager } from "./turn-output.js";
import { runVerify } from "./verify/index.js";
import { getSessionById } from "./session.js";
import { writeProbeResult } from "./manual-writeback.js";
import { errMsg } from "./diagnostics.js";
import type { Checklist, Domain, ProbeOutcome, Rule } from "./schema.js";

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

/** 检查失败回注给模型（v19，issue pt-asset-verifiable-norm）。
 *
 *  目的：把闭环从"通知人"扩到"**模型自己知道没通过**"——检查失败的信息进入下一轮的
 *  systemPrompt，模型有机会自我修正（而不是等人来告诉它）。
 *
 *  数据流：
 *   agent_settled 跑完检查 → DEVIATED 的失败项落 session JSONL（跨进程可恢复）
 *   → 下一轮 before_agent_start 把失败摘要作为独立 H2 段注入 → 注入后清空
 *   → 若模型修好了，下一次检查通过 → 失败列表空 → 不再注入
 *   （失败持续存在 → 每轮都会重新检查、重新通知 → 形成自我修正循环，不是一锤子买卖）
 */

/** session JSONL 中持久化检查失败的 custom entry customType。 */
export const PT_CHECK_FAILURES_ENTRY = "pt:check-failures";

/** 单条检查失败。 */
export interface CheckFailure {
  probe: string;
  message: string;
  actual?: string;
}

/** 回注段最多列几条失败。 */
export const MAX_CHECK_FAILURES = 3;
/** 单条失败消息截断长度。 */
export const MAX_FAILURE_MESSAGE = 200;

/** 把检查结果里的 DEVIATED 转成失败项（INCONCLUSIVE 不算失败——无法判定 ≠ 违反）。 */
export function toCheckFailures(results: CheckRunResult[]): CheckFailure[] {
  return results
    .filter((r) => r.outcome === "DEVIATED")
    .map((r) => ({
      probe: r.probe,
      message: r.message.slice(0, MAX_FAILURE_MESSAGE),
      actual: r.actual?.slice(0, MAX_FAILURE_MESSAGE),
    }));
}

/** 读 session JSONL 里的待回注失败项。 */
export function readCheckFailures(
  sessionManager: MinimalSessionManager | undefined
): CheckFailure[] {
  if (!sessionManager) return [];
  try {
    const entries = sessionManager.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e?.type !== "custom" || e.customType !== PT_CHECK_FAILURES_ENTRY) continue;
      const data = (e as { data?: unknown }).data;
      if (!data || typeof data !== "object") continue;
      const list = (data as { failures?: unknown }).failures;
      if (!Array.isArray(list)) continue;
      return list
        .filter((x): x is CheckFailure => !!x && typeof x === "object")
        .map((x) => ({
          probe: typeof x.probe === "string" ? x.probe : "",
          message: typeof x.message === "string" ? x.message : "",
          actual: typeof x.actual === "string" ? x.actual : undefined,
        }))
        .filter((x) => x.probe !== "");
    }
  } catch {
    // SessionManager 异常 → 静默
  }
  return [];
}

/** 把待回注失败项写入 session JSONL（失败静默——不阻塞主流程）。 */
export function persistCheckFailures(pi: ExtensionAPI, failures: CheckFailure[]): void {
  try {
    if (typeof pi.appendEntry !== "function") return;
    pi.appendEntry(PT_CHECK_FAILURES_ENTRY, { failures });
  } catch (e) {
    console.warn(`[pt] persistCheckFailures failed:`, { err: errMsg(e) });
  }
}

/** 渲染失败回注段（无失败 → undefined，调用方不注入）。
 *
 * ```
 * ## 检查未通过（Pt 自动检查）
 *
 * - lint-check: lint 失败: npm run lint
 *   修好后重跑（下次仍会检查）
 * ```
 */
export function renderCheckFailureSegment(failures: CheckFailure[]): string | undefined {
  if (failures.length === 0) return undefined;
  const lines: string[] = ["## 检查未通过（Pt 自动检查）", ""];
  for (const f of failures.slice(0, MAX_CHECK_FAILURES)) {
    lines.push(`- ${f.probe}: ${f.message}`);
    if (f.actual) lines.push(`  ${f.actual.split("\n")[0] ?? ""}`);
  }
  if (failures.length > MAX_CHECK_FAILURES) {
    lines.push(`- …另有 ${failures.length - MAX_CHECK_FAILURES} 项未列出`);
  }
  lines.push("- 这些检查由 Pt 主动执行（不是模型自报）——修好后会自动重查");
  return lines.join("\n");
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

/** 从 Domain IR 收集规范项的检查绑定（A1）。
 *  - `observe: [probe…]` → 无参探针
 *  - `checks: {probe, params}` → 带参探针
 *  同一探针 + 同参数只保留一份。 */
export function collectDomainNormChecks(domain: Domain): DeclaredCheck[] {
  const out: DeclaredCheck[] = [];
  const seen = new Set<string>();
  const push = (c: DeclaredCheck) => {
    const key = `${c.probe}::${JSON.stringify(c.params ?? {})}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(c);
  };
  const modules = (domain.modules ?? {}) as Record<string, unknown>;
  const rules = Array.isArray(modules[MOD_RULES]) ? (modules[MOD_RULES] as Rule[]) : [];
  const checklists = Array.isArray(modules[MOD_CHECKLISTS])
    ? (modules[MOD_CHECKLISTS] as Checklist[])
    : [];
  for (const item of [...rules, ...checklists]) {
    for (const probe of item.observe ?? []) push({ probe });
    for (const c of item.checks ?? []) push({ probe: c.probe, params: c.params });
  }
  return out;
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

  // v19（A1）：规范项自带的检查绑定（归属 S2）——
  //   只验**本 session 已注入过**的 domain（没查过的手册不用验）。
  //   domain 名来自 B3 记录的 pt_inject 调用；Domain IR 来自 active profile 的 cachedDomains。
  const s = getSessionById(sessionId);
  const injected = new Set(s.turnOutputs.flatMap((o) => o.domains));
  for (const d of s.cachedDomains ?? []) {
    if (!injected.has(d.name)) continue;
    for (const c of collectDomainNormChecks(d)) {
      if (!checks.some((x) => x.probe === c.probe)) checks.push({ ...c, when });
    }
  }

  if (mode === "on+manual") {
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
