// tests/verify/stats-report.test.ts — `/pt stats` 作者采用反馈报告测试
//
// issue pt-observability-read-gap §五 A 验收硬指标 1/2/3：
//   1. 空态 / 残行容错 / 正常态三态不崩
//   2. 归因正确性：fallback 噪声（首条 session:profile loaded = default→guide，
//      中途切 pt-dev）必须归到 pt-dev 而非 guide
//   3. 采用率与 log-stats.sh v2 一致：同一输入下 Domain 被查次数/被查 session 数吻合
//
// 测试用合成 fixture（不碰真实 .pt/ 数据）——夹具写入 tmp 目录。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  aggregateCheckDuty,
  aggregateDomains,
  aggregateFrom,
  aggregateProfiles,
  aggregateZeroConsult,
  buildStatsText,
  parseProductContent,
  readContextProducts,
  readLogEntries,
  readSummaryLines,
  type LogScan,
} from "../../src/stats-text.js";
import { LOG_DIR } from "../../src/log.js";
import { SUMMARY_FILE } from "../../src/summary.js";
import { CACHE_DIR } from "../../src/constants.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "pt-stats-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** 写一个日志文件（NDJSON 行数组）。 */
function writeLog(name: string, entries: unknown[]): void {
  mkdirSync(join(tmpDir, LOG_DIR), { recursive: true });
  const body = entries.map((e) => JSON.stringify(e)).join("\n");
  writeFileSync(join(tmpDir, LOG_DIR, name), body === "" ? "" : `${body}\n`, "utf8");
}

/** 写 summary.ndjson（对象数组）。 */
function writeSummary(records: unknown[]): void {
  mkdirSync(join(tmpDir, LOG_DIR), { recursive: true });
  const body = records.map((r) => JSON.stringify(r)).join("\n");
  writeFileSync(join(tmpDir, LOG_DIR, SUMMARY_FILE), body === "" ? "" : `${body}\n`, "utf8");
}

/** 写一个编译产物（AgentContext 物理文件）。 */
function writeProduct(name: string, content: string): void {
  mkdirSync(join(tmpDir, CACHE_DIR), { recursive: true });
  writeFileSync(join(tmpDir, CACHE_DIR, name), content, "utf8");
}

/** 构造一个最小 summary 记录（字段按 SessionSummaryRecord 补齐）。 */
function summaryRec(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    turns: 1,
    toolCalls: 1,
    ptInjectCalls: [],
    filesRead: [],
    filesModified: [],
    checkResults: [],
    blockedCount: 0,
    bypassCount: 0,
    injectedChars: 100,
    injectedCount: 1,
    status: "ok",
    providerCalls: 1,
    models: [],
    systemShas: [],
    lastSystemSha: null,
    injectionMatched: null,
    injectionMismatchCount: 0,
    injectionNotFoundCount: 0,
    sessionId: "sess-1",
    profile: "pt-dev",
    startedAt: "2026-10-25T10:00:00.000Z",
    endedAt: "2026-10-25T10:05:00.000Z",
    durationSec: 5,
    failedChecks: [],
    filesModifiedCount: 0,
    ...over,
  };
}

/** 构造一条日志 entry。 */
function logEntry(msg: string, ctx: Record<string, unknown>): Record<string, unknown> {
  return { ts: "2026-10-25T10:00:00.000Z", level: "info", msg, ctx };
}

/** 构造一个带 trigger-index 段的编译产物内容。 */
function productContent(profile: string, triggers: string[], extra = ""): string {
  const bullets = triggers.map((t) => `- ${t}: 说明文字`).join("\n");
  return [
    "---",
    "source-hash: abc-123",
    "pack: fullstack",
    `profile: ${profile}`,
    "blueprint: pt-default",
    "---",
    "",
    "## session-context",
    "",
    "### some-domain",
    "- a-rule: 规则说明",
    "",
    "## trigger-index",
    "",
    bullets,
    "",
    "## reference-manual",
    "",
    "### some-domain",
    "- a-flow: 流程说明",
    "",
    extra,
  ].join("\n");
}

// ==================== 1. 空态 ====================

describe("空态（无日志无产物）", () => {
  it("buildStatsText 不抛，输出含五块标题 + 空态提示", async () => {
    const txt = await buildStatsText(tmpDir);
    expect(txt).toContain("pt stats");
    expect(txt).toContain("【1】Profile 效果");
    expect(txt).toContain("【2】Domain 采用");
    expect(txt).toContain("【3】零查阅清单");
    expect(txt).toContain("【4】注入成本");
    expect(txt).toContain("【5】检查值班");
    expect(txt).toContain("诚实尾注");
    expect(txt).toContain("(无汇总数据)");
    expect(txt).toContain("(无编译产物)");
  });

  it("读侧全空：summary / log / products 都是空数组", async () => {
    expect(await readSummaryLines(tmpDir)).toEqual([]);
    expect((await readLogEntries(tmpDir)).parsedLines).toBe(0);
    expect(await readContextProducts(tmpDir)).toEqual([]);
  });
});

// ==================== 2. 残行容错 ====================

describe("残行容错（NDJSON 撕裂行）", () => {
  it("summary.ndjson 掺坏行：跳过不崩，好行计数正确", async () => {
    mkdirSync(join(tmpDir, LOG_DIR), { recursive: true });
    writeFileSync(
      join(tmpDir, LOG_DIR, SUMMARY_FILE),
      [
        JSON.stringify(summaryRec({ sessionId: "a", profile: "pt-dev" })),
        "{ this is not json",
        JSON.stringify(summaryRec({ sessionId: "b", profile: "pt-design" })),
        "",
      ].join("\n"),
      "utf8"
    );
    const recs = await readSummaryLines(tmpDir);
    expect(recs.length).toBe(2);
    expect(recs.map((r) => r.sessionId)).toEqual(["a", "b"]);
  });

  it("log 掺坏行：跳过不崩，好行计数正确 + skippedLines 记账", async () => {
    mkdirSync(join(tmpDir, LOG_DIR), { recursive: true });
    writeFileSync(
      join(tmpDir, LOG_DIR, "pt-sess.log"),
      [
        JSON.stringify(logEntry("turn:start", { sessionId: "real-1" })),
        "{ broken",
        JSON.stringify(logEntry("turn:start", { sessionId: "real-2" })),
        "",
      ].join("\n"),
      "utf8"
    );
    const scan = await readLogEntries(tmpDir);
    expect(scan.parsedLines).toBe(2);
    expect(scan.skippedLines).toBe(1);
    expect(scan.effectiveSessions.length).toBe(2);
  });

  it("buildStatsText 在残行数据上不抛", async () => {
    mkdirSync(join(tmpDir, LOG_DIR), { recursive: true });
    writeFileSync(join(tmpDir, LOG_DIR, SUMMARY_FILE), "{ bad\n", "utf8");
    writeFileSync(join(tmpDir, LOG_DIR, "pt-x.log"), '{ bad\n{"msg":"x"}\n', "utf8");
    await expect(buildStatsText(tmpDir)).resolves.toContain("pt stats");
  });
});

// ==================== 3. 正常态 ====================

describe("正常态（合成数据集）", () => {
  beforeEach(() => {
    writeSummary([
      summaryRec({ sessionId: "sess-a", profile: "pt-dev", turns: 10 }),
      summaryRec({ sessionId: "sess-b", profile: "pt-dev", turns: 4 }),
      summaryRec({ sessionId: "sess-c", profile: "pt-design", turns: 3 }),
    ]);
    writeLog("pt-sess-a.log", [
      logEntry("turn:start", { sessionId: "sess-a" }),
      logEntry("turn:start", { sessionId: "sess-b" }),
      logEntry("turn:start", { sessionId: "sess-c" }),
      logEntry("tool:call", {
        sessionId: "sess-a",
        name: "pt_inject",
        input: { domain: "dev-process" },
      }),
      logEntry("tool:call", {
        sessionId: "sess-a",
        name: "pt_inject",
        input: { domain: "dev-process" },
      }),
      logEntry("tool:call", {
        sessionId: "sess-b",
        name: "pt_inject",
        input: { domain: "pt-collab" },
      }),
      logEntry("tool:call", {
        sessionId: "sess-c",
        name: "pt_doc",
        input: { action: "start", procedure: "feature-lifecycle" },
      }),
      logEntry("transpile:done", {
        sessionId: "sess-a",
        profileName: "pt-dev",
        segmentLen: 9000,
      }),
    ]);
    writeProduct(
      "fullstack__pt-dev.agent-context.md",
      productContent("pt-dev", ["dev-process-trigger"])
    );
    writeProduct(
      "fullstack__pt-design.agent-context.md",
      productContent("pt-design", ["pt-collab-trigger"])
    );
  });

  it("五块结构齐全 + 尾注在场", async () => {
    const txt = await buildStatsText(tmpDir);
    for (const block of ["【1】", "【2】", "【3】", "【4】", "【5】"]) {
      expect(txt).toContain(block);
    }
    expect(txt).toContain("诚实尾注");
    expect(txt).toContain("观测点事实");
    expect(txt).toContain("查阅 ≠ 遵守");
  });

  it("Profile 效果表：sessions / turns 按 summary 归因聚合", async () => {
    const [summaries, scan, products] = await Promise.all([
      readSummaryLines(tmpDir),
      readLogEntries(tmpDir),
      readContextProducts(tmpDir),
    ]);
    const rows = aggregateProfiles(summaries, scan, products);
    const dev = rows.find((r) => r.profile === "pt-dev");
    expect(dev?.sessions).toBe(2);
    expect(dev?.turns).toBe(14);
    expect(dev?.avgSegmentLen).toBe(9000);
    const design = rows.find((r) => r.profile === "pt-design");
    expect(design?.sessions).toBe(1);
  });

  it("检查值班：outcome 分布 + manual 启动计数", async () => {
    const [summaries, scan] = await Promise.all([readSummaryLines(tmpDir), readLogEntries(tmpDir)]);
    const duty = aggregateCheckDuty(summaries, scan);
    expect(duty.manualStarts).toBe(1);
    expect(duty.manualByProcedure[0]).toEqual({ procedure: "feature-lifecycle", count: 1 });
    // injectionMatched 全 null → 内容到场层无数据
    expect(duty.noDeliveryData).toBe(true);
  });

  it("DEVIATED outcome 计数 + 阻断/绕过合计", async () => {
    writeSummary([
      summaryRec({
        sessionId: "sess-x",
        checkResults: [
          { probe: "p1", outcome: "COMPLETED" },
          { probe: "p2", outcome: "DEVIATED" },
        ],
        blockedCount: 2,
        bypassCount: 1,
      }),
    ]);
    const [summaries, scan] = await Promise.all([readSummaryLines(tmpDir), readLogEntries(tmpDir)]);
    const duty = aggregateCheckDuty(summaries, scan);
    expect(duty.outcomes.COMPLETED).toBe(1);
    expect(duty.outcomes.DEVIATED).toBe(1);
    expect(duty.deviates).toBe(1);
    expect(duty.blocked).toBe(2);
    expect(duty.bypass).toBe(1);
  });

  it("注入成本：三段字符数与占比", async () => {
    const [summaries, scan, products] = await Promise.all([
      readSummaryLines(tmpDir),
      readLogEntries(tmpDir),
      readContextProducts(tmpDir),
    ]);
    const agg = aggregateFrom(summaries, scan, products);
    const dev = agg.costs.find((c) => c.profile === "pt-dev");
    expect(dev).toBeDefined();
    expect(dev?.sessionContextChars).toBeGreaterThan(0);
    expect(dev?.triggerIndexChars).toBeGreaterThan(0);
    expect(dev?.referenceManualChars).toBeGreaterThan(0);
    const sum = dev ? ((dev.share[0] + dev.share[1] + dev.share[2]) as number) : 0;
    expect(Math.abs(sum - 100)).toBeLessThan(1);
  });

  it("Blueprint 一行：单一蓝图时诚实陈述无对比面", async () => {
    const txt = await buildStatsText(tmpDir);
    expect(txt).toContain("Blueprint:");
    expect(txt).toContain("无对比面");
  });
});

// ==================== 4. fallback 归因 ====================

describe("fallback 归因（验收硬指标 2）", () => {
  it("首条 session:profile loaded = default→guide，中途切 pt-dev → 归到 pt-dev", async () => {
    // session 结束时的 active profile = pt-dev（summary 是归因主源）。
    writeSummary([summaryRec({ sessionId: "sess-f", profile: "pt-dev", turns: 7 })]);
    writeLog("pt-sess-f.log", [
      // 首条：default fallback → guide（这会把 guide 吹大）
      logEntry("session:profile loaded", {
        sessionId: "sess-f",
        profileName: "guide",
        requested: "guide",
        loadedFrom: "default",
      }),
      // 中途切换到真实 profile
      logEntry("command:switchProfile inject", { sessionId: "sess-f", profileName: "pt-dev" }),
      logEntry("session:profile loaded", {
        sessionId: "sess-f",
        profileName: "pt-dev",
        requested: "pt-dev",
        loadedFrom: "settings",
      }),
      logEntry("turn:start", { sessionId: "sess-f" }),
    ]);

    const [summaries, scan, products] = await Promise.all([
      readSummaryLines(tmpDir),
      readLogEntries(tmpDir),
      readContextProducts(tmpDir),
    ]);
    const rows = aggregateProfiles(summaries, scan, products);
    const dev = rows.find((r) => r.profile === "pt-dev");
    const guide = rows.find((r) => r.profile === "guide");
    expect(dev?.sessions).toBe(1);
    expect(dev?.turns).toBe(7);
    // guide 不应被归因出 session（fallback 不参与归因）
    expect(guide).toBeUndefined();
    // fallback 只计数
    expect(scan.fallbackProfileLoads).toBe(1);
  });

  it("报告尾注标注 fallback 计数但不参与归因", async () => {
    writeSummary([summaryRec({ sessionId: "sess-f", profile: "pt-dev" })]);
    writeLog("pt-sess-f.log", [
      logEntry("session:profile loaded", {
        sessionId: "sess-f",
        profileName: "guide",
        loadedFrom: "default",
      }),
    ]);
    const txt = await buildStatsText(tmpDir);
    expect(txt).toContain("default fallback");
    expect(txt).toContain("不参与归因");
  });
});

// ==================== 5. v2 判定语义吻合 ====================

describe("与 log-stats.sh v2 判定语义吻合（验收硬指标 3）", () => {
  it("Domain 被查次数 / 被查 session 数 / 曝光 profile 数 与 v2 口径一致", async () => {
    // v2 §4.4/§4.5 的判定语义：
    //   被查次数   = tool:call name=pt_inject 且 input.domain == d 的行数
    //   被查 session 数 = 同上的行去重 sessionId 数
    //   曝光 profile 数 = 产物 trigger-index 里出现该 domain 的 profile 数
    writeLog("pt-sess-1.log", [
      logEntry("tool:call", {
        sessionId: "sess-1",
        name: "pt_inject",
        input: { domain: "dev-process" },
      }),
      logEntry("tool:call", {
        sessionId: "sess-1",
        name: "pt_inject",
        input: { domain: "dev-process" },
      }),
      logEntry("tool:call", {
        sessionId: "sess-2",
        name: "pt_inject",
        input: { domain: "dev-process" },
      }),
      logEntry("tool:call", {
        sessionId: "sess-2",
        name: "pt_inject",
        input: { domain: "pt-collab" },
      }),
    ]);
    writeProduct(
      "fullstack__pt-dev.agent-context.md",
      productContent("pt-dev", ["dev-process-trigger"])
    );
    writeProduct(
      "fullstack__pt-design.agent-context.md",
      productContent("pt-design", ["dev-process-trigger", "pt-collab-trigger"])
    );

    const [scan, products] = await Promise.all([
      readLogEntries(tmpDir),
      readContextProducts(tmpDir),
    ]);
    const rows = aggregateDomains(scan, products);
    const devProcess = rows.find((r) => r.domain === "dev-process");
    expect(devProcess?.consulted).toBe(3);
    expect(devProcess?.consultedSessions).toBe(2);
    expect(devProcess?.exposedProfiles).toBe(2);
    expect(devProcess?.profiles).toEqual(["pt-design", "pt-dev"]);
    const ptCollab = rows.find((r) => r.domain === "pt-collab");
    expect(ptCollab?.consulted).toBe(1);
    expect(ptCollab?.consultedSessions).toBe(1);
    expect(ptCollab?.exposedProfiles).toBe(1);
  });

  it("无 domain 归因的 pt_inject 计入总数但不计入任何 domain（v2 §4.4 警示口径）", async () => {
    writeLog("pt-sess-old.log", [
      logEntry("tool:call", { sessionId: "sess-old", name: "pt_inject" }),
      logEntry("tool:call", { sessionId: "sess-old", name: "pt_inject" }),
      logEntry("tool:call", {
        sessionId: "sess-old",
        name: "pt_inject",
        input: { domain: "pt-collab" },
      }),
    ]);
    const scan = await readLogEntries(tmpDir);
    expect(scan.ptInjectTotal).toBe(3);
    expect(scan.ptInjectWithDomain).toBe(1);
    const rows = aggregateDomains(scan, []);
    expect(rows.find((r) => r.domain === "pt-collab")?.consulted).toBe(1);
    expect(rows.length).toBe(1);
  });

  it("测试 fixture session 按 v2 jq 口径过滤（test-session / session-A / session-B）", async () => {
    writeLog("pt-fixture.log", [
      logEntry("tool:call", {
        sessionId: "test-session",
        name: "pt_inject",
        input: { domain: "dev-process" },
      }),
      logEntry("tool:call", {
        sessionId: "session-A",
        name: "pt_inject",
        input: { domain: "dev-process" },
      }),
      logEntry("tool:call", {
        sessionId: "session-B",
        name: "pt_inject",
        input: { domain: "dev-process" },
      }),
      logEntry("tool:call", {
        sessionId: "real-session",
        name: "pt_inject",
        input: { domain: "dev-process" },
      }),
    ]);
    const scan = await readLogEntries(tmpDir);
    expect(scan.ptInjectTotal).toBe(1);
    expect(scan.consults[0]?.domain).toBe("dev-process");
    expect(scan.consults[0]?.sessionId).toBe("real-session");
  });

  it("零查阅清单：曝光 session 数 ≥ 阈值且被查 0 → 入选；被查 > 0 → 不入选", () => {
    const mk = (
      domain: string,
      exposureSessions: number,
      consulted: number
    ): {
      domain: string;
      exposedProfiles: number;
      profiles: string[];
      exposureSessions: number;
      consulted: number;
      consultedSessions: number;
      adoptionRate: number | null;
    } => ({
      domain,
      exposedProfiles: 1,
      profiles: ["pt-dev"],
      exposureSessions,
      consulted,
      consultedSessions: consulted,
      adoptionRate: null,
    });
    const rows = [mk("zero-look", 9, 0), mk("used", 9, 3), mk("low-exposure", 2, 0)];
    const zero = aggregateZeroConsult(rows, 5);
    expect(zero.map((z) => z.domain)).toEqual(["zero-look"]);
  });

  it("产物解析：frontmatter + 三段 + trigger-index 条目（v2 awk 语义）", () => {
    const content = productContent("pt-dev", ["dev-process-trigger", "pt-collab-trigger"]);
    const info = parseProductContent("fullstack__pt-dev.agent-context.md", content);
    expect(info.pack).toBe("fullstack");
    expect(info.profile).toBe("pt-dev");
    expect(info.blueprint).toBe("pt-default");
    expect(info.triggers.map((t) => t.entry)).toEqual(["dev-process-trigger", "pt-collab-trigger"]);
    // v2 口径：domain = entry 名去掉 -trigger 后缀
    expect(info.triggers.map((t) => t.domain)).toEqual(["dev-process", "pt-collab"]);
    expect(info.sectionChars["session-context"]).toBeGreaterThan(0);
    expect(info.sectionChars["trigger-index"]).toBeGreaterThan(0);
    expect(info.sectionChars["reference-manual"]).toBeGreaterThan(0);
  });

  it("产物解析：无 -trigger 后缀的条目名 → domain 名 == entry 名（v2 同口径）", () => {
    const info = parseProductContent(
      "x.agent-context.md",
      ["---", "profile: p", "---", "", "## trigger-index", "", "- plain: 说明", ""].join("\n")
    );
    expect(info.triggers[0]?.entry).toBe("plain");
    expect(info.triggers[0]?.domain).toBe("plain");
  });
});

// ==================== 读侧稳健性 ====================

describe("读侧稳健性", () => {
  it("日志目录不存在 → 空扫描不抛", async () => {
    const scan = await readLogEntries(join(tmpDir, "no-such-dir"));
    expect(scan.parsedLines).toBe(0);
    expect(scan.consults).toEqual([]);
  });

  it("LogScan 空结构可直接聚合（无产物无日志）", () => {
    const empty: LogScan = {
      ptInjectTotal: 0,
      ptInjectWithDomain: 0,
      consults: [],
      docCalls: [],
      rebuilds: [],
      transpileDones: [],
      fallbackProfileLoads: 0,
      profileLoadSessions: 0,
      effectiveSessions: [],
      parsedLines: 0,
      skippedLines: 0,
    };
    const agg = aggregateFrom([], empty, []);
    expect(agg.profiles).toEqual([]);
    expect(agg.domains).toEqual([]);
    expect(agg.ptInjectUnattributable).toBe(0);
  });

  it("summary 缺失 + 产物存在 → 不崩且成本块有数据", async () => {
    writeProduct(
      "fullstack__pt-dev.agent-context.md",
      productContent("pt-dev", ["dev-process-trigger"])
    );
    const txt = await buildStatsText(tmpDir);
    expect(txt).toContain("【4】注入成本");
    expect(txt).toContain("pt-dev");
  });
});
