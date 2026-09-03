/**
 * 跨层复用的诊断辅助函数。
 *
 * 从 v0.x 起散落在 parse/index.ts / transpile.ts / index.ts 三处，逐字节相同。
 * P0 抽到此处统一来源，避免改动重复。
 */

import type { SourceAdapterContext } from "./schema.js";

/** 把 unknown error 序列化成可读字符串。 */
export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 三通道 fallback: log → notify → console（pt-quality #9 + 自定义细节）。
 *  顺序：log 优先（持久 trace），再 notify（UI 瞬时），最后 console（debug 兜底）。
 *  v10.x：增 details 参数，让 log/UI 用户能看到 structured 上下文。 */
export function reportWarn(
  adapterCtx: SourceAdapterContext | undefined,
  msg: string,
  details?: Record<string, unknown>
): void {
  if (adapterCtx?.log) adapterCtx.log.warn(msg, details);
  if (adapterCtx?.notify) adapterCtx.notify(msg, "warning");
  if (!adapterCtx?.log && !adapterCtx?.notify) console.warn(`[pt] ${msg}`);
}

export function reportError(
  adapterCtx: SourceAdapterContext | undefined,
  msg: string,
  details?: Record<string, unknown>
): void {
  if (adapterCtx?.log) adapterCtx.log.error(msg, details);
  if (adapterCtx?.notify) adapterCtx.notify(msg, "error");
  if (!adapterCtx?.log && !adapterCtx?.notify) console.error(`[pt] ${msg}`);
}
