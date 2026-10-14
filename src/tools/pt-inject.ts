// src/tools/pt-inject.ts
// pt_inject tool：user message 注入（transform，无副作用）。
// 从 index.ts 抽出（Step 7），逻辑零变更。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getSessionById } from "../session.js";
import { renderTurnInject } from "../render/turn-inject.js";
import { filterDomainsByProfile } from "../schema.js";
import { persistLastTurnRef } from "../manual-session.js";
import { getSessionIdFromCtx } from "../shared/session-helpers.js";

/** 注册 pt_inject tool。从 index.ts 抽出，逻辑零变更。 */
export function registerPtInjectTool(pi: ExtensionAPI): void {
  // 根基 3：user message 注入（transform，无副作用）
  //   等价原 pt_turn_inject tool；execute 调 renderTurnInject 走统一内核。
  //   renderTurnInject 内部仍按 `/pt_turn_inject <target>` 字符串前缀解析（tool execute 拼前缀传入）——
  //   内部耦合保留，issue §边界纪律（不在本 scope 解耦）。
  pi.registerTool({
    name: "pt_inject",
    label: "Pt Inject",
    description:
      "Inject TurnContext (compiled manual detail) for a Domain on demand. " +
      "Returns the Rules/Flows/Checklists content of the Domain. " +
      "Use when reasoning needs a Domain's manual detail referenced in SessionContext's trigger-index. " +
      "Input: domain name (from /pt info /kind=flows output).",
    promptSnippet: "Inject a Domain's TurnContext (manual detail) on demand",
    promptGuidelines: [
      "Use pt_inject to fetch a Domain's manual detail (Rules/Flows/Checklists) on demand.",
      "Consult SessionContext's trigger-index or /pt info flows to decide which Domain to query.",
    ],
    parameters: Type.Object({
      domain: Type.String({
        description:
          "Domain name to inject, e.g. 'dev-process' or 'pt-quality'. Use /pt info flows to list available domains.",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!getSessionIdFromCtx(ctx)) {
        return {
          content: [{ type: "text", text: "no session" }],
          details: { error: "no session" },
        };
      }
      const s = getSessionById(getSessionIdFromCtx(ctx) as string);
      if (
        !s.cachedBundles ||
        s.cachedBundles.length === 0 ||
        !s.cachedAgentContext ||
        !s.cachedBlueprint
      ) {
        return {
          content: [{ type: "text", text: "无激活 Profile，先用 /pt-profile 激活" }],
          details: { error: "no active profile" },
        };
      }
      const scoped = filterDomainsByProfile(s.cachedBundles[0].domains, s.cachedProfile);
      // 内部耦合：renderTurnInject 按 `/pt_turn_inject <target>` 前缀解析
      // 保留该耦合（issue §边界纪律）——后续 issue 解耦
      const content = renderTurnInject(
        s.cachedAgentContext,
        s.cachedBlueprint,
        scoped,
        s.cachedProfile,
        `/pt_turn_inject ${params.domain}`
      );
      if (content === null) {
        return {
          content: [
            {
              type: "text",
              text: `未找到 Domain 或无手册段: ${params.domain}（用 /pt info flows 查可用手册）`,
            },
          ],
          details: { error: "not found", domain: params.domain },
        };
      }
      // v18.x（决策 6）：记录 compaction 重注入线索——TurnContext domain 名
      s.lastTurnRef = {
        turnInjectDomain: params.domain,
        manualPath: s.lastTurnRef?.manualPath ?? null,
      };
      persistLastTurnRef(pi, s.lastTurnRef);
      return { content: [{ type: "text", text: content }], details: { domain: params.domain } };
    },
  });
}
