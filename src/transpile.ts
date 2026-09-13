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

import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { CACHE_DIR } from "./constants.js";
import { errMsg, reportError, reportWarn } from "./diagnostics.js";
import { mdAdapter } from "./parse/index.js";
import { compileAgentContext } from "./compile/agent-context.js";
import { saveAgentContext, loadAgentContext } from "./render/cache.js";
import { renderSessionInject } from "./render/session-inject.js";
import { findProfile } from "./schema.js";
import { parseRef, resolveBlueprint } from "./parse/ref-resolver.js";
import {
  expandProfile,
  UseTargetNotFound,
  UseChainCycle,
  BlueprintGroupOutOfScope,
} from "./compile/resolve-use.js";
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
  /** 注入 session 的字符串段（聚合所有 inject=session 的聚合组） */
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
  const rawProfile = findProfile(bundle.profiles, bundle.activeProfile);
  if (!rawProfile) {
    throw new Error(
      `transpile: profile "${bundle.activeProfile}" not found in bundle (available: ${bundle.profiles.map((p) => p.name).join(", ") || "<none>"})`
    );
  }

  // v15.x PR5（§5.3.2 + §8.2）：use 单继承展开
  //  - 在 findProfile 之后、findBlueprint 之前——展开后 blueprint 可能被 self 覆盖
  //  - 展开后 profile 进 compileAgentContext + computeSourceHash（§8.2 use 链自然进 hash）
  //  - profileByQualifiedName = workingSet.profiles 视图转换（key 已是 "pack/name"）
  //  - blueprintByQualifiedName 直接复用 workingSet.blueprints（{pack, asset} 视图）
  const profileByQualifiedName = new Map<string, Profile>();
  for (const [k, v] of bundle.workingSet.profiles) {
    profileByQualifiedName.set(k, v.asset);
  }
  let profile: Profile;
  try {
    profile = expandProfile(
      rawProfile,
      profileByQualifiedName,
      bundle.workingSet.blueprints,
      bundle.packs,
      new Set(),
      adapterCtx
    );
  } catch (e) {
    // use 链错误：reportWarn + rethrow——让上层报"transpile: failed"并阻断激活
    if (
      e instanceof UseTargetNotFound ||
      e instanceof UseChainCycle ||
      e instanceof BlueprintGroupOutOfScope
    ) {
      reportWarn(adapterCtx, e.message, {
        profileName: rawProfile.name,
        errorType: e.name,
      });
    }
    throw e;
  }
  const blueprintEntry = resolveBlueprint(
    profile,
    bundle.workingSet.blueprints,
    bundle.packs.map((p) => p.name)
  );
  const blueprint = blueprintEntry?.asset;
  if (!blueprint) {
    const resolved = (() => {
      const { pack, name } = parseRef(profile.blueprint, profile.sourcePack ?? "");
      return `${pack}/${name}`;
    })();
    reportWarn(adapterCtx, `Profile "${profile.name}" 引用未知 Blueprint "${profile.blueprint}"`, {
      profileName: profile.name,
      referencedBlueprint: profile.blueprint,
      resolvedBlueprint: `@${resolved}`,
      availableBlueprints: [...bundle.workingSet.blueprints.keys()],
    });
    throw new Error(
      `transpile: blueprint "${profile.blueprint}" not found for profile "${profile.name}"`
    );
  }
  // v15.x PR2（§8.1 + §8.3）+ PR3（§4.4.3 #2）：compileAgentContext 加 packs + profilePack + workingSet
  const ctx = compileAgentContext(
    profile,
    blueprint,
    bundle.domains,
    bundle.packs,
    bundle.activeProfilePack,
    bundle.workingSet
  );
  adapterCtx?.log?.debug("transpile:compile done", {
    profileName: profile.name,
    sourceHashPrefix: ctx.sourceHash.slice(0, 8),
    moduleCount: Object.keys(ctx.modules).length,
    packName: ctx.packName,
  });

  // 3. cache：load 命中 → 用缓存（跳过写入），未命中 → save
  //   Phase term-P4.2：cacheDir 改用 constants.CACHE_DIR 常量，签名删 compilation 参数。
  //   v15.x PR2（§8.3）：loadAgentContext 加 packName 参数，cache 文件名 <pack>__<profile>。
  const cached = await loadAgentContext(cwd, ctx.packName, ctx.name, ctx.sourceHash);
  let used: AgentContext;
  let cacheHit = false;
  if (cached) {
    cacheHit = true;
    adapterCtx?.log?.info("transpile:cache hit", { agentContextName: ctx.name });
    used = cached;
  } else {
    adapterCtx?.log?.info("transpile:cache miss → save", { agentContextName: ctx.name });
    await saveAgentContext(cwd, ctx);
    used = ctx;
  }

  // 4. render：剥 asset 分隔注释
  //   Phase term-P4.3：renderSystemPrompt → renderSessionInject（inject 语义值 session/turn）。
  const segment = renderSessionInject(used, blueprint)
    .replace(/<!-- =====[^\n]*-->\n?/g, "")
    .trim();

  // issue pt-status-no-injection-state：segmentLen === 0 几乎总是配置错误
  // (profile 缺 ### Modules / blueprint groups 名错配 / domain 段名不匹配等)。
  // cache hit 路径下特别危险——空 segment 被缓存复用，footer 永远 idle。
  // 主动告警让用户首次切换就发现问题，而不是依赖 `injected: true` 误导
  if (segment.length === 0) {
    reportWarn(
      adapterCtx,
      `Profile「${profile.name}」编译产出空 segment（注入不会生效，footer 会一直 idle）`,
      {
        profileName: profile.name,
        cacheHit,
        hint: "检查 Profile 的 H2 段下 `### Modules` 配置、Blueprint groups 名匹配、Domain H2 段名",
      }
    );
  }

  // 5. prune orphan caches（v13.x issue pt-no-agent-context-prune-orphan-caches 修复）
  //   Profile 删除/改名后，旧 cache 文件残留——transpile 末尾自动 unlink
  //   validProfileNames 来自当前 bundle（项目 + builtin 合并后的全集）
  //   Phase term-P4.2：Blueprint.competition 已移除，cacheDir 用 CACHE_DIR 常量
  const pruned = await pruneOrphanCaches(
    cwd,
    CACHE_DIR,
    new Set(bundle.profiles.map((p) => p.name))
  );
  if (pruned.length > 0) {
    adapterCtx?.log?.info("transpile:prune orphan caches", { pruned });
  }

  adapterCtx?.log?.info("transpile:done", {
    profileName: profile.name,
    segmentLen: segment.length,
    cacheHit,
    prunedCount: pruned.length,
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

/** 删除孤儿 cache 文件（Profile 已不存在的 cache）。
 *  v13.x（issue pt-no-agent-context-prune-orphan-caches）：transpile 末尾自动清理，
 *  避免 Profile 删改后旧 cache 文件残留误导排查。
 *
 *  @param cwd 项目根目录
 *  @param cacheDir 缓存目录（从 Blueprint.compilation.cacheDir 读，默认 `.pt/cache/agent-contexts/`）
 *  @param validProfileNames 当前 bundle.profiles 合并后的全集（项目覆盖 builtin）
 *  @returns 被 unlink 的 cache 名列表（用于 trace）
 */
export async function pruneOrphanCaches(
  cwd: string,
  cacheDir: string,
  validProfileNames: Set<string>
): Promise<string[]> {
  const dir = join(cwd, cacheDir);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return []; // 目录不存在（首次加载）返空，不抛错
  }
  const pruned: string[] = [];
  for (const f of files) {
    if (!f.endsWith(".agent-context.md")) continue;
    // v15.x PR2（§8.3）：cache 文件名 <pack>__<profile>.agent-context.md——split "__" 拿 profile name
    // PR1 阶段：<profile>.agent-context.md——slice 去后缀。二者需向后兼容。
    const stem = f.slice(0, -".agent-context.md".length);
    const sepIdx = stem.lastIndexOf("__");
    const name = sepIdx >= 0 ? stem.slice(sepIdx + 2) : stem;
    if (validProfileNames.has(name)) continue;
    try {
      await unlink(join(dir, f));
      pruned.push(name);
    } catch {
      // unlink 失败（权限/不存在）跳过——不影响主流程
    }
  }
  return pruned;
}
