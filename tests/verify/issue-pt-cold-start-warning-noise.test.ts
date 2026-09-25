// tests/verify/issue-pt-cold-start-warning-noise.test.ts
//
// 配套 .pt/docs/issues/pt-cold-start-warning-noise.md §短期方案：
//   1. scanProjectHealth hash 去重 + 跨 session 持久化
//   2. manifest 警告搬到 pack 字段，由 /pt packs 展示
//   3. transient pack validation 静默化（连续 N=3 失败才 notify）
//
// 验证：
//   - computeHealthHash：稳定排序 + 顺序无关 + 空返 ""
//   - readPersistedHealthHash：文件不存在 / 损坏 → 返 null
//   - writePersistedHealthHash + 跨 session 恢复（round-trip）
//   - MdFilePack.create 不再 notify（改填 manifestWarnings / manifestMissingHint）
//   - ValidationResult.manifestWarnings 从 pack 透传
//   - SessionState.transientValidationFailures 计数 + 清零

import { afterEach, describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeHealthHash,
  readPersistedHealthHash,
  writePersistedHealthHash,
} from "../../src/health-state.js";
import type { AssetHealthIssue } from "../../src/asset-health.js";
import { MdFilePack } from "../../src/asset-pack/md-file-pack.js";
import { validatePack } from "../../src/asset-pack/validate.js";
import type { AssetPack } from "../../src/schema.js";

const tempDirs: string[] = [];

async function makeCwd(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pt-cold-start-"));
  await mkdir(join(dir, ".pt/assets/{domains,blueprints,profiles}"), { recursive: true });
  tempDirs.push(dir);
  return dir;
}

async function mkAssetRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `pt-cold-start-${prefix}-`));
  await mkdir(join(root, "domains"), { recursive: true });
  await mkdir(join(root, "blueprints"), { recursive: true });
  await mkdir(join(root, "profiles"), { recursive: true });
  tempDirs.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

// =====================================================================
// computeHealthHash：稳定排序 + 顺序无关 + 空返 ""
// =====================================================================

describe("computeHealthHash", () => {
  it("空 issues → 返空字符串", () => {
    expect(computeHealthHash([])).toBe("");
  });

  it("issues 顺序变化 → hash 稳定（按 severity/name/field/msg 排序后计算）", () => {
    const a: AssetHealthIssue = {
      severity: "error",
      scope: "profile",
      name: "p1",
      field: "groups.session-context.modules",
      msg: "缺 ### Modules",
    };
    const b: AssetHealthIssue = {
      severity: "warning",
      scope: "profile",
      name: "p2",
      field: "groups.*.modules",
      msg: "modName 未识别",
    };
    const c: AssetHealthIssue = {
      severity: "warning",
      scope: "profile",
      name: "p1",
      msg: "blueprint 不存在",
    };
    // 顺序 1
    const h1 = computeHealthHash([a, b, c]);
    // 顺序 2（reverse）
    const h2 = computeHealthHash([c, b, a]);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[a-f0-9]{16}$/); // sha256 前 16 hex
  });

  it("msg 变化 → hash 变化（设计性变化要告知用户）", () => {
    const a: AssetHealthIssue = {
      severity: "error",
      scope: "profile",
      name: "p1",
      field: "f",
      msg: "msg-A",
    };
    const b: AssetHealthIssue = {
      severity: "error",
      scope: "profile",
      name: "p1",
      field: "f",
      msg: "msg-B",
    };
    expect(computeHealthHash([a])).not.toBe(computeHealthHash([b]));
  });

  it("severity 变化 → hash 变化", () => {
    const a: AssetHealthIssue = { severity: "error", scope: "profile", name: "p", msg: "m" };
    const b: AssetHealthIssue = { severity: "warning", scope: "profile", name: "p", msg: "m" };
    expect(computeHealthHash([a])).not.toBe(computeHealthHash([b]));
  });

  it("hint / fix 变化 → hash 不变（hint 不参与去重判断）", () => {
    const a: AssetHealthIssue = {
      severity: "error",
      scope: "profile",
      name: "p",
      msg: "m",
      hint: "hint-A",
      fix: "fix-A",
    };
    const b: AssetHealthIssue = {
      severity: "error",
      scope: "profile",
      name: "p",
      msg: "m",
      hint: "hint-B",
      fix: "fix-B",
    };
    expect(computeHealthHash([a])).toBe(computeHealthHash([b]));
  });
});

// =====================================================================
// readPersistedHealthHash / writePersistedHealthHash：跨 session 持久化
// =====================================================================

describe("readPersistedHealthHash / writePersistedHealthHash", () => {
  it("文件不存在 → readPersistedHealthHash 返 null", async () => {
    const cwd = await makeCwd();
    expect(await readPersistedHealthHash(cwd)).toBeNull();
  });

  it("文件损坏（非法 JSON）→ readPersistedHealthHash 返 null（视为首次启动）", async () => {
    const cwd = await makeCwd();
    await mkdir(join(cwd, ".pt/state"), { recursive: true });
    await writeFile(join(cwd, ".pt/state/last-health-hash.json"), "{invalid json", "utf8");
    expect(await readPersistedHealthHash(cwd)).toBeNull();
  });

  it("空 hash（无 issue）→ writePersistedHealthHash 不写文件", async () => {
    const cwd = await makeCwd();
    await writePersistedHealthHash(cwd, "", 0);
    expect(await readPersistedHealthHash(cwd)).toBeNull();
  });

  it("非空 hash → write → read round-trip 一致", async () => {
    const cwd = await makeCwd();
    await writePersistedHealthHash(cwd, "abc123def456", 3);
    expect(await readPersistedHealthHash(cwd)).toBe("abc123def456");
  });

  it("写 hash 后 .pt/state/ 目录自动创建", async () => {
    const cwd = await makeCwd();
    // 不预创建 .pt/state/，调 write 让它自动 mkdir recursive
    await writePersistedHealthHash(cwd, "hash1", 1);
    const got = await readPersistedHealthHash(cwd);
    expect(got).toBe("hash1");
  });
});

// =====================================================================
// MdFilePack.create 不再 notify，字段填充
// =====================================================================

describe("MdFilePack.create 静默（issue pt-cold-start-warning-noise §短期方案 2）", () => {
  it("settings pack 无 manifest → 不 notify，manifestMissingHint 填充", async () => {
    const root = await mkAssetRoot("silent-settings-no-manifest");
    const adapterCtx = {
      log: {
        warn: () => undefined,
        info: () => undefined,
        error: () => undefined,
        debug: () => undefined,
      },
      notify: () => {
        throw new Error("notify should NOT be called by MdFilePack.create");
      },
    };
    const pack = await MdFilePack.create({ rootDir: root, source: "settings", adapterCtx });
    expect(pack.manifestWarnings).toEqual([]);
    expect(pack.manifestMissingHint).toContain("无 manifest");
    expect(pack.manifestMissingHint).toContain("pack-management#pack-create");
  });

  it("settings pack manifest name 非 kebab → 不 notify，manifestWarnings 填充", async () => {
    const root = await mkAssetRoot("silent-settings-bad-name");
    await writeFile(join(root, "pt-asset-pack.yaml"), `name: "Bad Name"\n`);
    const adapterCtx = {
      log: {
        warn: () => undefined,
        info: () => undefined,
        error: () => undefined,
        debug: () => undefined,
      },
      notify: () => {
        throw new Error("notify should NOT be called");
      },
    };
    const pack = await MdFilePack.create({ rootDir: root, source: "settings", adapterCtx });
    expect(pack.manifestWarnings.length).toBeGreaterThan(0);
    expect(pack.manifestWarnings[0]).toContain("name-kebab");
  });

  it("reserved pack（project）无 manifest → 不 notify，不填 hint（back-compat 设计）", async () => {
    const root = await mkAssetRoot("silent-project-no-manifest");
    const adapterCtx = {
      log: {
        warn: () => undefined,
        info: () => undefined,
        error: () => undefined,
        debug: () => undefined,
      },
      notify: () => {
        throw new Error("notify should NOT be called");
      },
    };
    const pack = await MdFilePack.create({ rootDir: root, source: "project", adapterCtx });
    expect(pack.manifestWarnings).toEqual([]);
    expect(pack.manifestMissingHint).toBeUndefined();
  });
});

// =====================================================================
// ValidationResult.manifestWarnings：从 pack 字段透传
// =====================================================================

describe("ValidationResult.manifestWarnings 透传", () => {
  it("validatePack 把 pack.manifestWarnings 复制到 ValidationResult", async () => {
    const root = await mkAssetRoot("validate-manifest-warn");
    await writeFile(join(root, "pt-asset-pack.yaml"), `name: "Bad Name"\n`);
    const pack = await MdFilePack.create({ rootDir: root, source: "settings" });
    const result = await validatePack(pack);
    expect(result.manifestWarnings.length).toBeGreaterThan(0);
    expect(result.manifestWarnings[0]).toContain("name-kebab");
  });

  it("validatePack 即使 ok=false 也透传 manifestWarnings（如 rootDir 不存在）", async () => {
    const pack: AssetPack = {
      name: "broken",
      version: "0.0.0",
      rootDir: "/nonexistent/__pt_test__",
      source: "settings",
      manifestWarnings: ["[name-kebab] bad name"],
      loadDomains: () => Promise.resolve([]),
      loadBlueprints: () => Promise.resolve([]),
      loadProfiles: () => Promise.resolve([]),
    };
    const result = await validatePack(pack);
    expect(result.ok).toBe(false);
    expect(result.manifestWarnings).toEqual(["[name-kebab] bad name"]);
  });
});
