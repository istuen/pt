// tests/verify/issue-pt-observability-read-gap-c.test.ts
// C 项落地验证（issue pt-observability-read-gap §五 C：出厂感知兜底——builtin 资产挂真实 observe 绑定）
//
// 背景：A1/A2/A3 机制齐备（issue pt-asset-verifiable-norm），但 builtin 资产 0 个真实绑定
//   → checkResults 恒空 → /pt stats 第 5 块恒 0/0，新装用户开箱看不到「检查在跑」。
//
// 本文件验证第一枚出厂绑定：usage.md 的 cache-invalidation-rule 挂 fs-exists 探针。
//   ① parse：绑定从真实 builtin 资产里解析出来（防语法漂移 → 静默不跑的假合规）
//   ② 收集：collectDomainNormChecks 能拿到它（A2 入口）
//   ③ 体检：scanProjectHealth 对它不告警（探针名在注册表里）
//   ④ 执行：guide 场景（cachedDomains=usage + 本 session 已查阅）→ agent_settled 跑出结果
//      —— 产物目录存在 = COMPLETED（开箱即见）；缺失 = DEVIATED（装配未落盘的真实信号）
//   ⑤ 边界：绑定不进上下文产物（A1.4 同款边界——执行侧数据不占 context）

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDomain } from "../../src/parse/domain.js";
import { collectDomainNormChecks, runAutoChecks } from "../../src/checks.js";
import { scanProjectHealth } from "../../src/asset-health.js";
import { clearAllSessions, getSessionById } from "../../src/session.js";
import { MOD_RULES } from "../../src/constants.js";
import type { Domain, Rule } from "../../src/schema.js";

const BUILTIN_DOMAINS_DIR = join(process.cwd(), "src/builtin/assets/domains");
const CACHE_DIR_REL = ".pt/cache/agent-contexts";

let cwd: string;
const SESSION_ID = "test-readgap-c-session";

beforeEach(() => {
  clearAllSessions();
  cwd = mkdtempSync(join(tmpdir(), "pt-readgap-c-"));
});

afterEach(() => {
  clearAllSessions();
  rmSync(cwd, { recursive: true, force: true });
});

/** 解析真实 builtin usage.md（不造夹具——测的就是出厂资产本体）。 */
async function parseBuiltinUsage(): Promise<Domain> {
  return parseDomain(BUILTIN_DOMAINS_DIR, "usage.md");
}

describe("C 项：builtin 出厂 observe 绑定（cache-invalidation-rule × fs-exists）", () => {
  it("① parse：真实 builtin usage.md 的绑定解析出来（语法漂移 = 假合规，必须守住）", async () => {
    const d = await parseBuiltinUsage();
    const rules = d.modules[MOD_RULES] as Rule[];
    const rule = rules.find((r) => r.name === "cache-invalidation-rule");
    expect(rule, "cache-invalidation-rule 必须存在于 builtin usage.md").toBeDefined();
    expect(rule?.checks).toEqual([{ probe: "fs-exists", params: { path: CACHE_DIR_REL } }]);
    // 规范正文带机器底线声明（人读的部分说了机器验什么——绑定才算诚实）
    expect(rule?.check).toContain("机器可验证底线");
  });

  it("② 收集：collectDomainNormChecks 拿到 fs-exists 声明（A2 入口）", async () => {
    const d = await parseBuiltinUsage();
    const got = collectDomainNormChecks(d);
    expect(got).toContainEqual({
      probe: "fs-exists",
      params: { path: CACHE_DIR_REL },
      on: "notify",
    });
  });

  it("③ 体检：真实 builtin usage.md 挂的绑定不触发 unknown-probe 告警", async () => {
    const d = await parseBuiltinUsage();
    const report = await scanProjectHealth(cwd, [], [], [d], [] as never, "prj");
    // 预存 info：usage-trigger desc 153 字超预算（dev 既有，与本绑定无关）——只断 warning 级零命中
    const hits = report.issues.filter((i) => i.severity === "warning" && i.msg.includes("usage"));
    expect(
      hits,
      `builtin usage.md 不应产生 warning 级告警，got: ${JSON.stringify(hits)}`
    ).toHaveLength(0);
  });

  it("④ 开箱即见：guide 场景查阅 usage → agent_settled 跑出 fs-exists=COMPLETED", async () => {
    // 新装用户项目形态：产物目录在（session_start 转译落盘后的健康态）
    mkdirSync(join(cwd, CACHE_DIR_REL), { recursive: true });
    const d = await parseBuiltinUsage();
    const s = getSessionById(SESSION_ID);
    s.cachedDomains = [d]; // guide profile 装配了 usage
    s.turnOutputs = [
      { turn: 1, files: [], domains: [d.name], at: new Date().toISOString() }, // 本 session 查阅过
    ];
    const results = await runAutoChecks({ cwd }, SESSION_ID, "agent_settled");
    const hit = results.find((r) => r.probe === "fs-exists");
    expect(hit, "usage 的规范项检查必须跑起来（开箱即见）").toBeDefined();
    expect(hit?.outcome).toBe("COMPLETED");
    expect(hit?.params).toEqual({ path: CACHE_DIR_REL });
  });

  it("④-b 真实信号：产物目录缺失 → DEVIATED（装配未落盘，不是恒真的装饰检查）", async () => {
    // 不建 .pt/cache/agent-contexts——转译未落盘的破损态
    const d = await parseBuiltinUsage();
    const s = getSessionById(SESSION_ID);
    s.cachedDomains = [d];
    s.turnOutputs = [{ turn: 1, files: [], domains: [d.name], at: new Date().toISOString() }];
    const results = await runAutoChecks({ cwd }, SESSION_ID, "agent_settled");
    const hit = results.find((r) => r.probe === "fs-exists");
    expect(hit).toBeDefined();
    expect(hit?.outcome).toBe("DEVIATED");
  });

  it("④-c 未查阅不跑：没 pt_inject 过 usage → 零检查（A2 成本纪律）", async () => {
    mkdirSync(join(cwd, CACHE_DIR_REL), { recursive: true });
    const d = await parseBuiltinUsage();
    const s = getSessionById(SESSION_ID);
    s.cachedDomains = [d];
    s.turnOutputs = []; // 本 session 没查阅
    const results = await runAutoChecks({ cwd }, SESSION_ID, "agent_settled");
    expect(results).toHaveLength(0);
  });

  it("⑤ 边界：绑定不进上下文产物（执行侧数据不占 context）", async () => {
    const d = await parseBuiltinUsage();
    const rules = d.modules[MOD_RULES] as Rule[];
    const rule = rules.find((r) => r.name === "cache-invalidation-rule");
    // checks 字段存在（执行侧），但渲染吃的是 check 正文——正文里只有一条「机器可验证底线」声明，
    // 不含 probe 名 / params（TurnContext 渲染同 A1.4 边界：只含规范正文）
    expect(rule?.check).not.toContain("fs-exists");
    expect(rule?.check).not.toContain("probe");
  });
});
