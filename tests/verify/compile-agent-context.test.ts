// tests/verify/compile-agent-context.test.ts — compileAgentContext + computeSourceHash 单元测试（P2.5）
//
// v9 AgentContext IR = { name, blueprint, sourceHash, modules: Record<注入点名, markdown 字符串> }
//  - 遍历 Blueprint.injectionPoints，按 modName 注册表聚合 Profile 同名 InjectionPointInstance 追加的 Domain H2 段
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
    injectionPoints: [{ name: "会话知识", domains: [] }],
    ...overrides,
  };
}

function makeBlueprint(overrides?: Partial<Blueprint>): Blueprint {
  return {
    name: "test-blueprint",
    injectionPoints: [{ name: "会话知识", target: "session", modules: ["Scene"] }],
    ...overrides,
  };
}

function makeDomain(overrides?: Partial<Domain>): Domain {
  return {
    name: "d1",
    type: "term",
    modules: {
      Scene: [{ name: "t1", desc: "term 1 desc" }],
    },
    ...overrides,
  };
}

describe("compileAgentContext", () => {
  it("返回 AgentContext 基础字段：name / blueprint / sourceHash", () => {
    const p = makeProfile();
    const bp = makeBlueprint();
    const ds = [makeDomain()];
    const ctx = compileAgentContext(p, bp, ds);
    expect(ctx.name).toBe("test-profile");
    expect(ctx.blueprint).toBe("test-blueprint");
    // sourceHash = simpleHash(FNV-1a 32-bit hex) + "-" + payload.length hex
    expect(ctx.sourceHash).toMatch(/^[a-f0-9]+(-[a-f0-9]+)?$/);
  });

  it("按 Blueprint.injectionPoints 聚合 Profile 注入点的 Domain H2 段", () => {
    const p = makeProfile({ domains: ["d1"] });
    const bp = makeBlueprint();
    const ds = [makeDomain({ modules: { Scene: [{ name: "t1", desc: "term 1" }] } })];
    const ctx = compileAgentContext(p, bp, ds);
    expect(ctx.modules.会话知识).toContain("t1");
    expect(ctx.modules.会话知识).toContain("term 1");
  });

  it("Profile 注入点追加的 Domain（injectionPoints[].domains）也参与聚合", () => {
    const p = makeProfile({
      domains: [],
      injectionPoints: [{ name: "会话知识", domains: ["d2"] }],
    });
    const bp = makeBlueprint();
    const ds = [
      makeDomain({ name: "d1" }),
      makeDomain({
        name: "d2",
        modules: { Scene: [{ name: "t2", desc: "term 2" }] },
      }),
    ];
    const ctx = compileAgentContext(p, bp, ds);
    expect(ctx.modules.会话知识).toContain("t2");
    expect(ctx.modules.会话知识).not.toContain("t1"); // d1 不在追加列表
  });

  it("Blueprint 未声明的注入点不在 AgentContext.modules 中", () => {
    const p = makeProfile({
      injectionPoints: [
        { name: "会话知识", domains: [] },
        { name: "未声明注入点", domains: [] },
      ],
    });
    const bp = makeBlueprint();
    const ctx = compileAgentContext(p, bp, [makeDomain()]);
    expect(ctx.modules.会话知识).toBeDefined();
    expect(ctx.modules.未声明注入点).toBeUndefined();
  });
});

describe("computeSourceHash", () => {
  it("同输入 → 同 hash（稳定性）", () => {
    const p = makeProfile();
    const bp = makeBlueprint();
    const ds = [makeDomain()];
    const h1 = computeSourceHash(p, bp, ds);
    const h2 = computeSourceHash(p, bp, ds);
    expect(h1).toBe(h2);
  });

  it("对象 keys 顺序不同 → 同 hash（stableStringify 排序对象 keys）", () => {
    // 注意：数组视为有序（不是 sorted），所以不能测 domains 数组顺序
    // 只测对象 literal 的 keys 构造顺序不同 → stableStringify 排序后相同
    const p1: Profile = {
      name: "p",
      blueprint: "b",
      domains: [],
      injectionPoints: [],
    };
    const p2: Profile = {
      injectionPoints: [],
      domains: [],
      blueprint: "b",
      name: "p",
    };
    expect(computeSourceHash(p1, makeBlueprint(), [])).toBe(
      computeSourceHash(p2, makeBlueprint(), [])
    );
  });

  it("不同 Profile.name → 不同 hash", () => {
    const h1 = computeSourceHash(makeProfile({ name: "p1" }), makeBlueprint(), [makeDomain()]);
    const h2 = computeSourceHash(makeProfile({ name: "p2" }), makeBlueprint(), [makeDomain()]);
    expect(h1).not.toBe(h2);
  });

  it("不同 Blueprint.injectionPoints → 不同 hash", () => {
    const h1 = computeSourceHash(
      makeProfile(),
      makeBlueprint({
        injectionPoints: [{ name: "会话知识", target: "session", modules: ["Scene"] }],
      }),
      [makeDomain()]
    );
    const h2 = computeSourceHash(
      makeProfile(),
      makeBlueprint({
        injectionPoints: [{ name: "参考手册", target: "turn", modules: ["Manual"] }],
      }),
      [makeDomain()]
    );
    expect(h1).not.toBe(h2);
  });

  it("不同 domains → 不同 hash", () => {
    const h1 = computeSourceHash(makeProfile(), makeBlueprint(), [makeDomain({ name: "d1" })]);
    const h2 = computeSourceHash(makeProfile(), makeBlueprint(), [makeDomain({ name: "d2" })]);
    expect(h1).not.toBe(h2);
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
    const ctx = compileAgentContext(makeProfile(), makeBlueprint(), ds);
    expect(ctx.modules.会话知识).toContain("（字段：必读/设计原则/步骤）");
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
    const ctx = compileAgentContext(makeProfile(), makeBlueprint(), ds);
    expect(ctx.modules.会话知识).toContain(" — 每个硬指标都要有独立验证方式");
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
    const ctx = compileAgentContext(makeProfile(), makeBlueprint(), ds);
    // 顺序：name: desc（字段：a/b） — note
    const out = ctx.modules.会话知识;
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
    const ctx = compileAgentContext(makeProfile(), makeBlueprint(), ds);
    expect(ctx.modules.会话知识).toContain("- plain: just desc");
    // 不应出现 fields/note 追加
    expect(ctx.modules.会话知识).not.toContain("（字段：");
    expect(ctx.modules.会话知识).not.toContain(" — ");
  });
});
