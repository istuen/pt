// tests/verify/ref-resolver.test.ts — v15.x PR3 parseRef + fingerprint + resolveAndDedupRefs 单元测试
//
// 覆盖：
// - parseRef：限定 / 不限定 / 别名归一 / 畸形 / 无 selfPack（§4.2 / §4.5.1）
// - fingerprint：同 pack 同内容 / 不同 pack 同内容 / 同 pack 不同内容（§4.4.2）
// - resolveAndDedupRefs：场景 A-F 全部 + 不存在 ref 抛错（§4.5）

import { describe, it, expect } from "vitest";
import {
  parseRef,
  fingerprint,
  resolveAndDedupRefs,
  resolveBlueprint,
  isQualifiedRef,
  normalizePackName,
} from "../../src/parse/ref-resolver.js";
import type { AssetPack, Blueprint, Profile } from "../../src/schema.js";

function makePack(
  name: string,
  rootDir: string,
  version = "0.0.0",
  source?: AssetPack["source"]
): AssetPack {
  const inferredSource =
    source ?? (name === "prj" ? "project" : name === "pt" ? "builtin" : "settings");
  return {
    name,
    rootDir,
    version,
    source: inferredSource,
    manifestWarnings: [],
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

// ==================== parseRef ====================

describe("parseRef（§4.2 / §4.5.1 / §2.4.4 双层语义）", () => {
  it("限定 @pack/name（身份 alias）→ 返 {kind: identity, pack, name}", () => {
    expect(parseRef("@pt-internal/foo", "prj")).toEqual({
      kind: "identity",
      pack: "pt-internal",
      name: "foo",
    });
  });

  it("不限定 foo + selfPack='prj' → 绑 prj（identity kind）", () => {
    expect(parseRef("foo", "prj")).toEqual({ kind: "identity", pack: "prj", name: "foo" });
  });

  it("位置 alias @project/foo → 归一为 {kind: location, pack: prj}", () => {
    expect(parseRef("@project/foo", "prj")).toEqual({
      kind: "location",
      pack: "prj",
      name: "foo",
    });
  });

  // v15.x PR7（issue pt-remove-global-pack 移除）：@global/foo 不再归一为位置 alias——
  // global pack 已被删除。@global 现在按身份 alias 解析（kind="identity"）。

  it("位置 alias @builtin/foo → 归一为 {kind: location, pack: pt}", () => {
    expect(parseRef("@builtin/foo", "prj")).toEqual({
      kind: "location",
      pack: "pt",
      name: "foo",
    });
  });

  it("位置 alias 短名 @prj/foo → {kind: location, pack: prj}", () => {
    expect(parseRef("@prj/foo", "prj")).toEqual({
      kind: "location",
      pack: "prj",
      name: "foo",
    });
  });

  // v15.x PR7（issue pt-remove-global-pack 移除）：@gbl/foo 不再归一为位置 alias——
  // gbl 不是位置 alias。@gbl 按身份 alias 解析（kind="identity"）。

  it("位置 alias 短名 @pt/foo → {kind: location, pack: pt}", () => {
    expect(parseRef("@pt/foo", "prj")).toEqual({
      kind: "location",
      pack: "pt",
      name: "foo",
    });
  });

  it("畸形 @foo（无 /）抛错", () => {
    expect(() => parseRef("@foo", "prj")).toThrow(/malformed @pack\/name/);
  });

  it("畸形 @/foo（pack 名为空）抛错", () => {
    expect(() => parseRef("@/foo", "prj")).toThrow(/malformed @pack\/name/);
  });

  it("畸形 @pack/（asset 名为空）抛错", () => {
    expect(() => parseRef("@prj/", "prj")).toThrow(/malformed @pack\/name/);
  });

  it("不限定 + selfPack 空 → 抛 no sourcePack 错", () => {
    expect(() => parseRef("foo", "")).toThrow(/no sourcePack/);
  });

  it("isQualifiedRef 判定", () => {
    expect(isQualifiedRef("@pt/foo")).toBe(true);
    expect(isQualifiedRef("foo")).toBe(false);
  });

  it("normalizePackName 别名归一", () => {
    expect(normalizePackName("project")).toBe("prj");
    // v15.x PR7（issue pt-remove-global-pack 移除）：global → 不归一（原值返回）
    expect(normalizePackName("global")).toBe("global");
    expect(normalizePackName("builtin")).toBe("pt");
    expect(normalizePackName("pt-internal")).toBe("pt-internal");
  });

  // v15.x PR7（issue pt-remove-global-pack 移除）：@gbl/@global 不再是位置 alias
  it("@gbl/foo 按身份 alias 解析（kind=identity），不再归一为位置 alias", () => {
    expect(parseRef("@gbl/foo", "prj")).toEqual({
      kind: "identity",
      pack: "gbl",
      name: "foo",
    });
    expect(parseRef("@global/foo", "prj")).toEqual({
      kind: "identity",
      pack: "global",
      name: "foo",
    });
  });
});

// ==================== fingerprint ====================

describe("fingerprint（§4.4.2）", () => {
  it("同 pack 同内容 → fp 相同", () => {
    const pack = makePack("prj", "/x");
    const asset = { name: "foo", tag: "value" };
    expect(fingerprint(pack, asset)).toBe(fingerprint(pack, asset));
  });

  it("不同 pack 同内容 → fp 不同（rootDir 不同）", () => {
    const pack1 = makePack("prj", "/x");
    const pack2 = makePack("pt", "/y");
    const asset = { name: "foo", tag: "value" };
    expect(fingerprint(pack1, asset)).not.toBe(fingerprint(pack2, asset));
  });

  it("同 pack 不同内容 → fp 不同", () => {
    const pack = makePack("prj", "/x");
    expect(fingerprint(pack, { name: "foo", tag: "v1" })).not.toBe(
      fingerprint(pack, { name: "foo", tag: "v2" })
    );
  });

  it("fp 16 字符截断", () => {
    const pack = makePack("prj", "/x");
    expect(fingerprint(pack, { name: "foo" })).toHaveLength(16);
  });
});

// ==================== resolveAndDedupRefs ====================

describe("resolveAndDedupRefs（§4.4.2 / §4.5 双层语义）", () => {
  const prj = makePack("prj", "/x");
  const pt = makePack("pt", "/y");
  const assetA = { name: "foo", tag: "project-ver" };
  const assetB = { name: "foo", tag: "builtin-ver" }; // 不同 rootDir → fp 不同

  /** 构造双索引 WorkingSet（v15.x §4.4.2）：location（位置 alias）+ identity（pack.name） */
  function makeWS(
    entries: Array<[string, { pack: AssetPack; asset: { name: string; tag: string } }]>
  ): {
    location: Map<string, { pack: AssetPack; asset: { name: string; tag: string } }>;
    identity: Map<string, { pack: AssetPack; asset: { name: string; tag: string } }>;
  } {
    const identity = new Map(entries);
    // location 索引：prj/gbl/pt + asset.name（按 reserved alias）
    const locAlias: Record<string, string> = { prj: "prj", pt: "pt" };
    const location = new Map<string, typeof identity extends Map<string, infer V> ? V : never>();
    for (const [k, v] of entries) {
      const packName = k.split("/")[0]!;
      const assetName = k.split("/")[1]!;
      const alias = locAlias[packName];
      if (alias) location.set(`${alias}/${assetName}`, v);
    }
    return { location, identity };
  }

  it("场景 A：重复引用 @prj/foo × 2 → dedup 后 1 份", () => {
    const ws = makeWS([["prj/foo", { pack: prj, asset: assetA }]]);
    const { resolved: result } = resolveAndDedupRefs(["@prj/foo", "@prj/foo"], makeProfile(), ws, [
      "prj",
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.rawRef).toBe("@prj/foo");
  });

  it("场景 B：不限定重复 foo × 2 → dedup 后 1 份", () => {
    const ws = makeWS([["prj/foo", { pack: prj, asset: assetA }]]);
    const { resolved: result } = resolveAndDedupRefs(["foo", "foo"], makeProfile(), ws, ["prj"]);
    expect(result).toHaveLength(1);
  });

  it("场景 C：不限定 + 限定同 pack → dedup 后 1 份", () => {
    const ws = makeWS([["prj/foo", { pack: prj, asset: assetA }]]);
    const { resolved: result } = resolveAndDedupRefs(["foo", "@prj/foo"], makeProfile(), ws, [
      "prj",
    ]);
    expect(result).toHaveLength(1);
  });

  it("场景 D：不同 pack 同 name 同内容 → fp 不同 → 保留 2 份", () => {
    const ws = makeWS([
      ["prj/foo", { pack: prj, asset: { name: "foo", tag: "same" } }],
      ["pt/foo", { pack: pt, asset: { name: "foo", tag: "same" } }],
    ]);
    const { resolved: result } = resolveAndDedupRefs(["@prj/foo", "@pt/foo"], makeProfile(), ws, [
      "prj",
      "pt",
    ]);
    expect(result).toHaveLength(2);
  });

  it("场景 E：不同 pack 同 name 不同内容 → 保留 2 份", () => {
    const ws = makeWS([
      ["prj/foo", { pack: prj, asset: assetA }],
      ["pt/foo", { pack: pt, asset: assetB }],
    ]);
    const { resolved: result } = resolveAndDedupRefs(["@prj/foo", "@pt/foo"], makeProfile(), ws, [
      "prj",
      "pt",
    ]);
    expect(result).toHaveLength(2);
  });

  it("场景 F：限定跨 pack 不同 name → 保留 2 份", () => {
    const ws = makeWS([
      ["prj/foo", { pack: prj, asset: { name: "foo", tag: "F" } }],
      ["pt/bar", { pack: pt, asset: { name: "bar", tag: "F" } }],
    ]);
    const { resolved: result } = resolveAndDedupRefs(["@prj/foo", "@pt/bar"], makeProfile(), ws, [
      "prj",
      "pt",
    ]);
    expect(result).toHaveLength(2);
  });

  it("不限定 ref 在 selfPack 找不到时按 packs 顺序 fallback（§4.6 back-compat）", () => {
    const ws = makeWS([["pt/foo", { pack: pt, asset: assetA }]]);
    const { resolved: result } = resolveAndDedupRefs(["foo"], makeProfile(), ws, ["prj", "pt"]);
    expect(result).toHaveLength(1);
    expect(result[0]?.pack.name).toBe("pt");
  });

  it("显式 @prj/foo 找不到 → 抛错（§4.5.1，不 fallback）", () => {
    const ws = makeWS([["pt/foo", { pack: pt, asset: assetA }]]);
    expect(() => resolveAndDedupRefs(["@prj/foo"], makeProfile(), ws, ["prj", "pt"])).toThrow(
      /unknown pack|has no asset/
    );
  });

  it("skipOnMissing=true 静默跳过", () => {
    const ws = makeWS([["pt/foo", { pack: pt, asset: assetA }]]);
    const { resolved: result } = resolveAndDedupRefs(
      ["@prj/foo"],
      makeProfile(),
      ws,
      ["prj", "pt"],
      {
        skipOnMissing: true,
      }
    );
    expect(result).toHaveLength(0);
  });

  it("场景 G（v15.x §4.4.2）：身份 alias @pt-internal/foo + 位置 alias @prj/foo 命中同一 asset", () => {
    // project pack manifest.name=pt-internal → identity key=pt-internal/foo
    // 位置 alias @prj/foo → location key=prj/foo（双入口命中同一 asset）
    const ptInternal = makePack("pt-internal", "/x", "project");
    // 双索引手动构造：identity 按 pack.name，location 按位置 alias（project→prj）
    const identity = new Map<string, { pack: AssetPack; asset: { name: string; tag: string } }>();
    identity.set("pt-internal/foo", { pack: ptInternal, asset: assetA });
    const location = new Map<string, { pack: AssetPack; asset: { name: string; tag: string } }>();
    location.set("prj/foo", { pack: ptInternal, asset: assetA }); // 双入口
    const ws = { location, identity };
    // 双入口命中同一 asset
    const { resolved: result } = resolveAndDedupRefs(
      ["@pt-internal/foo", "@prj/foo"],
      makeProfile(),
      ws,
      ["pt-internal"]
    );
    expect(result).toHaveLength(1); // dedup 同 fp
    // dedup 同 fp 后者赢（Map.set 后写覆盖前写）— "@prj/foo" 在后写入
    expect(result[0]?.rawRef).toBe("@prj/foo");
    // 两个 rawRef 应都指向同一 asset
    expect(result[0]?.asset.name).toBe("foo");
    expect(result[0]?.pack.name).toBe("pt-internal");
  });
});

// ==================== SchemaBundle.workingSet + sourcePack ====================

describe("mdAdapter.load workingSet + Profile.sourcePack（§4.4.1 / §4.4.4）", () => {
  it("workingSet.domains 含 prj/ + pt/ 双份 user-info", async () => {
    const { mdAdapter } = await import("../../src/parse/index.js");
    const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = await mkdtemp(join(tmpdir(), "pt-pr3-"));
    await mkdir(join(root, "domains"), { recursive: true });
    await mkdir(join(root, "blueprints"), { recursive: true });
    await mkdir(join(root, "profiles"), { recursive: true });
    await writeFile(
      join(root, "domains/user-info.md"),
      `---
name: user-info
---

## User
### who-am-i
- desc: project version
`
    );
    try {
      const bundle = await mdAdapter.load(root, "guide", { assetDir: "." });
      // v15.x §4.4.2：workingSet 双索引——identity 按 pack.name
      expect(bundle.workingSet.domains.identity.get("prj/user-info")).toBeDefined();
      expect(bundle.workingSet.domains.identity.get("pt/user-info")).toBeDefined();
      // location 按位置 alias（reserved pack 双索引）
      expect(bundle.workingSet.domains.location.get("prj/user-info")).toBeDefined();
      expect(bundle.workingSet.domains.location.get("pt/user-info")).toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("Profile.sourcePack 由 MdFilePack.loadProfiles 打上", async () => {
    const { MdFilePack } = await import("../../src/asset-pack/md-file-pack.js");
    const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = await mkdtemp(join(tmpdir(), "pt-pr3-pack-"));
    await mkdir(join(root, "domains"), { recursive: true });
    await mkdir(join(root, "blueprints"), { recursive: true });
    await mkdir(join(root, "profiles"), { recursive: true });
    await writeFile(
      join(root, "profiles/my.profile.md"),
      `---
name: my
blueprint: bp
domains: []
---

## session-context
### Modules
`
    );
    try {
      const pack = await MdFilePack.create({
        rootDir: root,
        source: "project",
      });
      const profiles = await pack.loadProfiles();
      // v15.x §2.4.2：reserved pack 无 manifest 时 sourcePack=位置别名（"prj"）
      expect(profiles[0]?.name).toBe("my");
      expect(profiles[0]?.sourcePack).toBe("prj");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ==================== ProfileMeta.pack + formatProfileLabels ====================

describe("ProfileMeta.pack + formatProfileLabels（§7.2 / §7.3 / §4.4.4）", () => {
  it("formatProfileLabels：reserved 显 reservedAlias，settings 显 pack", async () => {
    const { formatProfileLabels } = await import("../../src/config.js");
    const labels = formatProfileLabels([
      {
        name: "guide",
        tagline: "builtin onboarding",
        source: "builtin",
        pack: "pt",
        reservedAlias: "pt",
      },
      {
        name: "pt-dev",
        tagline: "Senior dev",
        source: "project",
        pack: "prj",
        reservedAlias: "prj",
      },
      { name: "my-team", tagline: "team pack", source: "settings", pack: "pt-internal" }, // 无 reservedAlias
    ]);
    expect(labels).toContain("[@pt] guide — builtin onboarding");
    expect(labels).toContain("[@prj] pt-dev — Senior dev");
    // settings pack 无 reservedAlias → 显 pack 名
    expect(labels).toContain("[@pt-internal] my-team — team pack");
  });

  it("listProfilesWithTagline 返 pack 字段", async () => {
    const { listProfilesWithTagline } = await import("../../src/config.js");
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const cwd = await mkdtemp(join(tmpdir(), "pt-pr3-"));
    try {
      const metas = await listProfilesWithTagline(cwd);
      // 至少含 builtin guide + project 空目录
      const builtinGuide = metas.find((m) => m.name === "guide");
      expect(builtinGuide?.pack).toBe("pt");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

// ==================== resolveBlueprint（PR6 fix pt-parse-blueprint-warn-misleading）====================

function makeBlueprint(name: string): Blueprint {
  return { name, groups: [] };
}

describe("resolveBlueprint（§4.6 跨 pack 解析，与 transpile 阶段共用）", () => {
  const prj = makePack("prj", "/tmp/prj");
  const pt = makePack("pt", "/tmp/pt");
  // v15.x PR7（issue pt-remove-global-pack 移除）：global pack 删除——
  // resolveBlueprint 测试改用 prj + pt 双 pack 验证跨包 fallback 语义（无 gbl 中间层）。
  const packNames = ["prj", "pt"];

  /** v15.x §4.4.2：构造 WorkingSet<Blueprint> 双索引 */
  function makeWS(entries: Array<[string, { pack: AssetPack; asset: Blueprint }]>): {
    location: Map<string, { pack: AssetPack; asset: Blueprint }>;
    identity: Map<string, { pack: AssetPack; asset: Blueprint }>;
  } {
    const identity = new Map(entries);
    // v15.x PR7：位置 alias 从 prj/gbl/pt 收敛为 prj/pt
    const locAlias: Record<string, string> = { prj: "prj", pt: "pt" };
    const location = new Map<string, { pack: AssetPack; asset: Blueprint }>();
    for (const [k, v] of entries) {
      const packName = k.split("/")[0]!;
      const assetName = k.split("/")[1]!;
      const alias = locAlias[packName];
      if (alias) location.set(`${alias}/${assetName}`, v);
    }
    return { location, identity };
  }

  it("限定 @pt/foo + pt 命中 → 返 pt entry", () => {
    const ws = makeWS([["pt/foo", { pack: pt, asset: makeBlueprint("foo") }]]);
    expect(
      resolveBlueprint({ blueprint: "@pt/foo", sourcePack: "prj" }, ws, packNames)?.pack.name
    ).toBe("pt");
  });

  it("限定 @prj/foo + prj 缺 + pt 有 → 返 undefined（限定不 fallback）", () => {
    const ws = makeWS([["pt/foo", { pack: pt, asset: makeBlueprint("foo") }]]);
    expect(
      resolveBlueprint({ blueprint: "@prj/foo", sourcePack: "prj" }, ws, packNames)
    ).toBeUndefined();
  });

  it("不限定 foo + selfPack=prj 但 prj 缺 → fallback 到 pt 命中（核心场景：fix warn false-positive）", () => {
    const ws = makeWS([["pt/pt-default", { pack: pt, asset: makeBlueprint("pt-default") }]]);
    const result = resolveBlueprint({ blueprint: "pt-default", sourcePack: "prj" }, ws, packNames);
    expect(result?.pack.name).toBe("pt");
    expect(result?.asset.name).toBe("pt-default");
  });

  it("不限定 foo + prj 命中 → 返 prj entry（前者赢，不 fallback）", () => {
    const prjBp = makeBlueprint("foo");
    const ptBp = makeBlueprint("foo");
    const ws = makeWS([
      ["prj/foo", { pack: prj, asset: prjBp }],
      ["pt/foo", { pack: pt, asset: ptBp }],
    ]);
    expect(
      resolveBlueprint({ blueprint: "foo", sourcePack: "prj" }, ws, packNames)?.pack.name
    ).toBe("prj");
  });

  it("不限定 foo + 所有 pack 都缺 → 返 undefined（compile 阶段会 throw）", () => {
    const ws = makeWS([]);
    expect(
      resolveBlueprint({ blueprint: "missing", sourcePack: "prj" }, ws, packNames)
    ).toBeUndefined();
  });

  it("空 blueprint → 返 undefined（无 profile.blueprint 字段时）", () => {
    expect(
      resolveBlueprint({ blueprint: "", sourcePack: "prj" }, makeWS([]), packNames)
    ).toBeUndefined();
  });

  // v15.x PR7（issue pt-remove-global-pack 移除）："prj 缺 + gbl 有" fallback 测试
  // 删除——gbl pack 不存在。跨 pack fallback 语义已在 "prj 缺 → pt 命中" 测试中覆盖。

  it("v15.x PR7：3 类 pack 加载顺序中 prj 缺 + pt 有 → 返 pt（fallback 终点）", () => {
    // 验证 PR7 移除 global pack 后，fallback 链是 prj → pt（无 gbl 中间层）
    const ptBp = makeBlueprint("foo");
    const ws = makeWS([["pt/foo", { pack: pt, asset: ptBp }]]);
    expect(
      resolveBlueprint({ blueprint: "foo", sourcePack: "prj" }, ws, packNames)?.pack.name
    ).toBe("pt");
  });
});
