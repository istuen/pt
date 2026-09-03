// tests/verify/log.test.ts — PtLogger 单元测试（P2.7）
//
// 测试：
// - 4 个级别（debug/info/warning/error）按顺序写入，NDJSON 行可解析
// - 写盘顺序与调用顺序一致（writeChain 串行保证）
// - static tail() 读最近 N 条（默认 50）
// - static tail() 文件不存在 → 返空
// - static clear() 清空文件
// - static list() 枚举所有 pt-*.log

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PtLogger, LOG_DIR } from "../../src/log.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "pt-log-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("PtLogger instance", () => {
  it("filePath 路径：sessionId 为空时 fallback pt.log", () => {
    const logger = new PtLogger(tmpDir, "p", "");
    expect(logger.filePath).toBe(join(tmpDir, LOG_DIR, "pt.log"));
  });

  it("filePath 路径：sessionId 非空时用 pt-<sessionId>.log", () => {
    const logger = new PtLogger(tmpDir, "p", "abc123");
    expect(logger.filePath).toBe(join(tmpDir, LOG_DIR, "pt-abc123.log"));
  });

  it("4 级别写盘：NDJSON 行可解析 + 顺序正确", async () => {
    const logger = new PtLogger(tmpDir, "p1", "s1");
    logger.debug("d-msg", { x: 1 });
    logger.info("i-msg", { x: 2 });
    logger.warn("w-msg", { x: 3 });
    logger.error("e-msg", { x: 4 });
    await logger.flush();

    const raw = readFileSync(logger.filePath, "utf8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(4);
    const entries = lines.map((l) => JSON.parse(l));
    expect(entries.map((e) => e.level)).toEqual(["debug", "info", "warning", "error"]);
    expect(entries.map((e) => e.msg)).toEqual(["d-msg", "i-msg", "w-msg", "e-msg"]);
    expect(entries.map((e) => e.ctx.x)).toEqual([1, 2, 3, 4]);
  });

  it("baseCtx 注入：每条 entry 含 cwd/profile/sessionId", async () => {
    const logger = new PtLogger(tmpDir, "my-profile", "sess42");
    logger.info("hi");
    await logger.flush();
    const raw = readFileSync(logger.filePath, "utf8");
    const entry = JSON.parse(raw.trim());
    expect(entry.ctx.cwd).toBe(tmpDir);
    expect(entry.ctx.profile).toBe("my-profile");
    expect(entry.ctx.sessionId).toBe("sess42");
  });
});

describe("PtLogger static tail", () => {
  it("文件不存在 → 返空（首次启动）", async () => {
    const entries = await PtLogger.tail(tmpDir, 10);
    expect(entries).toEqual([]);
  });

  it("读最近 N 条", async () => {
    const logger = new PtLogger(tmpDir, "p", "s");
    for (let i = 0; i < 5; i++) logger.info(`msg-${i}`);
    await logger.flush();

    const all = await PtLogger.tail(tmpDir, 50, "s");
    expect(all).toHaveLength(5);
    expect(all.map((e) => e.msg)).toEqual(["msg-0", "msg-1", "msg-2", "msg-3", "msg-4"]);

    const last2 = await PtLogger.tail(tmpDir, 2, "s");
    expect(last2).toHaveLength(2);
    expect(last2.map((e) => e.msg)).toEqual(["msg-3", "msg-4"]);
  });

  it("损坏行（半行 / 非法 JSON）跳过", async () => {
    const logger = new PtLogger(tmpDir, "p", "s");
    logger.info("valid-1");
    logger.info("valid-2");
    await logger.flush();
    // 手动追加一行损坏内容
    const { appendFileSync } = await import("node:fs");
    appendFileSync(logger.filePath, "this is not json\n", "utf8");

    const entries = await PtLogger.tail(tmpDir, 50, "s");
    expect(entries).toHaveLength(2); // 损坏行被跳过
  });
});

describe("PtLogger static clear", () => {
  it("清空文件（保留目录）", async () => {
    const logger = new PtLogger(tmpDir, "p", "s");
    logger.info("to-be-cleared");
    await logger.flush();
    expect(readFileSync(logger.filePath, "utf8")).not.toBe("");

    await PtLogger.clear(tmpDir, "s");
    expect(readFileSync(logger.filePath, "utf8")).toBe("");
  });
});

describe("PtLogger static list", () => {
  it("无日志文件 → 返空", async () => {
    const files = await PtLogger.list(tmpDir);
    expect(files).toEqual([]);
  });

  it("枚举所有 pt-*.log（按名字排序）", async () => {
    const a = new PtLogger(tmpDir, "p", "aaa");
    a.info("a");
    await a.flush();
    const b = new PtLogger(tmpDir, "p", "bbb");
    b.info("b");
    await b.flush();

    const files = await PtLogger.list(tmpDir);
    expect(files).toEqual(["pt-aaa.log", "pt-bbb.log"]);
  });
});
