// tests/verify/render-cache.test.ts — saveContext / loadContext round-trip 测试（P2.6）
//
// 测试：
// - save → load 命中（同 sourceHash）
// - hash mismatch 降级（load 返 null）
// - 文件不存在 → load 返 null
// - 文件损坏（非法 frontmatter）→ load 返 null

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveContext, loadContext } from "../../src/render/cache.js";
import type { CompilationConfig, Context } from "../../src/schema.js";

const COMPILATION: CompilationConfig = {
  cacheDir: ".pt/cache/test-cache/",
  split: "single-file",
};

function makeContext(overrides?: Partial<Context>): Context {
  return {
    name: "test-ctx",
    blueprint: "test-bp",
    sourceHash: "abc12345-00000000",
    modules: {
      会话知识: "some rendered content",
    },
    ...overrides,
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "pt-cache-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("saveContext + loadContext round-trip", () => {
  it("save → load 同 sourceHash 命中", async () => {
    const ctx = makeContext();
    await saveContext(tmpDir, ctx, COMPILATION);
    const loaded = await loadContext(tmpDir, ctx.name, ctx.sourceHash, COMPILATION);
    expect(loaded).not.toBeNull();
    expect(loaded?.name).toBe(ctx.name);
    expect(loaded?.sourceHash).toBe(ctx.sourceHash);
    expect(loaded?.modules.会话知识).toBe("some rendered content");
  });

  it("hash mismatch 降级 → 返 null", async () => {
    const ctx = makeContext({ sourceHash: "abc12345-00000000" });
    await saveContext(tmpDir, ctx, COMPILATION);
    const loaded = await loadContext(tmpDir, ctx.name, "different-hash-00000000", COMPILATION);
    expect(loaded).toBeNull();
  });

  it("文件不存在 → 返 null（首次加载）", async () => {
    const loaded = await loadContext(tmpDir, "nonexistent", "any-hash", COMPILATION);
    expect(loaded).toBeNull();
  });

  it("文件损坏（无 frontmatter）→ 返 null", async () => {
    // 手动写一个没有 --- frontmatter 头的文件
    const dir = join(tmpDir, COMPILATION.cacheDir);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "test-ctx.context.md");
    writeFileSync(file, "this is not a valid frontmatter file", "utf8");
    const loaded = await loadContext(tmpDir, "test-ctx", "any-hash", COMPILATION);
    expect(loaded).toBeNull();
  });

  it("文件损坏（frontmatter 缺 source-hash）→ 返 null", async () => {
    const dir = join(tmpDir, COMPILATION.cacheDir);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "test-ctx.context.md");
    writeFileSync(
      file,
      `---\nprofile: test-ctx\nblueprint: test-bp\n---\n\n## 会话知识\n\nbody\n`,
      "utf8"
    );
    const loaded = await loadContext(tmpDir, "test-ctx", "any-hash", COMPILATION);
    expect(loaded).toBeNull();
  });

  it("save 写入路径包含 cacheDir", async () => {
    const ctx = makeContext();
    const file = await saveContext(tmpDir, ctx, COMPILATION);
    expect(file).toContain(COMPILATION.cacheDir);
    expect(file).toContain("test-ctx.context.md");
  });

  it("多注入点 modules 完整 round-trip", async () => {
    const ctx = makeContext({
      modules: {
        会话知识: "scene + trigger content",
        参考手册: "manual content",
      },
    });
    await saveContext(tmpDir, ctx, COMPILATION);
    const loaded = await loadContext(tmpDir, ctx.name, ctx.sourceHash, COMPILATION);
    expect(loaded?.modules.会话知识).toBe("scene + trigger content");
    expect(loaded?.modules.参考手册).toBe("manual content");
  });
});
