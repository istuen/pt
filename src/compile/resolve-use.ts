// src/compile/resolve-use.ts — v15.x PR5 use Profile 单继承展开
//
// 设计源：.pt/docs/designs/pt-asset-pack.md §5.3.2（展开算法）/ §5.3.3（菱形 M4）
//         §5.4（Group 合并）/ §5.5（越权校验）/ §5.6（错误信息）
//
// 关键纪律：
//   - parseUseRef 直接复用 parseRef（PR3a 已实现 @pack/name + 无前缀→selfPack 两种语义）
//   - 菱形用路径 visited（每层 new Set(visited)），不加 memo（M4）
//   - 越权校验 use 场景 error（§5.5.1 S7）
//   - mergeProfile blueprint 覆盖用 `||`（frontmatter blueprint 缺省 "" 非 undefined）

import { parseRef } from "../parse/ref-resolver.js";
import type {
  AssetPack,
  Blueprint,
  Profile,
  ProfileGroup,
  SourceAdapterContext,
} from "../schema.js";

// ==================== §5.6：错误类型 ====================

/** §5.6 错误类型：use 目标 Profile 不存在。 */
export class UseTargetNotFound extends Error {
  constructor(
    public readonly useRef: string,
    public readonly resolvedKey: string,
    public readonly loadedPacks: AssetPack[]
  ) {
    super(
      `Profile use: "${useRef}" — profile not found (resolved: ${resolvedKey}). ` +
        `Loaded profiles: [${loadedPacks.flatMap((p) => p.name).join(", ")}]. ` +
        `Hint: 检查 use 引用的 pack/name 拼写，或确认目标 pack 已加载`
    );
    this.name = "UseTargetNotFound";
  }
}

/** §5.6 错误类型：use 链循环。 */
export class UseChainCycle extends Error {
  constructor(public readonly chain: string[]) {
    super(`use chain cycle detected: ${chain.join(" → ")}`);
    this.name = "UseChainCycle";
  }
}

/** §5.6 错误类型：Blueprint group 越权（use 场景，error 阻断激活）。 */
export class BlueprintGroupOutOfScope extends Error {
  constructor(
    public readonly profileName: string,
    public readonly outOfScopeGroups: string[],
    public readonly blueprintName: string,
    public readonly allowedSlots: string[]
  ) {
    super(
      `Profile "${profileName}" expanded groups: [${outOfScopeGroups.join(", ")}] ` +
        `— group(s) not in blueprint "${blueprintName}" slots [${allowedSlots.join(", ")}]. ` +
        `Hint: 在 self.groups 中显式重写越权 group，或改回 use 的 blueprint`
    );
    this.name = "BlueprintGroupOutOfScope";
  }
}

// ==================== §5.3.2：expandProfile 主算法 ====================

/**
 * §5.3.2 expandProfile——递归展开 use 链。
 *
 * @param self 当前 Profile（已带 sourcePack）
 * @param profileByQualifiedName key="pack/name" 的 Profile 视图（= workingSet.profiles 转换）
 * @param blueprintByQualifiedName key="pack/name" 的 Blueprint 视图（越权校验用）
 * @param loadedPacks 错误信息展示用
 * @param visited 路径 visited（循环检测）——每层递归 new Set(visited)，菱形不误报
 * @param ctx adapterCtx（错误信息可走 notify 三通道 fallback——errors 已 throw，此参数备用）
 * @returns 展开后的 Profile（合并 use 链结果，self 优先）
 */
export function expandProfile(
  self: Profile,
  profileByQualifiedName: Map<string, Profile>,
  blueprintByQualifiedName: Map<string, { pack: AssetPack; asset: Blueprint }>,
  loadedPacks: AssetPack[],
  visited: Set<string> = new Set(),
  _ctx?: SourceAdapterContext
): Profile {
  const key = `${self.sourcePack ?? ""}/${self.name}`;

  // 步骤 2：循环检测（路径 visited）
  if (visited.has(key)) {
    throw new UseChainCycle([...visited, key]);
  }
  const nextVisited = new Set(visited);
  nextVisited.add(key);

  // 步骤 4：叶子 Profile——不写 use 直接返回 self（back-compat 早退）
  if (!self.use) {
    return self;
  }

  // 步骤 5：解析 use 引用（复用 parseRef——已含 @prj/@pt 别名归一）
  // v15.x PR7（issue pt-remove-global-pack 移除）：@gbl 从位置 alias 表删除，parseRef 内已收敛。
  const useRef = parseRef(self.use, self.sourcePack ?? "");
  let useKey = `${useRef.pack}/${useRef.name}`;
  let useProfile = profileByQualifiedName.get(useKey);
  // v15.x PR3a back-compat（§4.4）：无前缀 ref 跨 packs fallback（与 transpile findBlueprint 一致）
  // 限定 @pack/name 不 fallback——严格语义
  if (!useProfile && !self.use.startsWith("@")) {
    for (const fallbackPack of loadedPacks.map((p) => p.name)) {
      if (fallbackPack === useRef.pack) continue;
      const fallback = profileByQualifiedName.get(`${fallbackPack}/${useRef.name}`);
      if (fallback) {
        useProfile = fallback;
        useKey = `${fallbackPack}/${useRef.name}`;
        break;
      }
    }
  }
  if (!useProfile) {
    throw new UseTargetNotFound(self.use, useKey, loadedPacks);
  }

  // 步骤 6：递归展开 use Profile（每层独立 visited——菱形不误报）
  const useExpanded = expandProfile(
    useProfile,
    profileByQualifiedName,
    blueprintByQualifiedName,
    loadedPacks,
    nextVisited, // 路径 visited，非全图 visited（§5.3.3）
    _ctx
  );

  // 步骤 7：合并 self ⊕ useExpanded（§5.2 表）
  const merged = mergeProfile(self, useExpanded);

  // 步骤 8：越权校验——use 场景 error（§5.5.1 S7）
  validateGroupScopeForUse(merged, self, blueprintByQualifiedName);

  return merged;
}

// ==================== §5.2：mergeProfile ====================

/** §5.2 合并规则：self ⊕ useExpanded。
 *  - name：self 强制覆盖（不继承，§5.2 唯一不继承字段）
 *  - blueprint：self.blueprint || useExpanded.blueprint（覆盖；空字符串=未写→继承）
 *  - tagline：self.tagline ?? useExpanded.tagline（覆盖）
 *  - domains：dedupByName([...useExpanded.domains, ...self.domains])（追加，self 优先去重）
 *  - groups：mergeGroupsByName（同名 self 替换整个 use group；§5.4） */
function mergeProfile(self: Profile, useExpanded: Profile): Profile {
  return {
    name: self.name, // 强制覆盖
    blueprint: self.blueprint || useExpanded.blueprint, // || 而非 ??：空字符串 falsy
    tagline: self.tagline ?? useExpanded.tagline,
    domains: dedupByName([...useExpanded.domains, ...self.domains]),
    groups: mergeGroupsByName(useExpanded.groups, self.groups),
    use: undefined, // 展开后 Profile 不再带 use（已消化，避免下游重复展开）
    sourcePack: self.sourcePack, // 身份不变
  };
}

/** §5.2 domains 追加去重——后者（self）优先，保留首次插入顺序。 */
function dedupByName(domains: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const d of domains) {
    if (seen.has(d)) continue;
    seen.add(d);
    result.push(d);
  }
  return result;
}

/** §5.4 mergeGroupsByName——self 同名 group 整个替换 use 的（含 modules + domains）。
 *  modules 列表是替换不是 union（§5.4 明示）。 */
function mergeGroupsByName(useGroups: ProfileGroup[], selfGroups: ProfileGroup[]): ProfileGroup[] {
  const result: ProfileGroup[] = [];
  for (const useGroup of useGroups) {
    const selfMatch = selfGroups.find((g) => g.name === useGroup.name);
    result.push(selfMatch ?? useGroup); // self 替换整个 group
  }
  for (const selfGroup of selfGroups) {
    if (!useGroups.find((g) => g.name === selfGroup.name)) {
      result.push(selfGroup); // self 独有 group 追加
    }
  }
  return result;
}

// ==================== §5.5：use 场景越权校验 ====================

/** §5.5 越权校验——use 场景 error。
 *  合并后 groups 的所有 group.name 必须在 self.blueprint 的 slots 里。
 *  blueprint 查不到时 return（transpile.ts 会另行报"未知 Blueprint"，不重复）。 */
function validateGroupScopeForUse(
  merged: Profile,
  self: Profile,
  blueprintByQualifiedName: Map<string, { pack: AssetPack; asset: Blueprint }>
): void {
  if (!merged.blueprint) return; // 无 blueprint 不校验（与今天一致）
  const { pack: bpPack, name: bpName } = parseRef(merged.blueprint, self.sourcePack ?? "");
  const bpEntry = blueprintByQualifiedName.get(`${bpPack}/${bpName}`);
  if (!bpEntry) return; // blueprint 查不到不校验（transpile 另行报错）
  const allowedSlots = bpEntry.asset.groups.map((g) => g.name);
  const outOfScope = merged.groups
    .map((g) => g.name)
    .filter((name) => !allowedSlots.includes(name));
  if (outOfScope.length > 0) {
    throw new BlueprintGroupOutOfScope(merged.name, outOfScope, merged.blueprint, allowedSlots);
  }
}
