// src/injection-status.ts — pt 注入状态检测（纯函数内核）
//
// 配套 .pt/docs/designs/pt-injection-status-manual-track.md §2.3：
//   - footer 文本由 InjectionState × profile 决定
//   - 自报（PiAdapter before_agent_start 三分支写 session.injectionState）
//   - 不依赖 ExtensionAPI，可单测
//
// 边界纪律：
//   - 不检测 Pi 的 system prompt——自报更准（ctx.getSystemPrompt() 不含注入后内容）
//   - 不存进度——进度从 manual 实例文件 parse（见 manual-track.ts）
//
// v14.x（issue pt-asset-migration-visibility Layer 2 修复）：
//   - renderInjectionFooter 加 healthIssueCount 参数 → footer 末尾追加 "⚠ N issue(s)"
//   - useColor() 检测 TTY → TUI 用 ANSI 颜色（状态染色），web 用纯文本 + ⚠ 前缀
//   - pi 的 ui.setStatus 不支持 level 参数，ANSI 烧在 text 字段里
//   - back-compat：healthIssueCount 默认 0，旧 call site 行为不变

import type { InjectionState } from "./session.js";

/** ANSI 转义码集合。烧进 setStatus text 字段，让 TUI 渲染颜色。 */
const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[90m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  bold: "\x1b[1m",
} as const;

/** TTY 检测：TUI 模式 stdout 是 TTY（颜色可用）；web 模式 stdout 通常被 pipe（颜色退化为乱码）。
 *  加 isTTY 检查避免 web 下输出 "[31m..." 字面量。 */
function useColor(): boolean {
  return process.stdout?.isTTY === true;
}

/** 把字符串截断到 N 字符（用 Array.from 避免 surrogate pair 切坏 emoji）。
 *  v14.x（tagline）：footer 超长 tagline 裁短用。 */
function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  // 防止切到 surrogate pair 中间
  const arr = Array.from(s);
  if (arr.length <= n) return s;
  return `${arr.slice(0, n).join("")}...`;
}

/** v14.x（tagline）：对 footer tagline 作脱裁 + separator 拼装。
 *  - 缺省 tagline → 返回 ''（外层拼接到 footer 不变）
 *  - tagline.length ≤ maxLen → 原样
 *  - tagline.length > maxLen → 裁到 maxLen - 1 + '…'
 *  返回 `: <tagline>` 形式（带 separator），便于直拼。
 *
 *  maxLen 默认 35（与 health suffix 分享 footer 宽度预算）。
 */
export function formatTaglineForFooter(tagline: string | undefined, maxLen: number = 35): string {
  if (!tagline) return "";
  const trimmed = tagline.trim();
  if (!trimmed) return "";
  if (trimmed.length <= maxLen) return `: ${trimmed}`;
  // 超长：本地手动截 codepoints + 1-char ellipsis（`…`）— 避开 truncate() 的 `...` 3-char 形态
  const arr = Array.from(trimmed);
  if (arr.length <= maxLen) return `: ${trimmed}`;
  return `: ${arr.slice(0, maxLen - 1).join("")}…`;
}

/** 颜色模式。
 *  - "auto"（默认）：根据 process.stdout.isTTY 自动判断（TUI 用颜色，web 不用）
 *  - "always"：强制开启 ANSI（手动 debug / 调试 输出场景）
 *  - "never"：  强制关闭 ANSI（CI / pipe / 重定向场景）
 *
 *  v14.x（issue pt-asset-migration-visibility Layer 2）：加 colorMode 让测试与 CLI 可覆盖默认 TTY 检测。
 */
export type ColorMode = "auto" | "always" | "never";

/** 把 InjectionState × profile × error × healthIssueCount × tagline 渲染为 footer 文本。
 *
 *  状态颜色映射：
 *   - injected  → green
 *   - pending   → yellow
 *   - idle      → dim gray
 *   - failed    → red
 *
 *  Health suffix：healthIssueCount > 0 → 末尾追加 ` ⚠ N issue(s)`（emoji 前缀作主视觉信号，颜色补充）
 *
 *  Tagline（v14.x）：profile 名后追加 `: <tagline>`（≤35 字符），超长裁短 + …：
 *   - tagline 缺省 → 不追加（back-compat）
 *   - tagline 存在且短 → `pt: pt-dev: Senior dev + QA + Reviewer (3 agents) ok`
 *   - tagline 超长 → 裁到 34 + '…'
 *
 *  profile=null → "pt: 无 context"（其它状态必先有 profile，统一降级）
 *  failed 时追加 ": <error 前 40 字>"
 *
 *  TUI / Web 兼容：
 *   - TUI（isTTY=true）：状态染色 ANSI + ⚠ 后缀（颜色补充）
 *   - Web（isTTY=false）：纯文本 + ⚠ 前缀（无 ANSI 避免 [31m 字面量）
 *   - colorMode='always'|'never'：覆盖自动检测（调试 / 测试用）
 *
 *  back-compat：healthIssueCount + colorMode + tagline 均有默认值，旧 call site 行为不变。 */
export function renderInjectionFooter(
  state: InjectionState,
  profile: string | null,
  error: string | null,
  healthIssueCount: number = 0,
  colorMode: ColorMode = "auto",
  tagline: string | null = null
): string {
  if (profile === null) {
    return "pt: 无 context";
  }
  // 1. 状态后缀（failed 追加 error，injected 用 "ok"，其它用 state 名）
  //    failed + null error 仍拼 `: unknown`（与 v13 旧版兼容——存在不传 error 的旧 call site）
  let stateSuffix: string;
  if (state === "failed") {
    const errText = error ? truncate(error, 40) : "unknown";
    stateSuffix = ` failed: ${errText}`;
  } else if (state === "injected") {
    stateSuffix = " ok";
  } else {
    stateSuffix = ` ${state}`;
  }

  // 2. Health suffix：⚠ 前缀作主视觉信号（即便无 ANSI 也能看到）
  //    - 0 issue → 不显示
  //    - 1 issue → " ⚠ 1 issue"
  //    - N issue → " ⚠ N issues"
  const healthSuffix =
    healthIssueCount > 0 ? ` ⚠ ${healthIssueCount} issue${healthIssueCount > 1 ? "s" : ""}` : "";

  // 3. v14.x tagline：profile 名后拼 `: <tagline-truncated>`（≤35 字符）
  //    无 tagline 时返空串 → 不影响 back-compat
  const taglineSuffix = formatTaglineForFooter(tagline ?? undefined);

  const baseText = `pt: ${profile}${taglineSuffix}${stateSuffix}${healthSuffix}`;

  // 4. 颜色决策：colorMode 覆盖 TTY 默认检测
  const colorEnabled = colorMode === "always" ? true : colorMode === "never" ? false : useColor();
  if (!colorEnabled) return baseText;

  const colorByState: Record<InjectionState, string> = {
    injected: ANSI.green,
    pending: ANSI.yellow,
    idle: ANSI.dim,
    failed: ANSI.red,
  };
  // health issue 染色优先于 state 颜色（视觉上"严重"更突出）
  if (healthIssueCount > 0) {
    return `${ANSI.red}${ANSI.bold}⚠ ${baseText.replace(/^pt: /, "pt: ")}${ANSI.reset}`;
  }
  return `${colorByState[state]}${baseText}${ANSI.reset}`;
}

/** 把 ANSI 颜色码剥成纯文本（test 工具——便于断言内容而忽略颜色）。 */
export function stripAnsi(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI CSI 序列故意用 ESC 控制符
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}
