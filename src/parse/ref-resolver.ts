// src/parse/ref-resolver.ts — @pack/name 限定语法工具（v15.x PR3）
//
// 设计源：.pt/docs/designs/pt-asset-pack.md §4（@pack/name 限定语法）+ §4.4.2（fingerprint + dedup）
//
// 职责：
// - parseRef：统一解析限定 + 不限定 ref → {pack, name}
// - fingerprint：sha256(rootDir + content) 截 16 字符
// - resolveAndDedupRefs：解析 refs + fp dedup（后者覆盖前者，Map.set 语义）
//
// 关键纪律：
// - parseRef 抛异常（不像 parseManifest 容错）—— 畸形 ref 是配置错误
// - 别名归一：@project/foo → @prj/foo（兼容旧文档，§4.1）
// - 解析阶段展开为统一形态——IR 不升级（profile.domains 仍 string[]）
// - fingerprint 用 rootDir + content：保证"同 pack 同内容同 fp" + "不同 pack 偶然同内容不同 fp"

import { createHash } from "node:crypto";
import type { AssetPack, Blueprint, Profile } from "../schema.js";

// ==================== §4.2：parseRef ====================

/** reserved pack 名 + 别名（§2.4.1 + §4.1）。
 *  精确匹配：别名归一为短名（project → prj 等），非保留名原样保留。 */
const RESERVED_PACK_NAMES: ReadonlyMap<string, string> = new Map([
  ["prj", "prj"],
  ["project", "prj"],
  ["gbl", "gbl"],
  ["global", "gbl"],
  ["pt", "pt"],
  ["builtin", "pt"],
]);

/** 解析 ref → {pack, name}。不限定 ref 自动绑定 selfPack。
 *  畸形输入抛异常（§4.5.1 运行时校验）。 */
export function parseRef(raw: string, selfPack: string): { pack: string; name: string } {
  if (raw.startsWith("@")) {
    const rest = raw.slice(1);
    const slashIdx = rest.indexOf("/");
    if (slashIdx <= 0) {
      throw new Error(`malformed @pack/name: "${raw}"（缺 / 或 pack 名为空）`);
    }
    const rawPack = rest.slice(0, slashIdx);
    const name = rest.slice(slashIdx + 1);
    if (!name) {
      throw new Error(`malformed @pack/name: "${raw}"（asset 名为空）`);
    }
    const pack = RESERVED_PACK_NAMES.get(rawPack) ?? rawPack;
    return { pack, name };
  }
  // 不限定 ref：自动绑定 self.sourcePack（§4.5.1——无 sourcePack 抛错）
  if (!selfPack) {
    throw new Error(
      `unqualified ref "${raw}" but profile has no sourcePack (load context missing)`
    );
  }
  return { pack: selfPack, name: raw };
}

/** 判断 raw 是否限定 ref（以 @ 开头）。诊断用。 */
export function isQualifiedRef(raw: string): boolean {
  return raw.startsWith("@");
}

/** 保留名归一（project → prj 等）。非保留名原样返回。 */
export function normalizePackName(raw: string): string {
  return RESERVED_PACK_NAMES.get(raw) ?? raw;
}

// ==================== §4.6：resolveBlueprint ====================

/** v15.x PR6（fix pt-parse-blueprint-warn-misleading）：跨 pack Blueprint 解析。
 *  - 限定 ref（@pack/name）：只在目标 pack 查；查不到返 undefined（精确语义）
 *  - 不限定 ref（foo）：先在 self.sourcePack 查；查不到按 packNames 顺序 fallback
 *  - 与 transpile 阶段（§4.6 back-compat）行为等价——parse 阶段不再单独报
 *    "unknown Blueprint" warn（false positive），统一交给 compile 阶段 throw。
 *
 *  设计：parse 和 compile 共用同一份 fallback 逻辑，避免行为漂移。
 *  packNames 顺序 = [project, ...settings.reverse(), global, builtin]，前者赢。
 *  fallback 时跳过 selfPack（已查过），按声明顺序查后续 pack。 */
export function resolveBlueprint(
  profile: { blueprint: string; sourcePack?: string },
  blueprintWS: Map<string, { pack: AssetPack; asset: Blueprint }>,
  packNames: readonly string[]
): { pack: AssetPack; asset: Blueprint } | undefined {
  if (!profile.blueprint) return undefined;
  const { pack, name } = parseRef(profile.blueprint, profile.sourcePack ?? "");
  const direct = blueprintWS.get(`${pack}/${name}`);
  if (direct) return direct;
  // 不限定 ref + direct miss → fallback 查找其他 pack
  if (!profile.blueprint.startsWith("@")) {
    for (const fb of packNames) {
      if (fb === pack) continue;
      const entry = blueprintWS.get(`${fb}/${name}`);
      if (entry) return entry;
    }
  }
  return undefined;
}

// ==================== §4.4.2：fingerprint ====================

/** v15.x PR3（§4.4.2）：fingerprint = sha256(rootDir + content)。
 *  - rootDir 不同 → fp 不同（避免不同 pack 偶然同内容被合并）
 *  - content 不同 → fp 不同
 *  用于 resolveAndDedupRefs 的 dedup by fp（后者覆盖前者）。 */
export function fingerprint<T>(pack: AssetPack, asset: T): string {
  const input = `${pack.rootDir}\n${stableStringify(asset)}`;
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

/** 与 compile/agent-context.ts 同逻辑（PR3 不强制抽公共——YAGNI）。 */
function stableStringify(obj: unknown): string {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(",")}]`;
  if (!isRecord(obj)) return JSON.stringify(obj);
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

// ==================== §4.4.2：resolveAndDedupRefs ====================

/** v15.x PR3（§4.4.2）：解析 refs + fingerprint dedup（后者覆盖前者）。
 *
 * 阶段 1：所有 ref 解析为 {pack, asset, fp, rawRef}（保留原顺序）
 * 阶段 2：dedup by fp——Map.set 同 fp 后写覆盖前写 = 后者赢
 *
 * 返回值按首次插入顺序，值=最后写入的 ref（同 fp 后者赢）。
 * 场景 A/B/C（同 fp）→ dedup 后 1 份；场景 D/E/F（不同 fp）→ 保留多份。
 *
 * 错误信息含 loadedPackNames 帮用户定位（§4.5.1）。 */
export function resolveAndDedupRefs<T extends { name: string }>(
  refs: string[],
  self: Profile,
  workingSet: Map<string, { pack: AssetPack; asset: T }>,
  loadedPackNames: string[],
  options: { skipOnMissing?: boolean } = {}
): Array<{ pack: AssetPack; asset: T; fp: string; rawRef: string }> {
  const resolved: Array<{ pack: AssetPack; asset: T; fp: string; rawRef: string }> = [];
  for (const raw of refs) {
    const { pack: packName, name } = parseRef(raw, self.sourcePack ?? "");
    let entry = workingSet.get(`${packName}/${name}`);
    // v15.x PR3（§4.6 back-compat）：显式 @pack/name 查不到 → 抛错（§4.5.1）。
    // 不限定 ref 在 selfPack 查不到时（§4.6 等价今天 dedupByNameN 语义）：
    // 按 packs 优先级顺序逐个 fallback 查询——与今天前者赢补充一致。
    // 例：profile 写在 project pack，不限定 `foo` → "prj/foo" 不命中 → fallback "gbl/foo" → "pt/foo"。
    if (!entry && !raw.startsWith("@")) {
      for (const fallbackPack of loadedPackNames) {
        if (fallbackPack === packName) continue;
        const fallbackEntry = workingSet.get(`${fallbackPack}/${name}`);
        if (fallbackEntry) {
          entry = fallbackEntry;
          break;
        }
      }
    }
    if (!entry) {
      // skipOnMissing：scan 场景用——静默跳过不存在的 ref（与 dedupByNameN 旧行为一致）
      if (options.skipOnMissing) continue;
      throw new Error(
        `Profile "${self.name}" references "@${packName}/${name}" but pack "${packName}" has no asset "${name}". ` +
          `Loaded packs: [${loadedPackNames.join(", ")}]`
      );
    }
    const fp = fingerprint(entry.pack, entry.asset);
    resolved.push({ pack: entry.pack, asset: entry.asset, fp, rawRef: raw });
  }

  const byFp = new Map<string, (typeof resolved)[0]>();
  for (const r of resolved) {
    byFp.set(r.fp, r); // 同 fp 后写覆盖前写 = 后者赢
  }
  return [...byFp.values()]; // 保留首次插入顺序
}
