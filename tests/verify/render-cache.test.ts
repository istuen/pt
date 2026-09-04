// tests/verify/render-cache.test.ts — saveAgentContext / loadAgentContext round-trip 测试（P2.6）
//
// 测试：
// - save → load 命中（同 sourceHash）
// - hash mismatch 降级（load 返 null）
// - 文件不存在 → load 返 null
// - 文件损坏（非法 frontmatter）→ load 返 null
//
// Phase term-P1：saveContext/loadContext → saveAgentContext/loadAgentContext
//   文件后缀 .context.md → .agent-context.md
//
// Phase term-P4.2：cacheDir 改用 constants.CACHE_DIR 常量；签名删 compilation 参数。
//   测试用 tmpDir 作为 cwd，内部会自动在 tmpDir/<CACHE_DIR> 下建文件。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CACHE_DIR } from "../../src/constants.js";
import { saveAgentContext, loadAgentContext } from "../../src/render/cache.js";
import type { AgentContext } from "../../src/schema.js";

function makeContext(overrides?: Partial<AgentContext>): AgentContext {
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

describe("saveAgentContext + loadAgentContext round-trip", () => {
  it("save → load 同 sourceHash 命中", async () => {
    const ctx = makeContext();
    await saveAgentContext(tmpDir, ctx);
    const loaded = await loadAgentContext(tmpDir, ctx.name, ctx.sourceHash);
    expect(loaded).not.toBeNull();
    expect(loaded?.name).toBe(ctx.name);
    expect(loaded?.sourceHash).toBe(ctx.sourceHash);
    expect(loaded?.modules.会话知识).toBe("some rendered content");
  });

  it("hash mismatch 降级 → 返 null", async () => {
    const ctx = makeContext({ sourceHash: "abc12345-00000000" });
    await saveAgentContext(tmpDir, ctx);
    const loaded = await loadAgentContext(tmpDir, ctx.name, "different-hash-00000000");
    expect(loaded).toBeNull();
  });

  it("文件不存在 → 返 null（首次加载）", async () => {
    const loaded = await loadAgentContext(tmpDir, "nonexistent", "any-hash");
    expect(loaded).toBeNull();
  });

  it("文件损坏（无 frontmatter）→ 返 null", async () => {
    // 手动写一个没有 --- frontmatter 头的文件
    const dir = join(tmpDir, CACHE_DIR);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "test-ctx.agent-context.md");
    writeFileSync(file, "this is not a valid frontmatter file", "utf8");
    const loaded = await loadAgentContext(tmpDir, "test-ctx", "any-hash");
    expect(loaded).toBeNull();
  });

  it("文件损坏（frontmatter 缺 source-hash）→ 返 null", async () => {
    const dir = join(tmpDir, CACHE_DIR);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "test-ctx.agent-context.md");
    writeFileSync(
      file,
      `---\nprofile: test-ctx\nblueprint: test-bp\n---\n\n## 会话知识\n\nbody\n`,
      "utf8"
    );
    const loaded = await loadAgentContext(tmpDir, "test-ctx", "any-hash");
    expect(loaded).toBeNull();
  });

  it("save 写入路径包含 CACHE_DIR", async () => {
    const ctx = makeContext();
    const file = await saveAgentContext(tmpDir, ctx);
    expect(file).toContain(CACHE_DIR);
    expect(file).toContain("test-ctx.agent-context.md");
  });

  it("多注入点 modules 完整 round-trip", async () => {
    const ctx = makeContext({
      modules: {
        会话知识: "scene + trigger content",
        参考手册: "manual content",
      },
    });
    await saveAgentContext(tmpDir, ctx);
    const loaded = await loadAgentContext(tmpDir, ctx.name, ctx.sourceHash);
    expect(loaded?.modules.会话知识).toBe("scene + trigger content");
    expect(loaded?.modules.参考手册).toBe("manual content");
  });
});
