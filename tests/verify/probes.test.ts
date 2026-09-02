// tests/verify/probes.test.ts — P1：verify 模块测试
import { describe, it, expect } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runVerify, listProbes } from "../../src/verify/index.js";

describe("P1: verify 模块", () => {
  it("listProbes 返回 8 个 probe", () => {
    const probes = listProbes();
    expect(probes).toContain("fs-content-match");
    expect(probes).toContain("ts-compiles");
    expect(probes).toContain("test-pass");
    expect(probes.length).toBe(8);
  });

  it("未知 probe 返回 INCONCLUSIVE", async () => {
    const r = await runVerify(process.cwd(), "unknown-probe", {});
    expect(r.outcome).toBe("INCONCLUSIVE");
    expect(r.message).toContain("未知 probe");
  });

  it("fs-content-match: 文件含文本 → COMPLETED", async () => {
    const tmp = join(process.cwd(), ".pt/cache/test-verify-tmp");
    mkdirSync(tmp, { recursive: true });
    writeFileSync(join(tmp, "foo.ts"), "export const x = 1;\n");
    const r = await runVerify(tmp, "fs-content-match", { path: "foo.ts", pattern: "export" });
    expect(r.outcome).toBe("COMPLETED");
    rmSync(tmp, { recursive: true });
  });

  it("fs-content-match: 文件不含文本 → DEVIATED", async () => {
    const tmp = join(process.cwd(), ".pt/cache/test-verify-tmp");
    mkdirSync(tmp, { recursive: true });
    writeFileSync(join(tmp, "foo.ts"), "export const x = 1;\n");
    const r = await runVerify(tmp, "fs-content-match", { path: "foo.ts", pattern: "nonexistent" });
    expect(r.outcome).toBe("DEVIATED");
    rmSync(tmp, { recursive: true });
  });

  it("fs-content-match: 缺参数 → INCONCLUSIVE", async () => {
    const r = await runVerify(process.cwd(), "fs-content-match", {});
    expect(r.outcome).toBe("INCONCLUSIVE");
  });

  it("fs-exists: 文件存在 → COMPLETED", async () => {
    const r = await runVerify(process.cwd(), "fs-exists", { path: "package.json" });
    expect(r.outcome).toBe("COMPLETED");
  });

  it("fs-exists: 文件不存在 → DEVIATED", async () => {
    const r = await runVerify(process.cwd(), "fs-exists", { path: "nonexistent-xyz.md" });
    expect(r.outcome).toBe("DEVIATED");
  });

  it("fs-not-exists: 文件不存在 → COMPLETED", async () => {
    const r = await runVerify(process.cwd(), "fs-not-exists", { path: "nonexistent-xyz.md" });
    expect(r.outcome).toBe("COMPLETED");
  });

  it("ts-compiles: 项目自身编译 → COMPLETED", async () => {
    const r = await runVerify(process.cwd(), "ts-compiles", {});
    expect(r.outcome).toBe("COMPLETED");
  });

  it("git-status-clean: 返回 COMPLETED 或 DEVIATED（不 INCONCLUSIVE）", async () => {
    const r = await runVerify(process.cwd(), "git-status-clean", {});
    expect(["COMPLETED", "DEVIATED"]).toContain(r.outcome);
  });
});
