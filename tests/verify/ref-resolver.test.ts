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
  isQualifiedRef,
  normalizePackName,
} from "../../src/parse/ref-resolver.js";
import type { AssetPack, Profile } from "../../src/schema.js";

function makePack(name: string, rootDir: string, version = "0.0.0"): AssetPack {
  return {
    name,
    rootDir,
    version,
    source: name === "prj" ? "project" : name === "pt" ? "builtin" : "global",
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

describe("parseRef（§4.2 / §4.5.1）", () => {
  it("限定 @pack/name → 返 {pack, name}", () => {
    expect(parseRef("@pt-internal/foo", "prj")).toEqual({ pack: "pt-internal", name: "foo" });
  });

  it("不限定 foo + selfPack='prj' → 绑 prj", () => {
    expect(parseRef("foo", "prj")).toEqual({ pack: "prj", name: "foo" });
  });

  it("别名 @project/foo → 归一为 @prj/foo", () => {
    expect(parseRef("@project/foo", "prj")).toEqual({ pack: "prj", name: "foo" });
  });

  it("别名 @global/foo → 归一为 @gbl/foo", () => {
    expect(parseRef("@global/foo", "prj")).toEqual({ pack: "gbl", name: "foo" });
  });

  it("别名 @builtin/foo → 归一为 @pt/foo", () => {
    expect(parseRef("@builtin/foo", "prj")).toEqual({ pack: "pt", name: "foo" });
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
    expect(normalizePackName("global")).toBe("gbl");
    expect(normalizePackName("builtin")).toBe("pt");
    expect(normalizePackName("pt-internal")).toBe("pt-internal");
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

describe("resolveAndDedupRefs（§4.4.2 / §4.5）", () => {
  const prj = makePack("prj", "/x");
  const pt = makePack("pt", "/y");
  const assetA = { name: "foo", tag: "project-ver" };
  const assetB = { name: "foo", tag: "builtin-ver" }; // 不同 rootDir → fp 不同

  it("场景 A：重复引用 @prj/foo × 2 → dedup 后 1 份", () => {
    const ws = new Map<string, { pack: AssetPack; asset: { name: string; tag: string } }>();
    ws.set("prj/foo", { pack: prj, asset: assetA });
    const result = resolveAndDedupRefs(["@prj/foo", "@prj/foo"], makeProfile(), ws, ["prj"]);
    expect(result).toHaveLength(1);
    expect(result[0]?.rawRef).toBe("@prj/foo");
  });

  it("场景 B：不限定重复 foo × 2 → dedup 后 1 份", () => {
    const ws = new Map();
    ws.set("prj/foo", { pack: prj, asset: assetA });
    const result = resolveAndDedupRefs(["foo", "foo"], makeProfile(), ws, ["prj"]);
    expect(result).toHaveLength(1);
  });

  it("场景 C：不限定 + 限定同 pack → dedup 后 1 份", () => {
    const ws = new Map();
    ws.set("prj/foo", { pack: prj, asset: assetA });
    const result = resolveAndDedupRefs(["foo", "@prj/foo"], makeProfile(), ws, ["prj"]);
    expect(result).toHaveLength(1);
  });

  it("场景 D：不同 pack 同 name 同内容 → fp 不同 → 保留 2 份", () => {
    const ws = new Map();
    ws.set("prj/foo", { pack: prj, asset: { name: "foo", tag: "same" } });
    ws.set("pt/foo", { pack: pt, asset: { name: "foo", tag: "same" } });
    const result = resolveAndDedupRefs(["@prj/foo", "@pt/foo"], makeProfile(), ws, ["prj", "pt"]);
    expect(result).toHaveLength(2);
  });

  it("场景 E：不同 pack 同 name 不同内容 → 保留 2 份", () => {
    const ws = new Map();
    ws.set("prj/foo", { pack: prj, asset: assetA });
    ws.set("pt/foo", { pack: pt, asset: assetB });
    const result = resolveAndDedupRefs(["@prj/foo", "@pt/foo"], makeProfile(), ws, ["prj", "pt"]);
    expect(result).toHaveLength(2);
  });

  it("场景 F：限定跨 pack 不同 name → 保留 2 份", () => {
    const ws = new Map();
    ws.set("prj/foo", { pack: prj, asset: { name: "foo", tag: "F" } });
    ws.set("pt/bar", { pack: pt, asset: { name: "bar", tag: "F" } });
    const result = resolveAndDedupRefs(["@prj/foo", "@pt/bar"], makeProfile(), ws, ["prj", "pt"]);
    expect(result).toHaveLength(2);
  });

  it("不限定 ref 在 selfPack 找不到时按 packs 顺序 fallback（§4.6 back-compat）", () => {
    const ws = new Map();
    ws.set("pt/foo", { pack: pt, asset: assetA });
    const result = resolveAndDedupRefs(["foo"], makeProfile(), ws, ["prj", "pt"]);
    expect(result).toHaveLength(1);
    expect(result[0]?.pack.name).toBe("pt");
  });

  it("显式 @prj/foo 找不到 → 抛错（§4.5.1，不 fallback）", () => {
    const ws = new Map();
    ws.set("pt/foo", { pack: pt, asset: assetA });
    expect(() => resolveAndDedupRefs(["@prj/foo"], makeProfile(), ws, ["prj", "pt"])).toThrow(
      /unknown pack|has no asset/
    );
  });

  it("skipOnMissing=true 静默跳过", () => {
    const ws = new Map();
    ws.set("pt/foo", { pack: pt, asset: assetA });
    const result = resolveAndDedupRefs(["@prj/foo"], makeProfile(), ws, ["prj", "pt"], {
      skipOnMissing: true,
    });
    expect(result).toHaveLength(0);
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
      expect(bundle.workingSet.domains.get("prj/user-info")).toBeDefined();
      expect(bundle.workingSet.domains.get("pt/user-info")).toBeDefined();
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

## 会话背景
### Modules
`
    );
    try {
      const pack = await MdFilePack.create({
        rootDir: root,
        source: "project",
        reservedName: "prj",
      });
      const profiles = await pack.loadProfiles();
      // reserved pack 不打 sourcePack（保留固定名 prj）
      expect(profiles[0]?.name).toBe("my");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ==================== ProfileMeta.pack + formatProfileLabels ====================

describe("ProfileMeta.pack + formatProfileLabels（§7.2 / §7.3）", () => {
  it("formatProfileLabels 加 [@pack] 前缀", async () => {
    const { formatProfileLabels } = await import("../../src/config.js");
    const labels = formatProfileLabels([
      { name: "guide", tagline: "builtin onboarding", source: "builtin", pack: "pt" },
      { name: "pt-dev", tagline: "Senior dev", source: "project", pack: "prj" },
    ]);
    expect(labels).toContain("[@pt] guide — builtin onboarding");
    expect(labels).toContain("[@prj] pt-dev — Senior dev");
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
