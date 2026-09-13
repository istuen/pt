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
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CACHE_DIR } from "../../src/constants.js";
import { saveAgentContext, loadAgentContext, cacheFileName } from "../../src/render/cache.js";
import type { AgentContext } from "../../src/schema.js";

function makeContext(overrides?: Partial<AgentContext>): AgentContext {
  return {
    name: "test-ctx",
    blueprint: "test-bp",
    sourceHash: "abc12345-00000000",
    modules: {
      会话背景: "some rendered content",
    },
    // v15.x PR2（§8.3）：cache 文件名用
    packName: "prj",
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
    const loaded = await loadAgentContext(tmpDir, ctx.packName, ctx.name, ctx.sourceHash);
    expect(loaded).not.toBeNull();
    expect(loaded?.name).toBe(ctx.name);
    expect(loaded?.sourceHash).toBe(ctx.sourceHash);
    expect(loaded?.modules.会话背景).toBe("some rendered content");
  });

  it("hash mismatch 降级 → 返 null", async () => {
    const ctx = makeContext({ sourceHash: "abc12345-00000000" });
    await saveAgentContext(tmpDir, ctx);
    const loaded = await loadAgentContext(
      tmpDir,
      ctx.packName,
      ctx.name,
      "different-hash-00000000"
    );
    expect(loaded).toBeNull();
  });

  it("文件不存在 → 返 null（首次加载）", async () => {
    const loaded = await loadAgentContext(tmpDir, "prj", "nonexistent", "any-hash");
    expect(loaded).toBeNull();
  });

  it("文件损坏（无 frontmatter）→ 返 null", async () => {
    // 手动写一个没有 --- frontmatter 头的文件
    const dir = join(tmpDir, CACHE_DIR);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "test-ctx.agent-context.md");
    writeFileSync(file, "this is not a valid frontmatter file", "utf8");
    const loaded = await loadAgentContext(tmpDir, "prj", "test-ctx", "any-hash");
    expect(loaded).toBeNull();
  });

  it("文件损坏（frontmatter 缺 source-hash）→ 返 null", async () => {
    const dir = join(tmpDir, CACHE_DIR);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "test-ctx.agent-context.md");
    writeFileSync(
      file,
      `---\nprofile: test-ctx\nblueprint: test-bp\n---\n\n## 会话背景\n\nbody\n`,
      "utf8"
    );
    const loaded = await loadAgentContext(tmpDir, "prj", "test-ctx", "any-hash");
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
        会话背景: "scene + trigger content",
        参考手册: "manual content",
      },
    });
    await saveAgentContext(tmpDir, ctx);
    const loaded = await loadAgentContext(tmpDir, ctx.packName, ctx.name, ctx.sourceHash);
    expect(loaded?.modules.会话背景).toBe("scene + trigger content");
    expect(loaded?.modules.参考手册).toBe("manual content");
  });

  it("PR2 §8.3：save 写入文件名 = <pack>__<profile>.agent-context.md", async () => {
    const ctx = makeContext({ name: "guide", packName: "prj" });
    const file = await saveAgentContext(tmpDir, ctx);
    expect(file).toContain("prj__guide.agent-context.md");
    expect(file).not.toContain("guide.agent-context.md/");
  });

  it("PR2 §8.3：load 新名命中（传 packName + name）", async () => {
    const ctx = makeContext({ name: "my-profile", packName: "team-internal" });
    await saveAgentContext(tmpDir, ctx);
    const loaded = await loadAgentContext(tmpDir, "team-internal", "my-profile", ctx.sourceHash);
    expect(loaded).not.toBeNull();
    expect(loaded?.packName).toBe("team-internal");
    expect(loaded?.name).toBe("my-profile");
  });

  it("PR2 §9.4.1：新名不存在 + 旧名存在 → 旧名删除 + 返 null（触发重编译）", async () => {
    // 手动写一个旧名 cache 文件 <profile>.agent-context.md
    const dir = join(tmpDir, CACHE_DIR);
    mkdirSync(dir, { recursive: true });
    const oldFile = join(dir, "legacy-profile.agent-context.md");
    writeFileSync(
      oldFile,
      `---\nsource-hash: old-hash\nprofile: legacy-profile\nblueprint: old-bp\n---\n## x\nold content\n`,
      "utf8"
    );
    // load 新名 → 新名不存在 → 走旧名清理 → 删旧文件 → 返 null
    const loaded = await loadAgentContext(tmpDir, "prj", "legacy-profile", "any-hash");
    expect(loaded).toBeNull();
    // 旧文件被删除
    expect(existsSync(oldFile)).toBe(false);
  });

  it("PR2 §9.4.1：新旧名都不存在 → 返 null（首次加载）", async () => {
    const loaded = await loadAgentContext(tmpDir, "prj", "never-existed", "any-hash");
    expect(loaded).toBeNull();
  });

  it("PR2 §8.3：cacheFileName sanitize 特殊字符", () => {
    expect(cacheFileName("prj", "my profile")).toBe("prj__my_profile.agent-context.md");
    expect(cacheFileName("prj", "with/slash")).toBe("prj__with_slash.agent-context.md");
    expect(cacheFileName("team-internal", "guide")).toBe("team-internal__guide.agent-context.md");
  });
});
