// src/commands/pt-profile.ts
// /pt-profile 命令：即时切换 Profile。
// 从 index.ts 抽出（Step 5），逻辑零变更。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PROFILES_DIR } from "../constants.js";
import { formatProfileLabels, listProfiles, listProfilesWithTagline } from "../config.js";
import { getSessionById } from "../session.js";
import { getSessionIdFromCtx, switchProfile } from "../shared/session-helpers.js";

/** 注册 /pt-profile 命令。从 index.ts 抽出，逻辑零变更。 */
export function registerPtProfileCommand(pi: ExtensionAPI): void {
  // ========== /pt-profile 命令：即时切换 ==========
  // Phase term-P2：/pt-context → /pt-profile（命令参数是 Profile 名，名该匹配操作目标）。
  pi.registerCommand("pt-profile", {
    description:
      "切换当前 Profile（装配成 AgentContext 注入 Session Inject），即时重转译（无参则弹出选择器）",
    getArgumentCompletions: async (prefix) => {
      const sessionId = getSessionIdFromCtx({
        sessionManager: undefined,
      });
      const cwd = (sessionId && getSessionById(sessionId).lastCwd) || process.cwd(); // Q1 修复：fallback 到 process.cwd()
      const names = await listProfiles(cwd);
      const items = names.map((n) => ({ value: n, label: n }));
      const hit = items.filter((i) => i.value.startsWith(prefix));
      return hit.length > 0 ? hit : null;
    },
    handler: async (args, ctx) => {
      const name = args.trim();
      if (!name) {
        const names = await listProfiles(ctx.cwd);
        if (names.length === 0) {
          ctx.ui.notify(`未找到任何 Profile（${PROFILES_DIR}/*.profile.md）`, "warning");
          return;
        }
        if (!ctx.hasUI) {
          ctx.ui.notify("/pt-profile（无参）在非交互模式不可用，请指定名称", "warning");
          return;
        }
        // v14.x（tagline）：选择器展示 `name — tagline`，返回 label → 反查 name 走 switchProfile
        const profiles = await listProfilesWithTagline(ctx.cwd);
        const labels = formatProfileLabels(profiles);
        const pickedLabel = await ctx.ui.select("选择 Profile", labels);
        if (!pickedLabel) return;
        // 反查：精确匹配 profile 的 label 拿 name；fallback 到 split " — " 取首段（防格式漂移）
        const matched = profiles.find((p) => formatProfileLabels([p])[0] === pickedLabel);
        const picked = matched?.name ?? pickedLabel.split(" — ")[0] ?? pickedLabel;
        await switchProfile(pi, ctx, picked);
        return;
      }
      await switchProfile(pi, ctx, name);
    },
  });
}
