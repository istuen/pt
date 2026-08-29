// midend/layout.ts — SchemaBundle → LayoutedBundle
//
// Phase 2：中端编排变换。接收 SchemaBundle，按 layout.mode 重组 IR。
// 三种 mode 的变换策略（见 docs/pt-asset-layering.md §2.3）：
//   - byDomain：modules 按 domainOrder 排序，规则留在模块内。globalRules 为空。
//   - byType：  modules 原样保留（backend 跨模块聚合 terms/rules）。globalRules 为空。
//   - hybrid：  slot:"global" 的 rule 抽到 globalRules，其余 rule 留在模块内。
//              modules 按 domainOrder 排序。
//
// Rule.slot 语义契约（adapter/midend/backend 三方共识）：
//   - "global"      : 全局领域规则，hybrid 模式下抽到 globalRules
//   - "<具体 slot 名>": 步骤专属规则，留在模块内（backend 会按 slot 名匹配挂到对应步骤）
//
// Adapter 不感知 mode（前端/中端分离）；本文件只对 IR 做变换，不读来源、不生成 prompt。

import type {
  DomainModule,
  KnowledgeBase,
  Rule,
  SchemaBundle,
  StructureLayout,
} from "../schema.js";

/** 变换后的 IR：identity/flows 透传，modules 按 mode 重组，globalRules 抽出 slot:global。 */
export interface LayoutedBundle {
  /** hybrid 模式的「全局约束」段内容（slot:global 的 Rule 聚合）。byDomain/byType 永远为空。 */
  globalRules: Rule[];
  /**
   * byDomain/hybrid 的模块段内容（含 terms + 非 global rules）。
   * byType 也保留原 modules 供 backend 跨模块聚合（backend 按 mode 决定如何消费）。
   * hybrid 模式下：模块的 rules 已剥离 slot:global（被抽到 globalRules）。
   */
  modules: DomainModule[];
  mode: StructureLayout["mode"];
  identity: KnowledgeBase["identity"];
  flows: KnowledgeBase["flows"];
}

/** SchemaBundle → LayoutedBundle。按 layout.mode 应用不同变换。 */
export function layoutTransform(bundle: SchemaBundle): LayoutedBundle {
  const { mode, domainOrder } = bundle.knowledgeBase.layout;
  const sortedModules = sortByDomainOrder(bundle.knowledgeBase.modules, domainOrder);

  if (mode === "byDomain") {
    // 所有 rule 留模块内（含 slot:global），globalRules 为空。
    return {
      globalRules: [],
      modules: sortedModules,
      mode,
      identity: bundle.knowledgeBase.identity,
      flows: bundle.knowledgeBase.flows,
    };
  }

  if (mode === "byType") {
    // 全局聚合在 backend 做，layout 这里保留原样。
    return {
      globalRules: [],
      modules: sortedModules,
      mode,
      identity: bundle.knowledgeBase.identity,
      flows: bundle.knowledgeBase.flows,
    };
  }

  // hybrid：slot:global 的 rule 抽到 globalRules；其余 rule 留在模块内。
  const globalRules: Rule[] = [];
  const modules: DomainModule[] = sortedModules.map((mod) => {
    const globalFromMod: Rule[] = [];
    const localRules: Rule[] = [];
    for (const r of mod.rules) {
      if (r.slot === "global") {
        globalFromMod.push(r);
      } else {
        localRules.push(r);
      }
    }
    globalRules.push(...globalFromMod);
    return { ...mod, rules: localRules };
  });

  return {
    globalRules,
    modules,
    mode,
    identity: bundle.knowledgeBase.identity,
    flows: bundle.knowledgeBase.flows,
  };
}

/** 按 domainOrder 排序 modules。未声明顺序则原序。 */
function sortByDomainOrder(
  modules: DomainModule[],
  domainOrder: StructureLayout["domainOrder"],
): DomainModule[] {
  if (!domainOrder || domainOrder.length === 0) return modules;
  const orderMap = new Map<string, number>();
  domainOrder.forEach((name, i) => orderMap.set(name, i));
  return [...modules].sort((a, b) => {
    const ai = orderMap.get(a.name);
    const bi = orderMap.get(b.name);
    // 未声明顺序的 module 排到末尾
    if (ai === undefined && bi === undefined) return 0;
    if (ai === undefined) return 1;
    if (bi === undefined) return -1;
    return ai - bi;
  });
}
