// src/turn-output.ts — 轮次产出记录与回注（B3：事件驱动回注）
//
// 问题：Pt 编译出的上下文是"输入侧"产物，但 Agent 每轮真正**产出**了什么（改了哪些文件、
// 查了哪本手册、当前在跟哪本手册）没有进入下一轮的上下文——"这一次的输出"没有成为
// "后续的输入"。
//
// 方案（issue pt-asset-verifiable-norm §三 B3）：
//   记录：turn_end 时把本轮产出（文件指针 + 查过的 domain + 活跃手册）经
//         `pi.appendEntry` 落 session JSONL（`pt:turn-output` custom entry）——
//         与 profile 持久化同一套机制，跨进程可恢复。
//   回注：下一轮 before_agent_start 把产出摘要作为独立 H2 段追加到 systemPrompt。
//
// 边界：
//   - 只回注**指针与名称**，不回注内容正文（避免 context 膨胀）。
//   - 体积封顶（文件 ≤ MAX_FILES、domain ≤ MAX_DOMAINS、段长 ≤ MAX_SEGMENT_LEN）。
//   - 无产出 → 不注入（零噪音）。开关：settings `pt.turn-output-inject`（默认 on）。
//   - agent 层扩展，不改 parse/compile（守 inv-renderer-only-extension）。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { errMsg } from "./diagnostics.js";

/** session JSONL 中持久化轮次产出的 custom entry customType。 */
export const PT_TURN_OUTPUT_ENTRY = "pt:turn-output";

/** 单轮产出记录。 */
export interface TurnOutput {
  /** 轮次序号（session 内递增）。 */
  turn: number;
  /** 本轮改动/新建的文件（相对路径，去重、保序）。 */
  files: string[];
  /** 本轮查过的手册 domain（pt_inject 的 domain 参数）。 */
  domains: string[];
  /** 本轮活跃手册的路径（若有）。 */
  manual?: string;
  /** 记录时间（ISO）。 */
  at: string;
}

/** session JSONL 通用接口的最小子集（与 profile-persist 同构）。 */
export interface MinimalSessionManager {
  getEntries(): Array<{ type: string; customType?: string; data?: unknown }>;
}

/** 回注段里最多列几个文件。 */
export const MAX_FILES = 5;
/** 回注段里最多列几个 domain。 */
export const MAX_DOMAINS = 3;
/** 回注段最大字符数（超了截断提示）。 */
export const MAX_SEGMENT_LEN = 400;

/** 从 bash 命令里抽“可能写了文件”的路径（启发式）。
 *
 *  背景：真实 session 里 agent 常用 shell 改文件（`> file` / `>> file` / `sed -i` / `tee`），
 *  而不是走 edit/write 工具——只跟工具会漏掉真实产出。
 *
 *  启发式（保守）：
 *  - 重定向目标：`> path` / `>> path`
 *  - `sed -i` 的目标文件
 *  - `tee` 的目标文件
 *  过滤：`-` 开头（含通配）、`/dev/*`、含 `*` 的（不精确）。
 *  已知误报可能：`echo "a > b"` 这类引号内的重定向符号会被当成写入——
 *  故过滤掉带空格的 token（引号内通常带空格或标点）。
 */
export function extractBashWritePaths(command: string): string[] {
  const out: string[] = [];
  const push = (raw: string | undefined) => {
    if (!raw) return;
    const p = raw.replace(/^["']|["']$/g, "").trim();
    if (!p || p.startsWith("-") || p.startsWith("/dev/") || p.includes("*") || p.includes(" "))
      return;
    if (!out.includes(p)) out.push(p);
  };
  // 重定向：`>> path` / `> path`（前导空白，避免命中 `a->b`）；heredoc `<<` 不算写入目标
  for (const m of command.matchAll(/(?:^|\s)>>?(?!<)\s*([^\s|;&<>"']+)/g)) push(m[1]);
  // sed -i（就地编辑）：表达式常带引号，取命令末尾的文件操作数
  for (const m of command.matchAll(/\bsed\s+-i[^\s]*\s+(.+)$/gm)) {
    const tokens = m[1].trim().split(/\s+/);
    push(tokens[tokens.length - 1]);
  }
  // tee
  for (const m of command.matchAll(/\btee\s+(?:-a\s+)?([^\s|;&]+)/g)) push(m[1]);
  return out;
}

/** 从 session JSONL 读历史轮次产出（旧的在前）。 */
export function readTurnOutputs(sessionManager: MinimalSessionManager | undefined): TurnOutput[] {
  const out: TurnOutput[] = [];
  try {
    const entries = sessionManager?.getEntries() ?? [];
    for (const e of entries) {
      if (e?.type !== "custom" || e.customType !== PT_TURN_OUTPUT_ENTRY) continue;
      const data = (e as { data?: unknown }).data;
      if (!data || typeof data !== "object") continue;
      const d = data as Partial<TurnOutput>;
      out.push({
        turn: typeof d.turn === "number" ? d.turn : out.length + 1,
        files: Array.isArray(d.files)
          ? d.files.filter((x): x is string => typeof x === "string")
          : [],
        domains: Array.isArray(d.domains)
          ? d.domains.filter((x): x is string => typeof x === "string")
          : [],
        manual: typeof d.manual === "string" ? d.manual : undefined,
        at: typeof d.at === "string" ? d.at : "",
      });
    }
  } catch {
    // SessionManager 异常（不存在 / 旧版 pi）→ 静默
  }
  return out;
}

/** 把本轮产出写入 session JSONL（失败静默——不阻塞主流程）。 */
export function persistTurnOutput(pi: ExtensionAPI, output: TurnOutput): void {
  try {
    if (typeof pi.appendEntry !== "function") return;
    pi.appendEntry(PT_TURN_OUTPUT_ENTRY, output);
  } catch (e) {
    console.warn(`[pt] persistTurnOutput failed:`, { err: errMsg(e) });
  }
}

/** 把产出列表渲染成回注段（无产出 → 返 undefined，调用方不注入）。
 *
 * 形态（追加在 systemPrompt 末尾，独立 H2）：
 *
 * ```
 * ## 上一轮产出（Pt 记录）
 *
 * - 涉及文件：src/schema.ts、src/compile/renderer.ts（等 4 个）
 * - 查过手册：pt-quality
 * - 活跃手册：feature-lifecycle
 * ```
 */
export function renderTurnOutputSegment(outputs: TurnOutput[]): string | undefined {
  const files: string[] = [];
  const domains: string[] = [];
  let manual: string | undefined;
  for (const o of outputs) {
    for (const f of o.files) if (!files.includes(f)) files.push(f);
    for (const d of o.domains) if (!domains.includes(d)) domains.push(d);
    if (!manual && o.manual) manual = o.manual;
  }
  if (files.length === 0 && domains.length === 0 && !manual) return undefined;

  const lines: string[] = ["## 上一轮产出（Pt 记录）", ""];
  if (files.length > 0) {
    const shown = files.slice(0, MAX_FILES);
    const more = files.length - shown.length;
    lines.push(`- 涉及文件：${shown.join("、")}${more > 0 ? `（等 ${files.length} 个）` : ""}`);
  }
  if (domains.length > 0) {
    const shown = domains.slice(0, MAX_DOMAINS);
    const more = domains.length - shown.length;
    lines.push(`- 查过手册：${shown.join("、")}${more > 0 ? `（等 ${domains.length} 本）` : ""}`);
  }
  if (manual) lines.push(`- 活跃手册：${manual}`);
  let seg = lines.join("\n");
  if (seg.length > MAX_SEGMENT_LEN) {
    seg = `${seg.slice(0, MAX_SEGMENT_LEN - 1)}…`;
  }
  return seg;
}
