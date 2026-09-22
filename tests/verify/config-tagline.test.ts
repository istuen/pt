// tests/verify/config-tagline.test.ts — listProfilesWithTagline + formatProfileLabels 单测
//
// v14.x（tagline）：/pt-profile 选择器展示 tagline 用 helper

import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatProfileLabels, listProfiles, listProfilesWithTagline } from "../../src/config.js";

const tempDirs: string[] = [];

async function makeCwd(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pt-config-tagline-"));
  await mkdir(join(dir, ".pt/assets/profiles"), { recursive: true });
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("listProfilesWithTagline", () => {
  // 项目级 profile 辅助（builtin `guide` 总在结果里，这里只关心项目级）
  function projectOnly(result: Awaited<ReturnType<typeof listProfilesWithTagline>>) {
    return result.filter((r) => r.source === "project");
  }

  it("空目录 → 只有 builtin profile（guide 兜底）", async () => {
    const cwd = await makeCwd();
    const result = await listProfilesWithTagline(cwd);
    // 空项目目录下只有 builtin profile（至少 guide；builtin 可多个）
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result.every((r) => r.source === "builtin")).toBe(true);
    expect(result.some((r) => r.name === "guide")).toBe(true);
  });

  it("多个 profile 含 tagline → name + tagline 字段填充", async () => {
    const cwd = await makeCwd();
    await writeFile(
      join(cwd, ".pt/assets/profiles/dev.profile.md"),
      `---\nname: dev\nblueprint: bp\ntagline: Senior dev + QA\ndomains: []\n---\n`
    );
    await writeFile(
      join(cwd, ".pt/assets/profiles/po.profile.md"),
      `---\nname: po\nblueprint: bp\ntagline: Product owner + Architect\ndomains: []\n---\n`
    );
    const result = await listProfilesWithTagline(cwd);
    const project = projectOnly(result);
    expect(project.length).toBe(2);
    const dev = project.find((r) => r.name === "dev");
    expect(dev?.tagline).toBe("Senior dev + QA");
    expect(dev?.source).toBe("project");
    const po = project.find((r) => r.name === "po");
    expect(po?.tagline).toBe("Product owner + Architect");
  });

  it("无 tagline 的 profile → tagline undefined（back-compat）", async () => {
    const cwd = await makeCwd();
    await writeFile(
      join(cwd, ".pt/assets/profiles/old.profile.md"),
      `---\nname: old\nblueprint: bp\ndomains: []\n---\n`
    );
    const project = projectOnly(await listProfilesWithTagline(cwd));
    expect(project.length).toBe(1);
    expect(project[0]?.tagline).toBeUndefined();
    expect(project[0]?.source).toBe("project");
  });

  it("项目覆盖 builtin：同名 profile 项目优先", async () => {
    const cwd = await makeCwd();
    await writeFile(
      join(cwd, ".pt/assets/profiles/guide.profile.md"),
      `---\nname: guide\nblueprint: bp\ntagline: Custom override\ndomains: []\n---\n`
    );
    const result = await listProfilesWithTagline(cwd);
    const guide = result.find((r) => r.name === "guide");
    expect(guide?.source).toBe("project");
    expect(guide?.tagline).toBe("Custom override");
  });

  it("按 name 字母排序", async () => {
    const cwd = await makeCwd();
    for (const n of ["zeta", "alpha", "mu"]) {
      await writeFile(
        join(cwd, `.pt/assets/profiles/${n}.profile.md`),
        `---\nname: ${n}\nblueprint: bp\ndomains: []\n---\n`
      );
    }
    const project = projectOnly(await listProfilesWithTagline(cwd));
    expect(project.map((r) => r.name)).toEqual(["alpha", "mu", "zeta"]);
  });

  // issue pt-profile-selector-no-pack-grouping：跨 pack source 分组排序
  it("按 source 分组：project 在前、builtin 在后（避免字母序穿插）", async () => {
    const cwd = await makeCwd();
    // 项目 pack：guide（与 builtin 同名测覆盖）+ alpha + zeta
    for (const n of ["guide", "alpha", "zeta"]) {
      await writeFile(
        join(cwd, `.pt/assets/profiles/${n}.profile.md`),
        `---\nname: ${n}\nblueprint: bp\ndomains: []\n---\n`
      );
    }
    const result = await listProfilesWithTagline(cwd);
    const sources = result.map((r) => r.source);
    const firstBuiltinIdx = sources.indexOf("builtin");
    if (firstBuiltinIdx >= 0) {
      // 前面所有项都必须是 project
      expect(sources.slice(0, firstBuiltinIdx).every((s) => s === "project")).toBe(true);
      // 后面所有项都必须是 builtin
      expect(sources.slice(firstBuiltinIdx).every((s) => s === "builtin")).toBe(true);
    } else {
      // 没 builtin 项则全部是 project
      expect(sources.every((s) => s === "project")).toBe(true);
    }
    // 项目 pack 内按 name 字典序：alpha < guide < zeta
    const project = projectOnly(result);
    expect(project.map((r) => r.name)).toEqual(["alpha", "guide", "zeta"]);
  });

  it("字母序混排模拟：builtin `guide`(g) 排在项目 `pt-*(p)` 之前的 bug 已修", async () => {
    const cwd = await makeCwd();
    // 项目 pack 加 pt-* 系列（p 开头，按旧字母序会排在 builtin `guide` 之后）
    for (const n of ["pt-arch", "pt-design", "pt-dev"]) {
      await writeFile(
        join(cwd, `.pt/assets/profiles/${n}.profile.md`),
        `---\nname: ${n}\nblueprint: bp\ndomains: []\n---\n`
      );
    }
    const result = await listProfilesWithTagline(cwd);
    const allNames = result.map((r) => r.name);
    const firstProjectIdx = result.findIndex((r) => r.source === "project");
    const builtinItems = result.filter((r) => r.source === "builtin");
    // 至少一个 builtin 兜底 profile（`guide` 来自 builtin pack）
    expect(builtinItems.length).toBeGreaterThan(0);
    // builtin 项全部排在所有 project 项之后
    expect(firstProjectIdx).toBeLessThan(allNames.length - builtinItems.length);
    // builtin `guide`（g）排在所有 pt-*（p）之后
    const guideIdx = allNames.indexOf("guide");
    expect(guideIdx).toBeGreaterThan(-1);
    for (const n of ["pt-arch", "pt-design", "pt-dev"]) {
      expect(allNames.indexOf(n)).toBeLessThan(guideIdx);
    }
  });

  it("同名覆盖：项目 `guide` 覆盖 builtin `guide`，仅 1 项且 source=project", async () => {
    const cwd = await makeCwd();
    await writeFile(
      join(cwd, ".pt/assets/profiles/guide.profile.md"),
      `---\nname: guide\nblueprint: bp\ntagline: Custom\ndomains: []\n---\n`
    );
    const result = await listProfilesWithTagline(cwd);
    const guides = result.filter((r) => r.name === "guide");
    expect(guides.length).toBe(1);
    expect(guides[0]?.source).toBe("project");
  });

  it("tagline 带前后空格 → 自动 trim", async () => {
    const cwd = await makeCwd();
    await writeFile(
      join(cwd, ".pt/assets/profiles/p.profile.md"),
      `---\nname: p\nblueprint: bp\ntagline: "  trimmed tagline  "\ndomains: []\n---\n`
    );
    const project = projectOnly(await listProfilesWithTagline(cwd));
    const p = project.find((r) => r.name === "p");
    expect(p?.tagline).toBe("trimmed tagline");
  });

  it("空 tagline → undefined", async () => {
    const cwd = await makeCwd();
    await writeFile(
      join(cwd, ".pt/assets/profiles/p.profile.md"),
      `---\nname: p\nblueprint: bp\ntagline: ""\ndomains: []\n---\n`
    );
    const project = projectOnly(await listProfilesWithTagline(cwd));
    const p = project.find((r) => r.name === "p");
    expect(p?.tagline).toBeUndefined();
  });
});

describe("listProfiles（Tab 补全用）", () => {
  it("按 source 分组：project 在前、builtin 在后", async () => {
    const cwd = await makeCwd();
    // 项目 pack 加 pt-* 系列（按旧字母序 builtin `guide` 会插到这些之前）
    for (const n of ["pt-arch", "pt-design"]) {
      await writeFile(
        join(cwd, `.pt/assets/profiles/${n}.profile.md`),
        `---\nname: ${n}\nblueprint: bp\ndomains: []\n---\n`
      );
    }
    const names = await listProfiles(cwd);
    expect(names.length).toBeGreaterThan(0);
    // builtin 兜底 profile（`guide`）排在所有 project 之后
    const guideIdx = names.indexOf("guide");
    expect(guideIdx).toBeGreaterThan(-1);
    // 项目 profile 在 builtin 之前
    expect(names.indexOf("pt-arch")).toBeGreaterThan(-1);
    expect(names.indexOf("pt-arch")).toBeLessThan(guideIdx);
    expect(names.indexOf("pt-design")).toBeLessThan(guideIdx);
  });

  it("同 source 内按 name 字典序", async () => {
    const cwd = await makeCwd();
    for (const n of ["zeta", "alpha", "mu"]) {
      await writeFile(
        join(cwd, `.pt/assets/profiles/${n}.profile.md`),
        `---\nname: ${n}\nblueprint: bp\ndomains: []\n---\n`
      );
    }
    // 动态获取 builtin 列表过滤（避免硬编码 builtin profile 名单）
    const builtinNames = (await listProfilesWithTagline(cwd))
      .filter((r) => r.source === "builtin")
      .map((r) => r.name);
    const projectOnly = (await listProfiles(cwd)).filter((n) => !builtinNames.includes(n));
    expect(projectOnly).toEqual(["alpha", "mu", "zeta"]);
  });

  it("项目同名覆盖 builtin：仅 1 项", async () => {
    const cwd = await makeCwd();
    await writeFile(
      join(cwd, ".pt/assets/profiles/guide.profile.md"),
      `---\nname: guide\nblueprint: bp\ndomains: []\n---\n`
    );
    const names = await listProfiles(cwd);
    expect(names.filter((n) => n === "guide").length).toBe(1);
  });
});

describe("formatProfileLabels", () => {
  it("tagline 缺省 → 纯名", () => {
    expect(formatProfileLabels([{ name: "dev", tagline: undefined, source: "project" }])).toEqual([
      "dev",
    ]);
  });

  it("tagline 存在 → 'name — tagline'", () => {
    expect(
      formatProfileLabels([{ name: "dev", tagline: "Senior dev", source: "project" }])
    ).toEqual(["dev — Senior dev"]);
  });

  it("混合：有 tagline + 无 tagline 都正确处理", () => {
    const result = formatProfileLabels([
      { name: "a", tagline: "Architect", source: "project" },
      { name: "b", tagline: undefined, source: "builtin" },
      { name: "c", tagline: "QA + Reviewer", source: "project" },
    ]);
    expect(result).toEqual(["a — Architect", "b", "c — QA + Reviewer"]);
  });

  it("空 tagline → 纯名（与 undefined 行为一致）", () => {
    expect(
      formatProfileLabels([{ name: "p", tagline: "" as string | undefined, source: "project" }])
    ).toEqual(["p"]);
  });
});
