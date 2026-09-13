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
// 重点回归：switch-injection（transpileActive 改降级）/ phase9（集成 4 类加载链）
//           / asset-health（validatePack 与 asset-health 同层不冲突）。

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
import { shouldPromptGlobalPackGuide, validatePack } from "../../src/asset-pack/validate.js";
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
    // PR2：构造改 async（读 manifest），走 MdFilePack.create factory
    const pack = await MdFilePack.create({
      rootDir: root,
      source: "project",
      reservedName: "fixture",
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
      reservedName: "x",
    });
    const domains = await pack.loadDomains();
    expect(domains).toEqual([]);
  });

  it("loadBlueprints 目录不存在返空数组", async () => {
    const pack = await MdFilePack.create({
      rootDir: "/tmp/__pt_nonexistent_pack__",
      source: "project",
      reservedName: "x",
    });
    const blueprints = await pack.loadBlueprints();
    expect(blueprints).toEqual([]);
  });

  it("loadProfiles 目录不存在返空数组", async () => {
    const pack = await MdFilePack.create({
      rootDir: "/tmp/__pt_nonexistent_pack__",
      source: "project",
      reservedName: "x",
    });
    const profiles = await pack.loadProfiles();
    expect(profiles).toEqual([]);
  });
});

// ==================== tryLoadPack reserved name ====================

describe("tryLoadPack reserved name 不读 basename", () => {
  it("builtin pack 走 reserved name 'pt'（路径 basename 是 assets）", async () => {
    // BUILTIN_ASSETS_DIR 路径 basename 一定是 "assets"——reserved name 必须跳过它。
    const pack = await loadBuiltinPack();
    expect(pack.name).toBe("pt");
    expect(pack.source).toBe("builtin");
    expect(pack.rootDir).toBe(BUILTIN_ASSETS_DIR);
    expect(pack.version).toBe("0.0.0");
    expect(pack.description).toBeUndefined();
  });

  it("tryLoadPack 显式传 reserved name 时跳过 basename", async () => {
    // 显式构造 MdFilePack——name 由构造传入，不读 basename
    const pack = await tryLoadPack("/some/dir/assets", "prj", "project");
    expect(pack.name).toBe("prj");
    expect(pack.source).toBe("project");
  });
});

// ==================== working set + mdAdapter.load 行为 ====================

describe("mdAdapter.load working set + 前者赢 fallback", () => {
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
      // working set 三类 Map
      expect(bundle.workingSet.domains.size).toBeGreaterThan(0);
      expect(bundle.workingSet.blueprints.size).toBeGreaterThan(0);
      expect(bundle.workingSet.profiles.size).toBeGreaterThan(0);
      // user-info 在 project + builtin 各一份
      const projectUserInfo = bundle.workingSet.domains.get("prj/user-info");
      const builtinUserInfo = bundle.workingSet.domains.get("pt/user-info");
      expect(projectUserInfo).toBeDefined();
      expect(builtinUserInfo).toBeDefined();
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
      const projectEntry = bundle.workingSet.domains.get("prj/user-info");
      const builtinEntry = bundle.workingSet.domains.get("pt/user-info");
      expect(projectEntry).toBeUndefined();
      expect(builtinEntry).toBeDefined();
    } finally {
      await rm(emptyRoot, { recursive: true, force: true });
    }
  });
});

// ==================== validatePack ====================

describe("validatePack", () => {
  it("目录不存在 → ok=false + errors[0].code='dir-not-found'", async () => {
    const pack = await tryLoadPack("/tmp/__pt_nonexistent__", "prj", "project");
    const result = await validatePack(pack);
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe("dir-not-found");
    expect(result.errors[0]?.msg).toContain("/tmp/__pt_nonexistent__");
  });

  it("目录存在但无任何 asset 子目录 → ok=false + errors[0].code='no-asset-subdir'", async () => {
    const root = await mkdtemp(join(tmpdir(), "pt-empty-"));
    try {
      const pack = await tryLoadPack(root, "prj", "project");
      const result = await validatePack(pack);
      expect(result.ok).toBe(false);
      expect(result.errors[0]?.code).toBe("no-asset-subdir");
      expect(result.errors[0]?.msg).toContain('"prj"');
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

  it("合法 pack → ok=true + errors=[]", async () => {
    const root = await mkAssetRoot("validate-ok");
    try {
      const pack = await tryLoadPack(root, "prj", "project");
      const result = await validatePack(pack);
      expect(result.ok).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.warnings).toEqual([]);
      expect(result.source).toBe("project");
      expect(result.pack).toBe("prj");
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

// ==================== shouldPromptGlobalPackGuide（pure helper） ====================

describe("shouldPromptGlobalPackGuide（非交互兼容 + 一次性，§7.5.1）", () => {
  const base = {
    isTTY: true,
    globalPackExists: false,
    isFirstRun: true,
    isCi: false,
    guideDisabled: false,
  };

  it("满足全部条件 → true", () => {
    expect(shouldPromptGlobalPackGuide(base)).toBe(true);
  });

  it("!isTTY → false", () => {
    expect(shouldPromptGlobalPackGuide({ ...base, isTTY: false })).toBe(false);
  });

  it("globalPackExists → false（目录已存在时不引导）", () => {
    expect(shouldPromptGlobalPackGuide({ ...base, globalPackExists: true })).toBe(false);
  });

  it("!isFirstRun → false（同 session 第二次不提示）", () => {
    expect(shouldPromptGlobalPackGuide({ ...base, isFirstRun: false })).toBe(false);
  });

  it("isCi → false（CI 环境跳过）", () => {
    expect(shouldPromptGlobalPackGuide({ ...base, isCi: true })).toBe(false);
  });

  it("guideDisabled (PT_NO_GUIDE=1) → false", () => {
    expect(shouldPromptGlobalPackGuide({ ...base, guideDisabled: true })).toBe(false);
  });
});

// ==================== pack-repair builtin domain 加载验证 ====================

describe("pack-repair builtin domain（§6.7.4 guide 引用）", () => {
  it("builtin pack 含 pack-repair domain + FlowTemplate", async () => {
    const pack = await loadBuiltinPack();
    const domains = await pack.loadDomains();
    const packRepair = domains.find((d) => d.name === "pack-repair");
    expect(packRepair).toBeDefined();
    // Flows 段解析为 FlowTemplate[]——含 pack-repair 这条
    const flows = packRepair?.modules.Flows as Array<{ name: string }>;
    expect(flows).toBeDefined();
    expect(flows?.some((f) => f.name === "pack-repair")).toBe(true);
  });

  it("mdAdapter.load guide profile 能解析到 pack-repair domain", async () => {
    // 用 builtin pack 的根作为 cwd（assetDir 默认 = .pt/assets 不存在）——
    // 这里走空 assetDir + 任意 cwd，验证 guide profile domains 列表里能解析出 pack-repair
    const emptyRoot = await mkAssetRoot("guide-empty");
    try {
      const bundle = await mdAdapter.load(emptyRoot, "guide", { assetDir: "." });
      const packRepair = bundle.domains.find((d) => d.name === "pack-repair");
      expect(packRepair).toBeDefined();
      // 验证 rules 段存在（validate-pack-never-throws 这条规则）
      const rules = packRepair?.modules.Rules as Array<{ name: string }>;
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
  it("validatePack 目录不存在的 global pack → ok=false 但不阻断 builtin pack 加载", async () => {
    // global pack 目录不存在 → validatePack 返 ok=false
    const brokenGlobal = await tryLoadPack("/tmp/__pt_nonexistent_global__", "gbl", "global");
    const globalResult = await validatePack(brokenGlobal);
    expect(globalResult.ok).toBe(false);
    expect(globalResult.errors[0]?.code).toBe("dir-not-found");
    expect(globalResult.source).toBe("global");

    // builtin pack 同时验证 → 应正常通过
    const builtin = await loadBuiltinPack();
    const builtinResult = await validatePack(builtin);
    expect(builtinResult.ok).toBe(true);
    expect(builtinResult.source).toBe("builtin");
  });

  it("validatePack 无 asset 子目录的 pack → ok=false + errors[0].code='no-asset-subdir'", async () => {
    const root = await mkdtemp(join(tmpdir(), "pt-empty-pack-"));
    try {
      const emptyPack = await tryLoadPack(root, "x", "global");
      const result = await validatePack(emptyPack);
      expect(result.ok).toBe(false);
      expect(result.errors[0]?.code).toBe("no-asset-subdir");
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
        reservedName: "prj",
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
        reservedName: "prj",
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
        reservedName: "prj",
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
    s.packValidation = [
      { pack: "prj", source: "project", ok: true, errors: [], warnings: [] },
      { pack: "gbl", source: "global", ok: true, errors: [], warnings: [] },
      { pack: "pt", source: "builtin", ok: true, errors: [], warnings: [] },
    ];
    const out = statusText(s);
    expect(out).toContain("pt packs: 3/3 ok");
    expect(out).toContain("[@prj] ✅");
    expect(out).toContain("[@gbl] ✅");
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
        ok: false,
        errors: [{ code: "dir-not-found", msg: "pack 目录不存在: /tmp/__nonexistent__" }],
        warnings: [],
      },
      { pack: "gbl", source: "global", ok: true, errors: [], warnings: [] },
      { pack: "pt", source: "builtin", ok: true, errors: [], warnings: [] },
    ];
    const out = statusText(s);
    expect(out).toContain("pt packs: 2/3 degraded");
    expect(out).toContain("[@prj] ⚠ DEGRADED");
    expect(out).toContain("pack 目录不存在");
  });

  it("PR2：version 出现在展示行", async () => {
    const { statusText } = await import("../../src/commands.js");
    const { createSessionState } = await import("../../src/session.js");
    const s = createSessionState();
    s.packValidation = [
      {
        pack: "prj",
        source: "project",
        ok: true,
        errors: [],
        warnings: [],
        version: "1.2.3",
        rootDir: "/x",
      },
      {
        pack: "gbl",
        source: "global",
        ok: true,
        errors: [],
        warnings: [],
        version: "0.0.0",
        rootDir: "/y",
      },
      {
        pack: "pt",
        source: "builtin",
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

  it("PR2：description 出现在展示行（截断 40 字符）", async () => {
    const { statusText } = await import("../../src/commands.js");
    const { createSessionState } = await import("../../src/session.js");
    const s = createSessionState();
    const longDesc = "a".repeat(60);
    s.packValidation = [
      {
        pack: "prj",
        source: "project",
        ok: true,
        errors: [],
        warnings: [],
        version: "1.0.0",
        rootDir: "/x",
        description: longDesc,
      },
    ];
    const out = statusText(s);
    expect(out).toContain("aaa...");
    expect(out).not.toContain("a".repeat(45));
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

// ==================== PR2 §2.4.2：MdFilePack.create name 解析优先级 ====================

describe("MdFilePack.create name 解析优先级（§2.4.2）", () => {
  it("reserved pack 跳过 manifest 用固定名", async () => {
    // 即使目录有 manifest，reserved pack 跳过
    const root = await mkAssetRoot("mdpack-reserved");
    await writeFile(
      join(root, "pt-asset-pack.yaml"),
      `name: should-be-ignored
version: 9.9.9
`
    );
    try {
      const pack = await MdFilePack.create({
        rootDir: root,
        source: "project",
        reservedName: "prj",
      });
      expect(pack.name).toBe("prj");
      expect(pack.version).toBe("0.0.0"); // reserved 固定
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("显式 pack + 合法 manifest → manifest.name", async () => {
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
        source: "global", // 非 reserved
      });
      expect(pack.name).toBe("pt-internal");
      expect(pack.version).toBe("2.0.0");
      expect(pack.description).toBe("Test pack");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("隐式 pack 无 manifest → name=basename + version='0.0.0'", async () => {
    const root = await mkAssetRoot("mdpack-implicit"); // basename = "pt-asset-pack-mdpack-implicit-XXXX"
    try {
      const pack = await MdFilePack.create({
        rootDir: root,
        source: "global",
      });
      // basename 兜底（tmp 目录带 pt-asset-pack 前缀）
      expect(pack.name).toMatch(/mdpack-implicit/);
      expect(pack.version).toBe("0.0.0");
      expect(pack.description).toBeUndefined();
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
        reservedName: "prj",
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
        source: "global",
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
    expect(bundle.packs.map((p) => p.name)).toEqual(["prj", "gbl", "pt"]);
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
    // packs 顺序：prj, team-b, team-a, gbl, pt（settings 倒序后者赢）
    expect(bundle.packs.map((p) => p.name)).toEqual(["prj", "team-b", "team-a", "gbl", "pt"]);
    // workingSet 同时含 team-a/user-info + team-b/user-info（fp 不同）
    expect(bundle.workingSet.domains.get("team-a/user-info")).toBeDefined();
    expect(bundle.workingSet.domains.get("team-b/user-info")).toBeDefined();
  });
});
