// src/manual-track.ts — pt Manual 实例追踪（纯函数内核）
//
// 配套 .pt/docs/designs/pt-injection-status-manual-track.md §2.4 / §2.5：
//   - parseManualProgress：读文件 → 抽 frontmatter → 正则数 checklist
//   - renderManualWidgetLines：3 行 string[] 给 setWidget 用
//   - renderManualFooterSuffix：footer 后缀（"· manual: <procedure> 3/6"）
//   - isManualActive：文件存在 + status !== completed
//
// 边界纪律：
//   - manual 实例文件不是 Pt 资产（不是 Domain/Blueprint/Profile）→ 不进 parse/ 层
//   - 进度（stepDone/stepTotal）不存 session——文件是 single source of truth
//   - 不依赖 ExtensionAPI，可单测

import { access, readFile } from "node:fs/promises";

/** ## 执行状态 表的 Outcome 列规范化为 4 个值之一（其他字符串如 TODO 视为 INCONCLUSIVE）。
 *  - "—"        ：未填写（buildManualDoc 表头初始值）
 *  - "COMPLETED"：执行符合预期
 *  - "DEVIATED" ：偏离预期（不是失败，见 src/schema.ts ProbeOutcomeKind 注释）
 *  - "INCONCLUSIVE"：无法判定（人工评估 / probe 缺参数等） */
export type OutcomeKind = "—" | "COMPLETED" | "DEVIATED" | "INCONCLUSIVE";

/** Manual 实例文件 ## 执行状态 表的某一行（stepIndex + outcome）。
 *  stepIndex 1-indexed（与表行 | N | ... 对齐）。 */
export interface StepOutcome {
  stepIndex: number;
  outcome: OutcomeKind;
}

/** Manual 实例文件 parse 结果。
 *  - procedure：从 frontmatter.procedure 取
 *  - stepDone / stepTotal：实时正则数 "- [x]" / "- [ ]"
 *  - status：frontmatter.status（in-progress / completed）
 *  - nextStep：第一个 "- [ ]" 行去前缀的文本（下一步该做的），无则 null
 *  - stepOutcomes：从 ## 执行状态 表抽的每步 outcome（长度 ≤ stepTotal，缺行视为未完成）
 *  - hasUnfinishedOutcome：任一 outcome 是 "—" 或 "INCONCLUSIVE"（伪完成征兆之一）
 *  - pseudoComplete：status=completed 但有伪完成征兆（stepDone < stepTotal 或 hasUnfinishedOutcome） */
export interface ManualProgress {
  procedure: string;
  stepDone: number;
  stepTotal: number;
  status: string;
  nextStep: string | null;
  stepOutcomes: StepOutcome[];
  hasUnfinishedOutcome: boolean;
  pseudoComplete: boolean;
}

/** 从 manual 实例文件 parse 进度。失败返回 null（容错，不抛）。 */
export async function parseManualProgress(filePath: string): Promise<ManualProgress | null> {
  try {
    const content = await readFile(filePath, "utf8");
    return parseManualProgressFromContent(content);
  } catch {
    // 文件不存在 / 权限不足 / 读取失败
    return null;
  }
}

/** 规范化 Outcome 列字符串到 OutcomeKind。未识别值归 INCONCLUSIVE（保守按未完成处理）。 */
function normalizeOutcome(raw: string): OutcomeKind {
  const trimmed = raw.trim();
  if (trimmed === "—" || trimmed === "-" || trimmed === "") return "—";
  if (trimmed === "COMPLETED") return "COMPLETED";
  if (trimmed === "DEVIATED") return "DEVIATED";
  if (trimmed === "INCONCLUSIVE") return "INCONCLUSIVE";
  return "INCONCLUSIVE";
}

/** 内部：从字符串内容 parse（便于单测 & 未来内联输入）。
 *  算法：
 *   1. frontmatter：取首段 `---` ... `---` 之间的 YAML
 *   2. procedure / status：从 frontmatter 行解析（`key: value` 形式，宽松）
 *   3. checklist：全文正则 `/^- \[([ x])\]\s+(.+)$/gm` 数 done / total
 *   4. nextStep：第一个未完成项的文本（去前缀）
 *   5. stepOutcomes：从 ## 执行状态 段抽 `| N | <outcome> | <message> |` 行
 *   6. hasUnfinishedOutcome：任一 outcome 是 "—" 或 "INCONCLUSIVE"
 *   7. pseudoComplete：status=completed 但 stepDone<stepTotal 或 hasUnfinishedOutcome */
export function parseManualProgressFromContent(content: string): ManualProgress | null {
  const fm = extractFrontmatter(content);
  const procedure = fm?.procedure ?? "(unknown)";
  const status = fm?.status ?? "unknown";

  let stepDone = 0;
  let stepTotal = 0;
  let nextStep: string | null = null;
  // 多行匹配（m 标志），匹配行首 "- [x]" 或 "- [ ]"
  const re = /^- \[([ x])\]\s+(.+)$/gm;
  for (const m of content.matchAll(re)) {
    const checked = m[1] === "x";
    const text = m[2]?.trim() ?? "";
    stepTotal++;
    if (checked) {
      stepDone++;
    } else if (nextStep === null && text) {
      nextStep = text;
    }
  }

  // 5. 抽 ## 执行状态 表的每行 outcome
  const stepOutcomes: StepOutcome[] = [];
  // 表格行格式 `| N | <outcome> | <message> |`，message 列可空（`\s*` 兼容末列前的 0+ 空格）
  const tableRe = /^\| (\d+) \| (.+?) \| [^|]*\s*\|$/gm;
  for (const m of content.matchAll(tableRe)) {
    const idxStr = m[1] ?? "";
    const rawOutcome = m[2] ?? "";
    const idx = Number.parseInt(idxStr, 10);
    if (Number.isFinite(idx) && idx > 0) {
      stepOutcomes.push({
        stepIndex: idx,
        outcome: normalizeOutcome(rawOutcome),
      });
    }
  }

  const hasUnfinishedOutcome = stepOutcomes.some(
    (o) => o.outcome === "—" || o.outcome === "INCONCLUSIVE"
  );
  const pseudoComplete = status === "completed" && (stepDone < stepTotal || hasUnfinishedOutcome);

  return {
    procedure,
    stepDone,
    stepTotal,
    status,
    nextStep,
    stepOutcomes,
    hasUnfinishedOutcome,
    pseudoComplete,
  };
}

/** frontmatter 抽取（极简 YAML：只解 key: value）。 */
interface SimpleFrontmatter {
  procedure?: string;
  status?: string;
}
function extractFrontmatter(content: string): SimpleFrontmatter | null {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m?.[1]) return null;
  const out: SimpleFrontmatter = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([a-zA-Z_-]+)\s*:\s*(.*)$/);
    if (!kv?.[1]) continue;
    const key = kv[1];
    const value = (kv[2] ?? "").trim();
    if (key === "procedure") out.procedure = value;
    else if (key === "status") out.status = value;
  }
  return out;
}

/** widget 渲染：3 行 string[]，给 `ui.setWidget("pt-manual", lines, { placement: "aboveEditor" })` 用。
 *  - 第 1 行：`pt ▶ <procedure>  step <done>/<total>  (<status>)`（completed 加 ` ✓ done`；pseudoComplete 加 `⚠ fake done`）
 *  - 第 2 行：`  next: <nextStep 文本>`（无 nextStep 时该行省略）
 *  - 第 3 行：`  file: <filePath>`
 *  status === completed 时仍显示，但 footer 后缀改 done；widget 撤掉由 caller 决定（见 index.ts refreshManualWidget）。
 *  v15.x（issue pt-manual-completion-check-too-loose）：pseudoComplete 时加 ⚠ 提示用户
 *  （status=completed 但 stepDone<stepTotal 或 hasUnfinishedOutcome → 伪完成）。 */
export function renderManualWidgetLines(filePath: string, p: ManualProgress): string[] {
  let statusText: string;
  if (p.status === "completed") {
    statusText = p.pseudoComplete ? "⚠ fake done" : "✓ done";
  } else {
    statusText = `(${p.status})`;
  }
  const lines: string[] = [];
  lines.push(`pt ▶ ${p.procedure}  step ${p.stepDone}/${p.stepTotal}  ${statusText}`);
  if (p.nextStep && !p.pseudoComplete && p.status !== "completed") {
    lines.push(`  next: ${p.nextStep}`);
  }
  lines.push(`  file: ${filePath}`);
  return lines;
}

/** footer 后缀：有 activeManual 时追加。
 *  - in-progress → `· manual: <procedure> <done>/<total>`
 *  - completed   → `· manual: <procedure> done`
 *  - pseudoComplete（status=completed 但 stepDone<stepTotal 或 hasUnfinishedOutcome）→ `· manual: <procedure> ⚠ fake done` */
export function renderManualFooterSuffix(p: ManualProgress): string {
  if (p.status === "completed") {
    return p.pseudoComplete
      ? `· manual: ${p.procedure} ⚠ fake done`
      : `· manual: ${p.procedure} done`;
  }
  return `· manual: ${p.procedure} ${p.stepDone}/${p.stepTotal}`;
}

/** 检查 manual 实例是否应视为 active（widget 继续显示 + footer 显示）。
 *  v15.x（issue pt-manual-completion-check-too-loose）：硬校验 status=completed 也需 step 全勾 + outcome 非 —/INCONCLUSIVE。
 *  - status !== "completed" → true（active）
 *  - status="completed" 但 stepDone < stepTotal → true（伪完成）
 *  - status="completed" 但 hasUnfinishedOutcome → true（伪完成）
 *  - status="completed" 且 stepDone === stepTotal 且无 —/INCONCLUSIVE → false（真完成） */
export function checkManualCompletion(p: ManualProgress): boolean {
  if (p.status !== "completed") return true;
  if (p.stepDone < p.stepTotal) return true;
  if (p.hasUnfinishedOutcome) return true;
  return false;
}

/** 文件存在 + checkManualCompletion(p) === true。配合 widget/footer 决定要不要展示。
 *  - 用 fs.access 探测存在（轻量，不读全文）
 *  - 真的 parse status 用 parseManualProgress（一次 readFile 取齐）
 *  v15.x：status=completed 时不再直接判 active，需 checkManualCompletion 硬校验 */
export async function isManualActive(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
  } catch {
    return false;
  }
  const p = await parseManualProgress(filePath);
  if (!p) return false;
  return checkManualCompletion(p);
}

/** 浅比较两个 ManualProgress "对外可观察字段"是否相同（用于跳过无变化的 IPC）。
 *  P1：tool_result / turn_end 钩子刷新 widget + footer 前调，避免对同一进度重复发
 *  setWidget / setStatus（IPC 成本 ~3-8ms × 频率 60-120/h）。
 *  比 5 字段：procedure / stepDone / stepTotal / status / nextStep
 *  - 不比 stepOutcomes 数组内容（stepDone/stepTotal 已覆盖可观察变化）
 *  - 不比 pseudoComplete / hasUnfinishedOutcome（派生字段，前 5 字段相同则它们也相同）
 *  - null === null 视为相同（重置场景不会误判为有变化） */
export function manualProgressEqual(a: ManualProgress | null, b: ManualProgress | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.procedure === b.procedure &&
    a.stepDone === b.stepDone &&
    a.stepTotal === b.stepTotal &&
    a.status === b.status &&
    a.nextStep === b.nextStep
  );
}
