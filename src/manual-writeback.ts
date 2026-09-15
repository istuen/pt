// src/manual-writeback.ts — pt_verify 结果自动写回 manual 实例（纯函数内核）
//
// v15.x（issue pt-verify-result-not-written-back-to-manual）：
// pt_verify tool 跑完 probe 后，自动把结果写回 activeManual 文件的 ## 执行状态 表。
// 闭环不靠 LLM 自觉——与 pt-collab.md 的 acceptance 原则一致。
//
// 设计要点：
// - probe ↔ step 映射：按 FlowStep.observe 列表匹配 probe 名（首个匹配）
// - 多 observe 同步：frontmatter 注释维护已完成 probe 列表；该 step 全部 observe 都
//   完成时 checklist `- [ ]` → `- [x]`
// - 写回幂等：同一 probe 跑两次 → 用最新 outcome/message 覆盖原行
// - 纯函数：writeProbeResult 只改字符串，不碰 IO；IO 由 caller 包 withFileMutationQueue
//
// 边界纪律：
// - 不动 parseManualProgress / renderManualWidgetLines / renderManualFooterSuffix
//   （manual-track.ts 保持纯解析语义，写回是上层职责）
// - 不依赖 ExtensionAPI，可单测
// - manual 实例文件不是 Pt 资产（不是 Domain/Blueprint/Profile）→ 不进 parse/ 层

import type { ProbeOutcomeKind } from "./schema.js";

/** findStepForProbe 返回结构（probe 命中的 step 信息） */
export interface StepMatch {
  /** step 的 1-indexed 编号（对应 manual 文件 ## 执行状态 表的行号） */
  stepIndex: number;
  /** step 的 desc 文本（去 "- [ ] " 前缀） */
  desc: string;
  /** step 的 observe 列表（来自 `  - 验证参照：xxx, yyy` 行） */
  observeNames: string[];
}

/** writeProbeResult 返回结构 */
export interface WritebackResult {
  /** 匹配上的 step 数（0 = probe 名不在任何 step 的 observe 中） */
  matchCount: number;
  /** 写回的 step 索引（1-indexed） */
  stepIndexes: number[];
  /** 因全部 observe 完成而勾选 checklist 的 step 索引（1-indexed） */
  checkedSteps: number[];
  /** 改后的文件内容（changed=false 时返回原 content） */
  content: string;
  /** 是否真的改了文件 */
  changed: boolean;
  /** 改后的 completed-probes 列表（含历史 + 本次） */
  completedProbes: string[];
}

/** 从 manual 内容里扫 step + observe，建立 stepIndex → StepMatch 索引。
 *  算法：
 *   1. 逐行扫描：step 行 `^- \[([ x])\] (.+)$` 记录 stepIndex（1-indexed 累计）——兼容已勾选 `- [x]`；
 *      验证参照行 `^  - 验证参照：(.+)$` 关联到上一个 step。
 *   2. step 行格式兼容：`^- \[ \] \d+\. xxx`（旧版 buildManualDoc）也支持（取 \d+ 后内容）。
 *  失败返回空 Map（不含任何 step）。 */
function indexSteps(content: string): Map<number, StepMatch> {
  const out = new Map<number, StepMatch>();
  let stepIndex = 0;
  let lastStep: StepMatch | null = null;
  const lines = content.split("\n");
  for (const line of lines) {
    // step 行：兼容 "- [ ] desc" / "- [x] desc" / "- [ ] N. desc" / "- [x] N. desc"
    // 多轮 writeback 场景下，已勾选 step 必须算入索引（避免后续 step 索引错乱）
    const stepMatch = line.match(/^- \[[ x]\]\s+(?:\d+\.\s+)?(.+)$/);
    if (stepMatch) {
      stepIndex++;
      lastStep = {
        stepIndex,
        desc: (stepMatch[1] ?? "").trim(),
        observeNames: [],
      };
      out.set(stepIndex, lastStep);
      continue;
    }
    // observe 行（紧跟 step 的子项）
    const observeMatch = line.match(/^ {2}- 验证参照：(.+)$/);
    if (observeMatch && lastStep) {
      const names = (observeMatch[1] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      lastStep.observeNames = names;
    }
  }
  return out;
}

/** 从 manual 内容里按 probe 名找匹配的 step。多个 step 有同一 observe 时取首个。
 *  返回 null = probe 名不在任何 step 的 observe 中。 */
export function findStepForProbe(content: string, probeName: string): StepMatch | null {
  if (!probeName) return null;
  const steps = indexSteps(content);
  for (const step of steps.values()) {
    if (step.observeNames.includes(probeName)) {
      return step;
    }
  }
  return null;
}

/** 解析 frontmatter 注释里的 completed probes 列表（pt-verify-completed 行）。
 *  格式：<!-- pt-verify-completed: probe1, probe2, probe3 -->
 *  缺省返空 Set。 */
function parseCompletedProbes(content: string): Set<string> {
  const out = new Set<string>();
  const m = content.match(/<!--\s*pt-verify-completed:\s*([\s\S]*?)\s*-->/);
  if (!m?.[1]) return out;
  for (const name of m[1].split(",")) {
    const trimmed = name.trim();
    if (trimmed.length > 0) out.add(trimmed);
  }
  return out;
}

/** 把 completed probes Set 序列化成 frontmatter 注释行（含前后空格）。
 *  若 Set 为空，返回空字符串（删除注释行时不主动清，由 caller 决定）。 */
function renderCompletedProbes(probes: Set<string>): string {
  if (probes.size === 0) return "";
  const list = [...probes].sort().join(", ");
  return `<!-- pt-verify-completed: ${list} -->`;
}

/** 写回 probe 结果到 manual 文件内容（同步，不读文件）。
 *  - 写执行状态表 `| N | — | |` → `| N | <outcome> | <message> |`
 *  - 改 frontmatter 注释维护 completed probe 列表
 *  - 多 observe 同步：若 step 的全部 observe 都 in 列表 → checklist `- [ ]` → `- [x]`
 *  - 幂等：同一 probe 跑两次 → 用最新覆盖原 message
 *  - 边界：
 *    - 找不到匹配 step → matchCount=0, changed=false（让 caller 走 warn 分支）
 *    - 找不到执行状态表对应行 → 不改（保守：manual 损坏不擅自补） */
export function writeProbeResult(
  content: string,
  probeName: string,
  outcome: ProbeOutcomeKind,
  message: string
): WritebackResult {
  const baseResult: WritebackResult = {
    matchCount: 0,
    stepIndexes: [],
    checkedSteps: [],
    content,
    changed: false,
    completedProbes: [],
  };
  if (!probeName) return baseResult;

  const steps = indexSteps(content);
  if (steps.size === 0) return baseResult;

  const match = findStepForProbe(content, probeName);
  if (!match) return baseResult;
  baseResult.matchCount = 1;
  baseResult.stepIndexes.push(match.stepIndex);

  // 1. 改执行状态表对应行（幂等覆盖：找 `| N | ... |` 任意中间值）
  // `.+` 贪婪匹配到最后一个 ` |$`，覆盖已填行（COMPLETED|DEVIATED|INCONCLUSIVE）。
  let out = content;
  const statusLineRe = new RegExp(`^\\| ${match.stepIndex} \\| .+ \\|$`, "m");
  if (statusLineRe.test(out)) {
    // 转义 message 里的 | 字符（避免破坏 markdown 表格）+ 反斜杠（避免后续正则误判）
    const safeMsg = message.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
    out = out.replace(statusLineRe, `| ${match.stepIndex} | ${outcome} | ${safeMsg} |`);
  }

  // 2. 维护 frontmatter 注释里的 completed probes 列表
  const completed = parseCompletedProbes(out);
  completed.add(probeName);
  baseResult.completedProbes = [...completed];

  // 写回或追加 frontmatter 注释
  const commentRe = /<!--\s*pt-verify-completed:\s*[\s\S]*?-->/;
  const newComment = renderCompletedProbes(completed);
  if (commentRe.test(out)) {
    out = out.replace(commentRe, newComment);
  } else if (newComment) {
    // 追加到 frontmatter 后空行（frontmatter 后第一个空行）
    const fmEndRe = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/m;
    const fmMatch = out.match(fmEndRe);
    if (fmMatch?.index !== undefined) {
      const insertAt = fmMatch.index + fmMatch[0].length;
      out = out.slice(0, insertAt) + `\n${newComment}\n` + out.slice(insertAt);
    } else {
      // 无 frontmatter（不应该，但兼容）→ 追加到文件头
      out = `${newComment}\n${out}`;
    }
  }

  // 3. 多 observe 同步：若 step 的全部 observe 都 in completed → checklist 打勾
  const checkedSteps: number[] = [];
  const checklistLines: string[] = []; // [{lineIdx, newLine}] 延迟到循环外统一 replace
  const lines = out.split("\n");
  // 复用 indexSteps 但要在已更新的 out 里重新解析（completed 变了不影响 step 索引）
  const freshSteps = indexSteps(out);
  for (const [idx, step] of freshSteps) {
    if (step.observeNames.length === 0) continue;
    const allCompleted = step.observeNames.every((n) => completed.has(n));
    if (!allCompleted) continue;
    // 找该 step 对应的 checklist 行（兼容已勾选 - [x]）
    let stepLineIdx = -1;
    let lineNum = 0;
    let sIdx = 0;
    for (const line of lines) {
      if (line.match(/^- \[[ x]\]\s+(?:\d+\.\s+)?.+$/)) {
        sIdx++;
        if (sIdx === idx) {
          stepLineIdx = lineNum;
          break;
        }
      }
      lineNum++;
    }
    if (stepLineIdx === -1) continue;
    const oldLine = lines[stepLineIdx];
    if (oldLine === undefined) continue;
    const newLine = oldLine.replace(/^- \[ \]/, "- [x]");
    if (newLine !== oldLine) {
      lines[stepLineIdx] = newLine;
      checkedSteps.push(idx);
    }
  }
  if (checkedSteps.length > 0) {
    out = lines.join("\n");
    baseResult.checkedSteps = checkedSteps;
  }

  baseResult.content = out;
  baseResult.changed = out !== content;
  return baseResult;
}
