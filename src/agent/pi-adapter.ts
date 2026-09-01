// src/agent/pi-adapter.ts — PiAdapter：封装 Pi Agent 注入机制
//
// Phase 9.6：v9 新增 — AgentAdapter 的 Pi 实现。
//   - system_prompt 注入：api.on("before_agent_start") 每轮追加 segment
//   - context_message 触发：api.on("input") 拦截 /manual:xxx 和 /<flow-name>
//
// Pt 核心只调 AgentAdapter 接口，不直接调 Pi API。加新 Agent 只加 Adapter。
//
// Tech Debt T6: 全用 type guard 收窄，不用 as 断言（pt-quality #1）
// Tech Debt T2: 用 constants 模块名常量（pt-quality #5）

import { AGENT_PI, MOD_MANUAL } from "../constants.js";
import { isFlowTemplateArray, isRuleArray } from "../compile/type-guards.js";
import type {
  AgentAdapter,
  AgentAPI,
  Blueprint,
  Context,
  Domain,
} from "../schema.js";
import { renderContextMessage } from "../render/context-message.js";
import { renderSystemPrompt } from "../render/system-prompt.js";

/** PiAdapter：封装 Pi Agent 的注入机制。 */
export class PiAdapter implements AgentAdapter {
  name = AGENT_PI;
  supportedTargets = ["system_prompt", "context_message"];

  private ctx: Context | null = null;
  private blueprint: Blueprint | null = null;
  private domains: Domain[] = [];
  private segment: string | null = null;

  /** 设置编译产物（transpile 后调）。 */
  setContext(ctx: Context, blueprint: Blueprint, domains: Domain[]): void {
    this.ctx = ctx;
    this.blueprint = blueprint;
    this.domains = domains;
    this.segment = renderSystemPrompt(ctx, blueprint);
  }

  /** 启动时注册：把 Context 注入到 Agent。 */
  registerInject(api: AgentAPI, ctx: Context, blueprint: Blueprint): void {
    const seg = this.segment ?? renderSystemPrompt(ctx, blueprint);

    // system_prompt 注入：每轮追加 segment
    api.on("before_agent_start", async (...args: unknown[]) => {
      if (!seg) return undefined;
      const event = args[0];
      if (!isSystemPromptEvent(event)) return undefined;
      const final = event.systemPrompt + "\n\n## 当前任务上下文\n\n" + seg;
      return { systemPrompt: final };
    });

    // context_message 触发：/manual:xxx + /<flow-name>
    api.on("input", async (...args: unknown[]) => {
      if (!this.ctx || !this.blueprint) return { action: "continue" };
      const event = args[0];
      if (!isInputEvent(event)) return { action: "continue" };
      const result = renderContextMessage(this.ctx, this.blueprint, this.domains, event.text);
      if (result === null) return { action: "continue" };
      return { action: "transform", text: result };
    });
  }

  /** 查询可用手册（/pt flows 用）。
   *  v9：遍历 Blueprint 的 context_message 注入点 → 引用 Domain → 找 FlowTemplate + term 的 Manual Rule。 */
  listManuals(
    _ctx: Context,
    blueprint: Blueprint,
    domains: Domain[],
  ): Array<{ name: string; hint?: string; domain: string }> {
    const flows: Array<{ name: string; hint?: string; domain: string }> = [];

    for (const ip of blueprint.injectionPoints) {
      if (ip.target !== "context_message") continue;
      // ip.modules 是 modName 列表（"Manual"）；domains 是 Profile 注入点引用的 Domain 集
      // 这里用全集 domains 简化——renderContextMessage 也走全集
      for (const d of domains) {
        const manual = d.modules[MOD_MANUAL];
        if (manual === undefined) continue;
        if (d.type === "workflow") {
          if (!isFlowTemplateArray(manual)) continue;
          for (const t of manual) {
            flows.push({ name: t.name, hint: t.argumentHint, domain: d.name });
          }
        } else if (d.type === "term") {
          if (!isRuleArray(manual)) continue;
          // term-Domain 的 Rule[] 作为 /manual:<domain> 暴露
          flows.push({ name: `/manual:${d.name}`, hint: `${manual.length} 条规范`, domain: d.name });
        }
      }
    }

    // 去重（按 name）
    const seen = new Set<string>();
    return flows.filter((f) => {
      const key = `${f.domain}/${f.name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}

// ==================== Pi ExtensionAPI 事件 type guards ====================

function isSystemPromptEvent(x: unknown): x is { systemPrompt: string } {
  return !!x && typeof x === "object" && typeof (x as { systemPrompt?: unknown }).systemPrompt === "string";
}

function isInputEvent(x: unknown): x is { text: string } {
  return !!x && typeof x === "object" && typeof (x as { text?: unknown }).text === "string";
}