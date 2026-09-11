// tests/verify/config-tagline.test.ts — listProfilesWithTagline + formatProfileLabels 单测
//
// v14.x（tagline）：/pt-profile 选择器展示 tagline 用 helper

import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatProfileLabels, listProfilesWithTagline } from "../../src/config.js";

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

  it("空目录 → 只有 builtin guide", async () => {
    const cwd = await makeCwd();
    const result = await listProfilesWithTagline(cwd);
    expect(result.length).toBe(1);
    expect(result[0]?.name).toBe("guide");
    expect(result[0]?.source).toBe("builtin");
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
