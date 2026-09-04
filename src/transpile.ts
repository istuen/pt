// src/transpile.ts — v9 三段式链路：parse → compile → cache → render
//
// Phase 9.7：v9 链路——Profile 用户面 + Blueprint 结构层 + AgentAdapter 注入。
//   parse(profile md) → IR (SchemaBundle with profiles)
//     ↓
//   findProfile → findBlueprint → compileAgentContext(profile, blueprint, domains) → AgentContext IR
//     ↓
//   cache.load? 命中 → 用缓存 : cache.save(AgentContext) → 重编译
//     ↓
//   render.systemPrompt(AgentContext, Blueprint) → 给 AgentAdapter 注入 before_agent_start
//
// Phase 11.x / P1：单源线性（YAGNI 多源合并）——取第一个成功的 adapter。
//   旧版多 bundle 循环 + 5 个 lastXxx 累积已删（P1.1）。bundles 仍返 [bundle]
//   保留 SchemaBundle[] 形态（index.ts:786 r.bundles[0] 依赖）。无成功 bundle
//   抛错（P1.2）由 index.ts:286 catch 兜底。
//
// Phase term-P1：Context IR → AgentContext 改名同步——
//   - compileContext → compileAgentContext
//   - saveContext/loadContext → saveAgentContext/loadAgentContext
//   - TranspileResult.context → TranspileResult.agentContext（字段改名）

import { errMsg, reportError, reportWarn } from "./diagnostics.js";
import { mdAdapter } from "./parse/index.js";
import { compileAgentContext } from "./compile/agent-context.js";
import { saveAgentContext, loadAgentContext } from "./render/cache.js";
import { renderSystemPrompt } from "./render/system-prompt.js";
import { findBlueprint, findProfile } from "./schema.js";
import type {
  AgentContext,
  Blueprint,
  Domain,
  Profile,
  SchemaBundle,
  SourceAdapter,
  SourceAdapterContext,
} from "./schema.js";

export interface TranspileResult {
  /** 注入 systemPrompt 的字符串段（聚合所有 target=system_prompt 的注入点） */
  segment: string;
  /** 各 adapter 返回的 SchemaBundle（保留给 input handler 找 FlowTemplate / listManuals 用） */
  bundles: SchemaBundle[];
  /** 缓存命中信息 */
  cacheHit: boolean;
  /** v9 新增（给 AgentAdapter 用）。Phase term-P1：context → agentContext（IR 改名同步）。 */
  agentContext: AgentContext;
  blueprint: Blueprint;
  domains: Domain[];
  /** 当前激活的 Profile 名 */
  activeProfile: string;
  /** 当前激活的 Profile（listManuals 范围过滤用） */
  profile: Profile;
}

/** ============== Source Adapter 注册表（MVP 只有 MD） ==============
 *  P1.1：保留数组形式作为扩展点（未来加 yamlAdapter / dbAdapter），
 *  但 loadAndTranspile 改为"取第一个成功 adapter"——多源合并未来设计（YAGNI）。 */
const sourceAdapters: SourceAdapter[] = [
  mdAdapter,
  // 未来：yamlAdapter, dbAdapter, ...
];

/** 三段式转译：parse → compile → cache → render。 */
export async function loadAndTranspile(
  cwd: string,
  profileName: string,
  adapterCtx?: SourceAdapterContext
): Promise<TranspileResult> {
  adapterCtx?.log?.debug("transpile:start", { profileName, adapterCount: sourceAdapters.length });

  // 1. parse：依次调所有 adapter，取第一个成功的 bundle
  let bundle: SchemaBundle | null = null;
  for (const a of sourceAdapters) {
    try {
      const b = await a.load(cwd, profileName, adapterCtx);
      if (b) {
        bundle = b;
        break;
      }
    } catch (e) {
      reportError(adapterCtx, `adapter ${a.name} failed: ${errMsg(e)}`, { adapter: a.name });
    }
  }
  if (!bundle) {
    throw new Error(`transpile: no adapter succeeded for profile "${profileName}"`);
  }
  adapterCtx?.log?.info("transpile:parse done", {
    profileName,
    profileCount: bundle.profiles.length,
    blueprintCount: bundle.blueprints.length,
    domainCount: bundle.domains.length,
  });

  // 2. compile：profile → blueprint → context
  const profile = findProfile(bundle.profiles, bundle.activeProfile);
  if (!profile) {
    throw new Error(
      `transpile: profile "${bundle.activeProfile}" not found in bundle (available: ${bundle.profiles.map((p) => p.name).join(", ") || "<none>"})`
    );
  }
  const blueprint = findBlueprint(bundle.blueprints, profile.blueprint);
  if (!blueprint) {
    reportWarn(adapterCtx, `Profile "${profile.name}" 引用未知 Blueprint "${profile.blueprint}"`, {
      profileName: profile.name,
      referencedBlueprint: profile.blueprint,
      availableBlueprints: bundle.blueprints.map((b) => b.name),
    });
    throw new Error(
      `transpile: blueprint "${profile.blueprint}" not found for profile "${profile.name}"`
    );
  }
  const ctx = compileAgentContext(profile, blueprint, bundle.domains);
  adapterCtx?.log?.debug("transpile:compile done", {
    profileName: profile.name,
    sourceHashPrefix: ctx.sourceHash.slice(0, 8),
    moduleCount: Object.keys(ctx.modules).length,
  });

  // 3. cache：load 命中 → 用缓存（跳过写入），未命中 → save
  const cached = await loadAgentContext(cwd, ctx.name, ctx.sourceHash, blueprint.compilation);
  let used: AgentContext;
  let cacheHit = false;
  if (cached) {
    cacheHit = true;
    adapterCtx?.log?.info("transpile:cache hit", { agentContextName: ctx.name });
    used = cached;
  } else {
    adapterCtx?.log?.info("transpile:cache miss → save", { agentContextName: ctx.name });
    await saveAgentContext(cwd, ctx, blueprint.compilation);
    used = ctx;
  }

  // 4. render：剥 asset 分隔注释
  const segment = renderSystemPrompt(used, blueprint)
    .replace(/<!-- =====[^\n]*-->\n?/g, "")
    .trim();

  adapterCtx?.log?.info("transpile:done", {
    profileName: profile.name,
    segmentLen: segment.length,
    cacheHit,
  });

  return {
    segment,
    bundles: [bundle],
    cacheHit,
    agentContext: used,
    blueprint,
    domains: bundle.domains,
    activeProfile: profile.name,
    profile,
  };
}
