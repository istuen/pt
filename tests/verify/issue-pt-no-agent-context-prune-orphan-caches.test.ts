// tests/verify/issue-pt-no-agent-context-prune-orphan-caches.test.ts
//
// 验证 sub-issue pt-no-agent-context-prune-orphan-caches 修复：
//   pruneOrphanCaches() 在 transpile 末尾自动 unlink 不属于当前 Profile 全集的 cache 文件
//
// v13.x 边界纪律：
//   - 不依赖真实 pi ExtensionAPI
//   - 不依赖真实 transpile（手工构造 cache 目录 + 调用 pruneOrphanCaches）
//   - 覆盖 3 场景（新建/删除/重命名 Profile）+ 边界（空目录/不存在目录/无 .agent-context.md 文件）

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pruneOrphanCaches } from "../../src/transpile.js";

/** 创建临时目录，返回 cwd。 */
async function makeTmpCwd(): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  return mkdtemp(join(tmpdir(), "pt-prune-test-"));
}

/** 在 cwd 下创建 cache 目录 + 写入若干 cache 文件。 */
async function setupCache(cwd: string, cacheDir: string, files: string[]): Promise<void> {
  const dir = join(cwd, cacheDir);
  await mkdir(dir, { recursive: true });
  for (const f of files) {
    await writeFile(join(dir, f), "fake-content", "utf8");
  }
}

describe("pruneOrphanCaches (v13.x issue pt-no-agent-context-prune-orphan-caches)", () => {
  let cwd: string;
  let cacheDir: string;

  beforeEach(async () => {
    cwd = await makeTmpCwd();
    cacheDir = ".pt/cache/agent-contexts";
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("删除无对应 Profile 的 cache 文件", async () => {
    await setupCache(cwd, cacheDir, ["orphan.agent-context.md"]);
    const valid = new Set(["pt-dev"]);

    const pruned = await pruneOrphanCaches(cwd, cacheDir, valid);

    expect(pruned).toEqual(["orphan"]);
    const remaining = await readdir(join(cwd, cacheDir));
    expect(remaining).toEqual([]);
  });

  it("保留有效 Profile 的 cache 文件", async () => {
    await setupCache(cwd, cacheDir, [
      "pt-dev.agent-context.md",
      "pt-chat.agent-context.md",
      "orphan.agent-context.md",
    ]);
    const valid = new Set(["pt-dev", "pt-chat"]);

    const pruned = await pruneOrphanCaches(cwd, cacheDir, valid);

    expect(pruned).toEqual(["orphan"]);
    const remaining = await readdir(join(cwd, cacheDir));
    expect(remaining.sort()).toEqual(["pt-chat.agent-context.md", "pt-dev.agent-context.md"]);
  });

  it("场景：删除 Profile 后 transpile（orphan 自动 unlink）", async () => {
    // 模拟之前有 3 个 Profile 都生成了 cache
    await setupCache(cwd, cacheDir, [
      "pt-dev.agent-context.md",
      "pt-chat.agent-context.md",
      "removed.agent-context.md",
    ]);
    // 现在只剩 2 个 Profile（removed 被删了）
    const valid = new Set(["pt-dev", "pt-chat"]);

    const pruned = await pruneOrphanCaches(cwd, cacheDir, valid);

    expect(pruned).toEqual(["removed"]);
    const remaining = await readdir(join(cwd, cacheDir));
    expect(remaining).not.toContain("removed.agent-context.md");
    expect(remaining).toContain("pt-dev.agent-context.md");
  });

  it("场景：重命名 Profile 后 transpile（旧名 orphan unlink）", async () => {
    await setupCache(cwd, cacheDir, ["old-name.agent-context.md", "new-name.agent-context.md"]);
    // 现在 Profile 名是 new-name
    const valid = new Set(["new-name"]);

    const pruned = await pruneOrphanCaches(cwd, cacheDir, valid);

    expect(pruned).toEqual(["old-name"]);
    const remaining = await readdir(join(cwd, cacheDir));
    expect(remaining).toEqual(["new-name.agent-context.md"]);
  });

  it("场景：新建 Profile 后 transpile（valid 只含新名）", async () => {
    // 已有孤儿（之前的 pt-old）
    await setupCache(cwd, cacheDir, ["pt-old.agent-context.md"]);
    const valid = new Set(["pt-new"]);

    const pruned = await pruneOrphanCaches(cwd, cacheDir, valid);

    expect(pruned).toEqual(["pt-old"]);
    const remaining = await readdir(join(cwd, cacheDir));
    expect(remaining).toEqual([]);
  });

  it("边界：cache 目录不存在时返空不抛错", async () => {
    const valid = new Set(["pt-dev"]);

    const pruned = await pruneOrphanCaches(cwd, cacheDir, valid);

    expect(pruned).toEqual([]);
  });

  it("边界：cache 目录为空时返空", async () => {
    await mkdir(join(cwd, cacheDir), { recursive: true });
    const valid = new Set(["pt-dev"]);

    const pruned = await pruneOrphanCaches(cwd, cacheDir, valid);

    expect(pruned).toEqual([]);
  });

  it("边界：忽略非 .agent-context.md 文件", async () => {
    // 目录里可能有其他文件（用户手放、gitignored 子目录等）
    await setupCache(cwd, cacheDir, [
      "pt-dev.agent-context.md",
      "README.md", // 非 cache 文件，不动
      ".DS_Store", // macOS 垃圾文件，不动
      "subdir", // 目录，不动
    ]);
    const valid = new Set(["pt-dev"]);

    const pruned = await pruneOrphanCaches(cwd, cacheDir, valid);

    expect(pruned).toEqual([]);
    const remaining = await readdir(join(cwd, cacheDir));
    expect(remaining).toContain("README.md");
    expect(remaining).toContain(".DS_Store");
    expect(remaining).toContain("subdir");
    expect(remaining).toContain("pt-dev.agent-context.md");
  });

  it("边界：validProfileNames 为空时所有 cache 全 unlink", async () => {
    await setupCache(cwd, cacheDir, ["a.agent-context.md", "b.agent-context.md"]);
    const valid = new Set<string>();

    const pruned = await pruneOrphanCaches(cwd, cacheDir, valid);

    expect(pruned.sort()).toEqual(["a", "b"]);
    const remaining = await readdir(join(cwd, cacheDir));
    expect(remaining).toEqual([]);
  });
});
