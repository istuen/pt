// tests/verify/compile-agent-context.test.ts — compileAgentContext + computeSourceHash 单元测试（P2.5）
//
// v9 AgentContext IR = { name, blueprint, sourceHash, modules: Record<聚合组名, markdown 字符串> }
//  - 遍历 Blueprint.groups，按 modName 注册表聚合 Profile 同名 ProfileGroup 追加的 Domain H2 段
//  - sourceHash = hash(profile + blueprint + domains)，缓存失效依据
//
// Phase term-P1：compile-context.test.ts → compile-agent-context.test.ts
//   同步改名 compileContext → compileAgentContext（IR 改名）。

import { describe, it, expect } from "vitest";
import { compileAgentContext, computeSourceHash } from "../../src/compile/agent-context.js";
import type { Blueprint, Domain, Profile } from "../../src/schema.js";

function makeProfile(overrides?: Partial<Profile>): Profile {
  return {
    name: "test-profile",
    blueprint: "test-blueprint",
    domains: ["d1"],
    // v9.1+（modules-to-profile-complete）：modules 元素从 string 改为 ModName 对象
    groups: [{ name: "会话背景", domains: [], modules: [{ section: "Scene" }] }],
    // v15.x PR3：测试 profile 默认 sourcePack="prj"（不限定 ref 绑定需要）
    sourcePack: "prj",
    ...overrides,
  };
}

function makeBlueprint(overrides?: Partial<Blueprint>): Blueprint {
  return {
    name: "test-blueprint",
    groups: [{ name: "会话背景", inject: "session" }],
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

// v15.x PR2 + PR3：compileAgentContext/computeSourceHash 加 packs + workingSet 参数
// 测试用 ds 构造 domain workingSet——profile.domains 解析时能查 "prj/<name>"
function compileCtx(p: Profile, bp: Blueprint, ds: Domain[]) {
  const domainWS = new Map<string, { pack: AssetPack; asset: Domain }>();
  for (const d of ds) {
    domainWS.set(`prj/${d.name}`, { pack: makePack("prj", "/test"), asset: d });
  }
  const blueprintWS = new Map<string, { pack: AssetPack; asset: Blueprint }>();
  blueprintWS.set(`prj/${bp.name}`, { pack: makePack("prj", "/test"), asset: bp });
  return compileAgentContext(p, bp, ds, [makePack("prj", "/test")], "prj", {
    domains: domainWS,
    blueprints: blueprintWS,
    profiles: new Map(),
  });
}
function hashCtx(p: Profile, bp: Blueprint, ds: Domain[]) {
  return computeSourceHash(p, bp, ds, []);
}

// v15.x PR2（§8.1）：构造测试 AssetPack（mock 简化版本）
function makePack(name: string, rootDir: string): AssetPack {
  return {
    name,
    rootDir,
    version: "0.0.0",
    source: "project",
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
    expect(ctx.modules.会话背景).toContain("t1");
    expect(ctx.modules.会话背景).toContain("term 1");
  });

  it("Profile 聚合组追加的 Domain（groups[].domains）也参与聚合", () => {
    const p = makeProfile({
      domains: [],
      groups: [{ name: "会话背景", domains: ["d2"], modules: [{ section: "Scene" }] }],
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
    expect(ctx.modules.会话背景).toContain("t2");
    expect(ctx.modules.会话背景).not.toContain("t1"); // d1 不在追加列表
  });

  it("Blueprint 未声明的聚合组不在 AgentContext.modules 中", () => {
    const p = makeProfile({
      groups: [
        { name: "会话背景", domains: [], modules: [{ section: "Scene" }] },
        { name: "未声明聚合组", domains: [], modules: [] },
      ],
    });
    const bp = makeBlueprint();
    const ctx = compileCtx(p, bp, [makeDomain()]);
    expect(ctx.modules.会话背景).toBeDefined();
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
        groups: [{ name: "会话背景", inject: "session" }],
      }),
      [makeDomain()]
    );
    const h2 = hashCtx(
      makeProfile(),
      makeBlueprint({
        groups: [{ name: "参考手册", inject: "turn" }],
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
    expect(ctx.modules.会话背景).toContain("（字段：必读/设计原则/步骤）");
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
    expect(ctx.modules.会话背景).toContain(" — 每个硬指标都要有独立验证方式");
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
    const out = ctx.modules.会话背景;
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
    expect(ctx.modules.会话背景).toContain("- plain: just desc");
    // 不应出现 fields/note 追加
    expect(ctx.modules.会话背景).not.toContain("（字段：");
    expect(ctx.modules.会话背景).not.toContain(" — ");
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
          name: "会话背景",
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
    expect(ctx.modules.会话背景).toContain("### user-info.user-profile");
    expect(ctx.modules.会话背景).toContain("user-profile: Pt 项目作者与架构师");
    expect(ctx.modules.会话背景).not.toContain("pt-goal");
    expect(ctx.modules.会话背景).not.toContain("### user-info.pt-goal");
  });

  it("段.项形态：H3 项不存在 → 产出空段", () => {
    const p: Profile = {
      ...makeProfile(),
      domains: ["user-info"],
      groups: [
        {
          name: "会话背景",
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
    expect(ctx.modules.会话背景).toBe("");
  });

  it("段.项形态：跨段同名 H3 不跨段匹配（User.x 不匹配 Agent.x）", () => {
    const p: Profile = {
      ...makeProfile(),
      domains: ["user-info", "agent-info"],
      groups: [
        {
          name: "会话背景",
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
    expect(ctx.modules.会话背景).toContain("in user-info User 段");
    expect(ctx.modules.会话背景).not.toContain("in agent-info Agent 段");
  });

  it("段.项形态：同段内 H3 重名 → 后覆盖前（只取最后一个）", () => {
    const p: Profile = {
      ...makeProfile(),
      domains: ["user-info"],
      groups: [
        {
          name: "会话背景",
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
    expect(ctx.modules.会话背景).toContain("second occurrence");
    expect(ctx.modules.会话背景).not.toContain("first occurrence");
  });

  it("段名形态：整段聚合 → 跨所有引用域该段", () => {
    const p: Profile = {
      ...makeProfile(),
      domains: ["user-info", "agent-info"],
      groups: [
        {
          name: "会话背景",
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
    expect(ctx.modules.会话背景).toContain("user-profile");
    expect(ctx.modules.会话背景).not.toContain("agent-role-architect");
  });
});
