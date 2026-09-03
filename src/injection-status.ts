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

import type { InjectionState } from "./session.js";

/** 把 InjectionState × profile × error 渲染为 footer 文本。
 *  - profile=null  → "pt: 无 context"
 *  - 其它          → "pt: <profile> <state-suffix>"（failed 时追加 ": <error 前 40 字>"） */
export function renderInjectionFooter(
  state: InjectionState,
  profile: string | null,
  error: string | null
): string {
  if (profile === null) {
    // 无激活 profile：只在 idle 出现（其它状态必先有 profile）
    return "pt: 无 context";
  }
  switch (state) {
    case "idle":
      return `pt: ${profile} idle`;
    case "pending":
      return `pt: ${profile} pending`;
    case "injected":
      return `pt: ${profile} ok`;
    case "failed": {
      const truncated = error ? truncate(error, 40) : "unknown";
      return `pt: ${profile} failed: ${truncated}`;
    }
  }
}

/** 把字符串截断到 N 字符（用 Array.from 避免 surrogate pair 切坏 emoji）。 */
function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  // 防止切到 surrogate pair 中间
  const arr = Array.from(s);
  if (arr.length <= n) return s;
  return `${arr.slice(0, n).join("")}...`;
}
