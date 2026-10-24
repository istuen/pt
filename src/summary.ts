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

/** session 内累积的汇总数据。
 *
 *  ⚠️ **观测点边界**（规范 `observation-boundary-declared`；issue pt-delivery-chain-verification）：
 *  本结构的每个字段都只是**在 Pt 的观测点**成立的断言，不是端到端事实。逐项边界：
 *
 *  | 字段 | 观测点 | 边界（不保证什么） |
 *  |---|---|---|
 *  | `turns` / `toolCalls` | Pi 事件 | Pi 漏发事件则少计 |
 *  | `ptInjectCalls` | `tool_call` 事件 | 只证明"工具被调用"，**不证明**模型读懂了手册 |
 *  | `filesRead` / `filesModified` | `tool_call` 事件 | 只证明"工具被调用"，不证明文件真被读/写 |
 *  | `checkResults` | 探针进程 | 探针自报结论；不证明 LLM 会遵守它 |
 *  | `injectedChars` / `injectedCount` | `before_agent_start` 返回值 | **只证明 Pt 返回了这个字符串**——不证明 Pi 拼进去、provider 收到 |
 *  | `models` / `systemShas` / `lastSystemSha` | `before_provider_request` payload | **观测点 ≠ 终点**——后续 handler 可改写 payload（见 `injectionMatched` 说明） |
 *  | `injectionMatched` | 同上 | 「观测点一致性」，**非端到端保证** |
 *  | `status` | 上述各项的聚合 | CI 判定的只是**观测点**的健康度 |
 *
 *  端到端验证（"内容真的到了 LLM"）需独立证人：
 *  `scripts/verify-delivery-chain.sh`（三方独立比对 + 物理证据）。 */
export interface SessionSummary {
  /** turn 数（Pi 的 turn 粒度 = 每个工具调用一轮）。 */
  turns: number;
  /** 工具调用总数。 */
  toolCalls: number;
  /** pt_inject 调用（domain + turn）——"查了哪本手册"。
   *  观测点 = `tool_call` 事件——只证明**工具被调用**，不证明模型读懂了手册内容。 */
  ptInjectCalls: Array<{ domain: string; turn: number }>;
  /** 读过的文件（read 的 path）。
   *  观测点 = `tool_call` 事件——只证明**工具被调用**，不证明内容真被读。 */
  filesRead: string[];
  /** 改动过的文件（edit/write 的 path + shell 写入路径）。
   *  观测点 = `tool_call` 事件——只证明**工具被调用**，不证明文件真被写入。 */
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
  /** 注入量（system prompt 增量字符数）累计 + 次数。
   *  观测点 = `before_agent_start` 的返回值——**只证明 Pt 返回了这个字符串**，
   *  不证明 Pi 把它拼进 prompt、provider 收到（见结构级「观测点边界」表）。 */
  injectedChars: number;
  injectedCount: number;
  /** 会话状态（给 CI 判定用）。 */
  status: "ok" | "checks-failed" | "blocked" | "bypassed";

  // ===== v19（Layer 3，issue pt-adoption-observability §五 Layer 3）=====
  // 模型元数据 + 内容到场层证据 + 一致性校验结果。
  // 隐私边界：只记 hash / 计数 / 模型 id，**绝不记 payload 内容**。

  /** LLM 调用次数（每次 provider 请求 +1）。
   *  观测点 = `before_provider_request` 事件——只证明 Pi 走到了发请求这一步。 */
  providerCalls: number;
  /** 本 session 用过的模型 id（去重，顺序 = 首次出现顺序）。
   *  观测点 = `before_provider_request` payload 的 `model` 字段。 */
  models: string[];
  /** 每次调用观测到的系统提示 sha256（去重，顺序 = 首次出现顺序）。
   *  观测点 = `before_provider_request` payload——**观测点 ≠ 终点**
   *  （后续 handler 可改写 payload；provider 实际收到的可能不同）。 */
  systemShas: string[];
  /** 最后一次观测到的系统提示 sha256（null = 还没观测到 / 形状不认识）。
   *  同上：**观测点 ≠ 终点**。 */
  lastSystemSha: string | null;
  /** 注入一致性校验结论（**观测点一致性**，非端到端保证）：
   *  - true  = 在 Pt 观测那一刻，请求体里的段与 Pt 注入的一致
   *  - false = 出现过不一致（观测点看到的内容被改写/截断）
   *  - null  = 校验过但没定位到段（provider 形状不认识 / prompt 被改写）
   *
   *  ⚠️ **不是端到端保证**（issue pt-delivery-chain-verification §三）：
   *  Pi 的 `before_provider_request` handler 按扩展加载顺序串行执行，
   *  **后注册的 handler 能改写 Pt 已经观测过的 payload** → 本字段只证明
   *  「观测点那一刻一致」，**不能**证明 provider 最终收到的是这份内容。
   *  端到端验证需独立证人（`scripts/verify-delivery-chain.sh`）。 */
  injectionMatched: boolean | null;
  /** 不一致次数。 */
  injectionMismatchCount: number;
  /** 没定位到段的次数。 */
  injectionNotFoundCount: number;
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
    // v19（Layer 3）
    providerCalls: 0,
    models: [],
    systemShas: [],
    lastSystemSha: null,
    injectionMatched: null,
    injectionMismatchCount: 0,
    injectionNotFoundCount: 0,
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
