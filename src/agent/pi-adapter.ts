// src/agent/pi-adapter.ts — PiAdapter：封装 Pi Agent 注入机制
//
// Phase 9.6：v9 新增 — AgentAdapter 的 Pi 实现。
//   - system_prompt 注入：api.on("before_agent_start") 每轮追加 segment
//   - context_message 触发：api.on("input") 拦截 /manual:xxx 和 /<flow-name>
//
// Pt 核心只调 AgentAdapter 接口，不直接调 Pi API。加新 Agent 只加 Adapter。

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
  name = "pi";
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
      const event = args[0] as { systemPrompt: string } | undefined;
      if (!seg || !event) return undefined;
      const final = event.systemPrompt + "\n\n## 当前任务上下文\n\n" + seg;
      return { systemPrompt: final };
    });

    // context_message 触发：/manual:xxx + /<flow-name>
    api.on("input", async (...args: unknown[]) => {
      const event = args[0] as { text: string } | undefined;
      if (!event || !this.ctx || !this.blueprint) return { action: "continue" };
      const result = renderContextMessage(this.ctx, this.blueprint, this.domains, event.text);
      if (result === null) return { action: "continue" };
      return { action: "transform", text: result };
    });
  }

  /** 查询可用手册（/pt flows 用）。
   *  v9：遍历 Blueprint 的 context_message 注入点 → 引用 Domain → 找 FlowTemplate + term 的 Manual Rule。 */
  listManuals(
    ctx: Context,
    blueprint: Blueprint,
    domains: Domain[],
  ): Array<{ name: string; hint?: string; domain: string }> {
    const flows: Array<{ name: string; hint?: string; domain: string }> = [];
    void ctx;

    for (const ip of blueprint.injectionPoints) {
      if (ip.target !== "context_message") continue;
      // ip.modules 是 modName 列表（"Manual"）；domains 是 Profile 注入点引用的 Domain 集
      // 这里用全集 domains 简化——renderContextMessage 也走全集
      for (const d of domains) {
        const manual = d.modules["Manual"];
        if (!manual || !Array.isArray(manual)) continue;
        if (d.type === "workflow") {
          for (const t of manual as Array<{ name: string; argumentHint?: string }>) {
            flows.push({ name: t.name, hint: t.argumentHint, domain: d.name });
          }
        } else if (d.type === "term") {
          for (const r of manual as Array<{ name?: string; check: string }>) {
            // term-Domain 的 Rule[] 也作为"手册"暴露——/manual:<domain> 注入该 Domain 全部 Manual
            // 这里用 /manual:<domain> 形式聚合 term-Domain 而非单条 Rule
            if (r.name) flows.push({ name: r.name, hint: r.check, domain: d.name });
          }
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