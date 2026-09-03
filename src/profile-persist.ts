// src/profile-persist.ts — Session JSONL profile 持久化（P1.4 抽出）
//
// v10.x：用 pi.appendEntry() 把 activeProfile 写到 session JSONL。
//  - 读：反向遍历 entries，取最后一个 pt:active-profile（最新覆盖前一次）。
//  - 写：appendEntry，失败静默（ephemeral session / 旧版 pi 无此 API）。
//
//  MinimalSessionManager 是 session JSONL 通用接口的最小子集（profile + manual 持久化共用）。
//  P1 范围内放这里；未来 contract/ 迁移（P2+）时可考虑抽到 src/contract/。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { errMsg } from "./diagnostics.js";

/** session JSONL 通用接口的最小子集（结构类型，不用 ReadonlySessionManager——不在 pi 包顶层 export）。 */
export interface MinimalSessionManager {
  getEntries(): Array<{ type: string; customType?: string; data?: unknown }>;
}

/** session JSONL 中持久化 activeProfile 的 custom entry customType。
 *  用 `pt:` 命名空间避免污染 pi 通用命名空间。 */
export const PT_PROFILE_ENTRY = "pt:active-profile";

/** 从 session JSONL 读上次保存的 profile。
 *  - 反向遍历 entries，取最后一个 `pt:active-profile`（最新一次切换覆盖前一次）。
 *  - 静默 fallback：SessionManager 不可用 / ephemeral session / entry 损坏 → 返 undefined。
 *  - 不校验 profile 是否仍存在于 assets——校验留给 transpileActive（transpile 失败会被 session_start catch）。
 *  - 用结构类型而非 `ReadonlySessionManager`（该类型不在 pi 包顶层 export.d.ts 里）。 */
export function readProfileFromSession(sessionManager: MinimalSessionManager): string | undefined {
  try {
    const entries = sessionManager.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e && e.type === "custom" && e.customType === PT_PROFILE_ENTRY) {
        const data = (e as { data?: unknown }).data;
        if (data && typeof data === "object") {
          const profile = (data as { profile?: unknown }).profile;
          if (typeof profile === "string" && profile.trim()) {
            return profile.trim();
          }
        }
      }
    }
  } catch {
    // SessionManager 异常（如不存在 / 旧版 pi）→ 静默
  }
  return undefined;
}

/** 把当前 activeProfile 写入 session JSONL（Pi 自带持久化）。
 *  - 用 `pi.appendEntry()`（dist/core/extensions/types.d.ts:78 官方 API）。
 *  - 失败静默（ephemeral session / 旧版 pi 无此 API）——内存中 activeProfile 仍可用本进程。 */
export function persistProfileToSession(pi: ExtensionAPI, name: string): void {
  try {
    if (typeof pi.appendEntry !== "function") return;
    pi.appendEntry(PT_PROFILE_ENTRY, { profile: name });
  } catch (e) {
    // P1.4 边界：slog 是 index.ts 本地函数，profile-persist 不反向依赖 index。
    // 直接 console.warn 兜底（与 slog 行为一致）。未来抽 log 工具时统一接入。
    console.warn(`[pt] persistProfileToSession failed:`, { profileName: name, err: errMsg(e) });
  }
}
