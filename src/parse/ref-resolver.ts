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
import type { AssetPack, Blueprint, Profile, WorkingSet } from "../schema.js";

// ==================== §4.2：parseRef ====================

/** reserved pack 名 + 别名（§2.4.1 + §4.1 + §2.4.4 双层语义）。
 *  v15.x §2.4.4：这些是"位置 alias"——固定指向物理位置 slot，与 manifest.name 身份层独立。
 *  精确匹配：别名归一为短名（project → prj 等），非位置 alias 原样保留。
 *  v15.x PR7（issue pt-remove-global-pack 移除）：gbl/global 行删除，位置 alias 从
 *  3 个收敛为 2 个（project/builtin 两个保留名都映射到对应 prj/pt 短名）。 */
const LOCATION_ALIASES: ReadonlyMap<string, string> = new Map([
  ["prj", "prj"],
  ["project", "prj"],
  ["pt", "pt"],
  ["builtin", "pt"],
]);

/** 解析 ref → {kind, pack, name}。双层语义（§2.4.4）：
 *  - kind="location"：位置 alias（prj/pt + project/builtin）→ 按 pack name 物理位置查
 *  - kind="identity"：身份 alias（manifest.name）→ 按 pack.name 身份查
 *  不限定 ref 自动绑定 selfPack（kind="identity"）。
 *  畸形输入抛异常（§4.5.1 运行时校验）。 */
export function parseRef(
  raw: string,
  selfPack: string
): { kind: "location" | "identity"; pack: string; name: string } {
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
    const locAlias = LOCATION_ALIASES.get(rawPack);
    if (locAlias) {
      // 位置 alias：归一为短名（project → prj），kind=location
      return { kind: "location", pack: locAlias, name };
    }
    // 身份 alias：原值（manifest.name 原样保留），kind=identity
    return { kind: "identity", pack: rawPack, name };
  }
  // 不限定 ref：自动绑定 self.sourcePack——selfPack 是 manifest.name（身份），kind=identity
  if (!selfPack) {
    throw new Error(
      `unqualified ref "${raw}" but profile has no sourcePack (load context missing)`
    );
  }
  return { kind: "identity", pack: selfPack, name: raw };
}

/** 判断 raw 是否限定 ref（以 @ 开头）。诊断用。 */
export function isQualifiedRef(raw: string): boolean {
  return raw.startsWith("@");
}

/** 位置 alias 归一（project → prj 等）。非位置 alias 原样返回。
 *  与 parseRef 的 kind="location" 分支语义一致——独立暴露便于诊断。 */
export function normalizePackName(raw: string): string {
  return LOCATION_ALIASES.get(raw) ?? raw;
}

// ==================== §4.6：resolveBlueprint ====================

/** v15.x PR6（fix pt-parse-blueprint-warn-misleading）：跨 pack Blueprint 解析。
 *  v15.x §4.4.2：workingSet 改为双索引 WorkingSet<Blueprint>——按 parseRef 的 kind 分发查询：
 *    - kind="location"：查 location 索引（位置 alias 短名）
 *    - kind="identity"：查 identity 索引（manifest.name）
 *  - 限定 ref（@pack/name）：只在目标 pack 查；查不到返 undefined（精确语义）
 *  - 不限定 ref（foo）：先在 self.sourcePack 查；查不到按 packNames 顺序 fallback
 *  - 与 transpile 阶段（§4.6 back-compat）行为等价——parse 阶段不再单独报
 *    "unknown Blueprint" warn（false positive），统一交给 compile 阶段 throw。
 *
 *  设计：parse 和 compile 共用同一份 fallback 逻辑，避免行为漂移。
 *  packNames 顺序 = [project, ...settings.reverse(), global, builtin]，前者赢。
 *  fallback 时跳过 selfPack（已查过），按声明顺序查后续 pack（查 identity 索引，因 packNames 都是 pack.name = manifest.name）。 */
export function resolveBlueprint(
  profile: { blueprint: string; sourcePack?: string },
  blueprintWS: WorkingSet<Blueprint>,
  packNames: readonly string[]
): { pack: AssetPack; asset: Blueprint } | undefined {
  if (!profile.blueprint) return undefined;
  const { kind, pack, name } = parseRef(profile.blueprint, profile.sourcePack ?? "");
  const ws = kind === "location" ? blueprintWS.location : blueprintWS.identity;
  const direct = ws.get(`${pack}/${name}`);
  if (direct) return direct;
  // 不限定 ref + direct miss → fallback 查找其他 pack（按 packNames 顺序查 identity 索引）
  if (!profile.blueprint.startsWith("@")) {
    for (const fb of packNames) {
      if (fb === pack) continue;
      const entry = blueprintWS.identity.get(`${fb}/${name}`);
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

/** v15.x §4.4.2（双层语义）：解析 refs + fingerprint dedup（后者覆盖前者）。
 *  workingSet 改为 WorkingSet<T> 双索引——按 parseRef 的 kind 分发查询：
 *    - kind="location"：查 location 索引（位置 alias 短名）
 *    - kind="identity"：查 identity 索引（manifest.name）
 *  fallback 查其他 pack 时查 identity 索引（packNames 是 manifest.name 列表）。
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
  workingSet: WorkingSet<T>,
  loadedPackNames: string[],
  options: { skipOnMissing?: boolean } = {}
): Array<{ pack: AssetPack; asset: T; fp: string; rawRef: string }> {
  const resolved: Array<{ pack: AssetPack; asset: T; fp: string; rawRef: string }> = [];
  for (const raw of refs) {
    const { kind, pack: packName, name } = parseRef(raw, self.sourcePack ?? "");
    const ws = kind === "location" ? workingSet.location : workingSet.identity;
    let entry = ws.get(`${packName}/${name}`);
    // v15.x PR3（§4.6 back-compat）：显式 @pack/name 查不到 → 抛错（§4.5.1）。
    // 不限定 ref 在 selfPack 查不到时（§4.6 等价今天 dedupByNameN 语义）：
    // 按 packs 优先级顺序逐个 fallback 查询（查 identity 索引，packNames 是 manifest.name 列表）。
    // 例：profile 写在 project pack，不限定 `foo` → identity "pt-internal/foo" 不命中 → fallback "pt/foo"。
    if (!entry && !raw.startsWith("@")) {
      for (const fallbackPack of loadedPackNames) {
        if (fallbackPack === packName) continue;
        const fallbackEntry = workingSet.identity.get(`${fallbackPack}/${name}`);
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
