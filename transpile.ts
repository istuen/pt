// transpile.ts — Source Adapter 注册表 + 调度
//
// Phase 5.5 链路：adapter.load() → SchemaBundle → generateV6Prompt(bundle) → string → 注入 systemPrompt
//
// loadAndTranspile 同时返回 segment 和 bundles——segment 注入 systemPrompt，
// bundles（含 domains/structs/flows）给 input handler 用（dynamic manual 拦截需要）。
//
// 注：Phase 5.5 起中端 midend/layout.ts 已退出（layout 逻辑并入 backend/prompt.ts）。
//      backend/prompt.ts 消费 v6 SchemaBundle，按 mode（byDomain/byType/hybrid）+ type 分发。

import { oxnAdapter } from "./frontend/oxn/adapter.js";
import { generateV6Prompt } from "./backend/prompt.js";
import type { SchemaBundle, SourceAdapter } from "./schema.js";

export interface TranspileResult {
  /** 注入 systemPrompt 的字符串段 */
  segment: string;
  /** 各 adapter 返回的 SchemaBundle（含 domains/structs/flows，给 input handler 用） */
  bundles: SchemaBundle[];
}

/** ============== Source Adapter 注册表（MVP 只有 OXN） ============== */
const sourceAdapters: SourceAdapter[] = [
  oxnAdapter,
  // 未来：yamlAdapter, dbAdapter, ...
];

/** 并行调所有 adapter，合并转译产物（失败降级为空串）。 */
export async function loadAndTranspile(cwd: string, sceneName: string): Promise<TranspileResult> {
  const segs = await Promise.all(
    sourceAdapters.map((a) =>
      a.load(cwd, sceneName).catch((e) => {
        console.error(`[pt] adapter ${a.name} failed:`, e);
        return null;
      }),
    ),
  );
  const bundles = segs.filter((b): b is SchemaBundle => b !== null);
  const raw = bundles.map((b) => generateV6Prompt(b)).filter(Boolean).join("\n\n");
  // 注入版剥 asset 分隔注释（`<!-- ===== xxx ===== -->`），
  // 不误伤代码里其他用途的注释（如 TODO 占位）。
  const segment = raw.replace(/<!-- =====[^\n]*-->\n?/g, "").trim();
  return { segment, bundles };
}