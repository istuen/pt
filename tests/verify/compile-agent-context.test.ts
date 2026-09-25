// tests/verify/compile-agent-context.test.ts — compileAgentContext + computeSourceHash 单元测试（P2.5）
//
// v9 AgentContext IR = { name, blueprint, sourceHash, modules: Record<聚合组名, markdown 字符串> }
//  - 遍历 Blueprint.groups，按 modName 注册表聚合 Profile 同名 ProfileGroup 追加的 Domain H2 段
//  - sourceHash = hash(profile + blueprint + domains)，缓存失效依据
//
// Phase term-P1：compile-context.test.ts → compile-agent-context.test.ts
//   同步改名 compileContext → compileAgentContext（IR 改名）。

import { describe, it, expect, beforeAll } from "vitest";
import { compileAgentContext, computeSourceHash } from "../../src/compile/agent-context.js";
import type { Blueprint, Domain, Profile } from "../../src/schema.js";

function makeProfile(overrides?: Partial<Profile>): Profile {
  return {
    name: "test-profile",
    blueprint: "test-blueprint",
    domains: ["d1"],
    // v9.1+（modules-to-profile-complete）：modules 元素从 string 改为 ModName 对象
    groups: [{ name: "session-context", domains: [], modules: [{ section: "Scene" }] }],
    // v15.x PR3：测试 profile 默认 sourcePack="prj"（不限定 ref 绑定需要）
    sourcePack: "prj",
    ...overrides,
  };
}

function makeBlueprint(overrides?: Partial<Blueprint>): Blueprint {
  return {
    name: "test-blueprint",
    groups: [{ name: "session-context", inject: "session" }],
    ...overrides,
  };
}

function makeDomain(overrides?: Partial<Domain>): Domain {
  return {
    name: "d1",
    modules: {
      Scene: [{ name: "t1", desc: "term 1 desc" }],
    },
    ...overrides,
  };
}

// v15.x PR2 + PR3 + §4.4.2：compileAgentContext/computeSourceHash 加 packs + 双索引 workingSet 参数
// 测试用 ds 构造 domain workingSet——profile.domains 解析时能查 "prj/<name>"（identity + location 双索引）
function compileCtx(p: Profile, bp: Blueprint, ds: Domain[]) {
  const pack = makePack("prj", "/test");
  const domainIdWS = new Map<string, { pack: AssetPack; asset: Domain }>();
  const domainLocWS = new Map<string, { pack: AssetPack; asset: Domain }>();
  for (const d of ds) {
    domainIdWS.set(`prj/${d.name}`, { pack, asset: d });
    domainLocWS.set(`prj/${d.name}`, { pack, asset: d });
  }
  const blueprintIdWS = new Map<string, { pack: AssetPack; asset: Blueprint }>();
  const blueprintLocWS = new Map<string, { pack: AssetPack; asset: Blueprint }>();
  blueprintIdWS.set(`prj/${bp.name}`, { pack, asset: bp });
  blueprintLocWS.set(`prj/${bp.name}`, { pack, asset: bp });
  return compileAgentContext(p, bp, ds, [pack], "prj", {
    domains: { location: domainLocWS, identity: domainIdWS },
    blueprints: { location: blueprintLocWS, identity: blueprintIdWS },
    profiles: { location: new Map(), identity: new Map() },
  });
}
function hashCtx(p: Profile, bp: Blueprint, ds: Domain[]) {
  return computeSourceHash(p, bp, ds, []);
}

// v15.x PR3b（§4.5.2）：测试用 factory——直接构造 refDomains + bpGroup + profileGroup
function makeMod(section: string, item?: string): { section: string; item?: string } {
  return item ? { section, item } : { section };
}

// v15.x PR2（§8.1）：构造测试 AssetPack（mock 简化版本）
function makePack(name: string, rootDir: string): AssetPack {
  return {
    name,
    rootDir,
    version: "0.0.0",
    source: "project",
    manifestWarnings: [],
    loadDomains: () => Promise.resolve([]),
    loadBlueprints: () => Promise.resolve([]),
    loadProfiles: () => Promise.resolve([]),
  };
}

describe("compileAgentContext", () => {
  it("返回 AgentContext 基础字段：name / blueprint / sourceHash", () => {
    const p = makeProfile();
    const bp = makeBlueprint();
    const ds = [makeDomain()];
    const ctx = compileCtx(p, bp, ds);
    expect(ctx.name).toBe("test-profile");
    expect(ctx.blueprint).toBe("test-blueprint");
    // sourceHash = simpleHash(FNV-1a 32-bit hex) + "-" + payload.length hex
    expect(ctx.sourceHash).toMatch(/^[a-f0-9]+(-[a-f0-9]+)?$/);
  });

  it("按 Blueprint.groups 聚合 Profile 聚合组的 Domain H2 段", () => {
    const p = makeProfile({ domains: ["d1"] });
    const bp = makeBlueprint();
    const ds = [makeDomain({ modules: { Scene: [{ name: "t1", desc: "term 1" }] } })];
    const ctx = compileCtx(p, bp, ds);
    expect(ctx.modules["session-context"]).toContain("t1");
    expect(ctx.modules["session-context"]).toContain("term 1");
  });

  it("Profile 聚合组追加的 Domain（groups[].domains）也参与聚合", () => {
    const p = makeProfile({
      domains: [],
      groups: [{ name: "session-context", domains: ["d2"], modules: [{ section: "Scene" }] }],
    });
    const bp = makeBlueprint();
    const ds = [
      makeDomain({ name: "d1" }),
      makeDomain({
        name: "d2",
        modules: { Scene: [{ name: "t2", desc: "term 2" }] },
      }),
    ];
    const ctx = compileCtx(p, bp, ds);
    expect(ctx.modules["session-context"]).toContain("t2");
    expect(ctx.modules["session-context"]).not.toContain("t1"); // d1 不在追加列表
  });

  it("Blueprint 未声明的聚合组不在 AgentContext.modules 中", () => {
    const p = makeProfile({
      groups: [
        { name: "session-context", domains: [], modules: [{ section: "Scene" }] },
        { name: "未声明聚合组", domains: [], modules: [] },
      ],
    });
    const bp = makeBlueprint();
    const ctx = compileCtx(p, bp, [makeDomain()]);
    expect(ctx.modules["session-context"]).toBeDefined();
    expect(ctx.modules.未声明聚合组).toBeUndefined();
  });
});

describe("computeSourceHash", () => {
  it("同输入 → 同 hash（稳定性）", () => {
    const p = makeProfile();
    const bp = makeBlueprint();
    const ds = [makeDomain()];
    const h1 = hashCtx(p, bp, ds);
    const h2 = hashCtx(p, bp, ds);
    expect(h1).toBe(h2);
  });

  it("对象 keys 顺序不同 → 同 hash（stableStringify 排序对象 keys）", () => {
    // 注意：数组视为有序（不是 sorted），所以不能测 domains 数组顺序
    // 只测对象 literal 的 keys 构造顺序不同 → stableStringify 排序后相同
    const p1: Profile = {
      name: "p",
      blueprint: "b",
      domains: [],
      groups: [],
      sourcePack: "prj",
    };
    const p2: Profile = {
      groups: [],
      domains: [],
      blueprint: "b",
      name: "p",
      sourcePack: "prj",
    };
    expect(hashCtx(p1, makeBlueprint(), [])).toBe(hashCtx(p2, makeBlueprint(), []));
  });

  it("不同 Profile.name → 不同 hash", () => {
    const h1 = hashCtx(makeProfile({ name: "p1" }), makeBlueprint(), [makeDomain()]);
    const h2 = hashCtx(makeProfile({ name: "p2" }), makeBlueprint(), [makeDomain()]);
    expect(h1).not.toBe(h2);
  });

  it("不同 Blueprint.groups → 不同 hash", () => {
    const h1 = hashCtx(
      makeProfile(),
      makeBlueprint({
        groups: [{ name: "session-context", inject: "session" }],
      }),
      [makeDomain()]
    );
    const h2 = hashCtx(
      makeProfile(),
      makeBlueprint({
        groups: [{ name: "reference-manual", inject: "turn" }],
      }),
      [makeDomain()]
    );
    expect(h1).not.toBe(h2);
  });

  it("不同 domains → 不同 hash", () => {
    const h1 = hashCtx(makeProfile(), makeBlueprint(), [makeDomain({ name: "d1" })]);
    const h2 = hashCtx(makeProfile(), makeBlueprint(), [makeDomain({ name: "d2" })]);
    expect(h1).not.toBe(h2);
  });

  it("PR2 §8.1：packs[].name 变化 → hash 变化", () => {
    const p = makeProfile();
    const bp = makeBlueprint();
    const ds = [makeDomain()];
    const packs1 = [makePack("prj", "/x")];
    const packs2 = [makePack("gbl", "/x")];
    expect(computeSourceHash(p, bp, ds, packs1)).not.toBe(computeSourceHash(p, bp, ds, packs2));
  });

  it("PR2 §8.1：packs[].rootDir 变化 → hash 变化", () => {
    const p = makeProfile();
    const bp = makeBlueprint();
    const ds = [makeDomain()];
    const packs1 = [makePack("prj", "/path/a")];
    const packs2 = [makePack("prj", "/path/b")];
    expect(computeSourceHash(p, bp, ds, packs1)).not.toBe(computeSourceHash(p, bp, ds, packs2));
  });

  it("PR2 §8.1：packs[].version 变化 → hash 不变（M1：内容 hash 已覆盖）", () => {
    const p = makeProfile();
    const bp = makeBlueprint();
    const ds = [makeDomain()];
    const pack1: AssetPack = { ...makePack("prj", "/x"), version: "1.0.0" };
    const pack2: AssetPack = { ...makePack("prj", "/x"), version: "2.0.0" };
    expect(computeSourceHash(p, bp, ds, [pack1])).toBe(computeSourceHash(p, bp, ds, [pack2]));
  });

  it("PR2 §8.1：packs 列表从空变非空 → hash 变化（cache 失效）", () => {
    const p = makeProfile();
    const bp = makeBlueprint();
    const ds = [makeDomain()];
    expect(computeSourceHash(p, bp, ds, [])).not.toBe(
      computeSourceHash(p, bp, ds, [makePack("prj", "/x")])
    );
  });
});

describe("renderSceneModule term — fields/note 输出（v9.2 修复）", () => {
  // 背景：parse 阶段 Term 拿到 fields/note 后，compile 渲染要输出
  // `- name: desc（字段：a/b/c）` 和 `- name: desc — note`；两者都有则两者都输出。
  // 无 fields/note 时保持 v9 输出：`- name: desc`。
  it("有 fields → 产物含 `（字段：a/b/c）`", () => {
    const ds: Domain[] = [
      makeDomain({
        modules: {
          Scene: [
            {
              name: "task-description",
              desc: "派给执行者的任务描述",
              fields: ["必读", "设计原则", "步骤"],
            },
          ],
        },
      }),
    ];
    const ctx = compileCtx(makeProfile(), makeBlueprint(), ds);
    expect(ctx.modules["session-context"]).toContain("（字段：必读/设计原则/步骤）");
  });

  it("有 note → 产物含 ` — note`", () => {
    const ds: Domain[] = [
      makeDomain({
        modules: {
          Scene: [
            {
              name: "acceptance",
              desc: "验收者独立复验的准则",
              note: "每个硬指标都要有独立验证方式",
            },
          ],
        },
      }),
    ];
    const ctx = compileCtx(makeProfile(), makeBlueprint(), ds);
    expect(ctx.modules["session-context"]).toContain(" — 每个硬指标都要有独立验证方式");
  });

  it("fields + note 同时有 → 两个追加都输出", () => {
    const ds: Domain[] = [
      makeDomain({
        modules: {
          Scene: [
            {
              name: "task-description",
              desc: "desc",
              fields: ["a", "b"],
              note: "note text",
            },
          ],
        },
      }),
    ];
    const ctx = compileCtx(makeProfile(), makeBlueprint(), ds);
    // 顺序：name: desc（字段：a/b） — note
    const out = ctx.modules["session-context"];
    expect(out).toContain("（字段：a/b）");
    expect(out).toContain(" — note text");
    expect(out).toContain("- task-description: desc");
  });

  it("无 fields/note → 输出保持 v9 兼容（无中文括号 / 破折号追加）", () => {
    const ds: Domain[] = [
      makeDomain({
        modules: { Scene: [{ name: "plain", desc: "just desc" }] },
      }),
    ];
    const ctx = compileCtx(makeProfile(), makeBlueprint(), ds);
    expect(ctx.modules["session-context"]).toContain("- plain: just desc");
    // 不应出现 fields/note 追加
    expect(ctx.modules["session-context"]).not.toContain("（字段：");
    expect(ctx.modules["session-context"]).not.toContain(" — ");
  });
});

/** v9.1+（modules-to-profile-complete）：H3 项粒度 modules（段.项）
 *  - modName "User.user-profile" 精确选 H3 项
 *  - modName "User.senior-developer" 在 User 段不匹配 senior-developer（跨段不跨段匹配） */
describe("compileAgentContext H3 项粒度（v9.1+ modules-to-profile-complete）", () => {
  it("段.项形态：精确选 H3 项 → 输出 ### <domain>.<item> 形式", () => {
    const p: Profile = {
      ...makeProfile(),
      domains: ["user-info"], // 全局 domains 含 user-info
      groups: [
        {
          name: "session-context",
          domains: [],
          modules: [{ section: "User", item: "user-profile" }],
        },
      ],
      sourcePack: "prj",
    };
    const ds: Domain[] = [
      makeDomain({
        name: "user-info",
        modules: {
          User: [
            { name: "user-profile", desc: "Pt 项目作者与架构师" },
            { name: "pt-goal", desc: "Pt 要成为异构上下文编译器" },
          ],
        },
      }),
    ];
    const ctx = compileCtx(p, makeBlueprint(), ds);
    // H3 项粒度输出：只 user-profile，不含 pt-goal
    expect(ctx.modules["session-context"]).toContain("### user-info.user-profile");
    expect(ctx.modules["session-context"]).toContain("user-profile: Pt 项目作者与架构师");
    expect(ctx.modules["session-context"]).not.toContain("pt-goal");
    expect(ctx.modules["session-context"]).not.toContain("### user-info.pt-goal");
  });

  it("段.项形态：H3 项不存在 → 产出空段", () => {
    const p: Profile = {
      ...makeProfile(),
      domains: ["user-info"],
      groups: [
        {
          name: "session-context",
          domains: [],
          modules: [{ section: "User", item: "nonexistent" }],
        },
      ],
    };
    const ds: Domain[] = [
      makeDomain({
        name: "user-info",
        modules: { User: [{ name: "user-profile", desc: "desc" }] },
      }),
    ];
    const ctx = compileCtx(p, makeBlueprint(), ds);
    expect(ctx.modules["session-context"]).toBe("");
  });

  it("段.项形态：跨段同名 H3 不跨段匹配（User.x 不匹配 Agent.x）", () => {
    const p: Profile = {
      ...makeProfile(),
      domains: ["user-info", "agent-info"],
      groups: [
        {
          name: "session-context",
          domains: [],
          modules: [{ section: "User", item: "shared" }],
        },
      ],
    };
    const ds: Domain[] = [
      makeDomain({
        name: "user-info",
        modules: { User: [{ name: "shared", desc: "in user-info User 段" }] },
      }),
      makeDomain({
        name: "agent-info",
        modules: { Agent: [{ name: "shared", desc: "in agent-info Agent 段" }] },
      }),
    ];
    const ctx = compileCtx(p, makeBlueprint(), ds);
    // 只匹配 User 段下 shared，不匹配 Agent 段下
    expect(ctx.modules["session-context"]).toContain("in user-info User 段");
    expect(ctx.modules["session-context"]).not.toContain("in agent-info Agent 段");
  });

  it("段.项形态：同段内 H3 重名 → 后覆盖前（只取最后一个）", () => {
    const p: Profile = {
      ...makeProfile(),
      domains: ["user-info"],
      groups: [
        {
          name: "session-context",
          domains: [],
          modules: [{ section: "User", item: "shared" }],
        },
      ],
    };
    const ds: Domain[] = [
      makeDomain({
        name: "user-info",
        modules: {
          User: [
            { name: "shared", desc: "first occurrence" },
            { name: "shared", desc: "second occurrence (overrides first)" },
          ],
        },
      }),
    ];
    const ctx = compileCtx(p, makeBlueprint(), ds);
    expect(ctx.modules["session-context"]).toContain("second occurrence");
    expect(ctx.modules["session-context"]).not.toContain("first occurrence");
  });

  it("段名形态：整段聚合 → 跨所有引用域该段", () => {
    const p: Profile = {
      ...makeProfile(),
      domains: ["user-info", "agent-info"],
      groups: [
        {
          name: "session-context",
          domains: [],
          modules: [{ section: "User" }],
        },
      ],
    };
    const ds: Domain[] = [
      makeDomain({
        name: "user-info",
        modules: { User: [{ name: "user-profile", desc: "u" }] },
      }),
      makeDomain({
        name: "agent-info",
        modules: { Agent: [{ name: "agent-role-architect", desc: "a" }] },
      }),
    ];
    const ctx = compileCtx(p, makeBlueprint(), ds);
    // User 段聚合：只 user-info 的 User 段（agent-info 没有 User 段）
    expect(ctx.modules["session-context"]).toContain("user-profile");
    expect(ctx.modules["session-context"]).not.toContain("agent-role-architect");
  });
});

// ==================== PR3b §4.5.2：mergeSectionContent + dispatchGroup mixin ====================

describe("mergeSectionContent（PR3b §4.5.2）", () => {
  // v15.x PR3b：直接 import mergeSectionContent（export 供测试可见性）
  let mergeSectionContent: typeof import("../../src/compile/agent-context.js").mergeSectionContent;
  beforeAll(async () => {
    const mod = await import("../../src/compile/agent-context.js");
    mergeSectionContent = mod.mergeSectionContent;
  });

  it("单份 Term[] → 原样返回（back-compat 零开销）", () => {
    const d = makeDomain({
      name: "foo",
      modules: { Scene: [{ name: "t1", desc: "single" }] },
    });
    const out = mergeSectionContent([d], "Scene");
    expect(out).toEqual([{ name: "t1", desc: "single" }]);
  });

  it("两份 Term[] 不同 name → union by name（两 name 都保留）", () => {
    const d1 = makeDomain({
      name: "foo",
      modules: { Scene: [{ name: "t1", desc: "from prj" }] },
    });
    const d2 = makeDomain({
      name: "foo",
      modules: { Scene: [{ name: "t2", desc: "from pt" }] },
    });
    const out = mergeSectionContent([d1, d2], "Scene") as Array<{ name: string }>;
    expect(out).toHaveLength(2);
    expect(out.map((t) => t.name).sort()).toEqual(["t1", "t2"]);
  });

  it("两份 Term[] 同 name → 后写覆盖前写（场景 E mixin）", () => {
    const d1 = makeDomain({
      name: "foo",
      modules: { Scene: [{ name: "shared", desc: "from prj" }] },
    });
    const d2 = makeDomain({
      name: "foo",
      modules: { Scene: [{ name: "shared", desc: "from pt" }] },
    });
    const out = mergeSectionContent([d1, d2], "Scene") as Array<{
      name: string;
      desc: string;
    }>;
    expect(out).toHaveLength(1);
    expect(out[0]?.desc).toBe("from pt"); // 后写覆盖前写
  });

  it("两份 Rule[] → union by name", () => {
    const d1 = makeDomain({
      name: "foo",
      modules: {
        Rules: [{ name: "rule1", slot: "global", type: "invariant", check: "from prj" }],
      },
    });
    const d2 = makeDomain({
      name: "foo",
      modules: {
        Rules: [
          { name: "rule1", slot: "global", type: "invariant", check: "from pt" },
          { name: "rule2", slot: "global", type: "invariant", check: "extra" },
        ],
      },
    });
    const out = mergeSectionContent([d1, d2], "Rules") as Array<{ name: string }>;
    expect(out.map((r) => r.name).sort()).toEqual(["rule1", "rule2"]);
  });

  it("两份 FlowTemplate[] → union by name", () => {
    const d1 = makeDomain({
      name: "foo",
      modules: {
        Flows: [{ name: "flow-a", intent: "from prj", steps: [] }],
      },
    });
    const d2 = makeDomain({
      name: "foo",
      modules: {
        Flows: [{ name: "flow-b", intent: "from pt", steps: [] }],
      },
    });
    const out = mergeSectionContent([d1, d2], "Flows") as Array<{ name: string }>;
    expect(out.map((f) => f.name).sort()).toEqual(["flow-a", "flow-b"]);
  });

  it("两份 Checklist[] → union by name", () => {
    const d1 = makeDomain({
      name: "foo",
      modules: {
        Checklists: [{ name: "cl-a", items: ["x"] }],
      },
    });
    const d2 = makeDomain({
      name: "foo",
      modules: {
        Checklists: [{ name: "cl-b", items: ["y"] }],
      },
    });
    const out = mergeSectionContent([d1, d2], "Checklists") as Array<{ name: string }>;
    expect(out.map((c) => c.name).sort()).toEqual(["cl-a", "cl-b"]);
  });

  it("两份 Trigger 项[] → union by name", () => {
    const d1 = makeDomain({
      name: "foo",
      modules: {
        Trigger: [{ name: "t1", desc: "from prj" }],
      },
    });
    const d2 = makeDomain({
      name: "foo",
      modules: {
        Trigger: [{ name: "t2", desc: "from pt" }],
      },
    });
    const out = mergeSectionContent([d1, d2], "Trigger") as Array<{ name: string }>;
    expect(out.map((t) => t.name).sort()).toEqual(["t1", "t2"]);
  });

  it("所有 domain 都无该 section → undefined", () => {
    const d1 = makeDomain({ name: "foo", modules: { Scene: [{ name: "t1" }] } });
    expect(mergeSectionContent([d1], "Rules")).toBeUndefined();
  });

  it("未知 schema → 保守取首份（不 union）", () => {
    const d1 = makeDomain({
      name: "foo",
      modules: { Custom: "this is a string, not array" },
    });
    const d2 = makeDomain({
      name: "foo",
      modules: { Custom: "this is another string" },
    });
    // 类型不匹配 type guards（全是 string）→ fallback 取首份
    expect(mergeSectionContent([d1, d2], "Custom")).toBe("this is a string, not array");
  });
});

describe("dispatchGroup 场景 D/E mixin（PR3b §4.5.2 集成）", () => {
  let dispatchGroup: typeof import("../../src/compile/agent-context.js").dispatchGroup;
  beforeAll(async () => {
    const mod = await import("../../src/compile/agent-context.js");
    dispatchGroup = mod.dispatchGroup;
  });

  function buildGroups(section: string) {
    return {
      bpGroup: { name: "g", inject: "session" as const, mode: "hybrid" as const },
      profileGroup: {
        name: "g",
        domains: [] as string[],
        modules: [makeMod(section)],
      },
    };
  }

  it("场景 D：两份同 name 同内容 → ### foo 标题出现一次 + term 出现一次", () => {
    const d1 = makeDomain({
      name: "foo",
      modules: { Scene: [{ name: "term-a", desc: "same content" }] },
    });
    const d2 = makeDomain({
      name: "foo",
      modules: { Scene: [{ name: "term-a", desc: "same content" }] },
    });
    const { bpGroup, profileGroup } = buildGroups("Scene");
    const out = dispatchGroup(profileGroup, bpGroup, [d1, d2]);
    // ### foo 出现 1 次（不渲染两次）
    expect(out.match(/### foo/g)?.length).toBe(1);
    // term-a 出现 1 次（同 name union 后保留一份）
    expect(out.match(/term-a/g)?.length).toBe(1);
  });

  it("场景 E：两份同 name 不同内容 → 内容 union（后写覆盖前写）", () => {
    const d1 = makeDomain({
      name: "foo",
      modules: { Scene: [{ name: "term-a", desc: "from prj" }] },
    });
    const d2 = makeDomain({
      name: "foo",
      modules: {
        Scene: [
          { name: "term-b", desc: "from pt" },
          { name: "term-a", desc: "from pt override" },
        ],
      },
    });
    const { bpGroup, profileGroup } = buildGroups("Scene");
    const out = dispatchGroup(profileGroup, bpGroup, [d1, d2]);
    expect(out.match(/### foo/g)?.length).toBe(1);
    expect(out).toContain("term-b: from pt");
    expect(out).toContain("term-a: from pt override"); // 后写覆盖前写
    expect(out).not.toContain("from prj"); // 旧版覆盖
  });

  it("单份场景 back-compat：输出与今天格式完全一致", () => {
    const d = makeDomain({
      name: "foo",
      modules: { Scene: [{ name: "term-a", desc: "single domain" }] },
    });
    const { bpGroup, profileGroup } = buildGroups("Scene");
    const out = dispatchGroup(profileGroup, bpGroup, [d]);
    expect(out).toContain("### foo");
    expect(out).toContain("- term-a: single domain");
    expect(out.match(/### foo/g)?.length).toBe(1);
  });

  it("段.项粒度 + 两份 → union 后按 item 找（renderItemModule mixin）", () => {
    const d1 = makeDomain({
      name: "user-info",
      modules: { User: [{ name: "user-profile", desc: "from prj" }] },
    });
    const d2 = makeDomain({
      name: "user-info",
      modules: {
        User: [
          { name: "user-profile", desc: "from pt override" },
          { name: "pt-goal", desc: "extra" },
        ],
      },
    });
    const bpGroup = { name: "g", inject: "session" as const, mode: "hybrid" as const };
    const profileGroup = {
      name: "g",
      domains: [] as string[],
      modules: [makeMod("User", "user-profile")], // 段.项粒度
    };
    const out = dispatchGroup(profileGroup, bpGroup, [d1, d2]);
    // d0 = d1（首个有 User 段的 domain）→ ### d1.name
    expect(out).toContain("### user-info.user-profile");
    // union 后选 user-profile，fp 不同但 name 相同 → d2 版本胜
    expect(out).toContain("from pt override");
  });
});

// v15.x PR5 M1（§5.5.1 S7）：非 use 越权 warn——Profile 有 blueprint 没有的 group
//  - 不阻断（compileAgentContext 不抛错，产物返空 modules）
//  - 含 hint 区分 use 场景 (error) vs 非 use 场景 (warn)
describe("compileAgentContext 非 use 越权 warn（PR5 §5.5.1 S7）", () => {
  it("Profile H2 group 不在 Blueprint 插槽 → warn 不阻断 + hint 区分", async () => {
    const mod = await import("../../src/compile/agent-context.js");
    // blueprint 只含 "session-context"；profile 含两个 group（"session-context"合法 + "越权插槽"越权）
    const profile = makeProfile({
      name: "over-scoped",
      groups: [
        { name: "session-context", domains: ["d1"], modules: [makeMod("Scene")] },
        { name: "越权插槽", domains: ["d1"], modules: [makeMod("Scene")] },
      ],
    });
    const blueprint = makeBlueprint({
      groups: [{ name: "session-context", inject: "session" }],
    });
    const domain = makeDomain();
    // 收集 warn：reportWarn 走 adapterCtx.log.warn（见 src/diagnostics.ts 三通道 fallback）
    const messages: string[] = [];
    const detailsAll: unknown[] = [];
    const ctx = {
      assetDir: "/test",
      log: {
        warn: (msg: string, details?: unknown) => {
          messages.push(msg);
          detailsAll.push(details);
        },
      },
    };
    // 不抛错 = 不阻断
    const out = mod.compileAgentContext(
      profile,
      blueprint,
      [domain],
      [makePack("prj", "/test")],
      "prj",
      {
        domains: {
          location: new Map([["prj/d1", { pack: makePack("prj", "/test"), asset: domain }]]),
          identity: new Map([["prj/d1", { pack: makePack("prj", "/test"), asset: domain }]]),
        },
        blueprints: {
          location: new Map([
            ["prj/test-blueprint", { pack: makePack("prj", "/test"), asset: blueprint }],
          ]),
          identity: new Map([
            ["prj/test-blueprint", { pack: makePack("prj", "/test"), asset: blueprint }],
          ]),
        },
        profiles: { location: new Map(), identity: new Map() },
      },
      ctx
    );
    // 产物返有效 modules（合法 group 照常编译，越权 group 被忽略——modules 只含合法 group）
    expect(out.modules["session-context"]).toBeDefined();
    expect(out.modules.越权插槽).toBeUndefined();
    // 1 条 warn（含 hint 区分 use/error vs load/warn）
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("越权插槽");
    expect(messages[0]).toContain("不在 Blueprint 插槽中");
    expect(detailsAll[0]).toBeDefined();
    const detailsStr = JSON.stringify(detailsAll[0]);
    expect(detailsStr).toContain("hint");
    expect(detailsStr).toMatch(/use 场景.*error/);
    expect(detailsStr).toMatch(/非 use 场景.*warn/);
  });
});
