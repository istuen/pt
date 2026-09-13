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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mdAdapter } from "../../src/parse/index.js";
import { MdFilePack } from "../../src/asset-pack/md-file-pack.js";
import {
  applyProjectPackDegrade,
  loadBuiltinPack,
  loadProjectPack,
  tryLoadPack,
} from "../../src/asset-pack/loader.js";
import { shouldPromptGlobalPackGuide, validatePack } from "../../src/asset-pack/validate.js";
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
    const pack = new MdFilePack(root, "fixture", "project");
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
    const pack = new MdFilePack("/tmp/__pt_nonexistent_pack__", "x", "project");
    const domains = await pack.loadDomains();
    expect(domains).toEqual([]);
  });

  it("loadBlueprints 目录不存在返空数组", async () => {
    const pack = new MdFilePack("/tmp/__pt_nonexistent_pack__", "x", "project");
    const blueprints = await pack.loadBlueprints();
    expect(blueprints).toEqual([]);
  });

  it("loadProfiles 目录不存在返空数组", async () => {
    const pack = new MdFilePack("/tmp/__pt_nonexistent_pack__", "x", "project");
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

// ==================== dedupByNameN ====================

describe("dedupByNameN（通过 mdAdapter.load 行为间接验证）", () => {
  let assetRoot: string;
  beforeEach(async () => {
    // 临时项目资产根——含一个名为 "user-info" 的 domain（与 builtin 同名）
    assetRoot = await mkAssetRoot("dedup");
    await writeFile(
      join(assetRoot, "domains/user-info.md"),
      `---
name: user-info
---

## User

### who-am-i
- desc: 项目版 user-info
`
    );
  });
  afterEach(async () => {
    await rm(assetRoot, { recursive: true, force: true });
  });

  it("前者赢——项目同名 domain 覆盖 builtin", async () => {
    const bundle = await mdAdapter.load(assetRoot, "guide", { assetDir: "." });
    // 项目版 user-info.name 应是 "user-info"（frontmatter 已给），优先于 builtin
    const userInfo = bundle.domains.find((d) => d.name === "user-info");
    expect(userInfo).toBeDefined();
    // 验证是项目版（desc 文案）
    const userModule = userInfo?.modules.User as Array<{ name: string; desc?: string }>;
    expect(userModule?.[0]?.desc).toContain("项目版");
  });

  it("settingsPacks=[] 时 dedupByNameN 退化等价今天的 dedupByName(project, builtin)", async () => {
    // back-compat 校验：settingsPacks=[] 时项目 + global + builtin 三层。
    // 项目失效目录（无 user-info）应见到 builtin 的 user-info。
    const emptyRoot = await mkAssetRoot("dedup-empty");
    try {
      const bundle = await mdAdapter.load(emptyRoot, "guide", { assetDir: "." });
      const userInfo = bundle.domains.find((d) => d.name === "user-info");
      // 项目包无同名 → 看到 builtin 版
      expect(userInfo).toBeDefined();
      const userModule = userInfo?.modules.User as Array<{ name: string; desc?: string }>;
      expect(userModule?.[0]?.desc).toContain("这个项目的开发者");
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
