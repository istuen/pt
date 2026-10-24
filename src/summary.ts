// src/summary.ts — per-session 汇总记录（Layer 2，issue pt-adoption-observability §五 Layer 2）
//
// 目的：让**一个 session 成为可分析的一行**——能回答"查了 AND 改了 AND 改的是哪个文件"。
//   这是 G1 漂移诊断的最低要求（文件维度 × 查阅维度可 join）。
//   同时承担 **headless / CI 的结构化摘要**（定夺 ②）：`pi -p` 下 ctx.ui.notify 不渲染，
//   失败信号只落日志 → CI 需要一条机器可读的汇总来判定。
//
// 产出两处（内容相同）：
//   1. session 日志里一条 `pt:session-summary` 记录（NDJSON）
//   2. `.pt/logs/summary.ndjson` 追加一行（跨 session 聚合，CI 一次读全）
//
// 开关：`--pt-observe` flag > settings `pt.observe` > 默认 off（定夺：opt-in，体积成本）。
//   注：一条汇总约数百字节/session，体积成本已很小——默认值是否改为 always-on 待定夺。

import type { ProbeOutcomeKind } from "./schema.js";

/** session 内累积的汇总数据。 */
export interface SessionSummary {
  /** turn 数（Pi 的 turn 粒度 = 每个工具调用一轮）。 */
  turns: number;
  /** 工具调用总数。 */
  toolCalls: number;
  /** pt_inject 调用（domain + turn）——"查了哪本手册"。 */
  ptInjectCalls: Array<{ domain: string; turn: number }>;
  /** 读过的文件（read 的 path）。 */
  filesRead: string[];
  /** 改动过的文件（edit/write 的 path + shell 写入路径）。 */
  filesModified: string[];
  /** 检查结果（探针 + 结论 + 参数摘要——CI 要能定位是哪条失败）。 */
  checkResults: Array<{
    probe: string;
    outcome: ProbeOutcomeKind;
    message?: string;
    /** 参数摘要（probe(key=val)）——同名探针不同参数时用于区分。 */
    label?: string;
  }>;
  /** 硬约束阻断次数（A3）。 */
  blockedCount: number;
  /** bash 绕过硬约束次数（A3 绕过可观测）。 */
  bypassCount: number;
  /** 注入量（system prompt 增量字符数）累计 + 次数。 */
  injectedChars: number;
  injectedCount: number;
  /** 会话状态（给 CI 判定用）。 */
  status: "ok" | "checks-failed" | "blocked" | "bypassed";
}

/** 新的空汇总。 */
export function createSessionSummary(): SessionSummary {
  return {
    turns: 0,
    toolCalls: 0,
    ptInjectCalls: [],
    filesRead: [],
    filesModified: [],
    checkResults: [],
    blockedCount: 0,
    bypassCount: 0,
    injectedChars: 0,
    injectedCount: 0,
    status: "ok",
  };
}

/** 汇总记录的最终形态（进日志 / summary.ndjson）。 */
export interface SessionSummaryRecord extends SessionSummary {
  sessionId: string;
  profile: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationSec: number | null;
  /** 失败检查项（CI 判定用）。 */
  failedChecks: string[];
  /** 唯一化后的改动文件数（CI 判定用）。 */
  filesModifiedCount: number;
}

/** 把累积的汇总 + session 元信息组装成最终记录。 */
export function buildSessionSummaryRecord(
  summary: SessionSummary,
  meta: {
    sessionId: string;
    profile: string | null;
    startedAt: string | null;
    endedAt: string | null;
    durationSec: number | null;
  }
): SessionSummaryRecord {
  const failed = summary.checkResults
    .filter((c) => c.outcome === "DEVIATED")
    .map((c) => c.label ?? c.probe);
  const status: SessionSummaryRecord["status"] =
    summary.blockedCount > 0
      ? "blocked"
      : failed.length > 0
        ? "checks-failed"
        : summary.bypassCount > 0
          ? "bypassed"
          : "ok";
  return {
    ...summary,
    ...meta,
    failedChecks: failed,
    filesModifiedCount: summary.filesModified.length,
    status,
  };
}

// ==================== 汇总落盘 ====================

import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { LOG_DIR } from "./log.js";

/** 汇总文件（跨 session 聚合，CI 一次读全）。 */
export const SUMMARY_FILE = "summary.ndjson";

/** 把汇总记录追加到 `<cwd>/.pt/logs/summary.ndjson`（失败静默——不阻塞 session 收尾）。 */
export async function appendSummaryLine(cwd: string, record: SessionSummaryRecord): Promise<void> {
  try {
    const dir = join(cwd, LOG_DIR);
    await mkdir(dir, { recursive: true });
    await appendFile(join(dir, SUMMARY_FILE), `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // 写不了就算了——主日志里已有同一份记录
  }
}
