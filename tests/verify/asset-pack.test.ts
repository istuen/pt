// tests/verify/asset-pack.test.ts — v15.x PR1 新增 AssetPack 抽象的单元测试
//
// 覆盖（PR1 新增测试清单 ≥12 用例）：
//   - MdFilePack 加载 domains/ 递归多级 / 目录不存在返空
//   - tryLoadPack reserved name 不读 basename
//   - dedupByNameN 前者赢 / settings 倒序后者赢
//   - validatePack 目录不存在 / 无 asset 子目录 / 不抛异常
//   - applyProjectPackDegrade pure helper（project pack 降级强制 guide）
//   - shouldPromptGlobalPackGuide pure helper（非交互兼容 + 一次性）
//   - mdAdapter.load back-compat（settingsPacks=[] 时等价今天）
//
// 重点回归：switch-injection（transpileActive 改降级）/ phase9（集成 3 类加载链）
//           / asset-health（validatePack 与 asset-health 同层不冲突）。
// v15.x PR7（issue pt-remove-global-pack 移除）：全局 pack 删除后加载链为 3 类
//           （project/settings/builtin）而非 4 类。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { mdAdapter } from "../../src/parse/index.js";
import { MdFilePack } from "../../src/asset-pack/md-file-pack.js";
import {
  applyProjectPackDegrade,
  loadBuiltinPack,
  tryLoadPack,
} from "../../src/asset-pack/loader.js";
import { parseManifest } from "../../src/asset-pack/manifest.js";
import { validatePack } from "../../src/asset-pack/validate.js";
import {
  resolvePackPath,
  loadProjectPack,
  loadSettingsPacks,
} from "../../src/asset-pack/loader.js";
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import type { AssetPack } from "../../src/schema.js";
import { BUILTIN_ASSETS_DIR } from "../../src/constants.js";

/** 创建临时资产根目录（含 domains/blueprints/profiles 三个子目录）。 */
async function mkAssetRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `pt-asset-pack-${prefix}-`));
  await mkdir(join(root, "domains"), { recursive: true });
  await mkdir(join(root, "blueprints"), { recursive: true });
  await mkdir(join(root, "profiles"), { recursive: true });
  return root;
}

// ==================== MdFilePack ====================

describe("MdFilePack", () => {
  it("loadDomains 递归多级——能加载顶层 + 子目录的 .md", async () => {
    const root = join(process.cwd(), "tests/fixtures/asset-pack/nested");
    // v15.x §2.4.2：构造改 async（读 manifest），走 MdFilePack.create factory——删 reservedName
    const pack = await MdFilePack.create({
      rootDir: root,
      source: "project",
    });
    const domains = await pack.loadDomains();
    // 顶层 term-a.md + sub/term-b.md 都加载到（frontmatter.name 优先，name=term-b）
    const names = domains.map((d) => d.name).sort();
    expect(names.length).toBeGreaterThanOrEqual(2);
    expect(names).toContain("term-a");
    expect(names).toContain("term-b"); // frontmatter.name 优先 POSIX 路径
    // 但 sub/term-b.md 文件实际被加载—— modules 有内容
    const termB = domains.find((d) => d.name === "term-b");
    expect(termB).toBeDefined();
    expect(Object.keys(termB?.modules ?? {})).toContain("Scene");
  });

  it("loadDomains 目录不存在返空数组", async () => {
    const pack = await MdFilePack.create({
      rootDir: "/tmp/__pt_nonexistent_pack__",
      source: "project",
    });
    const domains = await pack.loadDomains();
    expect(domains).toEqual([]);
  });

  it("loadBlueprints 目录不存在返空数组", async () => {
    const pack = await MdFilePack.create({
      rootDir: "/tmp/__pt_nonexistent_pack__",
      source: "project",
    });
    const blueprints = await pack.loadBlueprints();
    expect(blueprints).toEqual([]);
  });

  it("loadProfiles 目录不存在返空数组", async () => {
    const pack = await MdFilePack.create({
      rootDir: "/tmp/__pt_nonexistent_pack__",
      source: "project",
    });
    const profiles = await pack.loadProfiles();
    expect(profiles).toEqual([]);
  });
});

// ==================== tryLoadPack reserved name ====================

describe("tryLoadPack reserved name（v15.x §2.4.2 双层语义）", () => {
  it("builtin pack 读 manifest → name='pt'（位置 alias = 身份 alias 合一）", async () => {
    // v15.x builtin 特例：builtin pack 加 manifest.name="pt"（保留名），位置 alias @pt = 身份 alias 合一。
    // 不引入 pt-builtin 之类的额外身份名——builtin pack 的"身份"就是"内置"，位置 slot @pt 是
    // 其完整身份表达。位置/身份双索引 key 重合，同一索引条目覆盖同一 key。
    const pack = await loadBuiltinPack();
    expect(pack.name).toBe("pt");
    expect(pack.source).toBe("builtin");
    expect(pack.rootDir).toBe(BUILTIN_ASSETS_DIR);
    expect(pack.version).toBe("0.2.0");
    expect(pack.description).toMatch(/builtin/i);
  });

  it("tryLoadPack 走位置别名退化", async () => {
    // v15.x §2.4.2：tryLoadPack 不再传 reservedName，reserved pack 无 manifest → 退化到位置别名
    const pack = await tryLoadPack("/some/dir/assets", "project");
    expect(pack.name).toBe("prj"); // 退化到位置别名
    expect(pack.source).toBe("project");
  });
});

// ==================== working set + mdAdapter.load 行为 ====================

describe("mdAdapter.load working set + 前者赢 fallback（v15.x §4.4.2 双索引）", () => {
  it("workingSet.domains 含 prj/ + pt/ 双份 user-info（项目 vs builtin）", async () => {
    const root = await mkAssetRoot("ws-dup");
    await writeFile(
      join(root, "domains/user-info.md"),
      `---
name: user-info
---

## User

### who-am-i
- desc: 项目版 user-info
`
    );
    try {
      const bundle = await mdAdapter.load(root, "guide", { assetDir: "." });
      // working set 双索引都非空
      expect(bundle.workingSet.domains.identity.size).toBeGreaterThan(0);
      expect(bundle.workingSet.domains.location.size).toBeGreaterThan(0);
      expect(bundle.workingSet.blueprints.identity.size).toBeGreaterThan(0);
      expect(bundle.workingSet.blueprints.location.size).toBeGreaterThan(0);
      expect(bundle.workingSet.profiles.identity.size).toBeGreaterThan(0);
      expect(bundle.workingSet.profiles.location.size).toBeGreaterThan(0);
      // user-info 在 project + builtin 各一份（identity 索引按 pack.name）
      const projectUserInfo = bundle.workingSet.domains.identity.get("prj/user-info");
      const builtinUserInfo = bundle.workingSet.domains.identity.get("pt/user-info");
      expect(projectUserInfo).toBeDefined();
      expect(builtinUserInfo).toBeDefined();
      // 位置索引按位置别名 key（project → prj）
      const projectLocUserInfo = bundle.workingSet.domains.location.get("prj/user-info");
      const builtinLocUserInfo = bundle.workingSet.domains.location.get("pt/user-info");
      expect(projectLocUserInfo).toBeDefined();
      expect(builtinLocUserInfo).toBeDefined();
      // 验证前者赢（项目版）— 项目版 desc 含"项目版"
      const projectUserModule = projectUserInfo?.asset.modules.User as Array<{
        name: string;
        desc?: string;
      }>;
      expect(projectUserModule?.[0]?.desc).toContain("项目版");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("项目无 user-info → working set 仍能从 builtin 取（fallback 走 prj→pt）", async () => {
    const emptyRoot = await mkAssetRoot("ws-empty");
    try {
      const bundle = await mdAdapter.load(emptyRoot, "guide", { assetDir: "." });
      // 项目无 user-info，但 builtin 有
      const projectEntry = bundle.workingSet.domains.identity.get("prj/user-info");
      const builtinEntry = bundle.workingSet.domains.identity.get("pt/user-info");
      expect(projectEntry).toBeUndefined();
      expect(builtinEntry).toBeDefined();
      // 位置索引同样验证
      const projectLocEntry = bundle.workingSet.domains.location.get("prj/user-info");
      const builtinLocEntry = bundle.workingSet.domains.location.get("pt/user-info");
      expect(projectLocEntry).toBeUndefined();
      expect(builtinLocEntry).toBeDefined();
    } finally {
      await rm(emptyRoot, { recursive: true, force: true });
    }
  });

  it("场景 G（v15.x §4.4.2）：@prj/foo + @pt-internal/foo 双入口命中同一 asset", async () => {
    // project pack manifest.name=pt-internal，builtin pack 无 manifest 退化到 'pt'
    // @prj/foo（位置）→ location 索引命中 project pack 的 foo
    // @pt-internal/foo（身份）→ identity 索引命中 project pack 的 foo（同 asset）
    // @pt/foo（位置）→ location 索引命中 builtin pack 的 foo
    const root = await mkAssetRoot("ws-scenario-g");
    await writeFile(
      join(root, "pt-asset-pack.yaml"),
      `name: pt-internal
version: 0.1.0
`
    );
    await writeFile(
      join(root, "domains/foo.md"),
      `---
name: foo
---

## User

### test
- desc: project 版本
`
    );
    try {
      const bundle = await mdAdapter.load(root, "guide", { assetDir: "." });
      const fooLoc = bundle.workingSet.domains.location.get("prj/foo");
      const fooId = bundle.workingSet.domains.identity.get("pt-internal/foo");
      // 两个查询命中同一 asset（同 pack 同 asset）
      expect(fooLoc).toBeDefined();
      expect(fooId).toBeDefined();
      expect(fooLoc?.asset.name).toBe("foo");
      expect(fooId?.asset.name).toBe("foo");
      expect(fooLoc?.pack.name).toBe("pt-internal");
      expect(fooId?.pack.name).toBe("pt-internal");
      // 同 fingerprint（同一 pack 同一 asset）
      const { fingerprint } = await import("../../src/parse/ref-resolver.js");
      if (fooLoc && fooId) {
        expect(fingerprint(fooLoc.pack, fooLoc.asset)).toBe(fingerprint(fooId.pack, fooId.asset));
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ==================== validatePack ====================

describe("validatePack", () => {
  it("目录不存在 → ok=false + errors[0].code='dir-not-found'", async () => {
    const pack = await tryLoadPack("/tmp/__pt_nonexistent__", "project");
    const result = await validatePack(pack);
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe("dir-not-found");
    expect(result.errors[0]?.msg).toContain("/tmp/__pt_nonexistent__");
    expect(result.reservedAlias).toBe("prj"); // v15.x §4.4.4：reserved pack 有 reservedAlias
  });

  // issue pt-pack-repair-cwd-home-edge-case：~/.pt/ 下路径 → hint 含路径语义说明
  it("~/.pt/ 下路径 dir-not-found → hint 提示'曾是 global pack 路径'", async () => {
    const homePt = join(homedir(), ".pt/__pt_test_nonexistent_home__");
    const pack = await tryLoadPack(homePt, "project");
    const result = await validatePack(pack);
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe("dir-not-found");
    expect(result.errors[0]?.hint).toContain("global pack"); // 路径语义提示
    expect(result.errors[0]?.hint).toContain("v15.x PR7"); // PR7 引用
  });

  // issue pt-pack-repair-cwd-home-edge-case：非 ~/.pt/ 路径 → hint 走通用 mkdir 指引
  it("非 ~/.pt/ 路径 dir-not-found → hint 走通用 mkdir 指引", async () => {
    const pack = await tryLoadPack("/tmp/__pt_test_nonexistent__", "project");
    const result = await validatePack(pack);
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe("dir-not-found");
    expect(result.errors[0]?.hint).toContain("mkdir"); // 通用 mkdir 指引
    expect(result.errors[0]?.hint).not.toContain("global pack"); // 非 home 路径不触发 path semantics 提示
  });

  it("目录存在但无任何 asset 子目录 → ok=false + errors[0].code='no-asset-subdir'", async () => {
    const root = await mkdtemp(join(tmpdir(), "pt-empty-"));
    try {
      const pack = await tryLoadPack(root, "project");
      const result = await validatePack(pack);
      expect(result.ok).toBe(false);
      expect(result.errors[0]?.code).toBe("no-asset-subdir");
      expect(result.errors[0]?.msg).toContain('"prj"');
      expect(result.reservedAlias).toBe("prj");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("loadXxx 抛异常时 validatePack 返 ok=false（不抛异常，§6.7.7）", async () => {
    // rootDir 需含至少一个 asset 子目录才能通过层 1，到达层 2 才调 loadXxx
    const dirWithSubs = await mkAssetRoot("validate-broken");
    try {
      const brokenPack: AssetPack = {
        name: "broken",
        version: "0.0.0",
        rootDir: dirWithSubs,
        source: "project",
        manifestWarnings: [],
        loadDomains: () => Promise.reject(new Error("parse error")),
        loadBlueprints: () => Promise.resolve([]),
        loadProfiles: () => Promise.resolve([]),
      };
      const result = await validatePack(brokenPack);
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.code === "load-failed")).toBe(true);
    } finally {
      await rm(dirWithSubs, { recursive: true, force: true });
    }
  });

  it("合法 pack → ok=true + errors=[] + reservedAlias=prj", async () => {
    const root = await mkAssetRoot("validate-ok");
    try {
      const pack = await tryLoadPack(root, "project");
      const result = await validatePack(pack);
      expect(result.ok).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.warnings).toEqual([]);
      expect(result.source).toBe("project");
      expect(result.pack).toBe("prj");
      expect(result.reservedAlias).toBe("prj"); // v15.x §4.4.4
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ==================== applyProjectPackDegrade（pure helper） ====================

describe("applyProjectPackDegrade（transpileActive 降级覆盖）", () => {
  it("degraded=false + 任意 profile → 返原值", () => {
    expect(applyProjectPackDegrade(false, "guide")).toBe("guide");
    expect(applyProjectPackDegrade(false, "my-dev")).toBe("my-dev");
  });

  it("degraded=true + requested='guide' → 返 guide（不重复覆盖）", () => {
    expect(applyProjectPackDegrade(true, "guide")).toBe("guide");
  });

  it("degraded=true + requested='my-dev' → 强制返 guide", () => {
    expect(applyProjectPackDegrade(true, "my-dev")).toBe("guide");
  });
});

// ==================== shouldPromptGlobalPackGuide（v15.x PR7 移除） ====================
//
// v15.x PR7（issue pt-remove-global-pack）：全局 pack 已被 settings pack 取代，
// shouldPromptGlobalPackGuide helper + session state.globalPackGuideShown 字段 +
// session_start 中的"~/.pt/assets/ 不存在"首次引导逻辑全部删除。跨项目共享场景
// 改走 pt.asset-packs: [{ path: "~/.pt/packs/foo" }]，无隐式首次引导。

// ==================== pack-repair builtin domain 加载验证 ====================

describe("pack-management builtin domain（§6.7.4 guide 引用）", () => {
  it("builtin pack 含 pack-management domain + FlowTemplate", async () => {
    const pack = await loadBuiltinPack();
    const domains = await pack.loadDomains();
    const packMgmt = domains.find((d) => d.name === "pack-management");
    expect(packMgmt).toBeDefined();
    // Flows 段解析为 FlowTemplate[]——含 pack-repair 这条（保留作为修复 flow）
    const flows = packMgmt?.modules.Flows as Array<{ name: string }>;
    expect(flows).toBeDefined();
    expect(flows?.some((f) => f.name === "pack-repair")).toBe(true);
  });

  it("mdAdapter.load guide profile 能解析到 pack-management domain", async () => {
    // 用 builtin pack 的根作为 cwd（assetDir 默认 = .pt/assets 不存在）——
    // 这里走空 assetDir + 任意 cwd，验证 guide profile domains 列表里能解析出 pack-management
    const emptyRoot = await mkAssetRoot("guide-empty");
    try {
      const bundle = await mdAdapter.load(emptyRoot, "guide", { assetDir: "." });
      const packMgmt = bundle.domains.find((d) => d.name === "pack-management");
      expect(packMgmt).toBeDefined();
      // 验证 rules 段存在（validate-pack-never-throws 这条规则）
      const rules = packMgmt?.modules.Rules as Array<{ name: string }>;
      expect(rules?.some((r) => r.name === "validate-pack-never-throws")).toBe(true);
    } finally {
      await rm(emptyRoot, { recursive: true, force: true });
    }
  });
});

// ==================== loadProjectPack ====================

describe("loadProjectPack", () => {
  it("reserved name='prj' + source='project'", async () => {
    const pack = await loadProjectPack("/tmp");
    expect(pack.name).toBe("prj");
    expect(pack.source).toBe("project");
  });

  it("adapterCtx.assetDir 覆盖默认路径", async () => {
    // 验证 cwd + assetDir 拼接正确
    const pack = await loadProjectPack("/tmp", { assetDir: "custom/assets" });
    expect(pack.rootDir).toBe(join("/tmp", "custom/assets"));
  });
});

// ==================== M1 + §6.7.5：第三方 pack 失效预警跳过 ====================

describe("第三方 pack 失效——预警跳过，不阻断其它 pack（§6.7.5）", () => {
  it("validatePack 目录不存在的 builtin pack 路径 → ok=false（提示作为 project pack 失败场景）", async () => {
    // v15.x PR7（issue pt-remove-global-pack 移除）：原 global pack 场景改为
    // 验证 project pack 失效路径——builtin pack 必须通过，不被 project 失败阻断。
    const brokenProject = await tryLoadPack("/tmp/__pt_nonexistent_project__", "project");
    const projectResult = await validatePack(brokenProject);
    expect(projectResult.ok).toBe(false);
    expect(projectResult.errors[0]?.code).toBe("dir-not-found");
    expect(projectResult.source).toBe("project");
    expect(projectResult.reservedAlias).toBe("prj"); // v15.x §4.4.4

    // builtin pack 同时验证 → 应正常通过（不被 project 失败阻断）
    const builtin = await loadBuiltinPack();
    const builtinResult = await validatePack(builtin);
    expect(builtinResult.ok).toBe(true);
    expect(builtinResult.source).toBe("builtin");
    expect(builtinResult.reservedAlias).toBe("pt");
  });

  it("validatePack 无 asset 子目录的 pack → ok=false + errors[0].code='no-asset-subdir'", async () => {
    const root = await mkdtemp(join(tmpdir(), "pt-empty-pack-"));
    try {
      // 非 reserved source (settings) 无 manifest → name=basename 兜底；reserved source 无 manifest → 退化
      const emptyPack = await tryLoadPack(root, "settings");
      const result = await validatePack(emptyPack);
      expect(result.ok).toBe(false);
      expect(result.errors[0]?.code).toBe("no-asset-subdir");
      expect(result.reservedAlias).toBeUndefined(); // settings 非 reserved
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ==================== S2 修复：parse 失败可见性 ====================

describe("MdFilePack parse 失败可见性（PR1 补丁 S2）", () => {
  it("parseDomain 抛错时调 adapterCtx.notify（错误上抛，不静默）", async () => {
    // 构造一个含 “目录名以 .md 结尾” 的子目录——readdir 看到 .md 条目，
    // readFile 读目录会抛 EISDIR，parseDomain 抛错。这是实际可触发 parse 抛错的场景。
    const root = await mkAssetRoot("parse-fail-notify");
    await mkdir(join(root, "domains/broken.md"), { recursive: true });
    const notifs: Array<{ msg: string; level: string }> = [];
    const adapterCtx = {
      notify: (msg: string, level: "warning" | "error") => {
        notifs.push({ msg, level });
      },
    };
    try {
      const pack = await MdFilePack.create({
        rootDir: root,
        source: "project",
        adapterCtx,
      });
      const domains = await pack.loadDomains();
      // broken.md（目录）被静默过滤掉（parse 失败）
      expect(domains).toEqual([]);
      // 但 notify 收到错误报告（恢复 v10.x 旧 loadDir 行为）
      expect(notifs.length).toBeGreaterThan(0);
      expect(notifs.some((n) => n.level === "error" && n.msg.includes("broken.md"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("parseBlueprint 抛错时调 adapterCtx.notify", async () => {
    const root = await mkAssetRoot("parse-fail-blueprint");
    // 创建 blueprints/broken.blueprint.yaml/ 目录——readFile 拋 EISDIR
    await mkdir(join(root, "blueprints/broken.blueprint.yaml"), { recursive: true });
    const notifs: Array<{ msg: string; level: string }> = [];
    const adapterCtx = {
      notify: (msg: string, level: "warning" | "error") => {
        notifs.push({ msg, level });
      },
    };
    try {
      const pack = await MdFilePack.create({
        rootDir: root,
        source: "project",
        adapterCtx,
      });
      const blueprints = await pack.loadBlueprints();
      expect(blueprints).toEqual([]);
      expect(notifs.some((n) => n.level === "error" && n.msg.includes("broken"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("不传 adapterCtx 时 fallback console.error（不依赖调用方上下文）", async () => {
    const root = await mkAssetRoot("parse-fail-no-ctx");
    await mkdir(join(root, "domains/broken.md"), { recursive: true });
    // 不传 adapterCtx → diagnostics.ts 三通道 fallback 最后走 console.error
    // 测试只验证 loadXxx 不抛（fallback 内部行为已由 console.error 处理，不影响返回）
    try {
      const pack = await MdFilePack.create({
        rootDir: root,
        source: "project",
      });
      const domains = await pack.loadDomains();
      expect(domains).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ==================== S1 修复：/pt status pack 健康展示 ====================

describe("formatPackHealthLine（§6.7.6 /pt status pack 健康展示）", () => {
  // import 内部函数——statusText 是单行格式，pack 健康行单独抽出便于测试
  it("packValidation=null → (not validated)", async () => {
    const { statusText } = await import("../../src/commands.js");
    const { createSessionState } = await import("../../src/session.js");
    const s = createSessionState();
    // packValidation 默认 null
    const out = statusText(s);
    expect(out).toContain("pt packs: (not validated)");
  });

  it("全部 ok → N/N ok + 每个 pack ✅", async () => {
    const { statusText } = await import("../../src/commands.js");
    const { createSessionState } = await import("../../src/session.js");
    const s = createSessionState();
    // v15.x PR7（issue pt-remove-global-pack 移除）：3 类 pack（project/builtin），
    // global pack 行删除——只在 PR6 测试场景出现。
    s.packValidation = [
      { pack: "prj", source: "project", reservedAlias: "prj", ok: true, errors: [], warnings: [] },
      { pack: "pt", source: "builtin", reservedAlias: "pt", ok: true, errors: [], warnings: [] },
    ];
    const out = statusText(s);
    expect(out).toContain("pt packs: 2/2 ok");
    expect(out).toContain("[@prj] ✅");
    expect(out).toContain("[@pt] ✅");
  });

  it("project 降级 → ⚠ DEGRADED + 原因", async () => {
    const { statusText } = await import("../../src/commands.js");
    const { createSessionState } = await import("../../src/session.js");
    const s = createSessionState();
    s.packValidation = [
      {
        pack: "prj",
        source: "project",
        reservedAlias: "prj",
        ok: false,
        errors: [{ code: "dir-not-found", msg: "pack 目录不存在: /tmp/__nonexistent__" }],
        warnings: [],
      },
      // v15.x PR7（issue pt-remove-global-pack 移除）：global pack 行删除，只剩 builtin pack
      { pack: "pt", source: "builtin", reservedAlias: "pt", ok: true, errors: [], warnings: [] },
    ];
    const out = statusText(s);
    expect(out).toContain("pt packs: 1/2 degraded");
    expect(out).toContain("[@prj] ⚠ DEGRADED");
    expect(out).toContain("pack 目录不存在");
  });

  // issue pt-pack-repair-cwd-home-edge-case：cwd=~ + project 降级 → 附加决策引导
  it("cwd=home + project 降级 → 附加 '| 建议切到项目目录' 后缀", async () => {
    const { statusText } = await import("../../src/commands.js");
    const { createSessionState } = await import("../../src/session.js");
    const s = createSessionState();
    s.lastCwd = homedir(); // cwd=home 触发决策引导
    s.packValidation = [
      {
        pack: "prj",
        source: "project",
        reservedAlias: "prj",
        ok: false,
        errors: [
          { code: "dir-not-found", msg: `pack 目录不存在: ${join(homedir(), ".pt/assets")}` },
        ],
        warnings: [],
      },
      { pack: "pt", source: "builtin", reservedAlias: "pt", ok: true, errors: [], warnings: [] },
    ];
    const out = statusText(s);
    expect(out).toContain("[@prj] ⚠ DEGRADED");
    expect(out).toContain("建议切到项目目录"); // cwd=home 引导
  });

  // issue pt-pack-repair-cwd-home-edge-case：cwd≠~ + project 降级 → 无引导后缀（边界）
  it("cwd=项目目录 + project 降级 → 不附加 '| 建议切到项目目录' 后缀", async () => {
    const { statusText } = await import("../../src/commands.js");
    const { createSessionState } = await import("../../src/session.js");
    const s = createSessionState();
    s.lastCwd = "/Users/issac/pro/pt"; // 非 home
    s.packValidation = [
      {
        pack: "prj",
        source: "project",
        reservedAlias: "prj",
        ok: false,
        errors: [{ code: "dir-not-found", msg: "pack 目录不存在: /tmp/__nonexistent__" }],
        warnings: [],
      },
      { pack: "pt", source: "builtin", reservedAlias: "pt", ok: true, errors: [], warnings: [] },
    ];
    const out = statusText(s);
    expect(out).toContain("[@prj] ⚠ DEGRADED");
    expect(out).not.toContain("建议切到项目目录"); // 非 home 不触发引导
  });

  // issue pt-pack-repair-cwd-home-edge-case：cwd=~ + project 降级 → 附加决策引导
  it("cwd=home + project 降级 → 附加 '| 建议切到项目目录' 后缀", async () => {
    const { statusText } = await import("../../src/commands.js");
    const { createSessionState } = await import("../../src/session.js");
    const s = createSessionState();
    s.lastCwd = homedir(); // cwd=home 触发决策引导
    s.packValidation = [
      {
        pack: "prj",
        source: "project",
        reservedAlias: "prj",
        ok: false,
        errors: [
          { code: "dir-not-found", msg: `pack 目录不存在: ${join(homedir(), ".pt/assets")}` },
        ],
        warnings: [],
      },
      { pack: "pt", source: "builtin", reservedAlias: "pt", ok: true, errors: [], warnings: [] },
    ];
    const out = statusText(s);
    expect(out).toContain("[@prj] ⚠ DEGRADED");
    expect(out).toContain("建议切到项目目录"); // cwd=home 引导
  });

  // issue pt-pack-repair-cwd-home-edge-case：cwd≠~ + project 降级 → 无引导后缀（边界）
  it("cwd=项目目录 + project 降级 → 不附加 '| 建议切到项目目录' 后缀", async () => {
    const { statusText } = await import("../../src/commands.js");
    const { createSessionState } = await import("../../src/session.js");
    const s = createSessionState();
    s.lastCwd = "/Users/issac/pro/pt"; // 非 home
    s.packValidation = [
      {
        pack: "prj",
        source: "project",
        reservedAlias: "prj",
        ok: false,
        errors: [{ code: "dir-not-found", msg: "pack 目录不存在: /tmp/__nonexistent__" }],
        warnings: [],
      },
      { pack: "pt", source: "builtin", reservedAlias: "pt", ok: true, errors: [], warnings: [] },
    ];
    const out = statusText(s);
    expect(out).toContain("[@prj] ⚠ DEGRADED");
    expect(out).not.toContain("建议切到项目目录"); // 非 home 不触发引导
  });

  it("PR2：version 出现在展示行", async () => {
    const { statusText } = await import("../../src/commands.js");
    const { createSessionState } = await import("../../src/session.js");
    const s = createSessionState();
    s.packValidation = [
      {
        pack: "prj",
        source: "project",
        reservedAlias: "prj",
        ok: true,
        errors: [],
        warnings: [],
        version: "1.2.3",
        rootDir: "/x",
      },
      // v15.x PR7（issue pt-remove-global-pack 移除）：global pack 行删除
      {
        pack: "pt",
        source: "builtin",
        reservedAlias: "pt",
        ok: true,
        errors: [],
        warnings: [],
        version: "0.0.0",
        rootDir: "/z",
      },
    ];
    const out = statusText(s);
    expect(out).toContain("v1.2.3");
    expect(out).toContain("v0.0.0");
  });

  it("v15.x §4.4.4：description 不进展示行（砍 desc，详情走 /pt packs）", async () => {
    const { statusText } = await import("../../src/commands.js");
    const { createSessionState } = await import("../../src/session.js");
    const s = createSessionState();
    const longDesc = "a".repeat(60);
    s.packValidation = [
      {
        pack: "pt-internal",
        source: "project",
        reservedAlias: "prj", // reserved 显位置别名（与 pack.name 不同 → name: pt-internal 走 /pt packs）
        ok: true,
        errors: [],
        warnings: [],
        version: "1.0.0",
        rootDir: "/x",
        description: longDesc,
      },
    ];
    const out = statusText(s);
    // status 行只显位置别名 + version，desc 砍掉
    expect(out).toContain("[@prj] v1.0.0 ✅");
    expect(out).not.toContain("a".repeat(45));
  });

  it("v15.x §4.4.4：settings pack 显 pack 名（不显 reservedAlias）", async () => {
    const { statusText } = await import("../../src/commands.js");
    const { createSessionState } = await import("../../src/session.js");
    const s = createSessionState();
    s.packValidation = [
      {
        pack: "pt-internal",
        source: "settings",
        ok: true, // settings 无 reservedAlias
        errors: [],
        warnings: [],
        version: "2.0.0",
        rootDir: "/x",
      },
    ];
    const out = statusText(s);
    expect(out).toContain("[@pt-internal] v2.0.0 ✅");
  });

  it("v15.x §4.4.4（缺口 5）：/pt packs 输出 desc + asset 计数 + manifest hints（issue pt-cold-start-warning-noise §短期方案 2）", async () => {
    const { packsText } = await import("../../src/commands.js");
    const { createSessionState } = await import("../../src/session.js");
    const s = createSessionState();
    s.packValidation = [
      {
        pack: "pt-internal",
        source: "project",
        reservedAlias: "prj",
        ok: true,
        errors: [],
        warnings: [],
        version: "1.0.0",
        rootDir: "/x",
        description: "Test pack desc",
        manifestWarnings: ["name-kebab: bad name"],
      },
      {
        pack: "prj",
        source: "project",
        reservedAlias: "prj",
        ok: true,
        errors: [],
        warnings: [],
        version: "0.0.0",
        rootDir: "/y",
        manifestWarnings: [],
      },
    ];
    const out = packsText(s);
    expect(out).toContain("pt packs (2 loaded):");
    expect(out).toContain("[@prj] v1.0.0 ✅ (project)");
    expect(out).toContain("name: pt-internal"); // 有 manifest 时显真实 name
    expect(out).toContain("Test pack desc"); // desc 走 packsText
    // reserved 退化场景：pack.name=位置别名，不显 name 行
    expect(out).toContain("[@prj] v0.0.0 ✅");
    // issue pt-cold-start-warning-noise §短期方案 2：manifest 警告被动展示
    expect(out).toContain("⚠ manifest hints:");
    expect(out).toContain("manifest: name-kebab: bad name");
  });

  it("manifestWarnings=[] → /pt packs 不出现 manifest hints 行", async () => {
    const { packsText } = await import("../../src/commands.js");
    const { createSessionState } = await import("../../src/session.js");
    const s = createSessionState();
    s.packValidation = [
      {
        pack: "pt",
        source: "builtin",
        reservedAlias: "pt",
        ok: true,
        errors: [],
        warnings: [],
        version: "0.0.0",
        rootDir: "/y",
        manifestWarnings: [],
      },
    ];
    const out = packsText(s);
    expect(out).not.toContain("manifest hints");
  });
});

// ==================== PR2 §2.2：parseManifest 测试 ====================

describe("parseManifest（§2.2 / §2.4.1 校验）", () => {
  it("合法 manifest → ok=true + name/version/description", async () => {
    const root = await mkdtemp(join(tmpdir(), "pt-manifest-"));
    try {
      await writeFile(
        join(root, "pt-asset-pack.yaml"),
        `name: pt-internal
version: 1.4.0
description: Pt 项目内部共享资产
`
      );
      const m = await parseManifest(root);
      expect(m.ok).toBe(true);
      expect(m.name).toBe("pt-internal");
      expect(m.version).toBe("1.4.0");
      expect(m.description).toBe("Pt 项目内部共享资产");
      expect(m.warnings).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("文件不存在 → ok=false + warnings=[]（隐式 pack）", async () => {
    const m = await parseManifest("/tmp/__pt_no_manifest__");
    expect(m.ok).toBe(false);
    expect(m.warnings).toEqual([]);
  });

  it("YAML 语法错 → ok=false + warnings 含 'parse failed'", async () => {
    const root = await mkdtemp(join(tmpdir(), "pt-manifest-"));
    try {
      await writeFile(join(root, "pt-asset-pack.yaml"), "name: [\nunclosed bracket\n");
      const m = await parseManifest(root);
      expect(m.ok).toBe(false);
      expect(m.warnings.some((w) => w.includes("parse failed"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("name 非 kebab-case → warnings + name 丢弃", async () => {
    const root = await mkdtemp(join(tmpdir(), "pt-manifest-"));
    try {
      await writeFile(join(root, "pt-asset-pack.yaml"), `name: "Bad Name"\n`);
      const m = await parseManifest(root);
      expect(m.ok).toBe(true);
      expect(m.name).toBeUndefined();
      expect(m.warnings.some((w) => w.includes("not kebab-case"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("name 保留名冲突（'prj'）→ warnings + name 丢弃", async () => {
    const root = await mkdtemp(join(tmpdir(), "pt-manifest-"));
    try {
      await writeFile(join(root, "pt-asset-pack.yaml"), `name: prj\n`);
      const m = await parseManifest(root);
      expect(m.ok).toBe(true);
      expect(m.name).toBeUndefined();
      expect(m.warnings.some((w) => w.includes("is reserved"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("version 非 semver → warnings + version 丢弃", async () => {
    const root = await mkdtemp(join(tmpdir(), "pt-manifest-"));
    try {
      await writeFile(
        join(root, "pt-asset-pack.yaml"),
        `name: foo\nversion: "1.2"\n` // 缺 patch
      );
      const m = await parseManifest(root);
      expect(m.ok).toBe(true);
      expect(m.name).toBe("foo");
      expect(m.version).toBeUndefined();
      expect(m.warnings.some((w) => w.includes("not semver"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("top-level 不是 mapping → ok=false + warnings", async () => {
    const root = await mkdtemp(join(tmpdir(), "pt-manifest-"));
    try {
      await writeFile(join(root, "pt-asset-pack.yaml"), `- just\n- a\n- list\n`);
      const m = await parseManifest(root);
      expect(m.ok).toBe(false);
      expect(m.warnings.some((w) => w.includes("not a mapping"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ==================== v15.x builtin 特例：保留名规则对 source=builtin 放行 ====================
//
// 设计依据（§2.4.2 + builtin 特例）：
//   - builtin pack 的"身份"就是"内置"（位置 slot @pt 是其完整身份表达）
//   - manifest.name="pt" 合法——位置 alias @pt = 身份 alias 合一
//   - project/settings pack 仍禁用保留名（保护位置 slot，避免占用 reserved pack 的物理位置）

describe("parseManifest 保留名规则（v15.x builtin 特例）", () => {
  it("source=builtin + manifest.name='pt'（保留名）→ ok=true + name='pt'（不放 warning）", async () => {
    const root = await mkdtemp(join(tmpdir(), "pt-manifest-builtin-"));
    try {
      await writeFile(join(root, "pt-asset-pack.yaml"), `name: pt\nversion: 0.0.0\n`);
      const m = await parseManifest(root, "builtin"); // 传 source=builtin
      expect(m.ok).toBe(true);
      expect(m.name).toBe("pt");
      expect(m.warnings).toEqual([]); // 不放保留名警告
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("source=project + manifest.name='prj'（保留名）→ 警告 + name 丢弃", async () => {
    const root = await mkdtemp(join(tmpdir(), "pt-manifest-project-"));
    try {
      await writeFile(join(root, "pt-asset-pack.yaml"), `name: prj\nversion: 0.0.0\n`);
      const m = await parseManifest(root, "project"); // 传 source=project
      expect(m.ok).toBe(true);
      expect(m.name).toBeUndefined(); // 保留名丢弃
      expect(m.warnings.some((w) => w.includes("is reserved"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // v15.x PR7（issue pt-remove-global-pack 移除）：source=global + manifest.name='gbl'
  // 测试删除——global pack 类型已删除，调用 parseManifest(root, "global") 在 type 系统层
  // 报错（"global" 不在 PackSource 联合类型里）。gbl 保留名也从 RESERVED_NAMES 移除，
  // 因为不再有位置 alias 与之关联。

  it("source=settings + manifest.name='pt'（保留名）→ 警告 + name 丢弃（保护位置 slot）", async () => {
    const root = await mkdtemp(join(tmpdir(), "pt-manifest-settings-"));
    try {
      await writeFile(join(root, "pt-asset-pack.yaml"), `name: pt\n`);
      const m = await parseManifest(root, "settings");
      expect(m.name).toBeUndefined();
      expect(m.warnings.some((w) => w.includes("is reserved"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("source 不传（默认） + manifest.name='pt'（保留名）→ 警告 + name 丢弃（保守行为）", async () => {
    // 不传 source → 走通用保留名规则（不允许），调用方需要明确 source 才能放行 builtin 特例
    const root = await mkdtemp(join(tmpdir(), "pt-manifest-default-"));
    try {
      await writeFile(join(root, "pt-asset-pack.yaml"), `name: pt\n`);
      const m = await parseManifest(root); // 不传 source
      expect(m.name).toBeUndefined();
      expect(m.warnings.some((w) => w.includes("is reserved"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("source=builtin + manifest.name='pt-builtin'（合法 kebab 非保留名）→ ok=true + name='pt-builtin'", async () => {
    // 未来如果 builtin pack 想用非保留名身份也是合法的（但当前默认用 pt 合一）
    const root = await mkdtemp(join(tmpdir(), "pt-manifest-builtin-alt-"));
    try {
      await writeFile(join(root, "pt-asset-pack.yaml"), `name: pt-builtin\nversion: 0.0.0\n`);
      const m = await parseManifest(root, "builtin");
      expect(m.ok).toBe(true);
      expect(m.name).toBe("pt-builtin");
      expect(m.warnings).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ==================== notify 分流：reserved silent / settings 提示 ====================
//
// 设计依据：v15.x §2.4.2 + pack-management 域 pack-naming 段
//   - reserved pack（project/builtin）无 manifest → 退化到位置别名（prj/pt），
//     back-compat 设计预期——silent 不通知
//   - settings pack 无 manifest → basename 兜底"易碎"，建议加 manifest 让 pack 自描述

describe("MdFilePack.create notify 分流（reserved silent / settings 提示）", () => {
  /** 抓 notify 调用的辅助——单测必备。 */
  function captureNotify(): {
    notifs: Array<{ msg: string; level: string }>;
    adapterCtx: { notify: (msg: string, level: "info" | "warning" | "error") => void };
  } {
    const notifs: Array<{ msg: string; level: string }> = [];
    return {
      notifs,
      adapterCtx: {
        notify: (msg: string, level: "info" | "warning" | "error") => {
          notifs.push({ msg, level });
        },
      },
    };
  }

  it("reserved pack（project）无 manifest → silent，不通知", async () => {
    const root = await mkAssetRoot("notify-reserved-project");
    const { notifs, adapterCtx } = captureNotify();
    try {
      const pack = await MdFilePack.create({
        rootDir: root,
        source: "project",
        adapterCtx,
      });
      expect(pack.name).toBe("prj"); // 位置别名退化
      expect(notifs).toEqual([]); // reserved pack 无 manifest = back-compat 设计预期
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reserved pack（builtin）有 manifest（name='pt'）→ 完全 silent（验证修复：不再被刷\"无 manifest\"警告）", async () => {
    // 本轮修复点：builtin pack 加 manifest 后不再被刷 "无 manifest（back-compat fallback）" 警告。
    // 该警告是 false positive——reserved pack 无 manifest 退到位置别名是 back-compat 设计预期。
    const { notifs, adapterCtx } = captureNotify();
    try {
      const pack = await MdFilePack.create({
        rootDir: BUILTIN_ASSETS_DIR,
        source: "builtin",
        adapterCtx,
      });
      expect(pack.name).toBe("pt"); // manifest.name="pt" 合一
      expect(notifs).toEqual([]); // manifest 合法 + source=builtin → 完全 silent
    } finally {
      // 不删 builtin dir
    }
  });

  it("settings pack 无 manifest → 不 notify，改填 manifestMissingHint（issue pt-cold-start-warning-noise §短期方案 2）", async () => {
    const root = await mkAssetRoot("notify-settings-no-manifest");
    const { notifs, adapterCtx } = captureNotify();
    try {
      const pack = await MdFilePack.create({
        rootDir: root,
        source: "settings",
        adapterCtx,
      });
      expect(pack.name).toMatch(/notify-settings-no-manifest/); // basename 兜底
      // issue pt-cold-start-warning-noise：session_start 不弹窗，改存到 pack 字段。
      expect(notifs.length).toBe(0);
      expect(pack.manifestWarnings).toEqual([]);
      expect(pack.manifestMissingHint).toContain("无 manifest");
      expect(pack.manifestMissingHint).toContain("/pt_turn_inject pack-management#pack-create");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("settings pack 有合法 manifest → silent（无警告，manifest.name 生效）", async () => {
    const root = await mkAssetRoot("notify-settings-with-manifest");
    await writeFile(
      join(root, "pt-asset-pack.yaml"),
      `name: my-settings-pack
version: 1.0.0
description: ok
`
    );
    const { notifs, adapterCtx } = captureNotify();
    try {
      const pack = await MdFilePack.create({
        rootDir: root,
        source: "settings",
        adapterCtx,
      });
      expect(pack.name).toBe("my-settings-pack");
      expect(notifs).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("settings pack manifest name 非 kebab → 走 warnings 字段，不 notify（issue pt-cold-start-warning-noise §短期方案 2）", async () => {
    const root = await mkAssetRoot("notify-settings-bad-name");
    await writeFile(join(root, "pt-asset-pack.yaml"), `name: "Bad Name"\n`);
    const { notifs, adapterCtx } = captureNotify();
    try {
      const pack = await MdFilePack.create({
        rootDir: root,
        source: "settings",
        adapterCtx,
      });
      expect(pack.name).toMatch(/notify-settings-bad-name/); // basename 兜底
      // issue pt-cold-start-warning-noise：session_start 不弹窗，改存到 pack.manifestWarnings
      expect(notifs.length).toBe(0);
      expect(pack.manifestWarnings.length).toBeGreaterThan(0);
      expect(pack.manifestWarnings[0]).toContain("name-kebab");
      expect(pack.manifestMissingHint).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ==================== v15.x builtin 特例：位置 alias + 身份 alias 合一 ====================
//
// 设计依据：builtin pack 的"身份"就是"内置"，位置 slot @pt 是其完整身份表达。
// 合一后：@pt/foo（位置 alias）和 @pt/foo（身份 alias）命中同一份 asset。
// workingSet 双索引 key 重合（location 与 identity index 的 pt/foo 指向同一 entry）。

describe("builtin pack 合一：位置 alias @pt = 身份 alias @pt（集成验证）", () => {
  it("@pt/guide（位置 alias）+ @pt/guide（身份 alias）→ 命中同一份 builtin guide profile", async () => {
    const { mdAdapter } = await import("../../src/parse/index.js");
    const bundle = await mdAdapter.load(process.cwd(), "guide");
    // profiles 工作集双索引
    const locWS = bundle.workingSet.profiles.location;
    const idWS = bundle.workingSet.profiles.identity;
    // 位置 alias @pt/guide → 命中 builtin pack 的 guide profile（按 source=builtin）
    const byLoc = locWS.get("pt/guide");
    expect(byLoc).toBeDefined();
    expect(byLoc?.pack.source).toBe("builtin");
    // 身份 alias @pt/guide → pack.name="pt" 查 identity 索引，key 重合命中同一份
    const byId = idWS.get("pt/guide");
    expect(byId).toBeDefined();
    expect(byId?.pack.source).toBe("builtin");
    // 关键合一证据：两个索引的 entry 是同一份 asset
    expect(byLoc?.asset).toBe(byId?.asset);
  });

  it("@pt/user-info（位置 alias）+ @pt/user-info（身份 alias）→ 命中同一份 builtin user-info domain", async () => {
    const { mdAdapter } = await import("../../src/parse/index.js");
    const bundle = await mdAdapter.load(process.cwd(), "guide");
    const locDomWS = bundle.workingSet.domains.location;
    const idDomWS = bundle.workingSet.domains.identity;
    const byLoc = locDomWS.get("pt/user-info");
    const byId = idDomWS.get("pt/user-info");
    expect(byLoc).toBeDefined();
    expect(byId).toBeDefined();
    expect(byLoc?.asset).toBe(byId?.asset); // 合一证明
  });

  it("active profile 解析：@pt/guide（位置 alias）→ exact（findActiveProfile 按 source 查位置 alias）", async () => {
    // v15.x §2.4.4：位置 alias 寻址 builtin pack 的 profile——findActiveProfile 本轮修复
    // （按 source 查位置 alias，与 pack.name 解耦）。合一后位置 alias @pt = 身份 alias @pt 都指向
    // 同一 pack，按 source 查的路径仍然正确（pack.name 也是 "pt"）。
    const { mdAdapter } = await import("../../src/parse/index.js");
    const bundle = await mdAdapter.load(process.cwd(), "@pt/guide");
    expect(bundle.activeProfileOrigin).toBe("exact");
    expect(bundle.activeProfile).toBe("guide");
  });
});

// ==================== PR2 §2.4.2：MdFilePack.create name 解析优先级 ====================

describe("MdFilePack.create name 解析优先级（§2.4.2 双层语义）", () => {
  it("reserved pack 读 manifest → pack.name=manifest.name", async () => {
    // v15.x §2.4.2（缺口 1）：reserved pack 读 manifest，不再跳过
    const root = await mkAssetRoot("mdpack-reserved");
    await writeFile(
      join(root, "pt-asset-pack.yaml"),
      `name: pt-internal
version: 0.1.0
description: Test reserved pack
`
    );
    try {
      const pack = await MdFilePack.create({
        rootDir: root,
        source: "project",
      });
      expect(pack.name).toBe("pt-internal");
      expect(pack.version).toBe("0.1.0");
      expect(pack.description).toBe("Test reserved pack");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reserved pack 无 manifest → 退化到位置别名（back-compat）", async () => {
    // v15.x §2.4.2（缺口 1-b）：reserved pack 无 manifest 时 name=位置别名（prj/gbl/pt）
    const root = await mkAssetRoot("mdpack-reserved-degrade");
    try {
      const pack = await MdFilePack.create({
        rootDir: root,
        source: "project",
      });
      expect(pack.name).toBe("prj"); // 位置别名退化
      expect(pack.version).toBe("0.0.0");
      expect(pack.description).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("显式 pack（settings/source）+ 合法 manifest → manifest.name", async () => {
    const root = await mkAssetRoot("mdpack-explicit");
    await writeFile(
      join(root, "pt-asset-pack.yaml"),
      `name: pt-internal
version: 2.0.0
description: Test pack
`
    );
    try {
      const pack = await MdFilePack.create({
        rootDir: root,
        source: "settings", // 非 reserved
      });
      expect(pack.name).toBe("pt-internal");
      expect(pack.version).toBe("2.0.0");
      expect(pack.description).toBe("Test pack");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("非 reserved pack 无 manifest → basename 兜底", async () => {
    const root = await mkAssetRoot("mdpack-implicit"); // basename = "pt-asset-pack-mdpack-implicit-XXXX"
    try {
      const pack = await MdFilePack.create({
        rootDir: root,
        source: "settings", // settings 是非 reserved
      });
      // basename 兜底（tmp 目录带 pt-asset-pack 前缀）
      expect(pack.name).toMatch(/mdpack-implicit/);
      expect(pack.version).toBe("0.0.0");
      expect(pack.description).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("end-to-end 退化路径：reserved 无 manifest 走 packValidation.reservedAlias", async () => {
    // v15.x §4.4.4（缺口 1-b + 缺口 4）：reserved pack 无 manifest → packValidation.reservedAlias=位置别名
    const root = await mkAssetRoot("mdpack-e2e-degrade");
    try {
      const pack = await MdFilePack.create({
        rootDir: root,
        source: "project",
      });
      expect(pack.name).toBe("prj");
      const { validatePack } = await import("../../src/asset-pack/validate.js");
      const v = await validatePack(pack);
      expect(v.reservedAlias).toBe("prj");
      expect(v.pack).toBe("prj");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ==================== PR2 §6.7.2：validatePack pack 内一致性 ====================

describe("validatePack pack 内一致性（§6.7.2 层 2）", () => {
  it("同 Pack 内两个同名 domain → ok=false + errors[0].code='intra-pack-conflict'", async () => {
    const root = await mkAssetRoot("intra-domain");
    await writeFile(join(root, "domains/dup-a.md"), "---\nname: dup\n---\n## Scene\n- x: y\n");
    await writeFile(join(root, "domains/dup-b.md"), "---\nname: dup\n---\n## Scene\n- x: z\n");
    try {
      const pack = await MdFilePack.create({
        rootDir: root,
        source: "project",
      });
      const result = await validatePack(pack);
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.code === "intra-pack-conflict")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ValidationResult 含 version/description/rootDir 展示字段", async () => {
    const root = await mkAssetRoot("vr-fields");
    await writeFile(
      join(root, "pt-asset-pack.yaml"),
      `name: test-pack
version: 1.0.0
description: test desc
`
    );
    try {
      const pack = await MdFilePack.create({
        rootDir: root,
        source: "settings", // v15.x PR7（issue pt-remove-global-pack 移除）：source 改 "settings"（"global" 已不在 PackSource）
      });
      const result = await validatePack(pack);
      expect(result.version).toBe("1.0.0");
      expect(result.description).toBe("test desc");
      expect(result.rootDir).toBe(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ==================== PR4：resolvePackPath + loadSettingsPacks + loadProjectPack 配置 ====================

describe("PR4 resolvePackPath（§6.2）", () => {
  it("~ 开头 → home dir 展开（~/foo）", () => {
    expect(resolvePackPath("~/projects", "/cwd")).toBe(join(homedir(), "projects"));
  });

  it("~ 开头（无 /）→ home dir 展开（~foo）", () => {
    expect(resolvePackPath("~assets", "/cwd")).toBe(join(homedir(), "assets"));
  });

  it("绝对路径 → 原样返回", () => {
    expect(resolvePackPath("/abs/path", "/cwd")).toBe("/abs/path");
  });

  it("相对路径 → resolve(cwd, raw)", () => {
    expect(resolvePackPath("../shared", "/cwd")).toBe(join("/cwd", "..", "shared"));
    expect(resolvePackPath("./sub", "/cwd")).toBe(join("/cwd", "sub"));
  });
});

describe("PR4 loadSettingsPacks（§6.1）", () => {
  let tmpCwd: string;
  beforeEach(() => {
    tmpCwd = mkdtempSync(join(tmpdir(), "pt-pr4-"));
  });
  afterEach(() => {
    rmSync(tmpCwd, { recursive: true, force: true });
  });

  function writeSettings(content: object): void {
    mkdirSync(join(tmpCwd, ".pi"), { recursive: true });
    writeFileSync(join(tmpCwd, ".pi/settings.json"), JSON.stringify(content), "utf8");
  }

  // readProjectSetting 按 dot path 解析——settings.json 需嵌套结构 {pt: {asset-packs: [...]}}
  function writeSettingsPacks(packs: Array<{ path: string }>): void {
    writeSettings({ pt: { "asset-packs": packs } });
  }

  function makePackDir(packName: string, withManifest = true): string {
    const dir = join(tmpCwd, "pack", packName);
    mkdirSync(join(dir, "domains"), { recursive: true });
    if (withManifest) {
      writeFileSync(join(dir, "pt-asset-pack.yaml"), `name: ${packName}\nversion: 1.0.0\n`, "utf8");
    }
    return dir;
  }

  it("无 settings.json → 返 []", async () => {
    const packs = await loadSettingsPacks(tmpCwd);
    expect(packs).toEqual([]);
  });

  it("settings.json 无 pt.asset-packs → 返 []", async () => {
    writeSettings({ pt: { "default-profile": "guide" } });
    const packs = await loadSettingsPacks(tmpCwd);
    expect(packs).toEqual([]);
  });

  it("pt.asset-packs 空数组 → 返 []", async () => {
    writeSettingsPacks([]);
    const packs = await loadSettingsPacks(tmpCwd);
    expect(packs).toEqual([]);
  });

  it("2 个有效 path → 返 2 个 settings pack（name 从 manifest 读）", async () => {
    const dirA = makePackDir("team-a");
    const dirB = makePackDir("team-b");
    writeSettingsPacks([{ path: dirA }, { path: dirB }]);
    const packs = await loadSettingsPacks(tmpCwd);
    expect(packs).toHaveLength(2);
    expect(packs[0]?.name).toBe("team-a");
    expect(packs[1]?.name).toBe("team-b");
    expect(packs[0]?.source).toBe("settings");
  });

  it("path 无效（目录不存在）→ 返空 Pack（不抛），session_start validatePack 兑底", async () => {
    const dirA = makePackDir("team-a");
    writeSettingsPacks([{ path: dirA }, { path: "/nonexistent/path/should/be/skipped" }]);
    const packs = await loadSettingsPacks(tmpCwd);
    // 两个 pack 都返（invald 返空 Pack，team-a 返真 Pack）——不预检测目录
    expect(packs).toHaveLength(2);
    expect(packs[0]?.name).toBe("team-a");
    // invalid pack name 是 basename（无 manifest）—— loader 不预检测，由 session_start validatePack 报 dir-not-found
    expect(packs[1]?.rootDir).toBe("/nonexistent/path/should/be/skipped");
  });

  it("条目无 path 字段 → 跳过", async () => {
    writeSettings({ pt: { "asset-packs": [{ name: "no-path" }, {}] } });
    const packs = await loadSettingsPacks(tmpCwd);
    expect(packs).toEqual([]);
  });

  it("path 是 ~ 开头 → home dir 展开（loader 不抛）", async () => {
    writeSettingsPacks([{ path: "~/__pt_test_nonexistent__" }]);
    const packs = await loadSettingsPacks(tmpCwd);
    expect(packs).toHaveLength(1); // 返空 Pack（目录不存在但 loader 不抛）
    expect(packs[0]?.source).toBe("settings");
    expect(packs[0]?.rootDir).toBe(join(homedir(), "__pt_test_nonexistent__"));
  });
});

describe("PR4 loadProjectPack pt.project-pack-dir（§6.5）", () => {
  let tmpCwd: string;
  beforeEach(() => {
    tmpCwd = mkdtempSync(join(tmpdir(), "pt-pr4-pp-"));
  });
  afterEach(() => {
    rmSync(tmpCwd, { recursive: true, force: true });
  });

  it("不写 project-pack-dir → 默认 .pt/assets", async () => {
    const pack = await loadProjectPack(tmpCwd);
    expect(pack.name).toBe("prj");
    expect(pack.source).toBe("project");
    expect(pack.rootDir).toBe(join(tmpCwd, ".pt/assets"));
  });

  it("pt.project-pack-dir 自定义相对路径 → 读配置", async () => {
    const customDir = join(tmpCwd, "custom");
    mkdirSync(customDir, { recursive: true });
    mkdirSync(join(tmpCwd, ".pi"), { recursive: true });
    writeFileSync(
      join(tmpCwd, ".pi/settings.json"),
      JSON.stringify({ pt: { "project-pack-dir": "custom" } }),
      "utf8"
    );
    const pack = await loadProjectPack(tmpCwd);
    expect(pack.rootDir).toBe(customDir);
    expect(pack.name).toBe("prj"); // 身份不变
  });

  it("pt.project-pack-dir 绝对路径 → 原样使用", async () => {
    const absDir = "/tmp/__pt_pr4_abs__";
    mkdirSync(join(tmpCwd, ".pi"), { recursive: true });
    writeFileSync(
      join(tmpCwd, ".pi/settings.json"),
      JSON.stringify({ pt: { "project-pack-dir": absDir } }),
      "utf8"
    );
    const pack = await loadProjectPack(tmpCwd);
    expect(pack.rootDir).toBe(absDir);
  });

  it("pt.project-pack-dir ~ 开头 → home dir 展开", async () => {
    mkdirSync(join(tmpCwd, ".pi"), { recursive: true });
    writeFileSync(
      join(tmpCwd, ".pi/settings.json"),
      JSON.stringify({ pt: { "project-pack-dir": "~/__pt_pr4_tilde__" } }),
      "utf8"
    );
    const pack = await loadProjectPack(tmpCwd);
    expect(pack.rootDir).toBe(join(homedir(), "__pt_pr4_tilde__"));
  });
});

describe("PR4 mdAdapter.load settings 倒序后者赢（§3.3.1）", () => {
  let tmpCwd: string;
  beforeEach(() => {
    tmpCwd = mkdtempSync(join(tmpdir(), "pt-pr4-md-"));
  });
  afterEach(() => {
    rmSync(tmpCwd, { recursive: true, force: true });
  });

  it("settings=[] → 行为等价今天（back-compat）", async () => {
    const { mdAdapter } = await import("../../src/parse/index.js");
    const bundle = await mdAdapter.load(tmpCwd, "guide", { assetDir: "." });
    expect(bundle.packs.map((p) => p.name)).toEqual(["prj", "pt"]);
  });

  it("settings 2 个 pack：workingSet 同时保留（同 fp 不同，dedup 保留 2 份）", async () => {
    const dirA = join(tmpCwd, "team-a");
    const dirB = join(tmpCwd, "team-b");
    mkdirSync(join(dirA, "domains"), { recursive: true });
    mkdirSync(join(dirB, "domains"), { recursive: true });
    writeFileSync(join(dirA, "pt-asset-pack.yaml"), "name: team-a\n", "utf8");
    writeFileSync(join(dirB, "pt-asset-pack.yaml"), "name: team-b\n", "utf8");
    writeFileSync(
      join(dirA, "domains/user-info.md"),
      "---\nname: user-info\n---\n## User\n### x\n- desc: from team-a\n",
      "utf8"
    );
    writeFileSync(
      join(dirB, "domains/user-info.md"),
      "---\nname: user-info\n---\n## User\n### x\n- desc: from team-b\n",
      "utf8"
    );
    mkdirSync(join(tmpCwd, ".pi"), { recursive: true });
    writeFileSync(
      join(tmpCwd, ".pi/settings.json"),
      JSON.stringify({ pt: { "asset-packs": [{ path: dirA }, { path: dirB }] } }),
      "utf8"
    );
    const { mdAdapter } = await import("../../src/parse/index.js");
    const bundle = await mdAdapter.load(tmpCwd, "guide", { assetDir: "." });
    // packs 顺序：prj, team-b, team-a, pt（settings 倒序后者赢；v15.x PR7 移除 global pack 槽位）
    expect(bundle.packs.map((p) => p.name)).toEqual(["prj", "team-b", "team-a", "pt"]);
    // workingSet 同时含 team-a/user-info + team-b/user-info（fp 不同）
    // v15.x §4.4.2：workingSet 双索引——identity 按 pack.name，location 按位置别名（settings 无位置别名）
    expect(bundle.workingSet.domains.identity.get("team-a/user-info")).toBeDefined();
    expect(bundle.workingSet.domains.identity.get("team-b/user-info")).toBeDefined();
  });
});

// ==================== M1：PR4 checkPackNameConflicts（§3.4）===================

describe("M1 PR4 checkPackNameConflicts（§3.4 pack name 冲突报错）", () => {
  let tmpCwd: string;
  beforeEach(() => {
    tmpCwd = mkdtempSync(join(tmpdir(), "pt-pr4-conflict-"));
  });
  afterEach(() => {
    rmSync(tmpCwd, { recursive: true, force: true });
  });

  // v15.x §3.4 缺口 2 升级：checkPackNameConflicts 从 warn 改 throw + 场景 A/B 区分
  it("场景 A：settings pack path = project 目录 → throw + error 含 '路径重叠'", async () => {
    // project pack 用 assetDir="." 指向 tmpCwd，settings pack path 也指向 tmpCwd
    // → 两者 rootDir 相同 = 路径重叠
    const dupeDir = join(tmpCwd, "dupe-dir");
    mkdirSync(join(dupeDir, "domains"), { recursive: true });
    writeFileSync(join(dupeDir, "pt-asset-pack.yaml"), "name: dupe\n", "utf8");
    mkdirSync(join(tmpCwd, ".pi"), { recursive: true });
    writeFileSync(
      join(tmpCwd, ".pi/settings.json"),
      JSON.stringify({ pt: { "asset-packs": [{ path: dupeDir }] } }),
      "utf8"
    );

    const { mdAdapter } = await import("../../src/parse/index.js");
    // assetDir 也指向 dupeDir → project pack rootDir = settings pack rootDir = 路径重叠
    await expect(mdAdapter.load(tmpCwd, "guide", { assetDir: dupeDir })).rejects.toThrow(
      /§3.4 路径重叠/
    );
  });

  it("场景 B：两个 settings pack 同 manifest.name 不同路径 → throw + error 含 '不同路径同 name'", async () => {
    // 构造两个不同目录的 settings pack，都带 manifest name="dupe"（违反 §3.4）
    const dirA = join(tmpCwd, "dupe-a");
    const dirB = join(tmpCwd, "dupe-b");
    mkdirSync(join(dirA, "domains"), { recursive: true });
    mkdirSync(join(dirB, "domains"), { recursive: true });
    writeFileSync(join(dirA, "pt-asset-pack.yaml"), "name: dupe\n", "utf8");
    writeFileSync(join(dirB, "pt-asset-pack.yaml"), "name: dupe\n", "utf8");
    mkdirSync(join(tmpCwd, ".pi"), { recursive: true });
    writeFileSync(
      join(tmpCwd, ".pi/settings.json"),
      JSON.stringify({ pt: { "asset-packs": [{ path: dirA }, { path: dirB }] } }),
      "utf8"
    );

    const { mdAdapter } = await import("../../src/parse/index.js");
    // project pack 用不同目录（assetDir='.' = tmpCwd，无 domains/blueprints/profiles），与 settings pack 不撞
    // 但 dirA 和 dirB 同 manifest.name="dupe"，rootDir 不同 = 场景 B
    await expect(mdAdapter.load(tmpCwd, "guide", { assetDir: "." })).rejects.toThrow(
      /§3.4 不同路径同 name/
    );
  });

  it("back-compat：project 覆盖 builtin（无 settings 冲突）→ 不 throw", async () => {
    // v15.x PR7（issue pt-remove-global-pack 移除）：global pack 删除后，
    // 降级测试改为验证 project + builtin 各自唯一（无 settings 时）→ 不 throw。
    // project pack 与 builtin 同名（manifest.name="prj"）是不可能的（manifest 校验挡 reserved name）。
    const { mdAdapter } = await import("../../src/parse/index.js");
    // 不写 settings，project + builtin 各自唯一 → 不 throw
    const bundle = await mdAdapter.load(tmpCwd, "guide", { assetDir: "." });
    expect(bundle.packs.map((p) => p.name).sort()).toEqual(["prj", "pt"]);
  });

  // v15.x PR7（issue pt-remove-global-pack 移除）：3 类 pack 加载顺序断言
  it("v15.x PR7：3 类 pack 加载顺序 project + settings + builtin（无 global）", async () => {
    // 验证 PR7 移除 global pack 后，packs 数组只含 3 类（project/settings/builtin）
    const dirA = join(tmpCwd, "team-a");
    mkdirSync(join(dirA, "domains"), { recursive: true });
    writeFileSync(join(dirA, "pt-asset-pack.yaml"), "name: team-a\n", "utf8");
    mkdirSync(join(tmpCwd, ".pi"), { recursive: true });
    writeFileSync(
      join(tmpCwd, ".pi/settings.json"),
      JSON.stringify({ pt: { "asset-packs": [{ path: dirA }] } }),
      "utf8"
    );
    const { mdAdapter } = await import("../../src/parse/index.js");
    const bundle = await mdAdapter.load(tmpCwd, "guide", { assetDir: "." });
    const sources = bundle.packs.map((p) => p.source).sort();
    // source 类型只 3 种（project/settings/builtin），没有 "global"
    expect(sources).toEqual(["builtin", "project", "settings"]);
    expect(bundle.packs.some((p) => p.source === "global")).toBe(false);
    // pack name 只 3 个：prj, team-a, pt
    expect(bundle.packs.map((p) => p.name).sort()).toEqual(["prj", "pt", "team-a"]);
  });

  it("back-compat：settings pack name 不与任何其他 pack 撞 → 不 throw", async () => {
    // 构造一个 settings pack，manifest.name="solo"（不与任何 reserved pack 撞）
    const soloDir = join(tmpCwd, "solo");
    mkdirSync(join(soloDir, "domains"), { recursive: true });
    writeFileSync(join(soloDir, "pt-asset-pack.yaml"), "name: solo\n", "utf8");
    mkdirSync(join(tmpCwd, ".pi"), { recursive: true });
    writeFileSync(
      join(tmpCwd, ".pi/settings.json"),
      JSON.stringify({ pt: { "asset-packs": [{ path: soloDir }] } }),
      "utf8"
    );

    const { mdAdapter } = await import("../../src/parse/index.js");
    const bundle = await mdAdapter.load(tmpCwd, "guide", { assetDir: "." });
    expect(bundle.packs.map((p) => p.name).sort()).toContain("solo");
  });
});

// ==================== M2：PR4 session_start settings pack 校验预警（§6.7.5）===================

describe("M2 PR4 session_start settings pack 校验预警（§6.7.5）", () => {
  let tmpCwd: string;
  beforeEach(() => {
    tmpCwd = mkdtempSync(join(tmpdir(), "pt-pr4-validate-"));
  });
  afterEach(() => {
    rmSync(tmpCwd, { recursive: true, force: true });
  });

  it("settings pack path 无效 → validatePack 报 dir-not-found，其他 pack 正常加载", async () => {
    // 构造 1 个有效 settings pack + 1 个无效（path 不存在）
    const validDir = join(tmpCwd, "valid-pack");
    mkdirSync(join(validDir, "domains"), { recursive: true });
    writeFileSync(join(validDir, "pt-asset-pack.yaml"), "name: valid-pack\n", "utf8");
    const invalidPath = "/nonexistent/never/created/this/path";

    mkdirSync(join(tmpCwd, ".pi"), { recursive: true });
    writeFileSync(
      join(tmpCwd, ".pi/settings.json"),
      JSON.stringify({
        pt: { "asset-packs": [{ path: validDir }, { path: invalidPath }] },
      }),
      "utf8"
    );

    // 直接调 validatePack（不通过 session_start，验证 validatePack 本身行为）
    const { loadSettingsPacks } = await import("../../src/asset-pack/loader.js");
    const { validatePack } = await import("../../src/asset-pack/validate.js");
    const packs = await loadSettingsPacks(tmpCwd);
    expect(packs).toHaveLength(2);

    const results = await Promise.all(packs.map(validatePack));

    // valid pack → ok
    const validResult = results.find((r) => r.pack === "valid-pack");
    expect(validResult?.ok).toBe(true);

    // invalid pack → ok=false + errors[0].code="dir-not-found"
    const invalidResult = results.find((r) => r.rootDir === invalidPath);
    expect(invalidResult?.ok).toBe(false);
    expect(invalidResult?.errors[0]?.code).toBe("dir-not-found");
    expect(invalidResult?.source).toBe("settings"); // 确认是 settings 来源
  });

  it("session_start settings pack 校验失败触发 ui.notify 预警（§6.7.5 集成，issue pt-cold-start-warning-noise §短期方案 3：需要连续 N=3 次失败）", async () => {
    // 构造 settings pack path 不存在 + 真实集成调用 session_start
    const invalidPath = "/nonexistent/never/created/this/path";
    mkdirSync(join(tmpCwd, ".pi"), { recursive: true });
    writeFileSync(
      join(tmpCwd, ".pi/settings.json"),
      JSON.stringify({ pt: { "asset-packs": [{ path: invalidPath }] } }),
      "utf8"
    );

    // 模拟 pi ExtensionAPI + 调 session_start handler
    const installExtension = (await import("../../src/index.js")).default;
    const events = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const notifs: Array<{ msg: string; level: string }> = [];
    const pi = {
      registerFlag: () => undefined,
      registerCommand: () => undefined,
      registerTool: () => undefined,
      on: (event: string, handler: (...args: unknown[]) => unknown) => {
        events.set(event, [...(events.get(event) ?? []), handler]);
      },
      getFlag: () => undefined,
      appendEntry: () => undefined,
    };
    const ctx = {
      cwd: tmpCwd,
      sessionManager: { getEntries: () => [], getSessionId: () => "test-session-m2" },
      hasUI: true,
      ui: {
        notify: (msg: string, level: "info" | "warning" | "error") => notifs.push({ msg, level }),
        setStatus: () => undefined,
        setWidget: () => undefined,
      },
      getSystemPrompt: () => "BASE",
    };
    installExtension(pi as never);
    const sessionStart = events.get("session_start")?.[0];
    expect(sessionStart).toBeDefined();

    // issue pt-cold-start-warning-noise §短期方案 3：transient validation 静默化——
    //   同 pack 名连续失败 N=3 次才 notify。模拟 3 次 session_start 触发叠加。
    for (let i = 0; i < 3; i++) {
      notifs.length = 0; // 清空上一轮 notifications
      await sessionStart({ type: "session_start" }, ctx);
    }

    // §6.7.5 预警触发：settings pack 校验失败达阈值 → notify("⚠ Pt: settings pack ...", "warning")
    const settingsWarn = notifs.find(
      (n) => n.level === "warning" && n.msg.includes("settings pack") && n.msg.includes("已跳过")
    );
    expect(
      settingsWarn,
      `expected settings pack warn after 3 transient fails, got: ${JSON.stringify(notifs)}`
    ).toBeDefined();
  });

  it("session_start settings pack 失败 < N=3 次 → 不 notify（transient 静默化）", async () => {
    const invalidPath = "/nonexistent/never/created/this/path";
    mkdirSync(join(tmpCwd, ".pi"), { recursive: true });
    writeFileSync(
      join(tmpCwd, ".pi/settings.json"),
      JSON.stringify({ pt: { "asset-packs": [{ path: invalidPath }] } }),
      "utf8"
    );

    const installExtension = (await import("../../src/index.js")).default;
    const events = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const notifs: Array<{ msg: string; level: string }> = [];
    const pi = {
      registerFlag: () => undefined,
      registerCommand: () => undefined,
      registerTool: () => undefined,
      on: (event: string, handler: (...args: unknown[]) => unknown) => {
        events.set(event, [...(events.get(event) ?? []), handler]);
      },
      getFlag: () => undefined,
      appendEntry: () => undefined,
    };
    const ctx = {
      cwd: tmpCwd,
      sessionManager: { getEntries: () => [], getSessionId: () => "test-session-m2-silent" },
      hasUI: true,
      ui: {
        notify: (msg: string, level: "info" | "warning" | "error") => notifs.push({ msg, level }),
        setStatus: () => undefined,
        setWidget: () => undefined,
      },
      getSystemPrompt: () => "BASE",
    };
    installExtension(pi as never);
    const sessionStart = events.get("session_start")?.[0];
    expect(sessionStart).toBeDefined();

    // 只跑一次 session_start（首次失败，未达阈值 N=3）——不期望 settings pack warn notify
    await sessionStart({ type: "session_start" }, ctx);

    const settingsWarn = notifs.find(
      (n) => n.level === "warning" && n.msg.includes("settings pack") && n.msg.includes("已跳过")
    );
    expect(settingsWarn, `expected NO settings pack warn on first fail, got: ${JSON.stringify(notifs)}`).toBeUndefined();
  });
});
