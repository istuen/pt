// src/transpile.ts — v9 三段式链路：parse → compile → cache → render
//
// Phase 9.7：v9 链路——Profile 用户面 + Blueprint 结构层 + AgentAdapter 注入。
//   parse(profile md) → IR (SchemaBundle with profiles)
//     ↓
//   findProfile → findBlueprint → compileContext(profile, blueprint, domains) → Context IR
//     ↓
//   cache.load? 命中 → 用缓存 : cache.save(Context) → 重编译
//     ↓
//   render.systemPrompt(Context, Blueprint) → 给 AgentAdapter 注入 before_agent_start

import { oxnAdapter } from "./parse/index.js";
import { compileContext } from "./compile/context.js";
import { saveContext, loadContext } from "./render/cache.js";
import { renderSystemPrompt } from "./render/system-prompt.js";
import { findBlueprint, findProfile } from "./schema.js";
import type { Blueprint, Context, Domain, Profile, SchemaBundle, SourceAdapter } from "./schema.js";

export interface TranspileResult {
  /** 注入 systemPrompt 的字符串段（聚合所有 target=system_prompt 的注入点） */
  segment: string;
  /** 各 adapter 返回的 SchemaBundle（保留给 input handler 找 FlowTemplate / listManuals 用） */
  bundles: SchemaBundle[];
  /** 缓存命中信息 */
  cacheHit: boolean;
  /** v9 新增（给 AgentAdapter 用） */
  context: Context;
  blueprint: Blueprint;
  domains: Domain[];
  /** 当前激活的 Profile 名 */
  activeProfile: string;
  /** 当前激活的 Profile（listManuals 范围过滤用） */
  profile: Profile;
}

const EMPTY_CTX: Context = { name: "", sourceHash: "0", modules: {} };
const EMPTY_BP: Blueprint = { name: "", agent: "pi", injectionPoints: [], compilation: { cacheDir: ".pt/contexts/cache/", split: "single-file" } };
const EMPTY_PROFILE: Profile = { name: "", blueprint: "", domains: [], injectionPoints: [] };

/** ============== Source Adapter 注册表（MVP 只有 OXN） ============== */
const sourceAdapters: SourceAdapter[] = [
  oxnAdapter,
  // 未来：yamlAdapter, dbAdapter, ...
];

/** 三段式转译：parse → compile → cache → render。 */
export async function loadAndTranspile(cwd: string, profileName: string): Promise<TranspileResult> {
  // 1. parse：并行调所有 adapter 拿 SchemaBundle
  const segs = await Promise.all(
    sourceAdapters.map((a) =>
      a.load(cwd, profileName).catch((e) => {
        console.error(`[pt] adapter ${a.name} failed:`, e);
        return null;
      }),
    ),
  );
  const bundles = segs.filter((b): b is SchemaBundle => b !== null);
  if (bundles.length === 0) {
    return {
      segment: "",
      bundles: [],
      cacheHit: false,
      context: { ...EMPTY_CTX, name: profileName },
      blueprint: EMPTY_BP,
      domains: [],
      activeProfile: profileName,
      profile: { ...EMPTY_PROFILE, name: profileName },
    };
  }

  // 2. compile + cache + render：对每个 bundle 处理（取 activeProfile）
  const segments: string[] = [];
  let anyHit = false;
  let lastContext: Context | null = null;
  let lastBlueprint: Blueprint | null = null;
  let lastDomains: Domain[] = [];
  let lastActiveProfile = profileName;
  let lastProfile: Profile | null = null;

  for (const bundle of bundles) {
    const profile = findProfile(bundle.profiles, bundle.activeProfile);
    if (!profile) continue;
    const blueprint = findBlueprint(bundle.blueprints, profile.blueprint);
    if (!blueprint) {
      console.warn(`[pt] Profile "${profile.name}" 引用未知 Blueprint "${profile.blueprint}"`);
      continue;
    }
    const ctx = compileContext(profile, blueprint, bundle.domains);

    // 3. cache：load 命中 → 用缓存（跳过写入），未命中 → save
    const cached = await loadContext(cwd, ctx.name, ctx.sourceHash, blueprint.compilation);
    let used: Context;
    if (cached) {
      anyHit = true;
      used = cached;
    } else {
      await saveContext(cwd, ctx, blueprint.compilation);
      used = ctx;
    }

    segments.push(renderSystemPrompt(used, blueprint));
    lastContext = used;
    lastBlueprint = blueprint;
    lastDomains = bundle.domains;
    lastActiveProfile = profile.name;
    lastProfile = profile;
  }

  // 4. 注入版剥 asset 分隔注释
  const segment = segments.join("\n\n").replace(/<!-- =====[^\n]*-->\n?/g, "").trim();

  return {
    segment,
    bundles,
    cacheHit: anyHit,
    context: lastContext ?? { ...EMPTY_CTX, name: lastActiveProfile },
    blueprint: lastBlueprint ?? EMPTY_BP,
    domains: lastDomains,
    activeProfile: lastActiveProfile,
    profile: lastProfile ?? { ...EMPTY_PROFILE, name: lastActiveProfile },
  };
}