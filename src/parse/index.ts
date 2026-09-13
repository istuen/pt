// src/parse/index.ts — Parse 前端入口
//
// Phase 9.3：v9 适配 — 枚举 profiles/（用户面是 Profile，不是 Blueprint）；
//   channels/ 删除（v9 Channel 留作未来 Connector，不实现）。
// 按目录位置分发载体（domains/ → domain adapter / blueprints/ → blueprint adapter / profiles/ → profile adapter）。
//
// v15.x PR1（§3.1）：mdAdapter.load 改为构造 AssetPack[] → 加载 → N 元 dedupByNameN。
//   - 加载顺序：project → settings → global → builtin（settings PR1 stub 返空）
//   - settings 数组内部 reverse（§3.3.1 后者赢）
//   - 删除 loadAllDomains/loadAllBlueprints/loadAllProfiles/loadAllBuiltin* 旧函数
//     ——它们的逻辑已迁入 src/asset-pack/md-file-pack.ts
//   - back-compat：settingsPacks=[] 时，dedupByNameN([project, global, builtin])
//     退化等价于今天的 dedupByName(project, builtin)（project 前者赢，builtin 补充）。

import type {
  AssetPack,
  Blueprint,
  Domain,
  Profile,
  SchemaBundle,
  SourceAdapter,
  SourceAdapterContext,
} from "../schema.js";
import {
  loadBuiltinPack,
  loadGlobalPack,
  loadProjectPack,
  loadSettingsPacks,
} from "../asset-pack/loader.js";
import { reportWarn } from "../diagnostics.js";
import { parseRef, resolveBlueprint } from "./ref-resolver.js";
import { parseBlueprint } from "./blueprint.js";
import { parseDomain } from "./domain.js";
import { parseProfile } from "./profile.js";

/** MD adapter：按目录位置分发到 domain/blueprint/profile adapter，组装 SchemaBundle。
 *  v9 命名约定：适配的是 MD 文件格式（不再叫 OXN——OXN 是历史名）。
 *  v15.x PR1（§3.1）：内部构造 4 类 AssetPack → loadXxx → N 元 dedupByNameN。 */
export const mdAdapter: SourceAdapter = {
  name: "md",

  async load(cwd, profileName, adapterCtx): Promise<SchemaBundle> {
    // 1. 构造 4 类 pack（§3.1 顺序：project → settings → global → builtin）
    const projectPack = await loadProjectPack(cwd, adapterCtx);
    const settingsPacks = await loadSettingsPacks(cwd); // PR4 接通：读 .pi/settings.json pt.asset-packs
    const globalPack = await loadGlobalPack(adapterCtx);
    const builtinPack = await loadBuiltinPack(adapterCtx);

    // v15.x PR4（§3.3.1）：settings 倒序——后者赢（npm 风格）
    // packs 顺序 = [project, ...settings.reverse(), global, builtin]
    // findActiveProfile 不限定 ref 按此顺序前者赢 → project > 后声明 settings > 先声明 settings > global > builtin
    const packs: AssetPack[] = [
      projectPack,
      ...settingsPacks.slice().reverse(),
      globalPack,
      builtinPack,
    ];

    // v15.x PR4（§3.4）：pack name 全局唯一性校验——settings pack 之间同名报错
    checkPackNameConflicts(packs, adapterCtx);

    // 2. v15.x PR3（§4.4.4）：构建 working set——不去重，每份带 pack 标签
    const domainWS = new Map<string, { pack: AssetPack; asset: Domain }>();
    const blueprintWS = new Map<string, { pack: AssetPack; asset: Blueprint }>();
    const profileWS = new Map<string, { pack: AssetPack; asset: Profile }>();
    const packProfiles: Profile[][] = [];
    const allDomains: Domain[] = [];
    const allBlueprints: Blueprint[] = [];
    const allProfiles: Profile[] = [];

    for (const pack of packs) {
      const packDoms = await pack.loadDomains();
      for (const d of packDoms) {
        domainWS.set(`${pack.name}/${d.name}`, { pack, asset: d });
        allDomains.push(d);
      }
      const packBps = await pack.loadBlueprints();
      for (const b of packBps) {
        blueprintWS.set(`${pack.name}/${b.name}`, { pack, asset: b });
        allBlueprints.push(b);
      }
      const packProfs = await pack.loadProfiles();
      for (const p of packProfs) {
        profileWS.set(`${pack.name}/${p.name}`, { pack, asset: p });
        allProfiles.push(p);
      }
      packProfiles.push(packProfs);
    }

    // 3. 找 active profile（PR3：支持 "foo" 和 "@pack/foo" 两种）
    let active: Profile;
    try {
      active = findActiveProfile(packs, packProfiles, profileName);
    } catch (e) {
      // active 没找到时 fallback 到第一个 profile（与今天行为一致）
      const fallback = allProfiles[0];
      if (!fallback) {
        throw e; // 真的没 profile——抛错
      }
      active = fallback;
    }

    // 4. 校验 active 引用的 Blueprint 存在（用 working set）
    // v15.x PR6（fix pt-parse-blueprint-warn-misleading）：改用 resolveBlueprint helper
    // 与 compile 阶段（transpile.ts:145）共用 fallback 逻辑——避免 parse 层单方面
    // 报 "unknown Blueprint" warn 但 compile 层能 fallback 成功的 false positive。
    // 行为：
    //   - 不限定 ref + 跨 pack fallback 命中 → 静默（compile 阶段会复用同一 fallback）
    //   - 限定 ref 找不到 / 不限定 ref fallback 全部 miss → warn（compile 阶段会 throw）
    const bpResolved = resolveBlueprint(active, blueprintWS, packs.map((p) => p.name));
    if (!bpResolved && active.blueprint) {
      const { pack: bpPack, name: bpName } = parseRef(
        active.blueprint,
        active.sourcePack ?? ""
      );
      reportWarn(
        adapterCtx,
        `Profile "${active.name}" 引用了未知 Blueprint "${active.blueprint}"`,
        {
          profileName: active.name,
          referencedBlueprint: active.blueprint,
          resolvedBlueprint: `@${bpPack}/${bpName}`,
          availableBlueprints: [...blueprintWS.keys()],
        }
      );
    }

    return {
      domains: allDomains,
      blueprints: allBlueprints,
      profiles: allProfiles,
      activeProfile: active.name,
      packs,
      activeProfilePack: findProfilePack(packs, packProfiles, active.name),
      workingSet: { domains: domainWS, blueprints: blueprintWS, profiles: profileWS },
    };
  },
};

/** v15.x PR3：找 active profile——支持 "foo" 和 "@pack/foo" 两种。
 *  限定 ref 直接查目标 pack；不限定按 packs 顺序前者赢（project > settings 倒序 > global > builtin）。
 *  v15.x PR4：settings 倒序逻辑由 mdAdapter.load 构造 packs 时已处理，findActiveProfile 不变。 */
function findActiveProfile(
  packs: AssetPack[],
  packProfiles: Profile[][],
  profileRef: string
): Profile {
  if (profileRef.startsWith("@")) {
    const { pack, name } = parseRef(profileRef, ""); // 限定 ref 不需要 selfPack
    const packIdx = packs.findIndex((p) => p.name === pack);
    if (packIdx < 0) {
      throw new Error(`active profile "@${pack}/${name}" references unknown pack "${pack}"`);
    }
    const found = packProfiles[packIdx]?.find((p) => p.name === name);
    if (!found) {
      throw new Error(`active profile "@${pack}/${name}" not found in pack "${pack}"`);
    }
    return found;
  }
  for (let i = 0; i < packs.length; i++) {
    const found = packProfiles[i]?.find((p) => p.name === profileRef);
    if (found) return found;
  }
  throw new Error(`active profile "${profileRef}" not found in any pack`);
}

/** v15.x PR2（§8.3）：找 profile 所属 pack——按 dedup 前顺序，
 *  第一个含该 profile name 的 pack 赢（PR3 后 working set 取代 dedup，但 cache 文件名仍用 pack name）。
 *  fallback "prj"（不应到达——active profile 必来自某 pack）。 */
function findProfilePack(
  packs: AssetPack[],
  packProfiles: Profile[][],
  profileName: string
): string {
  for (let i = 0; i < packs.length; i++) {
    if (packProfiles[i]?.some((p) => p.name === profileName)) {
      return packs[i].name;
    }
  }
  return "prj";
}

/** v15.x PR4（§3.4）：pack name 全局唯一性校验。
 *  settings pack 之间 manifest.name 冲突 → warn 提示去重（不静默覆盖）。
 *  project/settings 覆盖 global/builtin = 合理优先级，静默（§3.4 表）。
 *
 *  实现：扫所有 pack，按 name 分组——同 name 的 pack 如有任一是 settings 来源则 warn。
 *  reserved 名（prj/gbl/pt）只 1 份，不会冲突。settings pack manifest.name 不能是 reserved 名
 *  （PR2 manifest 校验已挡），所以不会与 reserved 重名。 */
function checkPackNameConflicts(packs: AssetPack[], adapterCtx?: SourceAdapterContext): void {
  const seen = new Map<string, AssetPack[]>();
  for (const pack of packs) {
    const arr = seen.get(pack.name) ?? [];
    arr.push(pack);
    seen.set(pack.name, arr);
  }
  for (const [name, group] of seen) {
    if (group.length <= 1) continue;
    // 同 name 多份——如有 settings 来源则 warn（§3.4）
    const hasSettings = group.some((p) => p.source === "settings");
    if (hasSettings) {
      const paths = group.map((p) => p.rootDir).join('" and "');
      reportWarn(
        adapterCtx,
        `pack "${name}" loaded from both "${paths}" — remove one from pt.asset-packs（§3.4 pack 身份冲突）`,
        { packName: name, paths: group.map((p) => p.rootDir) }
      );
    }
  }
}

// 保留 parseX 函数的导出（其他模块 / 测试可能 import）。PR1 阶段 MdFilePack 已复用，
// 但 parseX 仍作为底层 parser 公开——加新 adapter 类型时可直接 import。
export { parseBlueprint, parseDomain, parseProfile };
