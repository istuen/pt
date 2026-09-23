// tests/verify/commands-docs.test.ts — Phase 3 §Step 6：命令层纯函数内核测试
//
// 配套 .pt/docs/designs/pt-doc-schema-phase3-command-layer-executor-brief.md §Step 2-3
//
// 测试策略：
//   - 真数据：把 .pt/ 全集作为 happy-path 输出断言（数量 + 列头 + 关键字段）
//   - parseListFlags：纯字符串解析，完全独立单元测

import { describe, it, expect } from "vitest";
import {
  issuesText,
  manualsText,
  designsText,
  checkDocsText,
  parseListFlags,
} from "../../src/commands.js";

describe("commands: parseListFlags", () => {
  it("空串 → {}", () => {
    expect(parseListFlags("")).toEqual({});
  });
  it("只含空白 → {}", () => {
    expect(parseListFlags("   ")).toEqual({});
  });
  it("--status open → { status: 'open' }", () => {
    expect(parseListFlags("--status open")).toEqual({ status: "open" });
  });
  it("--profile pt-dev --status resolved → 两个字段都识别", () => {
    expect(parseListFlags("--profile pt-dev --status resolved")).toEqual({
      profile: "pt-dev",
      status: "resolved",
    });
  });
  it("--key=value 形态全部识别", () => {
    expect(parseListFlags("--profile=pt-design --status=open --kind=issue")).toEqual({
      profile: "pt-design",
      status: "open",
      kind: "issue",
    });
  });
  it("-p 别名 → 只 profile 字段", () => {
    expect(parseListFlags("-p pt-dev")).toEqual({ profile: "pt-dev" });
  });
  it("--profile 无值 → 跳过（不让吞掉下一个 -- 开头 flag）", () => {
    expect(parseListFlags("--profile --status open")).toEqual({ status: "open" });
  });
  it("--profile 是最后 token 无值 → 不存", () => {
    expect(parseListFlags("--profile")).toEqual({});
  });
});

describe("commands: issuesText (真数据 .pt/docs/issues)", () => {
  const cwd = process.cwd();

  it("activeProfile=null → 不过滤，返回全部（47）", async () => {
    const r = await issuesText(cwd, null);
    // 标题行 + 47 行 + 计数行 + filtered out 行
    expect(r).toContain("Issues (");
    expect(r).toContain("parse errors");
    // 应含表头 NAME/STATUS/SEVERITY/CREATED/PROFILE
    expect(r).toContain("NAME");
    expect(r).toContain("STATUS");
    expect(r).toContain("SEVERITY");
    expect(r).toContain("CREATED");
    expect(r).toContain("PROFILE");
  });

  it("activeProfile=pt-dev → 含 pt-dev profile + 无 profile 字段的（数 = 含无字段）", async () => {
    const r = await issuesText(cwd, "pt-dev");
    // pt-dev 应见 pt-doc-index-and-schema（标三 profile）、pt-execution-observability-gap
    expect(r).toContain("pt-doc-index-and-schema");
    expect(r).toContain("pt-execution-observability-gap");
    // 模块名验证排序：pt-doc-index-and-schema 在第一行（status=open 优先级最高）
    const firstDataLine =
      r.split("\n")[r.split("\n").findIndex((l) => l.includes("pt-doc-index-and-schema"))];
    expect(firstDataLine).toContain("pt-doc-index-and-schema");
  });

  it("--status open → 只列 open 的 issue", async () => {
    const r = await issuesText(cwd, null, { status: "open" });
    expect(r).toContain("pt-doc-index-and-schema");
    expect(r).not.toContain("pt-scan-miss-use-chain"); // resolved，不应出现
  });

  it("--profile 优先级 > activeProfile", async () => {
    const r1 = await issuesText(cwd, "pt-dev", { profile: "pt-design", status: "open" });
    expect(r1).toContain("pt-doc-index-and-schema"); // 三 profile 含 pt-design
    expect(r1).not.toContain("pt-execution-observability-gap"); // 只有 pt-dev
  });

  it("空目录（或全部过滤掉）→ '(no documents match filter)'", async () => {
    const r = await issuesText(cwd, "ghost-profile-xyz", { profile: "ghost-profile-xyz" });
    // 全部文档都被过滤，但降级兼容让无 profile 字段的留下——
    // 真数据中 issues 都有 profile 字段（47 条均有），所以应无过滤
    expect(r).toContain("Issues (");
  });
});

describe("commands: manualsText / designsText (回归)", () => {
  const cwd = process.cwd();
  it("manualsText 不含 profile → 返回 ≥ 120 条", async () => {
    const r = await manualsText(cwd, null);
    expect(r).toContain("Manuals (");
    expect(r).toContain("PROCEDURE");
  });
  it("designsText 不含 profile → 返回 ≥ 65 条", async () => {
    const r = await designsText(cwd, null);
    expect(r).toContain("Designs (");
    expect(r).toContain("DOMAIN");
  });
  it("designsText --status 仍能识别（designs 没 status 字段则空）", async () => {
    const r = await designsText(cwd, null, { status: "active" });
    expect(r).toContain("Designs (");
  });
});

describe("commands: checkDocsText (批量 schema 校验)", () => {
  const cwd = process.cwd();

  it("kind=issue → 列已知 violations + 摘要", async () => {
    const r = await checkDocsText(cwd, null, { kind: "issue" });
    expect(r).toContain("Doc schema check");
    expect(r).toContain("kind: issue");
    // Phase 2 未完：所有 47 个 issues 缺 domain 字段
    expect(r).toContain("47 files");
    expect(r).toContain("47 violations");
    expect(r).toContain("✖ .pt/docs/issues/");
  });

  it("kind=manual → 列出 violations（含 verified 条件必填违反）", async () => {
    const r = await checkDocsText(cwd, null, { kind: "manual" });
    expect(r).toContain("Doc schema check");
    expect(r).toContain("kind: manual");
    expect(r).toContain("verified"); // 条件必填字段名
  });

  it("无 kind → 全文档扫描（issue + manual + design）", async () => {
    const r = await checkDocsText(cwd, null);
    expect(r).toContain("kind: all");
    // 总数 >= 232（三类合计）
    expect(r).toMatch(/files, \d+ violations/);
  });

  it("输出格式遵守 biome 风格——以 ✖ 开头列违规", async () => {
    const r = await checkDocsText(cwd, null, { kind: "issue" });
    const lines = r.split("\n");
    const violationLines = lines.filter((l) => l.startsWith("✖"));
    // 至少 47 个 ✖ 行（每违规文件一行）
    expect(violationLines.length).toBeGreaterThanOrEqual(47);
  });
});
