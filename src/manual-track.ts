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

/** Manual 实例文件 parse 结果。
 *  - procedure：从 frontmatter.procedure 取
 *  - stepDone / stepTotal：实时正则数 "- [x]" / "- [ ]"
 *  - status：frontmatter.status（in-progress / completed）
 *  - nextStep：第一个 "- [ ]" 行去前缀的文本（下一步该做的），无则 null */
export interface ManualProgress {
  procedure: string;
  stepDone: number;
  stepTotal: number;
  status: string;
  nextStep: string | null;
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

/** 内部：从字符串内容 parse（便于单测 & 未来内联输入）。
 *  算法：
 *   1. frontmatter：取首段 `---` ... `---` 之间的 YAML
 *   2. procedure / status：从 frontmatter 行解析（`key: value` 形式，宽松）
 *   3. checklist：全文正则 `/^- \[([ x])\]\s+(.+)$/gm` 数 done / total
 *   4. nextStep：第一个未完成项的文本（去前缀） */
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

  return { procedure, stepDone, stepTotal, status, nextStep };
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
 *  - 第 1 行：`pt ▶ <procedure>  step <done>/<total>  (<status>)`（completed 加 ` ✓ done`）
 *  - 第 2 行：`  next: <nextStep 文本>`（无 nextStep 时该行省略）
 *  - 第 3 行：`  file: <filePath>`
 *  status === completed 时仍显示，但 footer 后缀改 done；widget 撤掉由 caller 决定（见 index.ts refreshManualWidget）。 */
export function renderManualWidgetLines(filePath: string, p: ManualProgress): string[] {
  const statusText = p.status === "completed" ? "✓ done" : `(${p.status})`;
  const lines: string[] = [];
  lines.push(`pt ▶ ${p.procedure}  step ${p.stepDone}/${p.stepTotal}  ${statusText}`);
  if (p.nextStep && p.status !== "completed") {
    lines.push(`  next: ${p.nextStep}`);
  }
  lines.push(`  file: ${filePath}`);
  return lines;
}

/** footer 后缀：有 activeManual 时追加。
 *  - in-progress → `· manual: <procedure> <done>/<total>`
 *  - completed   → `· manual: <procedure> done` */
export function renderManualFooterSuffix(p: ManualProgress): string {
  if (p.status === "completed") {
    return `· manual: ${p.procedure} done`;
  }
  return `· manual: ${p.procedure} ${p.stepDone}/${p.stepTotal}`;
}

/** 文件存在 + status !== completed。配合 widget/footer 决定要不要展示。
 *  - 用 fs.access 探测存在（轻量，不读全文）
 *  - 真的 parse status 用 parseManualProgress（一次 readFile 取齐） */
export async function isManualActive(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
  } catch {
    return false;
  }
  const p = await parseManualProgress(filePath);
  return p !== null && p.status !== "completed";
}
