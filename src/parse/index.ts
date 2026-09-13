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

import type { AssetPack, Profile, SchemaBundle, SourceAdapter } from "../schema.js";
import { findBlueprint, findProfile } from "../schema.js";
import {
  loadBuiltinPack,
  loadGlobalPack,
  loadProjectPack,
  loadSettingsPacks,
} from "../asset-pack/loader.js";
import { reportWarn } from "../diagnostics.js";
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
    const settingsPacks = await loadSettingsPacks(cwd); // PR1 stub 返 []
    const globalPack = await loadGlobalPack(adapterCtx);
    const builtinPack = await loadBuiltinPack(adapterCtx);
    const packs: AssetPack[] = [projectPack, ...settingsPacks, globalPack, builtinPack];

    // 2. 加载所有 pack 的资产（每个 pack 独立加载，不去重）
    const packDomains = await Promise.all(packs.map((p) => p.loadDomains()));
    const packBlueprints = await Promise.all(packs.map((p) => p.loadBlueprints()));
    const packProfiles = await Promise.all(packs.map((p) => p.loadProfiles()));

    // 3. N 元 dedupByNameN（§3.3）：settings 数组倒序（§3.3.1 后者赢）
    const domains = mergeAcrossPacks(packDomains);
    const blueprints = mergeAcrossPacks(packBlueprints);
    const profiles = mergeAcrossPacks(packProfiles);

    // 4. 找激活的 Profile（按 profileName）
    const active = findProfile(profiles, profileName);
    // v15.x PR2（§8.3）：active profile 所属 pack——按 dedup 前顺序找（与 dedupByNameN 前者赢一致）
    const activeProfilePack = active ? findProfilePack(packs, packProfiles, active.name) : "prj"; // fallback（active=null 时不应到达此分支）
    if (!active) {
      // fallback：取第一个 Profile
      const fallback = profiles[0];
      if (!fallback) {
        throw new Error(`Pt: 未找到 Profile "${profileName}"（profiles/*.profile.md）`);
      }
      // PR2：用第一个含 fallback profile 的 pack（与 dedupByNameN 一致）
      const fallbackPack = findProfilePack(packs, packProfiles, fallback.name);
      return {
        domains,
        blueprints,
        profiles,
        activeProfile: fallback.name,
        packs,
        activeProfilePack: fallbackPack,
      };
    }

    // 5. 校验 Profile 引用的 Blueprint 必须存在（明确的错误提示）
    const bp = findBlueprint(blueprints, active.blueprint);
    if (!bp && active.blueprint) {
      // 把"可用 Blueprint 列表"塞进 details，让日志/UI 用户能看到怎么改
      reportWarn(
        adapterCtx,
        `Profile "${active.name}" 引用了未知 Blueprint "${active.blueprint}"`,
        {
          profileName: active.name,
          referencedBlueprint: active.blueprint,
          availableBlueprints: blueprints.map((b) => b.name),
        }
      );
    }

    return {
      domains,
      blueprints,
      profiles,
      activeProfile: active.name,
      packs,
      activeProfilePack,
    };
  },
};

/** v15.x PR2（§8.3）：找 profile 所属 pack——按 dedup 前顺序，
 *  第一个含该 profile name 的 pack 赢（与 dedupByNameN 前者赢语义一致）。
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

// ==================== N 元 dedup（§3.3） ====================

/** N 元链式 dedupByName（§3.3）。
 *  语义：前者赢——按 packs 数组顺序，先出现的同 name asset 保留，后出现的被跳过。
 *  packs[0] = project（最高），中间 settings 数组已倒序（后者赢），
 *  倒数第二 = global，最后 = builtin。
 *  back-compat：settings=[] 时退化为 [project, global, builtin]，等价于今天的 2-arg 版本。
 *
 *  export 给 PR1 测试用——settings 倒序后者赢场景需要直接构造 packLists 验证。
 *  生产代码不推荐直接调——走 mergeAcrossPacks 处理 settings 倒序逻辑。 */
export function dedupByNameN<T extends { name: string }>(packs: T[][]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const pack of packs) {
    for (const asset of pack) {
      if (seen.has(asset.name)) continue;
      seen.add(asset.name);
      result.push(asset);
    }
  }
  return result;
}

/** 把 4 类 pack 的资产按"项目 → settings（倒序）→ global → builtin"顺序合并。
 *  packLists 长度 = 3（settings=[] 时）或 3+N（PR4 接通 settings 时 N 个 settings pack）。
 *  PR4 接通后中间 N 个元素是 settings packs，按数组下标顺序是"先声明的优先"，
 *  但这里我们 reverse——后声明的 pack 优先（npm 风格，§3.3.1）。
 *  抽出来避免 domains/blueprints/profiles 三处重复。
 *
 *  export 给 PR1 测试用——settings 倒序后者赢场景需要直接构造 packLists 验证。 */
export function mergeAcrossPacks<T extends { name: string }>(packLists: T[][]): T[] {
  if (packLists.length === 0) return [];
  // packLists[0] = project；最后两个 = global / builtin；中间 = settings 数组
  const settingsLen = packLists.length - 3;
  const settingsSlice = settingsLen > 0 ? packLists.slice(1, 1 + settingsLen).reverse() : [];
  const global = packLists[1 + settingsLen];
  const builtin = packLists[2 + settingsLen];
  return dedupByNameN<T>([packLists[0], ...settingsSlice, global, builtin]);
}

// 保留 parseX 函数的导出（其他模块 / 测试可能 import）。PR1 阶段 MdFilePack 已复用，
// 但 parseX 仍作为底层 parser 公开——加新 adapter 类型时可直接 import。
export { parseBlueprint, parseDomain, parseProfile };
