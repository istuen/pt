// tests/verify/issue-pt-asset-verifiable-norm-a1.test.ts
// A1 落地验证（issue pt-asset-verifiable-norm §三 A1）
//
// 目标：规范项（Rules / Checklists 的 H3 项）可挂"怎么自动验"的绑定：
//   ① parse：observe（无参形态）/ checks（行内对象带参）都能解析出来
//   ② 体检：探针名拼错 → 告警；字段名疑似拼错 → 告警
//   ③ 执行：只验**本 session 已注入过**的 domain 的规范项检查（归属 S2）
//   ④ 边界：不进上下文产物（TurnContext 不含 checks 细节）

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDomain } from "../../src/parse/domain.js";
import { parseNormChecks } from "../../src/parse/domain-renderers.js";
import { collectDomainNormChecks, runAutoChecks } from "../../src/checks.js";
import { scanProjectHealth } from "../../src/asset-health.js";
import { clearAllSessions, getSessionById } from "../../src/session.js";
import { MOD_CHECKLISTS, MOD_RULES } from "../../src/constants.js";
import type { Domain } from "../../src/schema.js";

let cwd: string;
const SESSION_ID = "test-a1-session";

beforeEach(() => {
  clearAllSessions();
  cwd = mkdtempSync(join(tmpdir(), "pt-a1-"));
});

afterEach(() => {
  clearAllSessions();
  rmSync(cwd, { recursive: true, force: true });
});

/** 写一个含规范项检查绑定的 domain 文件并 parse。 */
async function writeAndParseDomain(body: string, name = "demo"): Promise<Domain> {
  const dir = join(cwd, "domains");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${name}.md`),
    `---\nname: ${name}\n---\n\n# ${name}\n\n${body}\n`,
    "utf8"
  );
  return parseDomain(dir, `${name}.md`);
}

describe("A1.1 parse：observe / checks 绑定", () => {
  it("observe（无参形态）解析成 observe[]", async () => {
    const d = await writeAndParseDomain(
      [
        "## Rules",
        "",
        "### r1",
        "- check: 改完要跑 lint",
        "- observe: [lint-check, git-status-clean]",
      ].join("\n")
    );
    const rules = d.modules[MOD_RULES] as Array<{ name: string; observe?: string[] }>;
    expect(rules[0].observe).toEqual(["lint-check", "git-status-clean"]);
  });

  it("checks（行内对象带参）解析成 NormCheck[]", async () => {
    const d = await writeAndParseDomain(
      [
        "## Rules",
        "",
        "### r1",
        "- check: 改完要跑 lint",
        "- checks: { probe: lint-check, params: { cmd: npm run lint } }",
      ].join("\n")
    );
    const rules = d.modules[MOD_RULES] as Array<{ checks?: unknown[] }>;
    expect(rules[0].checks).toEqual([{ probe: "lint-check", params: { cmd: "npm run lint" } }]);
  });

  it("Checklists 段同样支持", async () => {
    const d = await writeAndParseDomain(
      ["## Checklists", "", "### c1", "- items: [a, b]", "- observe: [fs-exists]"].join("\n")
    );
    const cls = d.modules[MOD_CHECKLISTS] as Array<{ observe?: string[] }>;
    expect(cls[0].observe).toEqual(["fs-exists"]);
  });

  it("坏数据宽松处理（不抛、丢弃）", () => {
    expect(parseNormChecks(undefined)).toEqual([]);
    expect(parseNormChecks("")).toEqual([]);
    expect(parseNormChecks("lint-check")).toEqual([{ probe: "lint-check" }]);
    expect(parseNormChecks({ probe: "x", params: { a: 1, b: true } })).toEqual([
      { probe: "x", params: { a: "1", b: "true" } },
    ]);
    expect(parseNormChecks({ noProbe: "x" })).toEqual([]);
    expect(parseNormChecks([{ probe: "a" }, "b", 123, null])).toEqual([
      { probe: "a" },
      { probe: "b" },
    ]);
  });
});

describe("A1.2 体检：探针名 / 字段名", () => {
  it("探针名拼错 → norm-check-unknown-probe 告警", async () => {
    const d = await writeAndParseDomain(
      ["## Rules", "", "### r1", "- check: x", "- observe: [lint-chek]"].join("\n")
    );
    const report = await scanProjectHealth(cwd, [], [], [d], [] as never, "prj");
    const hit = report.issues.find((i) => i.msg.includes("lint-chek"));
    expect(hit).toBeDefined();
    expect(hit?.severity).toBe("warning");
  });

  it("字段名疑似拼错 → 告警（编辑距离 1）", async () => {
    const d = await writeAndParseDomain(
      ["## Rules", "", "### r1", "- check: x", "- chekc: 拼错了"].join("\n")
    );
    const report = await scanProjectHealth(cwd, [], [], [d], [] as never, "prj");
    const hit = report.issues.find((i) => i.msg.includes("chekc"));
    expect(hit).toBeDefined();
  });

  it("合法资产 → 无新增告警", async () => {
    const d = await writeAndParseDomain(
      ["## Rules", "", "### r1", "- check: x", "- observe: [lint-check]"].join("\n")
    );
    const report = await scanProjectHealth(cwd, [], [], [d], [] as never, "prj");
    expect(report.issues.filter((i) => i.msg.includes("r1"))).toHaveLength(0);
  });
});

describe("A1.3 执行：归属 S2（只验已注入的 domain）", () => {
  it("已注入的 domain → 跑它的规范项检查；未注入 → 不跑", async () => {
    const d = await writeAndParseDomain(
      ["## Rules", "", "### r1", "- check: x", "- observe: [fs-exists]"].join("\n")
    );
    // 未注入：cachedDomains 有它，但 turnOutputs 没记录查过
    getSessionById(SESSION_ID).cachedDomains = [d];
    getSessionById(SESSION_ID).turnOutputs = [];
    const before = await runAutoChecks({ cwd }, SESSION_ID, "agent_settled");
    expect(before).toHaveLength(0);

    // 已注入：B3 记录了 pt_inject 该 domain
    getSessionById(SESSION_ID).turnOutputs = [
      { turn: 1, files: [], domains: [d.name], at: new Date().toISOString() },
    ];
    const after = await runAutoChecks({ cwd }, SESSION_ID, "agent_settled");
    expect(after.map((r) => r.probe)).toContain("fs-exists");
  });

  it("collectDomainNormChecks：observe + checks 合并去重", () => {
    const domain: Domain = {
      name: "d",
      modules: {
        [MOD_RULES]: [
          { name: "r1", slot: "global", type: "invariant", check: "x", observe: ["a"] },
          { name: "r2", slot: "global", type: "invariant", check: "y", checks: [{ probe: "b" }] },
        ],
        [MOD_CHECKLISTS]: [
          { name: "c1", items: [], observe: ["a"], checks: [{ probe: "b", params: { p: "1" } }] },
        ],
      },
    };
    const got = collectDomainNormChecks(domain);
    expect(got.map((c) => c.probe).sort()).toEqual(["a", "b", "b"]);
    // 同名不同参数 → 两条
    expect(got.filter((c) => c.probe === "b")).toHaveLength(2);
  });
});

describe("A1.4 边界：checks 不进上下文产物", () => {
  it("TurnContext 渲染不含 checks 细节（只含规范正文）", async () => {
    const d = await writeAndParseDomain(
      [
        "## Rules",
        "",
        "### r1",
        "- check: 改完必须跑 lint",
        "- checks: { probe: lint-check, params: { cmd: npm run lint } }",
      ].join("\n")
    );
    const rules = d.modules[MOD_RULES] as Array<{ check: string; checks?: unknown[] }>;
    // 检查绑定存在，但渲染只吃 check 文本
    expect(rules[0].checks).toBeDefined();
    expect(rules[0].check).toBe("改完必须跑 lint");
  });
});
