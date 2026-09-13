// tests/verify/asset-health.test.ts — scanProjectHealth 单元测试
//
// 配套 .pt/docs/issues/pt-asset-migration-visibility.md §Layer 2：
//   5 条规则正反测 + cwd 必要参数 + builtin profile 跳过 file 重读

import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanProjectHealth } from "../../src/asset-health.js";
import type { AssetPack, Blueprint, Domain, Profile } from "../../src/schema.js";

// v15.x PR2：scanProjectHealth 加 packs + profilePack 参数——测试用空 packs + "prj" 占位
function scan(cwd: string, profiles: Profile[], blueprints: Blueprint[], domains: Domain[]) {
  return scanProjectHealth(cwd, profiles, blueprints, domains, [] as AssetPack[], "prj");
}

const tempDirs: string[] = [];

async function makeCwd(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pt-asset-health-"));
  await mkdir(join(dir, ".pt/assets/profiles"), { recursive: true });
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

// ==================== 测试夹具 ====================

function makeBlueprint(): Blueprint {
  return {
    name: "bp-bb",
    groups: [{ name: "会话背景", inject: "session", mode: "hybrid" }],
  };
}

function makeProfile(overrides?: Partial<Profile>): Profile {
  return {
    name: "ok-profile",
    blueprint: "bp-bb",
    domains: ["d1"],
    groups: [{ name: "会话背景", domains: [], modules: [{ section: "Scene" }] }],
    ...overrides,
  };
}

function makeDomain(overrides?: Partial<Domain>): Domain {
  return {
    name: "d1",
    modules: { Scene: [{ name: "t1", desc: "term 1" }] },
    ...overrides,
  };
}

// ==================== 5 条规则 ====================

describe("scanProjectHealth", () => {
  describe("1. missing-modules (error)", () => {
    it("ProfileGroup.modules 为空 → 报 error", async () => {
      const cwd = await makeCwd();
      const profile = makeProfile({
        groups: [{ name: "会话背景", domains: [], modules: [] }],
      });
      const r = await scan(cwd, [profile], [makeBlueprint()], [makeDomain()]);
      // missing-modules (error) + empty-segment (error，modules 空产出空段) = 2 errors
      expect(r.errors).toBeGreaterThanOrEqual(1);
      const missing = r.issues.filter((i) => i.msg.includes("缺 ### Modules"));
      expect(missing.length).toBe(1);
      expect(missing[0]?.severity).toBe("error");
      expect(missing[0]?.field).toBe("groups.会话背景.modules");
    });

    it("ProfileGroup.modules 非空 → 不报", async () => {
      const cwd = await makeCwd();
      const r = await scan(cwd, [makeProfile()], [makeBlueprint()], [makeDomain()]);
      expect(r.issues.filter((i) => i.msg.includes("缺 ### Modules"))).toHaveLength(0);
    });

    it("ProfileGroup 整个不存在（无 H2 实例化）→ 不报 missing-modules（orphan 优先）", async () => {
      const cwd = await makeCwd();
      const profile = makeProfile({ groups: [] });
      const r = await scan(cwd, [profile], [makeBlueprint()], [makeDomain()]);
      // groups: [] → 不触发 missing-modules（无 group 可检查）
      expect(r.issues.filter((i) => i.msg.includes("缺 ### Modules"))).toHaveLength(0);
    });
  });

  describe("2. dangling-blueprint-ref (error)", () => {
    it("profile.blueprint 不存在 → 报 error 且 skip 后续 group 检查", async () => {
      const cwd = await makeCwd();
      const profile = makeProfile({ blueprint: "ghost-blueprint" });
      const r = await scan(cwd, [profile], [makeBlueprint()], [makeDomain()]);
      expect(r.issues.length).toBe(1);
      expect(r.issues[0]?.msg).toContain("Blueprint「ghost-blueprint」不存在");
      expect(r.issues[0]?.severity).toBe("error");
    });

    it("profile.blueprint 存在 → 不报", async () => {
      const cwd = await makeCwd();
      const r = await scan(cwd, [makeProfile()], [makeBlueprint()], [makeDomain()]);
      expect(r.issues.filter((i) => i.msg.includes("不存在"))).toHaveLength(0);
    });
  });

  describe("3. orphan-h2 (warning)", () => {
    it("ProfileGroup.name 不在 Blueprint.groups → 报 warning", async () => {
      const cwd = await makeCwd();
      const profile = makeProfile({
        groups: [
          { name: "会话背景", domains: [], modules: [{ section: "Scene" }] },
          { name: "未知聚合组", domains: [], modules: [{ section: "Trigger" }] },
        ],
      });
      const r = await scan(cwd, [profile], [makeBlueprint()], [makeDomain()]);
      const orphans = r.issues.filter((i) => i.msg.includes("不在 Blueprint"));
      expect(orphans.length).toBe(1);
      expect(orphans[0]?.severity).toBe("warning");
    });

    it("ProfileGroup.name 在 Blueprint.groups → 不报", async () => {
      const cwd = await makeCwd();
      const r = await scan(cwd, [makeProfile()], [makeBlueprint()], [makeDomain()]);
      expect(r.issues.filter((i) => i.msg.includes("不在 Blueprint"))).toHaveLength(0);
    });
  });

  describe("4. empty-segment (error)", () => {
    it("compileAgentContext 产出全空字符串 → 报 error", async () => {
      const cwd = await makeCwd();
      // profile 引用了不存在的 domain → resolveDomains 返空 → 编译产物全空
      const profile = makeProfile({
        domains: [],
        groups: [
          { name: "会话背景", domains: ["nonexistent-domain"], modules: [{ section: "Scene" }] },
        ],
      });
      const r = await scan(cwd, [profile], [makeBlueprint()], [makeDomain()]);
      const empty = r.issues.filter((i) => i.msg.includes("全聚合组空字符串"));
      expect(empty.length).toBe(1);
      expect(empty[0]?.severity).toBe("error");
    });

    it("正常 profile → 不报 empty-segment", async () => {
      const cwd = await makeCwd();
      const r = await scan(cwd, [makeProfile()], [makeBlueprint()], [makeDomain()]);
      expect(r.issues.filter((i) => i.msg.includes("全聚合组空字符串"))).toHaveLength(0);
    });

    it("compile 抛错（dangling blueprint 已先报）→ 跳过 empty-segment", async () => {
      const cwd = await makeCwd();
      const profile = makeProfile({ blueprint: "ghost" });
      // dangling-blueprint-ref 已 catch → 不该再报 empty-segment
      const r = await scan(cwd, [profile], [makeBlueprint()], [makeDomain()]);
      expect(r.issues.length).toBe(1); // 只有 dangling 一条
    });
  });

  describe("5. unknown-modname (warning)", () => {
    it("重读 profile 文件：modName 段名不在 KNOWN_SECTION_NAMES → 报 warning", async () => {
      const cwd = await makeCwd();
      // 写一个 profile 文件，### Modules 含未知段名 "Foo"
      const file = join(cwd, ".pt/assets/profiles/bad.profile.md");
      await writeFile(
        file,
        `---
name: bad
blueprint: bp-bb
domains: []
---

## 会话背景
### Modules
- Scene
- Foo
- User.bar
`
      );
      const profile: Profile = {
        name: "bad",
        blueprint: "bp-bb",
        domains: [],
        groups: [{ name: "会话背景", domains: [], modules: [{ section: "Scene" }] }],
      };
      const r = await scan(cwd, [profile], [makeBlueprint()], [makeDomain()]);
      const unknowns = r.issues.filter((i) => i.msg.includes("modName「"));
      // "Foo" 是单段未知 + "User.bar" 段已知但 item 名合法（不算未知）
      // 但 Foo 也算 unknown。Bar 不算（User 段已知）。
      // 实际只有 "Foo" 一条
      expect(unknowns.length).toBe(1);
      expect(unknowns[0]?.msg).toContain("modName「Foo」");
      expect(unknowns[0]?.severity).toBe("warning");
    });

    it("全部合法 modName → 不报 unknown-modname", async () => {
      const cwd = await makeCwd();
      const file = join(cwd, ".pt/assets/profiles/ok.profile.md");
      await writeFile(
        file,
        `---
name: ok
blueprint: bp-bb
domains: []
---

## 会话背景
### Modules
- Scene
- User.user-profile
`
      );
      const profile: Profile = {
        name: "ok",
        blueprint: "bp-bb",
        domains: [],
        groups: [{ name: "会话背景", domains: [], modules: [{ section: "Scene" }] }],
      };
      const r = await scan(cwd, [profile], [makeBlueprint()], [makeDomain()]);
      expect(r.issues.filter((i) => i.msg.includes("modName「"))).toHaveLength(0);
    });

    it("profile 文件不存在（builtin profile）→ 跳过 unknown-modname 检测", async () => {
      const cwd = await makeCwd();
      // 不写文件
      const profile = makeProfile({ name: "builtin-fake" });
      const r = await scan(cwd, [profile], [makeBlueprint()], [makeDomain()]);
      // unknown-modname 跳过（文件不存在）→ 但 empty-segment 仍可能触发
      // 此处 profile 正常 → 0 issue
      expect(r.issues.filter((i) => i.msg.includes("modName「"))).toHaveLength(0);
    });

    it("unknown-modname 与 missing-modules 独立：合法但 modules 数组为空 → 只报 missing-modules", async () => {
      const cwd = await makeCwd();
      const file = join(cwd, ".pt/assets/profiles/empty-mods.profile.md");
      await writeFile(
        file,
        `---
name: empty-mods
blueprint: bp-bb
domains: []
---

## 会话背景
### Modules
- Scene
`
      );
      const profile: Profile = {
        name: "empty-mods",
        blueprint: "bp-bb",
        domains: [],
        groups: [{ name: "会话背景", domains: [], modules: [] }], // missing-modules
      };
      const r = await scan(cwd, [profile], [makeBlueprint()], [makeDomain()]);
      // unknown-modname 不报（Scene 合法）
      expect(r.issues.filter((i) => i.msg.includes("modName「"))).toHaveLength(0);
      // missing-modules 报
      expect(r.issues.filter((i) => i.msg.includes("缺 ### Modules"))).toHaveLength(1);
    });
  });
});

// ==================== 集成 / 边界 ====================

describe("scanProjectHealth integration", () => {
  it("多个 profile × 多 issue → issue 列表按 profile 分组（issues 数累加）", async () => {
    const cwd = await makeCwd();
    const p1 = makeProfile({
      name: "p1",
      groups: [{ name: "会话背景", domains: [], modules: [] }], // missing-modules + empty-segment
    });
    const p2 = makeProfile({ name: "p2", blueprint: "ghost" }); // dangling only
    const p3 = makeProfile({ name: "p3" }); // ok
    const r = await scan(cwd, [p1, p2, p3], [makeBlueprint()], [makeDomain()]);
    // p1: 2 errors, p2: 1 error, p3: 0 → 3 errors total
    expect(r.errors).toBe(3);
    expect(r.warnings).toBe(0);
  });

  it("空 profiles → 0 issue", async () => {
    const cwd = await makeCwd();
    const r = await scan(cwd, [], [makeBlueprint()], [makeDomain()]);
    expect(r.issues.length).toBe(0);
    expect(r.errors).toBe(0);
    expect(r.warnings).toBe(0);
  });

  it("5 规则独立触发：同一 profile 触发所有规则时 issue 独立列出", async () => {
    const cwd = await makeCwd();
    const file = join(cwd, ".pt/assets/profiles/all-bad.profile.md");
    await writeFile(
      file,
      `---
name: all-bad
blueprint: bp-bb
domains: []
---

## 会话背景
### Modules
- Scene
- Foo
## 未知聚合组
### Modules
- Scene
`
    );
    const profile: Profile = {
      name: "all-bad",
      blueprint: "bp-bb",
      domains: [],
      groups: [
        { name: "会话背景", domains: [], modules: [{ section: "Scene" }] },
        { name: "未知聚合组", domains: [], modules: [{ section: "Scene" }] },
      ],
    };
    const r = await scan(cwd, [profile], [makeBlueprint()], [makeDomain()]);
    // orphan-h2 (warning，H2 未知聚合组) + unknown-modname (warning，Foo 段名未知) = 2 warnings
    expect(r.warnings).toBe(2);
    expect(r.issues.filter((i) => i.msg.includes("不在 Blueprint")).length).toBe(1);
    expect(r.issues.filter((i) => i.msg.includes("modName「Foo」")).length).toBe(1);
  });
});
