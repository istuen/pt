// src/agent/pi-adapter.ts — PiAdapter：封装 Pi Agent 注入机制
//
// Phase 9.6：v9 新增 — AgentAdapter 的 Pi 实现。
//   - system_prompt 注入：api.on("before_agent_start") 每轮追加 segment
//   - context_message 触发：api.on("input") 拦截 /manual:xxx 和 /<flow-name>
//   - 这些是 Agent Runtime 层（Pi API），本 Adapter 在该层做 session→system_prompt、turn→context_message 映射
//
// Pt 核心只调 AgentAdapter 接口，不直接调 Pi API。加新 Agent 只加 Adapter。
//
// Tech Debt T6: 全用 type guard 收窄，不用 as 断言（pt-quality #1）
// Tech Debt T2: 用 constants 模块名常量（pt-quality #5）
//
// v12.x（issue pt-session-singleton-pi-web-pollution 修复）：
//   - handler 内部读 `args[1]?.sessionManager?.getSessionId()` 拿 per-session sessionId
//   - 通过 `getSessionById(sessionId)` 拿 per-session SessionState，**不再读 module-level 单例**
//   - 配合 `src/agent/registry.ts` 的 per-pi WeakMap 改造，
//     `this.ctx / this.blueprint / this.domains / this.segment / this.injectedApi` 五个实例字段
//     现在是 per-pi 隔离——其他 session 的 setContext 不会覆盖本 session 的 segment

import { AGENT_PI, MOD_FLOWS, MOD_RULES } from "../constants.js";
import { isFlowTemplateArray, isRuleArray } from "../compile/type-guards.js";
import { renderInjectionFooter } from "../injection-status.js";
import { getSessionById } from "../session.js";
import {
  filterDomainsByProfile,
  type AgentAdapter,
  type AgentAPI,
  type AgentContext,
  type Blueprint,
  type Domain,
  type Profile,
} from "../schema.js";
import { renderTurnInject } from "../render/turn-inject.js";
import { renderSessionInject } from "../render/session-inject.js";

/** v12.x：从 handler 的 args[1] ctx 提取 sessionId。
 *  pi 的 `pi.on(event, handler)` 触发时传 `(event, ctx)` 两个参数；通过 AgentAPI 包装后
 *  handler 拿到 `(...args)`，args[0] = event, args[1] = ctx (ExtensionContext)。 */
function sessionIdFromArgs(args: unknown[]): string | undefined {
  const ctx = args[1] as { sessionManager?: { getSessionId?: () => string } } | undefined;
  return ctx?.sessionManager?.getSessionId?.();
}

/** PiAdapter：封装 Pi Agent 的注入机制。 */
export class PiAdapter implements AgentAdapter {
  name = AGENT_PI;
  /** Phase term-P4.3：保留 Pi API 名 system_prompt/context_message——
   *  这是 AgentAdapter 映射边界声明（Pi 支持哪些 Agent Runtime 层注入位置）。
   *  Blueprint 用 session/turn 语义值（聚合组 inject 字段），Adapter 内部映射到此字段声明的 Pi API 名。 */
  supportedTargets = ["system_prompt", "context_message"];

  private ctx: AgentContext | null = null;
  private blueprint: Blueprint | null = null;
  private domains: Domain[] = [];
  private segment: string | null = null;
  /** 与当前 Pi runtime 的 AgentAPI 绑定；同一 runtime 不重复注册 handler。
   *  v12.x：per-pi 实例字段——`registry.ts` 给每个 pi 一个新 PiAdapter，所以 `injectedApi`
   *  不会被其他 session 覆盖。 */
  private injectedApi: AgentAPI | null = null;
  /** v13.x（issue pt-turn-inject-not-profile-scoped）：当前 Profile——turn 路径 scope 过滤用。 */
  private profile: Profile | null = null;

  /** 设置编译产物（transpile 后调）。v12.x：per-pi 实例字段——本 session 的 segment
   *  不会被其他 session 覆盖。
   *  v13.x（issue pt-turn-inject-not-profile-scoped）：加 profile 参数——turn 路径 scope 过滤用。 */
  setAgentContext(
    ctx: AgentContext,
    blueprint: Blueprint,
    domains: Domain[],
    profile: Profile
  ): void {
    this.ctx = ctx;
    this.blueprint = blueprint;
    this.domains = domains;
    this.profile = profile;
    this.segment = renderSessionInject(ctx, blueprint);
  }

  /** 清除当前 session 的 context；保留当前 runtime 的 handler 绑定。
   *  v12.x：per-pi 实例字段——只清本 session 的状态。 */
  resetInjection(): void {
    this.ctx = null;
    this.blueprint = null;
    this.domains = [];
    this.profile = null;
    this.segment = null;
  }

  /** 启动时注册：把 AgentContext 注入到 Agent。 */
  registerInject(
    api: AgentAPI,
    ctx: AgentContext,
    blueprint: Blueprint,
    domains: Domain[] = this.domains,
    profile: Profile | null = this.profile
  ): void {
    // 先更新状态；同一 runtime 的后续 Profile 切换不能重新注册 handler，
    // 但 handler 会在事件发生时读取最新的 this.segment / this.ctx。
    this.ctx = ctx;
    this.blueprint = blueprint;
    this.domains = domains;
    this.profile = profile;
    this.segment = renderSessionInject(ctx, blueprint);

    if (this.injectedApi === api) {
      api.log?.debug("agent:registerInject skipped (already injected)");
      return;
    }
    this.injectedApi = api;

    // session 注入（inject=session → Pi system_prompt 事件）：每轮追加 segment
    // v10.x：包 try/catch，运行时异常走 api.log.error + ui.notify，不再 swallow
    // v11.x（issue pt-injection-status-manual-track）：三分支写 session.injectionState +
    //   调 api.ui?.setStatus，让 footer 三态文字真实反映注入结果（自报，不检测 Pi）
    // v12.x：从 args[1] ctx 拿 per-session sessionId，写 per-session SessionState
    api.on("before_agent_start", async (...args: unknown[]) => {
      const t0 = Date.now();
      try {
        const sessionId = sessionIdFromArgs(args);
        const sessionState = sessionId ? getSessionById(sessionId) : null;

        const currentSegment = this.segment;
        // v14.x（issue pt-asset-migration-visibility Layer 2）：footer 末尾追加 ⚠ N issues。
        //   从 sessionState.assetHealthIssues 读计数——session_start 已批量体检过。
        const healthCount = sessionState?.assetHealthIssues?.length ?? 0;
        if (!currentSegment) {
          // 无 segment（未加载 Profile / 已被 reset）→ idle
          if (sessionState) {
            sessionState.injectionState = "idle";
            sessionState.injectionError = null;
            api.ui?.setStatus(
              "pt",
              renderInjectionFooter("idle", sessionState.activeProfile, null, healthCount)
            );
          }
          return undefined;
        }
        const event = args[0];
        if (!isSystemPromptEvent(event)) {
          // 事件形状异常：归类为 idle（不视为失败——Pi 可能改了事件签名）
          if (sessionState) {
            sessionState.injectionState = "idle";
            sessionState.injectionError = null;
            api.ui?.setStatus(
              "pt",
              renderInjectionFooter("idle", sessionState.activeProfile, null, healthCount)
            );
          }
          return undefined;
        }
        const final = `${event.systemPrompt}\n\n## 当前任务上下文\n\n${currentSegment}`;
        api.log?.debug("agent:before_agent_start ok", {
          originalLen: event.systemPrompt.length,
          injectedLen: final.length,
          deltaLen: final.length - event.systemPrompt.length,
          durationMs: Date.now() - t0,
        });
        if (sessionState) {
          api.onInjected?.(final);
          // 成功注入 → injected
          sessionState.injectionState = "injected";
          sessionState.injectionError = null;
          api.ui?.setStatus(
            "pt",
            renderInjectionFooter("injected", sessionState.activeProfile, null, healthCount)
          );
        } else {
          api.onInjected?.(final);
        }
        return { systemPrompt: final };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        api.log?.error("agent:before_agent_start failed", {
          err: msg,
          durationMs: Date.now() - t0,
        });
        api.ui?.notify(`[pt] before_agent_start failed: ${msg}`, "error");
        // 异常 → failed + 错误消息（footer 追加）
        const sessionId = sessionIdFromArgs(args);
        const sessionState = sessionId ? getSessionById(sessionId) : null;
        // v14.x：catch 路径同样透传 healthCount（避免修复丢告警）
        const healthCount = sessionState?.assetHealthIssues?.length ?? 0;
        if (sessionState) {
          sessionState.injectionState = "failed";
          sessionState.injectionError = msg;
          api.ui?.setStatus(
            "pt",
            renderInjectionFooter("failed", sessionState.activeProfile, msg, healthCount)
          );
        }
        return undefined; // 失败降级, 不影响主流程
      }
    });

    // context_message 触发：/manual:xxx + /<flow-name>
    // v10.x：包 try/catch，renderTurnInject 抛错不再 swallow
    api.on("input", async (...args: unknown[]) => {
      const t0 = Date.now();
      try {
        if (!this.ctx || !this.blueprint) return { action: "continue" };
        const event = args[0];
        if (!isInputEvent(event)) return { action: "continue" };
        // Phase term-P4.3：renderContextMessage → renderTurnInject
        // v13.x（issue pt-turn-inject-not-profile-scoped）：按 Profile scope 过滤 domains + 传 profile
        //   让 /manual:<domain> 在未引用该 domain 的 Profile 下返 null（与 /pt flows 列表一致）
        const scoped = filterDomainsByProfile(this.domains, this.profile);
        const result = renderTurnInject(this.ctx, this.blueprint, scoped, this.profile, event.text);
        const durationMs = Date.now() - t0;
        if (result === null) {
          api.log?.debug("agent:input passthrough", {
            inputPreview: event.text.slice(0, 80),
            durationMs,
          });
          return { action: "continue" };
        }
        api.log?.info("agent:input transformed", {
          inputPreview: event.text.slice(0, 80),
          outputLen: result.length,
          durationMs,
        });
        return { action: "transform", text: result };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        api.log?.error("agent:input render failed", {
          err: msg,
          input: args[0],
          durationMs: Date.now() - t0,
        });
        api.ui?.notify(`[pt] input render failed: ${msg}`, "error");
        return { action: "continue" }; // 失败降级: 不拦截 input, 让原文本过 LLM
      }
    });
  }

  /** 查询可用手册（/pt flows 用）。
   *  v9：遍历 Blueprint 的 inject=turn 聚合组 → 引用 Domain → 找 FlowTemplate + Rules 段的 Rule。 */
  listManuals(
    _ctx: AgentContext,
    blueprint: Blueprint,
    domains: Domain[]
  ): Array<{ name: string; hint?: string; domain: string }> {
    const flows: Array<{ name: string; hint?: string; domain: string }> = [];

    for (const group of blueprint.groups) {
      // Phase term-P4.3：inject 语义值 context_message → turn
      // Phase term-naming：字段名 target → inject
      if (group.inject !== "turn") continue;
      // v13.x（issue pt-turn-inject-not-profile-scoped）：按 Profile scope 过滤 domains——
      // adapter 内部统一过滤，调用方（commands.ts flowsText）无需预过滤。
      const scoped = filterDomainsByProfile(domains, this.profile);
      for (const d of scoped) {
        // Phase term-P9.2：FlowTemplate 在 ## Flows 段；Rule[] 在 ## Rules 段；Checklist[] 在 ## Checklists 段。
        const flowsContent = d.modules[MOD_FLOWS];
        if (isFlowTemplateArray(flowsContent)) {
          for (const t of flowsContent) {
            flows.push({ name: t.name, hint: t.argumentHint, domain: d.name });
          }
        }
        const rulesContent = d.modules[MOD_RULES];
        if (isRuleArray(rulesContent) && rulesContent.length > 0) {
          // term-Domain 的 Rule[] 作为 /manual:<domain> 暴露
          flows.push({
            name: `/manual:${d.name}`,
            hint: `${rulesContent.length} 条规范`,
            domain: d.name,
          });
        }
        // Checklist[] 暂不单独暴露——/manual:<domain> 命令会统一处理（renderDomainManual）
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
  return (
    !!x &&
    typeof x === "object" &&
    typeof (x as { systemPrompt?: unknown }).systemPrompt === "string"
  );
}

function isInputEvent(x: unknown): x is { text: string } {
  return !!x && typeof x === "object" && typeof (x as { text?: unknown }).text === "string";
}
