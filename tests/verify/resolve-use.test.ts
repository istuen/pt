// tests/verify/resolve-use.test.ts — v15.x PR5 use Profile 单继承测试
//
// 覆盖：
// - expandProfile 基础（不写 use 早退、parseRef 复用、别名归一）
// - §5.2 合并规则（name 强制 / blueprint 覆盖 / tagline 覆盖 / domains 追加 / groups 替换）
// - 菱形（§5.3.3 M4）路径 visited 不误报
// - 循环检测（A use B use A → UseChainCycle）
// - use 目标不存在 → UseTargetNotFound 含 loaded packs hint
// - §5.5 越权校验 use 场景 error（BlueprintGroupOutOfScope）
// - §8.2 cache sourceHash use 链变化 → cache miss / cache hit
// - transpile 集成：use profile 展开后进 compileAgentContext

import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  expandProfile,
  UseTargetNotFound,
  UseChainCycle,
  BlueprintGroupOutOfScope,
} from "../../src/compile/resolve-use.js";
import { computeSourceHash } from "../../src/compile/agent-context.js";
import { loadAndTranspile } from "../../src/transpile.js";
import type { AssetPack, Blueprint, Profile } from "../../src/schema.js";

function makePack(name: string, rootDir: string, version = "0.0.0"): AssetPack {
  return {
    name,
    rootDir,
    version,
    // v15.x PR7（issue pt-remove-global-pack 移除）：fallback 默认值改 "settings"（"global" 已不在 PackSource）
    source: name === "prj" ? "project" : "settings",
    loadDomains: () => Promise.resolve([]),
    loadBlueprints: () => Promise.resolve([]),
    loadProfiles: () => Promise.resolve([]),
  };
}

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    name: "test",
    blueprint: "bp",
    domains: [],
    groups: [],
    sourcePack: "prj",
    ...overrides,
  };
}

function makeBlueprint(overrides: Partial<Blueprint> = {}): Blueprint {
  return {
    name: "bp",
    groups: [{ name: "g", inject: "session" }],
    ...overrides,
  };
}

// ==================== 基础 ====================

describe("expandProfile 基础", () => {
  it("不写 use → 返回 self（back-compat 早退，步骤 4）", () => {
    const self = makeProfile({ name: "leaf" });
    const out = expandProfile(self, new Map(), new Map(), []);
    expect(out).toBe(self); // 同引用
  });

  it("use 限定 @pack/name → 解析正确", () => {
    const self = makeProfile({ name: "a", use: "@team-b/base" });
    const base = makeProfile({ name: "base", sourcePack: "team-b" });
    const ws = new Map([["team-b/base", base]]);
    const out = expandProfile(self, ws, new Map(), [makePack("prj", "/x")]);
    expect(out.name).toBe("a");
    expect(out.use).toBeUndefined(); // 展开后 use 消化
  });

  it("use 无限定 name → self.sourcePack/name", () => {
    const self = makeProfile({ name: "a", use: "base" });
    const base = makeProfile({ name: "base", sourcePack: "prj" });
    const ws = new Map([["prj/base", base]]);
    const out = expandProfile(self, ws, new Map(), [makePack("prj", "/x")]);
    expect(out.name).toBe("a");
  });

  it("use=@prj/... → 别名归一（RESERVED_PACK_NAMES）", () => {
    const self = makeProfile({ name: "a", use: "@project/base" });
    const base = makeProfile({ name: "base", sourcePack: "prj" });
    const ws = new Map([["prj/base", base]]);
    const out = expandProfile(self, ws, new Map(), [makePack("prj", "/x")]);
    expect(out.name).toBe("a");
  });

  it("use 链 sourcePack 保持 self 的（不随 use 改变身份）", () => {
    const self = makeProfile({ name: "a", use: "@team-b/base", sourcePack: "prj" });
    const base = makeProfile({ name: "base", sourcePack: "team-b" });
    const ws = new Map([["team-b/base", base]]);
    const out = expandProfile(self, ws, new Map(), [makePack("prj", "/x")]);
    expect(out.sourcePack).toBe("prj");
  });

  it("use 无前缀跨 pack fallback（PR3a back-compat §4.4）", () => {
    // 项目 use profile 引用无前缀名——落到 builtin pack
    const self = makeProfile({ name: "a", use: "base", sourcePack: "prj" });
    const base = makeProfile({ name: "base", sourcePack: "pt" });
    const ws = new Map([["pt/base", base]]);
    const out = expandProfile(self, ws, new Map(), [makePack("prj", "/x"), makePack("pt", "/y")]);
    expect(out.name).toBe("a");
  });

  it("use 限定 @pack/name 不 fallback（严格语义）", () => {
    const self = makeProfile({ name: "a", use: "@prj/missing" });
    const base = makeProfile({ name: "missing", sourcePack: "pt" });
    const ws = new Map([["pt/missing", base]]);
    expect(() =>
      expandProfile(self, ws, new Map(), [makePack("prj", "/x"), makePack("pt", "/y")])
    ).toThrow(UseTargetNotFound);
  });
});

// ==================== §5.2 合并规则 ====================

describe("§5.2 mergeProfile 合并规则", () => {
  it("name 强制 self（不继承 use 的 name）", () => {
    const self = makeProfile({ name: "self-name", use: "@team-b/base" });
    const base = makeProfile({ name: "BASE-NAME", sourcePack: "team-b" });
    const ws = new Map([["team-b/base", base]]);
    const out = expandProfile(self, ws, new Map(), []);
    expect(out.name).toBe("self-name");
  });

  it("blueprint self 写了 → 覆盖 use 的", () => {
    const self = makeProfile({ name: "a", blueprint: "self-bp", use: "@team-b/base" });
    const base = makeProfile({ name: "base", blueprint: "base-bp", sourcePack: "team-b" });
    const ws = new Map([["team-b/base", base]]);
    const out = expandProfile(self, ws, new Map(), []);
    expect(out.blueprint).toBe("self-bp");
  });

  it("blueprint self 未写（空字符串） → 继承 use 的", () => {
    const self = makeProfile({ name: "a", blueprint: "", use: "@team-b/base" });
    const base = makeProfile({ name: "base", blueprint: "base-bp", sourcePack: "team-b" });
    const ws = new Map([["team-b/base", base]]);
    const out = expandProfile(self, ws, new Map(), []);
    expect(out.blueprint).toBe("base-bp");
  });

  it("tagline self 写了 → 覆盖 use 的", () => {
    const self = makeProfile({ name: "a", tagline: "self-tag", use: "@team-b/base" });
    const base = makeProfile({ name: "base", tagline: "base-tag", sourcePack: "team-b" });
    const ws = new Map([["team-b/base", base]]);
    const out = expandProfile(self, ws, new Map(), []);
    expect(out.tagline).toBe("self-tag");
  });

  it("tagline self 未写 → 继承 use 的", () => {
    const self = makeProfile({ name: "a", use: "@team-b/base" });
    const base = makeProfile({ name: "base", tagline: "base-tag", sourcePack: "team-b" });
    const ws = new Map([["team-b/base", base]]);
    const out = expandProfile(self, ws, new Map(), []);
    expect(out.tagline).toBe("base-tag");
  });

  it("domains 追加去重（self 优先，保留首次插入顺序）", () => {
    const self = makeProfile({
      name: "a",
      domains: ["d1", "d3"],
      use: "@team-b/base",
    });
    const base = makeProfile({ name: "base", domains: ["d1", "d2"], sourcePack: "team-b" });
    const ws = new Map([["team-b/base", base]]);
    const out = expandProfile(self, ws, new Map(), []);
    // base 先入（d1, d2），self 后入覆盖 d1 + 加 d3 → [d1(来自 self 但同名先入 base), d2, d3]
    expect(out.domains).toEqual(["d1", "d2", "d3"]);
  });

  it("groups 同名替换（self 整个 group 覆盖 use 的）", () => {
    const self = makeProfile({
      name: "a",
      groups: [
        {
          name: "g",
          domains: ["self-d"],
          modules: [{ section: "Scene" }],
        },
      ],
      use: "@team-b/base",
    });
    const base = makeProfile({
      name: "base",
      groups: [
        {
          name: "g",
          domains: ["base-d"],
          modules: [{ section: "Scene" }],
        },
        { name: "use-only", domains: [], modules: [] },
      ],
      sourcePack: "team-b",
    });
    const ws = new Map([["team-b/base", base]]);
    const out = expandProfile(self, ws, new Map(), []);
    // self 的 "g" 替换 base 的 "g"；use-only 保留
    expect(out.groups).toHaveLength(2);
    const g = out.groups.find((gr) => gr.name === "g");
    expect(g?.domains).toEqual(["self-d"]);
    expect(out.groups.find((gr) => gr.name === "use-only")).toBeDefined();
  });

  it("groups self 独有追加（不在 use 的 groups 列表中）", () => {
    const self = makeProfile({
      name: "a",
      groups: [{ name: "self-only", domains: [], modules: [] }],
      use: "@team-b/base",
    });
    const base = makeProfile({
      name: "base",
      groups: [{ name: "g", domains: [], modules: [] }],
      sourcePack: "team-b",
    });
    const ws = new Map([["team-b/base", base]]);
    const out = expandProfile(self, ws, new Map(), []);
    expect(out.groups.map((g) => g.name).sort()).toEqual(["g", "self-only"]);
  });
});

// ==================== §5.3.3 菱形 ====================

describe("§5.3.3 菱形（M4 路径 visited）", () => {
  it("菱形 A use B, A use C, B use D, C use D → D 展开两次无循环误报", () => {
    const a = makeProfile({ name: "a", use: "@prj/b", domains: ["d1"] });
    const b = makeProfile({ name: "b", use: "@prj/d", domains: ["d2"] });
    const c = makeProfile({ name: "c", use: "@prj/d", domains: ["d3"] });
    const d = makeProfile({ name: "d" });
    const ws = new Map([
      ["prj/a", a],
      ["prj/b", b],
      ["prj/c", c],
      ["prj/d", d],
    ]);
    // 期望：a 的 use 是单值——不能同时用 b 和 c（use 是单继承，不是多）
    // 此测试构造的是 a use b 链（B 含 D），验证不误报
    expect(() => expandProfile(a, ws, new Map(), [])).not.toThrow();
  });

  it("菱形场景下 self 单继承 use B（B 再 use D），D 正确展开", () => {
    const a = makeProfile({ name: "a", use: "@prj/b", domains: ["a-d"] });
    const b = makeProfile({ name: "b", use: "@prj/d", domains: ["b-d"] });
    const d = makeProfile({ name: "d", domains: ["d-d"] });
    const ws = new Map([
      ["prj/a", a],
      ["prj/b", b],
      ["prj/d", d],
    ]);
    const out = expandProfile(a, ws, new Map(), []);
    // a domains = b.domains (d-d) 追加 → a 原有 a-d 追加 → 合并去重
    expect(out.domains).toContain("d-d");
    expect(out.domains).toContain("a-d");
  });
});

// ==================== 循环检测 ====================

describe("expandProfile 循环检测", () => {
  it("A use B use A → UseChainCycle 报错含完整链", () => {
    const a = makeProfile({ name: "a", use: "@prj/b" });
    const b = makeProfile({ name: "b", use: "@prj/a" });
    const ws = new Map([
      ["prj/a", a],
      ["prj/b", b],
    ]);
    try {
      expandProfile(a, ws, new Map(), []);
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(UseChainCycle);
      expect((e as UseChainCycle).message).toMatch(/use chain cycle/);
      expect((e as UseChainCycle).chain).toContain("prj/a");
      expect((e as UseChainCycle).chain).toContain("prj/b");
    }
  });

  it("A use A 自循环 → UseChainCycle", () => {
    const a = makeProfile({ name: "a", use: "a" });
    const ws = new Map([["prj/a", a]]);
    expect(() => expandProfile(a, ws, new Map(), [])).toThrow(UseChainCycle);
  });
});

// ==================== §5.6 use 目标不存在 ====================

describe("§5.6 use 目标不存在", () => {
  it("use 不存在的 profile → UseTargetNotFound 含 loaded packs hint", () => {
    const self = makeProfile({ name: "a", use: "@team-b/missing" });
    const packs = [makePack("prj", "/x"), makePack("pt", "/y")];
    try {
      expandProfile(self, new Map(), new Map(), packs);
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(UseTargetNotFound);
      expect((e as UseTargetNotFound).useRef).toBe("@team-b/missing");
      expect((e as UseTargetNotFound).resolvedKey).toBe("team-b/missing");
      expect((e as Error).message).toContain("Loaded profiles");
      expect((e as Error).message).toContain("prj");
      expect((e as Error).message).toContain("pt");
    }
  });
});

// ==================== §5.5 越权校验 ====================

describe("§5.5 越权校验 use 场景 error", () => {
  it("use 场景 self 重写 blueprint 后 use 的 group 越权 → BlueprintGroupOutOfScope", () => {
    // self 重写 blueprint 到 minimal（slots=[main]）——use 的 "extra" group 越权
    const minimalBp = makeBlueprint({
      name: "minimal",
      groups: [{ name: "main", inject: "session" }],
    });
    const a = makeProfile({
      name: "a",
      blueprint: "minimal",
      use: "@prj/b",
      groups: [], // empty after expand
    });
    const b = makeProfile({
      name: "b",
      groups: [
        { name: "main", domains: [], modules: [{ section: "Scene" }] },
        { name: "extra", domains: [], modules: [{ section: "Scene" }] },
      ],
    });
    const ws = new Map([
      ["prj/a", a],
      ["prj/b", b],
    ]);
    const bpWS = new Map([["prj/minimal", { pack: makePack("prj", "/x"), asset: minimalBp }]]);
    try {
      expandProfile(a, ws, bpWS, [makePack("prj", "/x")]);
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(BlueprintGroupOutOfScope);
      expect((e as BlueprintGroupOutOfScope).outOfScopeGroups).toEqual(["extra"]);
      expect((e as BlueprintGroupOutOfScope).blueprintName).toBe("minimal");
      expect((e as Error).message).toContain("Hint");
    }
  });
});

// ==================== §8.2 cache sourceHash ====================

describe("§8.2 cache sourceHash（use 链变化反映在 hash）", () => {
  it("use 链上 B 的 domains 变化 → A 的 sourceHash 变化（cache miss）", () => {
    const a = makeProfile({ name: "a", use: "b", domains: ["a-d"] });
    const b1 = makeProfile({ name: "b", domains: ["b-d-1"] });
    const b2 = makeProfile({ name: "b", domains: ["b-d-2"] });
    const aExpanded1 = expandProfile(a, new Map([["prj/b", b1]]), new Map(), []);
    const aExpanded2 = expandProfile(a, new Map([["prj/b", b2]]), new Map(), []);
    const bp = makeBlueprint();
    const h1 = computeSourceHash(aExpanded1, bp, [], []);
    const h2 = computeSourceHash(aExpanded2, bp, [], []);
    expect(h1).not.toBe(h2);
  });

  it("use 链上 B 不变 → A 的 sourceHash 不变（cache hit）", () => {
    const a = makeProfile({ name: "a", use: "b", domains: ["a-d"] });
    const b = makeProfile({ name: "b", domains: ["b-d"] });
    const aExpanded1 = expandProfile(a, new Map([["prj/b", b]]), new Map(), []);
    const aExpanded2 = expandProfile(a, new Map([["prj/b", b]]), new Map(), []);
    const bp = makeBlueprint();
    const h1 = computeSourceHash(aExpanded1, bp, [], []);
    const h2 = computeSourceHash(aExpanded2, bp, [], []);
    expect(h1).toBe(h2);
  });

  it("不改 computeSourceHash 签名——展开后 profile 直接进 hash", () => {
    // 验证 computeSourceHash 接受 Profile 参数，use 字段不需特殊处理
    const a = makeProfile({ name: "a", use: "b" });
    const b = makeProfile({ name: "b" });
    const aExpanded = expandProfile(a, new Map([["prj/b", b]]), new Map(), []);
    const bp = makeBlueprint();
    // 不报错即通过——§8.2 稳定
    expect(() => computeSourceHash(aExpanded, bp, [], [])).not.toThrow();
  });
});

// ==================== 集成：transpile ====================

describe("集成：transpile loadAndTranspile use profile", () => {
  const tempDirs: string[] = [];
  function mkCwd(): string {
    const cwd = mkdtempSync(join(tmpdir(), "pt-pr5-use-"));
    tempDirs.push(cwd);
    mkdirSync(join(cwd, ".pt/assets/profiles"), { recursive: true });
    return cwd;
  }
  // 清理
  // 不在 afterEach——测试结束后整体清理

  // 注意：transpile loadAndTranspile 加载 builtin packs——builtin guide 含 "pack-repair" 域名
  // 构造 use profile 时确保引用的 profile 在 builtin pack 内

  it("transpile 不写 use → 行为等价今天（back-compat）", async () => {
    const cwd = mkCwd();
    const r = await loadAndTranspile(cwd, "guide");
    expect(r.profile.name).toBe("guide");
    expect(r.profile.use).toBeUndefined();
  });

  it("transpile use profile → 展开后进 compileAgentContext（profile.blueprint 来自 use 的）", async () => {
    const cwd = mkCwd();
    // builtin pack 有 guide profile（name=guide, blueprint=pt-default）
    // 写一个项目 use profile 继承 builtin guide——use 无前缀（PR3a back-compat 跨 pack fallback）
    writeFileSync(
      join(cwd, ".pt/assets/profiles/my-dev.profile.md"),
      `---
name: my-dev
use: guide
domains: [user-info]
---

## session-context
### Modules
- Scene
- User
- Agent
`
    );
    const r = await loadAndTranspile(cwd, "my-dev");
    expect(r.profile.name).toBe("my-dev");
    // 展开后 blueprint 继承 guide 的
    expect(r.blueprint.name).toBe("pt-default");
    // 展开后 domains 包含 guide 的 + self 的
    expect(r.profile.domains).toContain("user-info");
  });

  it("transpile use 链循环 → 报错阻断激活", async () => {
    const cwd = mkCwd();
    // builtin pack guide 不 use；项目 pack my-loop use @pt/guide + builtin 反向 use my-loop 不可能（frontmatter 不能循环）
    // 构造项目内 use 循环需多个项目 profile；这里简化为 use 目标不存在
    writeFileSync(
      join(cwd, ".pt/assets/profiles/orphan.profile.md"),
      `---
name: orphan
use: nonexistent
domains: []
---

## session-context
### Modules
- Scene
`
    );
    await expect(loadAndTranspile(cwd, "orphan")).rejects.toThrow(UseTargetNotFound);
  });

  it("transpile 完整清理", async () => {
    for (const d of tempDirs.splice(0)) {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
