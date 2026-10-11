// tests/verify/issue-pt-virtual-profile.test.ts — pt-virtual-profile 机制集成测试
//
// issue: .pt/docs/issues/pt-virtual-profile.md
// 覆盖硬指标：
//   3  loadProfiles 为 mode=virtual Domain 生成虚拟 Profile IR
//   5  /pt-profile 选择器无差别展示虚拟 Profile（listProfilesWithTagline + formatProfileLabels）
//   6  虚拟 Profile 经 loadAndTranspile 全链路编译 + 注入成功（segment 含 Domain 内容）
//   8  显式 Profile 与 virtual 同名时显式赢 + warn
//   +  loadDomains 缓存（issue §八 发现 2：避免双扫盘）
//
// 边界：本测试不改 render/compile 主循环——虚拟 Profile 走既有 byDomain 模式 + generic fallback。

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MdFilePack } from "../../src/asset-pack/md-file-pack.js";
import { listProfilesWithTagline, formatProfileLabels } from "../../src/config.js";
import { loadAndTranspile } from "../../src/transpile.js";

/** 构造临时 asset root：root/.pt/assets/{domains,blueprints,profiles}。
 *  用 .pt/assets 默认布局——listProfilesWithTagline / loadAndTranspile 不传 assetDir 时走默认 ASSETS_DIR。 */
async function mkAssetRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `pt-virtual-${prefix}-`));
  const assets = join(root, ".pt", "assets");
  await mkdir(join(assets, "domains"), { recursive: true });
  await mkdir(join(assets, "blueprints"), { recursive: true });
  await mkdir(join(assets, "profiles"), { recursive: true });
  return root;
}

function assetsDir(root: string): string {
  return join(root, ".pt", "assets");
}

/** 虚拟 Domain 夹具：H3 形式（### name + - desc: value），让 fallback Term[] 带上 desc，
 *  renderGenericModule 产出 "- name: desc"（验证整篇注入含描述）。 */
const VIRTUAL_DOMAIN_MD = `---
name: codex-vendor-prompt
mode: virtual
tagline: Codex vendor system prompt (整篇注入验证)
---

## When to ask for clarification
### ask-when-ambiguous
- desc: 当需求有歧义时先问清楚
### confirm-breaking-changes
- desc: 破坏性改动前确认

## How to format code
### use-ecmascript-modules
- desc: 用 ES module 语法
### prefer-named-exports
- desc: 优先 named export
`;

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("pt-virtual-profile：loadProfiles 生成虚拟 Profile IR（硬指标 3）", () => {
  it("pack 含 mode=virtual Domain → loadProfiles 返回虚拟 Profile", async () => {
    const root = await mkAssetRoot("gen");
    await writeFile(join(assetsDir(root), "domains/codex.md"), VIRTUAL_DOMAIN_MD);
    tempDirs.push(root);
    const pack = await MdFilePack.create({ rootDir: assetsDir(root), source: "project" });
    const profiles = await pack.loadProfiles();
    const vp = profiles.find((p) => p.name === "codex-vendor-prompt");
    expect(vp).toBeDefined();
    expect(vp?.blueprint).toBe("pt-virtual");
    expect(vp?.domains).toEqual(["codex-vendor-prompt"]);
    expect(vp?.groups).toHaveLength(1);
    expect(vp?.groups[0].name).toBe("session-context");
    expect(vp?.groups[0].domains).toEqual(["codex-vendor-prompt"]);
    // modules 含 Domain 全部 H2 段名（整篇注入）
    expect(vp?.groups[0].modules.map((m) => m.section).sort()).toEqual([
      "How to format code",
      "When to ask for clarification",
    ]);
    expect(vp?.tagline).toBe("Codex vendor system prompt (整篇注入验证)");
    expect(vp?.sourcePack).toBe("prj");
  });

  it("pack 不含 virtual Domain → loadProfiles 无虚拟 Profile", async () => {
    const root = await mkAssetRoot("no-virtual");
    await writeFile(
      join(assetsDir(root), "domains/normal.md"),
      `---\nname: normal\n---\n## Scene\n- t: d\n`
    );
    tempDirs.push(root);
    const pack = await MdFilePack.create({ rootDir: assetsDir(root), source: "project" });
    const profiles = await pack.loadProfiles();
    expect(profiles.find((p) => p.blueprint === "pt-virtual")).toBeUndefined();
  });
});

describe("pt-virtual-profile：loadDomains 缓存（issue §八 发现 2）", () => {
  it("loadDomains 第二次调用返缓存（删盘后仍命中）", async () => {
    const root = await mkAssetRoot("cache");
    await writeFile(join(assetsDir(root), "domains/a.md"), `---\nname: a\n---\n## Scene\n- t: d\n`);
    tempDirs.push(root);
    const pack = await MdFilePack.create({ rootDir: assetsDir(root), source: "project" });
    const first = await pack.loadDomains();
    expect(first.map((d) => d.name)).toEqual(["a"]);
    // 删盘后第二次调用——缓存生效仍返 ["a"]，重新扫盘则返 []
    await rm(join(assetsDir(root), "domains/a.md"));
    const second = await pack.loadDomains();
    expect(second.map((d) => d.name)).toEqual(["a"]);
  });
});

describe("pt-virtual-profile：同名冲突显式赢（硬指标 8）", () => {
  it("显式 Profile 与 virtual 同名 → 显式赢 + virtual 被忽略 + warn", async () => {
    const root = await mkAssetRoot("conflict");
    await writeFile(
      join(assetsDir(root), "domains/dup.md"),
      `---\nname: dup\nmode: virtual\ntagline: virtual tag\n---\n## S\n- a: d\n`
    );
    await writeFile(
      join(assetsDir(root), "profiles/dup.profile.md"),
      `---\nname: dup\nblueprint: pt-default\ndomains: []\ntagline: explicit tag\n---\n## session-context\n### Domains\n\n### Modules\n- Scene\n`
    );
    tempDirs.push(root);
    const notifs: Array<{ msg: string; level: "warning" | "error" }> = [];
    const pack = await MdFilePack.create({
      rootDir: assetsDir(root),
      source: "project",
      adapterCtx: { notify: (msg, level) => notifs.push({ msg, level }) },
    });
    const profiles = await pack.loadProfiles();
    const dup = profiles.find((p) => p.name === "dup");
    expect(dup).toBeDefined();
    expect(dup?.blueprint).toBe("pt-default"); // 显式赢
    expect(dup?.tagline).toBe("explicit tag");
    expect(profiles.filter((p) => p.name === "dup")).toHaveLength(1); // 只一份
    expect(
      notifs.some((n) => n.level === "warning" && n.msg.includes("dup") && n.msg.includes("同名"))
    ).toBe(true);
  });
});

describe("pt-virtual-profile：选择器展示（硬指标 5）", () => {
  it("listProfilesWithTagline 含虚拟 Profile + formatProfileLabels 显示 [@prj] name — tagline", async () => {
    const root = await mkAssetRoot("selector");
    await writeFile(join(assetsDir(root), "domains/codex.md"), VIRTUAL_DOMAIN_MD);
    tempDirs.push(root);
    const metas = await listProfilesWithTagline(root);
    const vp = metas.find((m) => m.name === "codex-vendor-prompt");
    expect(vp).toBeDefined();
    expect(vp?.tagline).toBe("Codex vendor system prompt (整篇注入验证)");
    expect(vp?.source).toBe("project");
    expect(vp?.pack).toBe("prj");
    expect(vp?.reservedAlias).toBe("prj");
    const labels = formatProfileLabels(metas);
    expect(
      labels.some(
        (l) => l.includes("[@prj] codex-vendor-prompt") && l.includes("Codex vendor system prompt")
      )
    ).toBe(true);
  });
});

describe("pt-virtual-profile：loadAndTranspile 全链路（硬指标 6）", () => {
  it("虚拟 Profile 经 parse→compile→render → segment 含 Domain 全部 H2 段内容", async () => {
    const root = await mkAssetRoot("e2e");
    await writeFile(join(assetsDir(root), "domains/codex.md"), VIRTUAL_DOMAIN_MD);
    tempDirs.push(root);
    const notifs: Array<{ msg: string; level: "warning" | "error" }> = [];
    const result = await loadAndTranspile(root, "codex-vendor-prompt", {
      notify: (msg, level) => notifs.push({ msg, level }),
    });
    expect(result.activeProfile).toBe("codex-vendor-prompt");
    expect(result.activeProfileOrigin).toBe("exact");
    expect(result.blueprint.name).toBe("pt-virtual");
    // segment 含 Domain 全部 H2 段的 name + desc（整篇注入）
    expect(result.segment).toContain("ask-when-ambiguous");
    expect(result.segment).toContain("当需求有歧义时先问清楚");
    expect(result.segment).toContain("confirm-breaking-changes");
    expect(result.segment).toContain("破坏性改动前确认");
    expect(result.segment).toContain("use-ecmascript-modules");
    expect(result.segment).toContain("prefer-named-exports");
    // 无空 segment 告警（注入生效）
    expect(notifs.some((n) => n.msg.includes("空 segment"))).toBe(false);
  });
});
