// src/transpile.ts — v8 三段式链路：parse → compile → render + cache
//
// Phase 8.5：v8 链路。
//   parse(blueprint, channel, domain md) → IR (SchemaBundle)
//     ↓
//   compile(blueprint + channel + domains) → Context IR
//     ↓
//   cache.load? 命中 → 用缓存 : cache.save(Context) → 重编译
//     ↓
//   render.systemPrompt(Context, Channel) → 注入 before_agent_start
//   render.contextMessage(Context, Channel, Blueprint, args) → 注入 input 事件

import { oxnAdapter } from "./parse/index.js";
import { compileContext } from "./compile/context.js";
import { renderSystemPrompt } from "./render/system-prompt.js";
import { saveContext, loadContext } from "./render/cache.js";
import { findBlueprint } from "./schema.js";
import type { SchemaBundle, SourceAdapter } from "./schema.js";

export interface TranspileResult {
  /** 注入 systemPrompt 的字符串段（聚合所有 target=system_prompt 的注入点） */
  segment: string;
  /** 各 adapter 返回的 SchemaBundle（保留给 input handler 找 FlowTemplate 用） */
  bundles: SchemaBundle[];
  /** 缓存命中信息（用于 8.7/8.8 缓存验证） */
  cacheHit: boolean;
}

/** ============== Source Adapter 注册表（MVP 只有 OXN） ============== */
const sourceAdapters: SourceAdapter[] = [
  oxnAdapter,
  // 未来：yamlAdapter, dbAdapter, ...
];

/** 三段式转译：parse → compile → cache → render。 */
export async function loadAndTranspile(cwd: string, blueprintName: string): Promise<TranspileResult> {
  // 1. parse：并行调所有 adapter 拿 SchemaBundle
  const segs = await Promise.all(
    sourceAdapters.map((a) =>
      a.load(cwd, blueprintName).catch((e) => {
        console.error(`[pt] adapter ${a.name} failed:`, e);
        return null;
      }),
    ),
  );
  const bundles = segs.filter((b): b is SchemaBundle => b !== null);
  if (bundles.length === 0) {
    return { segment: "", bundles: [], cacheHit: false };
  }

  // 2. compile + cache + render：对每个 bundle 处理（取 activeBlueprint）
  const segments: string[] = [];
  let anyHit = false;
  for (const bundle of bundles) {
    const bp = findBlueprint(bundle.blueprints, bundle.activeBlueprint);
    if (!bp) continue;
    const ch = bundle.channels.find((c) => c.name === bp.channel);
    if (!ch) {
      console.warn(`[pt] Blueprint "${bp.name}" 引用未知 Channel "${bp.channel}"`);
      continue;
    }
    const ctx = compileContext(bp, ch, bundle.domains);

    // 3. cache：load 命中 → 用缓存（跳过写入），未命中 → save
    const cached = await loadContext(cwd, ctx.name, ctx.sourceHash, bp.compilation);
    if (cached) {
      anyHit = true;
      segments.push(renderSystemPrompt(cached, ch));
    } else {
      await saveContext(cwd, ctx, bp.compilation);
      segments.push(renderSystemPrompt(ctx, ch));
    }
  }

  // 4. 注入版剥 asset 分隔注释
  const segment = segments.join("\n\n").replace(/<!-- =====[^\n]*-->\n?/g, "").trim();
  return { segment, bundles, cacheHit: anyHit };
}
