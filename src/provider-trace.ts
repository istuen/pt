// src/provider-trace.ts — Layer 3：provider 请求体观测（issue pt-adoption-observability §五 Layer 3）
//
// 目的：闭合 H3 的**内容到场层**——不再靠行为推断"内容到了没"，而是直接观测
//   **真正发给 provider 的请求体**。三个目标：
//   1. SessionContext 真到场的内容 hash（systemSha）——内容到场层的直接证据
//   2. 模型元数据（model id）——排除"换模型导致的漂移"这一混淆因子
//   3. 一致性校验：Pt 注入的段 vs provider 请求体里那段，sha 比对
//
// 事件归属（第三次修正，2026-06-24 勘察实证 183/183）：
//   **唯一 ground truth = `before_provider_request` 的 payload**——它就是真正发给 provider 的请求体。
//   - `provider_stream_event` 拿 model —— ❌ 本 Pi 版本 ExtensionEvent union 里没有该事件
//   - `context` 事件的 messages —— ❌ 不含 system 消息（本 provider 把系统消息放请求体里）
//   - `context_with_system` —— ❌ 同样不含（Pi 在 provider 层组装）
//
// **隐私边界（硬约束）**：绝不记录 payload 内容——只记 hash / 长度 / 键名 / 采样参数。
//   任何进入日志或汇总的字段都必须是数值、hash 或键名枚举。
//
// 边界纪律：
//   - 只消费 Pi 事件，不改 Pi 契约；handler **返回 undefined**（绝不替换 payload）
//   - 不改资产层（parse/compile/render）
//   - provider 形状不认识的 → 记 `shape: "unknown"` + 留空字段，**不崩不抛**

import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getSessionById } from "./session.js";
import { getSessionIdFromCtx } from "./shared/session-helpers.js";

// ==================== 纯函数：抽取器 ====================

/** Pt 注入段的定位标记（与 pi-adapter.ts 的注入格式一致）。
 *  注入格式：`${systemPrompt}\n\n## 当前任务上下文\n\n${segment}`。
 *  段尾 = 下一个 H2 标题（`## ` 开头，行首）——Pt 回注的
 *  `## 上一轮产出（Pt 记录）` / `## 检查未通过（Pt 自动检查）` 都在段之后。 */
export const PT_INJECT_MARKER = "## 当前任务上下文";

/** provider 请求体的形状识别结果。 */
export type ProviderPayloadShape =
  /** 识别到：messages 里有 system/developer 角色消息 */
  | "messages"
  /** 识别到：顶层 system 字段（string 或 content 数组） */
  | "top-level-system"
  /** 识别到：两者都有（顶层 system 优先——它通常是完整系统提示） */
  | "both"
  /** 不认识 */
  | "unknown";

/** 采样参数（机会主义取——provider 不给就留空）。 */
export interface SamplingParams {
  temperature?: number;
  top_p?: number;
  topP?: number;
  seed?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  max_completion_tokens?: number;
  max_tokens?: number;
}

/** 从 provider 请求体抽出的观测结果（**只含 hash / 长度 / 枚举，不含内容**）。 */
export interface ProviderTrace {
  /** 模型 id（payload.model）——null = provider 没给。 */
  model: string | null;
  /** 请求体形状。 */
  shape: ProviderPayloadShape;
  /** 顶层键名（仅键名，不含值）——诊断 payload 结构用。 */
  keys: string[];
  /** 系统消息文本的 sha256（hex）——null = 没定位到系统消息。 */
  systemSha: string | null;
  /** 系统消息文本长度（字符数）。 */
  systemLen: number;
  /** 采样参数（有机会主义取到的才出现）。 */
  sampling?: SamplingParams;
  /** 请求体序列化字节数。 */
  payloadBytes: number;
}

/** sha256（hex）。空串也返回固定 hash（不返回 undefined——避免"空内容"与"无内容"混淆）。 */
export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 内容块数组 → 纯文本（拼所有 text 块的 text）。 */
function contentBlocksToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block);
      continue;
    }
    if (block && typeof block === "object") {
      const b = block as { type?: unknown; text?: unknown };
      if (typeof b.text === "string") parts.push(b.text);
    }
  }
  return parts.join("");
}

/** 角色容忍：system / developer（部分 provider 用 developer 承载系统消息）。 */
const SYSTEM_ROLES = new Set(["system", "developer"]);

/** 从 payload 里定位系统消息文本。
 *  返回 null = 没定位到（provider 形状不认识）。 */
export function extractSystemText(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;

  // ① 顶层 system 字段（OpenAI 兼容的另一种放法）
  const top = p.system;
  if (typeof top === "string" && top.length > 0) return top;
  if (Array.isArray(top)) {
    const t = contentBlocksToText(top);
    if (t.length > 0) return t;
  }

  // ② messages 数组里的 system / developer 角色消息
  const messages = p.messages;
  if (Array.isArray(messages)) {
    for (const m of messages) {
      if (!m || typeof m !== "object") continue;
      const msg = m as { role?: unknown; content?: unknown };
      if (typeof msg.role !== "string" || !SYSTEM_ROLES.has(msg.role)) continue;
      const text = contentBlocksToText(msg.content);
      if (text.length > 0) return text;
    }
  }
  return null;
}

/** 判断 payload 形状。 */
export function detectPayloadShape(payload: unknown): ProviderPayloadShape {
  if (!payload || typeof payload !== "object") return "unknown";
  const p = payload as Record<string, unknown>;
  const hasTop = typeof p.system === "string" || Array.isArray(p.system);
  let hasMessages = false;
  if (Array.isArray(p.messages)) {
    for (const m of p.messages) {
      if (!m || typeof m !== "object") continue;
      const role = (m as { role?: unknown }).role;
      if (typeof role === "string" && SYSTEM_ROLES.has(role)) {
        hasMessages = true;
        break;
      }
    }
  }
  if (hasTop && hasMessages) return "both";
  if (hasTop) return "top-level-system";
  if (hasMessages) return "messages";
  return "unknown";
}

/** 机会主义取采样参数——provider 不给就留空（**温度盲区是 provider 侧事实**）。 */
export function extractSampling(payload: unknown): SamplingParams | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const p = payload as Record<string, unknown>;
  const out: SamplingParams = {};
  const numericKeys: Array<keyof SamplingParams> = [
    "temperature",
    "top_p",
    "topP",
    "seed",
    "presence_penalty",
    "frequency_penalty",
    "max_completion_tokens",
    "max_tokens",
  ];
  for (const k of numericKeys) {
    const v = p[k];
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** 顶层键名（仅键名）。 */
export function extractKeys(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  return Object.keys(payload as Record<string, unknown>).sort();
}

/** 从 provider 请求体抽取全部观测字段（**只含 hash / 长度 / 键名 / 采样参数**）。 */
export function extractProviderTrace(payload: unknown): ProviderTrace {
  const systemText = extractSystemText(payload);
  const shape = detectPayloadShape(payload);
  const sampling = extractSampling(payload);
  let payloadBytes = 0;
  try {
    payloadBytes = Buffer.byteLength(JSON.stringify(payload) ?? "", "utf8");
  } catch {
    // 循环引用等无法序列化的 payload → 字节数留 0（不崩）
    payloadBytes = 0;
  }
  return {
    model:
      typeof (payload as { model?: unknown })?.model === "string"
        ? (payload as { model: string }).model
        : null,
    shape,
    keys: extractKeys(payload),
    systemSha: systemText === null ? null : sha256(systemText),
    systemLen: systemText === null ? 0 : systemText.length,
    ...(sampling ? { sampling } : {}),
    payloadBytes,
  };
}

// ==================== 纯函数：段定位 ====================

/** 从 Pt 侧已知内容提取"注入段"的规范形式。
 *  Pt 注入格式：`${systemPrompt}\n\n## 当前任务上下文\n\n${segment}`，
 *  segment 后面可能跟回注段（`## 上一轮产出（Pt 记录）` / `## 检查未通过（Pt 自动检查）`）。
 *  AgentContext 内部用 H3（`### `）标题，H2（`## `）只出现在 Pt 自己的段边界上——
 *  所以段尾 = 下一个 H2 标题（`^## ` 但不是 `^### `）。
 *  返回裁剪后的段文本（与 locateInjectedSegment 的输出形态一致——可直接比 sha）。 */
export function extractInjectedSegment(content: string): string {
  if (!content) return "";
  const next = content.search(/^## [^#]/m);
  const segment = next >= 0 ? content.slice(0, next) : content;
  return segment.trim();
}

/** 在系统提示文本里定位 Pt 注入的段。
 *  返回 null = 没找到 `## 当前任务上下文` 标记（说明本次请求没有 Pt 注入段）。
 *  段范围 = 标记之后到下一个 H2 标题之前（含尾部空白裁剪）。 */
export function locateInjectedSegment(systemText: string): string | null {
  if (!systemText) return null;
  const markerIdx = systemText.indexOf(PT_INJECT_MARKER);
  if (markerIdx < 0) return null;
  const after = systemText.slice(markerIdx + PT_INJECT_MARKER.length);
  // 标记后可能跟若干空行
  const bodyStart = after.replace(/^\s+/, "");
  const bodyOffset = after.length - bodyStart.length;
  const body = systemText.slice(markerIdx + PT_INJECT_MARKER.length + bodyOffset);
  return extractInjectedSegment(body);
}

// ==================== 一致性校验 ====================

/**
 * 一致性校验：Pt 注入的段 vs provider 请求体里那段。
 *  - `no-expectation`：Pt 本轮没注入（无期望值）——不是错误
 *  - `not-found`：请求体里没定位到段——可能是 provider 改写了 prompt（要报）
 *  - `mismatch`：两段 sha 不同——注入链路被截断/改写（要报）
 *  - `matched`：一致
 *
 * ⚠️ **语义边界（issue pt-delivery-chain-verification §三）**：
 *  本校验发生在 Pi 的 `before_provider_request` 观测点。Pi 的 handler 按扩展加载顺序
 *  串行执行，**后注册的 handler 能改写本 handler 已观测过的 payload** →
 *  `matched` 只证明「观测点那一刻一致」，**不证明 provider 最终收到的是这份内容**。
 *  端到端验证需独立证人：`scripts/verify-delivery-chain.sh`。
 */
/** 一致性校验结果。 */
export interface InjectionCheck {
  /** 校验状态。 */
  status: "matched" | "mismatch" | "not-found" | "no-expectation";
  /** Pt 侧期望的段 sha（null = 本次没注入过，无期望值）。 */
  expectedSha: string | null;
  /** 请求体里定位到的段 sha（null = 没定位到）。 */
  actualSha: string | null;
}

/**
 * 一致性校验：Pt 注入的段 vs provider 请求体里那段。
 *  - `no-expectation`：Pt 本轮没注入（无期望值）——不是错误
 *  - `not-found`：请求体里没定位到段——可能是 provider 改写了 prompt（要报）
 *  - `mismatch`：两段 sha 不同——注入链路被截断/改写（要报）
 *  - `matched`：一致
 */
export function checkInjectionConsistency(
  expectedSegment: string | null,
  systemText: string | null
): InjectionCheck {
  if (expectedSegment === null) {
    return { status: "no-expectation", expectedSha: null, actualSha: null };
  }
  const expectedSha = sha256(expectedSegment);
  if (systemText === null) {
    return { status: "not-found", expectedSha, actualSha: null };
  }
  const located = locateInjectedSegment(systemText);
  if (located === null) {
    return { status: "not-found", expectedSha, actualSha: null };
  }
  const actualSha = sha256(located);
  return {
    status: actualSha === expectedSha ? "matched" : "mismatch",
    expectedSha,
    actualSha,
  };
}

// ==================== Pi 事件注册 ====================

/** 记录一条 provider trace 到 per-session 汇总（Layer 3 字段）。 */
function recordTrace(sessionId: string, trace: ProviderTrace, check: InjectionCheck): void {
  const s = getSessionById(sessionId);
  const sum = s.summary;
  sum.providerCalls += 1;
  if (trace.model && !sum.models.includes(trace.model)) sum.models.push(trace.model);
  if (trace.systemSha && !sum.systemShas.includes(trace.systemSha)) {
    sum.systemShas.push(trace.systemSha);
  }
  // lastSystemSha = 最近一次观测到的系统提示 hash（null = 还没观测到 / 形状不认识）
  sum.lastSystemSha = trace.systemSha;
  // 一致性校验：取**最严重**的一次结论（mismatch > not-found > matched）。
  //   mismatch 一旦出现就不再被覆盖——注入被改写是硬信号，不能被后续的 matched 洗掉。
  if (check.status === "mismatch") {
    sum.injectionMatched = false;
    sum.injectionMismatchCount += 1;
  } else if (check.status === "not-found") {
    if (sum.injectionMatched !== false) sum.injectionMatched = null;
    sum.injectionNotFoundCount += 1;
  } else if (check.status === "matched" && sum.injectionMatched === null) {
    sum.injectionMatched = true;
  }
}

/** 注册 provider 请求体观测 handler（Layer 3）。
 *  handler **返回 undefined**——绝不替换 payload（Pi runner 只在返回值 !== undefined 时才替换）。 */
export function registerProviderTrace(pi: ExtensionAPI): void {
  pi.on("before_provider_request", async (event, ctx) => {
    try {
      const payload = (event as { payload?: unknown })?.payload;
      const trace = extractProviderTrace(payload);
      const sessionId = getSessionIdFromCtx(ctx);
      if (!sessionId) return undefined;

      const s = getSessionById(sessionId);
      // Pt 本轮注入的段（PiAdapter 写入）——用于一致性校验
      const expected = s.lastInjectedSegment;
      const systemText = extractSystemText(payload);
      const check = checkInjectionConsistency(expected, systemText);

      recordTrace(sessionId, trace, check);

      s.logger?.info("provider:trace", {
        model: trace.model,
        shape: trace.shape,
        keys: trace.keys,
        systemSha: trace.systemSha,
        systemLen: trace.systemLen,
        payloadBytes: trace.payloadBytes,
        // 采样参数（机会主义——provider 不给就不出现）
        ...(trace.sampling ? { sampling: trace.sampling } : {}),
        injection: check.status,
        // 不一致才告警（matched 是常态，不刷日志）
        ...(check.status === "mismatch" || check.status === "not-found"
          ? {
              expectedSha: check.expectedSha,
              actualSha: check.actualSha,
            }
          : {}),
      });

      if (check.status === "mismatch" || check.status === "not-found") {
        s.logger?.warn("provider:injection-mismatch", {
          status: check.status,
          expectedSha: check.expectedSha,
          actualSha: check.actualSha,
        });
      }
    } catch (e) {
      // 观测失败绝不影响主流程（不崩不抛）
      const sessionId = getSessionIdFromCtx(ctx);
      if (sessionId) {
        getSessionById(sessionId).logger?.warn("provider:trace failed", {
          err: e instanceof Error ? e.message : String(e),
        });
      }
    }
    // ⚠️ 必须返回 undefined——Pi runner 只在返回值 !== undefined 时替换 payload
    return undefined;
  });
}
