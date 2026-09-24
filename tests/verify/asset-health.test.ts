// tests/verify/asset-health.test.ts — scanProjectHealth 单元测试
//
// 配套 .pt/docs/issues/pt-asset-migration-visibility.md §Layer 2：
//   5 条规则正反测 + cwd 必要参数 + builtin profile 跳过 file 重读

import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanProjectHealth } from "../../src/asset-health.js";
import type { AssetPack, Blueprint, Domain, Profile, WorkingSet } from "../../src/schema.js";

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
    groups: [{ name: "session-context", inject: "session", mode: "hybrid" }],
  };
}

function makeProfile(overrides?: Partial<Profile>): Profile {
  return {
    name: "ok-profile",
    blueprint: "bp-bb",
    domains: ["d1"],
    groups: [{ name: "session-context", domains: [], modules: [{ section: "Scene" }] }],
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
        groups: [{ name: "session-context", domains: [], modules: [] }],
      });
      const r = await scan(cwd, [profile], [makeBlueprint()], [makeDomain()]);
      // missing-modules (error) + empty-segment (error，modules 空产出空段) = 2 errors
      expect(r.errors).toBeGreaterThanOrEqual(1);
      const missing = r.issues.filter((i) => i.msg.includes("缺 ### Modules"));
      expect(missing.length).toBe(1);
      expect(missing[0]?.severity).toBe("error");
      expect(missing[0]?.field).toBe("groups.session-context.modules");
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
          { name: "session-context", domains: [], modules: [{ section: "Scene" }] },
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
          {
            name: "session-context",
            domains: ["nonexistent-domain"],
            modules: [{ section: "Scene" }],
          },
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
      const empty = r.issues.filter((i) => i.msg.includes("全聚合组空字符串"));
      expect(empty, `unexpected: ${empty.map((e) => e.msg).join("; ")}`).toHaveLength(0);
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

## session-context
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
        groups: [{ name: "session-context", domains: [], modules: [{ section: "Scene" }] }],
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

## session-context
### Modules
- Scene
- User.user-profile
`
      );
      const profile: Profile = {
        name: "ok",
        blueprint: "bp-bb",
        domains: [],
        groups: [{ name: "session-context", domains: [], modules: [{ section: "Scene" }] }],
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

## session-context
### Modules
- Scene
`
      );
      const profile: Profile = {
        name: "empty-mods",
        blueprint: "bp-bb",
        domains: [],
        groups: [{ name: "session-context", domains: [], modules: [] }], // missing-modules
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
      groups: [{ name: "session-context", domains: [], modules: [] }], // missing-modules + empty-segment
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

## session-context
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
        { name: "session-context", domains: [], modules: [{ section: "Scene" }] },
        { name: "未知聚合组", domains: [], modules: [{ section: "Scene" }] },
      ],
    };
    const r = await scan(cwd, [profile], [makeBlueprint()], [makeDomain()]);
    // orphan-h2 (warning，H2 未知聚合组) + unknown-modname (warning，Foo 段名未知) = 2 warnings
    expect(r.warnings).toBe(2);
    expect(r.issues.filter((i) => i.msg.includes("不在 Blueprint")).length).toBe(1);
    expect(r.issues.filter((i) => i.msg.includes("modName「Foo」")).length).toBe(1);
  });

  // 规则 6 (optional-domain-unresolved) 删除：optional slot 空是设计意图，不推 issue
  // 关联：issue pt-optional-domains-no-match-per-domain-aggregation

  describe("7. optional-domain-no-matching-section (warning) — per-domain 聚合", () => {
    it("prj 有 domain 但 H2 段全不匹配任一 bpGroup 的 modules → 报 1 条 warning（不是 N 条）", async () => {
      const cwd = await makeCwd();
      // domain d2 只有 Rules 段，profile 的 modules 过滤是 Scene（不匹配）
      const profile = makeProfile({
        optionalDomains: ["@prj/d2"],
      });
      const d2: Domain = {
        name: "d2",
        modules: { Rules: [{ name: "r1", type: "invariant", check: "x" }] },
      };
      const r = await scan(cwd, [profile], [makeBlueprint()], [d2]);
      const noMatch = r.issues.filter(
        (i) => i.field === "optional-domains" && i.severity === "warning"
      );
      expect(noMatch.length).toBe(1); // per-domain 聚合：1 条而非 N 条
      expect(noMatch[0]?.msg).toContain("@prj/d2");
      expect(noMatch[0]?.msg).toContain("已加载但未对任何聚合组产生贡献"); // 新措辞
      // hint 改为 actionable 两条路径
      expect(noMatch[0]?.hint).toContain("加匹配段");
      expect(noMatch[0]?.hint).toContain("从 optional-domains 移除该引用");
    });

    it("domain 部分贡献（只匹配部分 bpGroup）→ 不警告", async () => {
      const cwd = await makeCwd();
      // blueprint 2 个 bpGroup：session-context (Scene/User) + trigger-index (Trigger)
      const blueprint: Blueprint = {
        name: "bp-multi",
        groups: [
          { name: "session-context", inject: "session", mode: "hybrid" },
          { name: "trigger-index", inject: "session" },
        ],
      };
      // profile 同时实例化两个 bpGroup，modules 列表明确
      const profile: Profile = {
        name: "multi",
        blueprint: "bp-multi",
        domains: [],
        groups: [
          {
            name: "session-context",
            domains: [],
            modules: [{ section: "Scene" }, { section: "User" }],
          },
          { name: "trigger-index", domains: [], modules: [{ section: "Trigger" }] },
        ],
        optionalDomains: ["@prj/d3"],
      };
      // d3 只贡献session-context（User 段），不贡献trigger-index
      const d3: Domain = {
        name: "d3",
        modules: { User: [{ name: "u1", profile: "dev" }] },
      };
      const r = await scan(cwd, [profile], [blueprint], [d3]);
      const noMatch = r.issues.filter((i) => i.field === "optional-domains");
      expect(noMatch).toHaveLength(0); // 部分贡献 → 不警告
    });

    it("profile 含多个不贡献 bpGroup 的 optional-domain → 每个 domain 报 1 条（per-domain 聚合）", async () => {
      const cwd = await makeCwd();
      const profile = makeProfile({
        optionalDomains: ["@prj/d2", "@prj/d3"],
      });
      const d2: Domain = {
        name: "d2",
        modules: { Rules: [{ name: "r1", type: "invariant", check: "x" }] },
      };
      const d3: Domain = {
        name: "d3",
        modules: { Checklists: [{ name: "c1", steps: ["x"] }] },
      };
      const r = await scan(cwd, [profile], [makeBlueprint()], [d2, d3]);
      const noMatch = r.issues.filter(
        (i) => i.field === "optional-domains" && i.severity === "warning"
      );
      expect(noMatch.length).toBe(2); // 每个 domain 1 条（共 2 条，不是 4 条 per-bpGroup 旧行为）
      const refs = noMatch.map((i) => i.msg).join(" ");
      expect(refs).toContain("@prj/d2");
      expect(refs).toContain("@prj/d3");
    });

    it("unresolved optional ref（prj 无 domain）→ 不推 issue（规则 6 静默化）", async () => {
      const cwd = await makeCwd();
      const profile = makeProfile({
        optionalDomains: ["@prj/nonexistent-domain"],
      });
      const r = await scan(cwd, [profile], [makeBlueprint()], [makeDomain()]);
      // 规则 6 已删除——unresolved 不推 info
      const optionalIssues = r.issues.filter((i) => i.field === "optional-domains");
      expect(optionalIssues).toHaveLength(0);
      // r.infos 应为 0（未生成任何 info issue）
      expect(r.infos ?? 0).toBe(0);
    });
  });

  describe("v16 back-compat", () => {
    it("profile 不写 optional-domains → 不报 optional-* 规则", async () => {
      const cwd = await makeCwd();
      const profile = makeProfile(); // 无 optionalDomains
      const r = await scan(cwd, [profile], [makeBlueprint()], [makeDomain()]);
      expect(r.issues.filter((i) => i.field === "optional-domains")).toHaveLength(0);
      expect(r.infos ?? 0).toBe(0);
    });

    it("profile.optional-domains=[] 空数组 → 等价不写（不报）", async () => {
      const cwd = await makeCwd();
      const profile = makeProfile({ optionalDomains: [] });
      const r = await scan(cwd, [profile], [makeBlueprint()], [makeDomain()]);
      expect(r.issues.filter((i) => i.field === "optional-domains")).toHaveLength(0);
    });

    it("prj 有 optional domain + H2 段匹配 modules → 解析成功不报（back-compat）", async () => {
      const cwd = await makeCwd();
      const profile = makeProfile({
        optionalDomains: ["@prj/d1"],
      });
      // makeDomain() 默认 d1.modules.Scene 有内容 + profile.modules 含 Scene → 匹配
      const r = await scan(cwd, [profile], [makeBlueprint()], [makeDomain()]);
      // 解析成功 → 既不报 unresolved 也不报 no-match
      expect(r.issues.filter((i) => i.field === "optional-domains")).toHaveLength(0);
    });
  });

  // v17+（issue pt-scan-miss-use-chain）：scan 调 expandProfile 对齐 transpile use 链解析
  describe("8. use-expansion-error (warning) — use 链展开", () => {
    it("use 目标存在 + child 完全继承 → 不报 empty-segment（false positive 修复）", async () => {
      const cwd = await makeCwd();
      // parent：标准 profile，groups 带 modules
      const parent = makeProfile({ name: "parent", sourcePack: "prj" });
      // child：use parent，自己 groups=[]（完全继承）
      const child = makeProfile({
        name: "child",
        use: "@prj/parent",
        groups: [],
        sourcePack: "prj",
      });
      const r = await scan(cwd, [parent, child], [makeBlueprint()], [makeDomain()]);
      // child 经 expand 继承 parent 的 groups + modules → 编译产物非空 → 不报 empty-segment
      expect(r.issues.filter((i) => i.msg.includes("全聚合组空字符串"))).toHaveLength(0);
      // parent 和 child 均无 use 展开错误
      expect(r.issues.filter((i) => i.field === "use")).toHaveLength(0);
      expect(r.errors).toBe(0);
    });

    it("use 目标不存在 → 推 use-expansion-error warning + 跳过 child 的规则 1/2/3/4/7", async () => {
      const cwd = await makeCwd();
      const child = makeProfile({
        name: "child",
        use: "@prj/ghost-parent",
        groups: [],
        sourcePack: "prj",
      });
      const r = await scan(cwd, [child], [makeBlueprint()], [makeDomain()]);
      // 推 1 条 use-expansion-error warning
      const useErr = r.issues.filter((i) => i.field === "use");
      expect(useErr.length).toBe(1);
      expect(useErr[0]?.severity).toBe("warning");
      expect(useErr[0]?.msg).toContain("use 链展开失败");
      expect(useErr[0]?.msg).toContain("ghost-parent");
      // child 的空 groups 不报 missing-modules（跳过规则 1）
      expect(r.issues.filter((i) => i.msg.includes("缺 ### Modules"))).toHaveLength(0);
      // child 的空 segment 不报 empty-segment（跳过规则 4）—— 这就是 false positive 的修复点
      expect(r.issues.filter((i) => i.msg.includes("全聚合组空字符串"))).toHaveLength(0);
    });

    it("use 链循环（A→B→A）→ 推 use-expansion-error warning", async () => {
      const cwd = await makeCwd();
      const a = makeProfile({
        name: "a",
        use: "@prj/b",
        groups: [],
        sourcePack: "prj",
      });
      const b = makeProfile({
        name: "b",
        use: "@prj/a",
        groups: [],
        sourcePack: "prj",
      });
      const r = await scan(cwd, [a, b], [makeBlueprint()], [makeDomain()]);
      // 两条 use-expansion-error（a 和 b 各 1 条）
      const useErr = r.issues.filter((i) => i.field === "use");
      expect(useErr.length).toBe(2);
      for (const issue of useErr) {
        expect(issue.severity).toBe("warning");
        expect(issue.msg).toContain("use 链展开失败");
      }
    });

    it("use 后 blueprint out-of-scope → 推 use-expansion-error warning", async () => {
      const cwd = await makeCwd();
      // parent 有 groups=[a, b, c]，但 child 的 blueprint 只有 [a]（c 越权）
      const parent = makeProfile({
        name: "parent",
        sourcePack: "prj",
        groups: [
          { name: "session-context", domains: [], modules: [{ section: "Scene" }] },
          { name: "trigger-index", domains: [], modules: [{ section: "Trigger" }] },
          { name: "reference-manual", domains: [], modules: [{ section: "Rules" }] },
        ],
      });
      // child blueprint 限定 slots=[a]
      const childBlueprint: Blueprint = {
        name: "bp-child",
        groups: [{ name: "session-context", inject: "session", mode: "hybrid" }],
      };
      const child = makeProfile({
        name: "child",
        blueprint: "bp-child",
        use: "@prj/parent",
        groups: [],
        sourcePack: "prj",
      });
      const r = await scan(cwd, [parent, child], [childBlueprint], [makeDomain()]);
      // child 推 1 条 BlueprintGroupOutOfScope warning
      const useErr = r.issues.filter((i) => i.field === "use");
      expect(useErr.length).toBe(1);
      expect(useErr[0]?.severity).toBe("warning");
      expect(useErr[0]?.msg).toContain("use 链展开失败");
    });

    it("use 继承 optionalDomains → 规则 7 在继承后的 groups 上判定", async () => {
      const cwd = await makeCwd();
      // parent：声明 optionalDomains=@prj/d2，groups 带 Scene 模块
      const parent = makeProfile({
        name: "parent",
        sourcePack: "prj",
        optionalDomains: ["@prj/d2"],
      });
      // child：use parent + 自定义 blueprint（只声明 session-context 一个 bpGroup）
      const childBlueprint: Blueprint = {
        name: "bp-child",
        groups: [{ name: "session-context", inject: "session", mode: "hybrid" }],
      };
      const child = makeProfile({
        name: "child",
        blueprint: "bp-child",
        use: "@prj/parent",
        groups: [],
        sourcePack: "prj",
      });
      // d2 只有 Rules 段（与 Scene 不匹配）
      const d2: Domain = {
        name: "d2",
        modules: { Rules: [{ name: "r1", type: "invariant", check: "x" }] },
      };
      const r = await scan(cwd, [parent, child], [childBlueprint], [makeDomain(), d2]);
      // child 继承 parent 的 optionalDomains=@prj/d2 → 规则 7 报 1 条 warning
      // (parent 因 use 未涉及 optionalDomains 不该报)
      const noMatch = r.issues.filter(
        (i) => i.name === "child" && i.field === "optional-domains" && i.severity === "warning"
      );
      expect(noMatch.length).toBe(1);
      expect(noMatch[0]?.msg).toContain("@prj/d2");
    });
  });

  // v18+（issue pt-pack-ref-drift-detection 方案 A）：
  // scan 末尾合并 checkAllRefs，新增规则 9 dangling-domain-ref。
  // 覆盖矩阵：
  //   - 全局悬空 Domain 引用（profile.domains）
  //   - 聚合组悬空 Domain 引用（profile.groups[X].domains）
  //   - 规则 2/3 已覆盖的（dangling-blueprint-ref / orphan-h2）不重复推
  //   - 未实例化聚合组 warning 不纳入 scan（设计信号）
  describe("9. dangling-domain-ref (error) — settings pack 删 domain 静默破坏兜底", () => {
    it("profile.domains 引用悬空 Domain → 推 1 条 error（field=domains）", async () => {
      const cwd = await makeCwd();
      // d1 存在（makeDomain 默认），但 profile.domains 又多引用一个 d-ghost（不存在）
      const profile = makeProfile({
        domains: ["d1", "d-ghost"],
      });
      const r = await scan(cwd, [profile], [makeBlueprint()], [makeDomain()]);
      const dangling = r.issues.filter((i) => i.msg.includes("全局 domains 引用悬空"));
      expect(dangling.length).toBe(1);
      expect(dangling[0]?.severity).toBe("error");
      expect(dangling[0]?.scope).toBe("profile");
      expect(dangling[0]?.name).toBe("ok-profile");
      expect(dangling[0]?.field).toBe("domains");
      expect(dangling[0]?.msg).toContain("d-ghost");
      // hint 给 actionable 路径
      expect(dangling[0]?.hint).toContain("settings pack");
      expect(dangling[0]?.hint).toContain("从 profile.domains 移除该引用");
    });

    it("profile.groups[X].domains 引用悬空 Domain → 推 1 条 error（field=groups.X.domains）", async () => {
      const cwd = await makeCwd();
      // group.domains 引用一个不存在的 domain
      const profile = makeProfile({
        domains: [],
        groups: [
          {
            name: "session-context",
            domains: ["d1", "d-ghost-in-group"],
            modules: [{ section: "Scene" }],
          },
        ],
      });
      const r = await scan(cwd, [profile], [makeBlueprint()], [makeDomain()]);
      const dangling = r.issues.filter((i) => i.msg.includes("聚合组「session-context」引用悬空"));
      expect(dangling.length).toBe(1);
      expect(dangling[0]?.severity).toBe("error");
      expect(dangling[0]?.scope).toBe("profile");
      expect(dangling[0]?.name).toBe("ok-profile");
      expect(dangling[0]?.field).toBe("groups.session-context.domains");
      expect(dangling[0]?.msg).toContain("d-ghost-in-group");
      expect(dangling[0]?.hint).toContain("从聚合组");
    });

    it("规则 2/3 已覆盖的项不重复推 dangling-domain-ref（去重）", async () => {
      const cwd = await makeCwd();
      // case A: 规则 2（dangling-blueprint-ref）—— blueprint="ghost" 独立触发
      // checkAllRefs 会报 `Profile "X" 引用的 Blueprint "ghost" 不存在` 但 scan 不重复推
      const bpGhost = makeProfile({ name: "overlap-bp", blueprint: "ghost" });
      const rA = await scan(cwd, [bpGhost], [makeBlueprint()], [makeDomain()]);
      expect(rA.issues.filter((i) => i.msg.includes("Blueprint「ghost」不存在")).length).toBe(1);
      // scan 不重复推 "引用悬空 Blueprint" 类的 dangling-domain-ref（只报 Domain 类）
      expect(
        rA.issues.filter(
          (i) => i.msg.includes("引用悬空 Domain") || i.msg.includes("全局 domains 引用悬空")
        ).length
      ).toBe(0);

      // case B: 规则 3（orphan-h2）—— blueprint 存在但 group 越权
      // checkAllRefs 会报 `Profile "X" 的聚合组 "未知聚合组" 在 Blueprint ... 里无对应` 但 scan 不重复推
      const orphanGroup = makeProfile({
        name: "overlap-orphan",
        groups: [
          { name: "session-context", domains: [], modules: [{ section: "Scene" }] },
          { name: "未知聚合组", domains: [], modules: [{ section: "Scene" }] },
        ],
      });
      const rB = await scan(cwd, [orphanGroup], [makeBlueprint()], [makeDomain()]);
      expect(rB.issues.filter((i) => i.msg.includes("不在 Blueprint")).length).toBe(1);
      // scan 不重复推 group-domains 类的 dangling-domain-ref
      expect(
        rB.issues.filter(
          (i) => i.msg.includes("引用悬空 Domain") || i.msg.includes("全局 domains 引用悬空")
        ).length
      ).toBe(0);
    });

    it("checkAllRefs warning（未实例化聚合组）不纳入 scan——scan 不越界判断设计选择", async () => {
      const cwd = await makeCwd();
      // bp 有 2 个 bpGroup，profile 只实例化 1 个
      // checkAllRefs 会报 warning "未实例化"，但 scan 不接
      const blueprint: Blueprint = {
        name: "bp-multi",
        groups: [
          { name: "session-context", inject: "session", mode: "hybrid" },
          { name: "reference-manual", inject: "turn" },
        ],
      };
      const profile = makeProfile({
        groups: [{ name: "session-context", domains: [], modules: [{ section: "Scene" }] }],
      });
      const r = await scan(cwd, [profile], [blueprint], [makeDomain()]);
      // 不该有 "未实例化" 相关 issue（scan 不接 ref-check warning）
      const uninstantiated = r.issues.filter((i) => i.msg.includes("未实例化"));
      expect(uninstantiated.length).toBe(0);
    });

    it("正常 profile（所有 Domain 引用存在）→ 不推 dangling-domain-ref", async () => {
      const cwd = await makeCwd();
      const r = await scan(cwd, [makeProfile()], [makeBlueprint()], [makeDomain()]);
      const dangling = r.issues.filter(
        (i) => i.msg.includes("引用悬空 Domain") || i.msg.includes("全局 domains 引用悬空")
      );
      expect(dangling.length).toBe(0);
    });

    it("规则 9 与规则 4（empty-segment）独立：悬空 Domain 引用同时产 empty-segment", async () => {
      const cwd = await makeCwd();
      // profile 全局 domains 引用悬空 → compile 产空段
      const profile = makeProfile({ domains: ["d-ghost"] });
      const r = await scan(cwd, [profile], [makeBlueprint()], [makeDomain()]);
      // 规则 9 报悬空
      const dangling = r.issues.filter((i) => i.msg.includes("全局 domains 引用悬空"));
      expect(dangling.length).toBe(1);
      // 规则 4 报 empty-segment（领域加载空 → 编译产空）
      const empty = r.issues.filter((i) => i.msg.includes("全聚合组空字符串"));
      expect(empty.length).toBe(1);
      // 两条独立 issue，不去重（语义不同：rule 9 指根因，rule 4 指症状）
    });
  });
});

// ==================== v17.1 regression: pack-aware lookup with proper workingSet ====================
// c963bd4 + 76d1b46：scan 加 workingSet 参数以保留 per-asset pack identity。
// 此组测试验证：scan 收到正确 workingSet 后，不会把 `@fullstack/foo` 误报为 pack drift。

function makeMockPack(name: string): AssetPack {
  return {
    name,
    version: "0.0.0",
    rootDir: `/test/${name}`,
    source: "settings",
    loadDomains: () => Promise.resolve([]),
    loadBlueprints: () => Promise.resolve([]),
    loadProfiles: () => Promise.resolve([]),
  };
}

describe("v17.1：scan 接收 workingSet 保留 pack identity", () => {
  it("profile 引用 @fullstack/known-domain（限限定 ref，pack 正确）→ 不报 pack drift", async () => {
    const cwd = await makeCwd();
    const knownDomain = makeDomain({ name: "foo" });
    const fullstackPack = makeMockPack("fullstack");
    const projectPack = makeMockPack("prj");
    const workingSet: { domains: WorkingSet<typeof knownDomain> } = {
      domains: {
        location: new Map([["prj/foo", { pack: projectPack, asset: knownDomain }]]),
        identity: new Map([
          ["fullstack/foo", { pack: fullstackPack, asset: knownDomain }],
          ["prj/foo", { pack: projectPack, asset: knownDomain }],
        ]),
      },
    };
    const profile = makeProfile({
      name: "test",
      domains: ["@fullstack/foo"], // 限限定 ref 指向正确 pack
    });
    const r = await scanProjectHealth(
      cwd,
      [profile],
      [makeBlueprint()],
      [knownDomain],
      [projectPack, fullstackPack],
      "prj",
      workingSet
    );
    // 修包后不应报 pack drift（issue pt-scan-pack-identity-fix）
    const drift = r.issues.filter((i) => i.msg.includes("pack 改名漂移"));
    expect(drift.length).toBe(0);
  });

  it("profile 引用 @fullstack/missing-domain（pack 改名漂移场景）→ 报 pack drift", async () => {
    const cwd = await makeCwd();
    const knownDomain = makeDomain({ name: "foo" });
    const projectPack = makeMockPack("prj");
    // 只有 project pack 的 workingSet，没有 fullstack pack
    const workingSet: { domains: WorkingSet<typeof knownDomain> } = {
      domains: {
        location: new Map(),
        identity: new Map([["prj/foo", { pack: projectPack, asset: knownDomain }]]),
      },
    };
    const profile = makeProfile({
      name: "test",
      domains: ["@fullstack/foo"], // 限限定 ref 指向不存在的 pack
    });
    const r = await scanProjectHealth(
      cwd,
      [profile],
      [makeBlueprint()],
      [knownDomain],
      [projectPack],
      "prj",
      workingSet
    );
    const drift = r.issues.filter((i) => i.msg.includes("pack 改名漂移"));
    expect(drift.length).toBe(1);
    expect(drift[0]?.msg).toContain("fullstack");
  });
});
