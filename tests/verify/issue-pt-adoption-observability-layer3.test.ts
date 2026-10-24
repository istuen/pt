// tests/verify/issue-pt-adoption-observability-layer3.test.ts
// Layer 3 provider 请求体观测验证（issue pt-adoption-observability §五 Layer 3）
//
// 目标：
//   1. 抽取器：各种 payload 形状都能定位系统消息（system / developer / 顶层 system）
//   2. 采样参数机会主义取（有就记，没有就留空——温度盲区是 provider 侧事实）
//   3. 一致性校验：Pt 注入的段 == 请求体里那段 → matched；改坏 → mismatch
//   4. 接入 Layer 2 汇总：model / systemSha / providerCalls / injectionMatched 出现
//   5. 隐私边界：payload 内容不出现在任何日志/文件
//   6. 边界纪律：handler 返回 undefined（绝不替换 payload）；不认识形状不崩

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import installExtension from "../../src/index.js";
import { clearAllSessions, getSessionById } from "../../src/session.js";
import {
  checkInjectionConsistency,
  detectPayloadShape,
  extractInjectedSegment,
  extractProviderTrace,
  extractSampling,
  extractSystemText,
  locateInjectedSegment,
  PT_INJECT_MARKER,
  sha256,
} from "../../src/provider-trace.js";

type GenericHandler = (...args: unknown[]) => unknown;

const SESSION_ID = "test-layer3-session";
let cwd: string;

beforeEach(() => {
  clearAllSessions();
  cwd = mkdtempSync(join(tmpdir(), "pt-layer3-"));
});

afterEach(() => {
  clearAllSessions();
  rmSync(cwd, { recursive: true, force: true });
});

/** 装扩展。 */
function makePi(flags: Record<string, unknown> = {}) {
  const events = new Map<string, GenericHandler[]>();
  const pi = {
    registerFlag: () => undefined,
    registerCommand: () => undefined,
    registerTool: () => undefined,
    on: (event: string, handler: GenericHandler) => {
      events.set(event, [...(events.get(event) ?? []), handler]);
    },
    getFlag: (name: string) => flags[name],
    appendEntry: () => undefined,
  };
  const ctx = {
    cwd,
    sessionManager: { getEntries: () => [], getSessionId: () => SESSION_ID },
    hasUI: true,
    ui: { notify: () => undefined, setStatus: () => undefined, setWidget: () => undefined },
    getSystemPrompt: () => "BASE",
  };
  installExtension(pi as never);
  return { events, ctx };
}

/** 构造一个 provider 请求体（system 角色在 messages 里）。 */
function payloadWithSystemRole(systemText: string, extra: Record<string, unknown> = {}) {
  return {
    model: "glm-5.3",
    messages: [
      { role: "system", content: systemText },
      { role: "user", content: "hi" },
    ],
    stream: true,
    ...extra,
  };
}

describe("L3.1 抽取器：系统消息定位（角色容忍）", () => {
  it("messages 里的 system 角色", () => {
    const p = payloadWithSystemRole("SYSTEM-TEXT");
    expect(extractSystemText(p)).toBe("SYSTEM-TEXT");
    expect(detectPayloadShape(p)).toBe("messages");
  });

  it("messages 里的 developer 角色（部分 provider 用 developer 承载系统消息）", () => {
    const p = {
      model: "glm-5.3",
      messages: [{ role: "developer", content: "DEVELOPER-TEXT" }],
    };
    expect(extractSystemText(p)).toBe("DEVELOPER-TEXT");
    expect(detectPayloadShape(p)).toBe("messages");
  });

  it("顶层 system 字段（string）", () => {
    const p = { model: "gpt-4", system: "TOP-TEXT", messages: [{ role: "user", content: "x" }] };
    expect(extractSystemText(p)).toBe("TOP-TEXT");
    expect(detectPayloadShape(p)).toBe("top-level-system");
  });

  it("顶层 system 字段（content 数组）", () => {
    const p = {
      model: "gpt-4",
      system: [
        { type: "text", text: "PART1" },
        { type: "text", text: "PART2" },
      ],
    };
    expect(extractSystemText(p)).toBe("PART1PART2");
  });

  it("messages 里的 content 数组（多 text 块拼接）", () => {
    const p = {
      model: "x",
      messages: [
        {
          role: "system",
          content: [
            { type: "text", text: "A" },
            { type: "text", text: "B" },
          ],
        },
      ],
    };
    expect(extractSystemText(p)).toBe("AB");
  });

  it("两者都有 → shape=both（顶层优先）", () => {
    const p = {
      model: "x",
      system: "TOP",
      messages: [{ role: "system", content: "MSG" }],
    };
    expect(detectPayloadShape(p)).toBe("both");
    expect(extractSystemText(p)).toBe("TOP");
  });

  it("不认识 → null + shape=unknown（不崩）", () => {
    expect(
      extractSystemText({ model: "x", messages: [{ role: "user", content: "hi" }] })
    ).toBeNull();
    expect(detectPayloadShape({ model: "x" })).toBe("unknown");
    expect(extractSystemText(null)).toBeNull();
    expect(extractSystemText(undefined)).toBeNull();
    expect(extractSystemText("not-an-object")).toBeNull();
  });
});

describe("L3.2 采样参数：机会主义", () => {
  it("provider 给了 → 取到", () => {
    const s = extractSampling({ model: "gpt-4", temperature: 0.7, top_p: 0.9, seed: 42 });
    expect(s).toEqual({ temperature: 0.7, top_p: 0.9, seed: 42 });
  });

  it("provider 没给 → undefined（温度盲区是 provider 侧事实，不算错误）", () => {
    expect(extractSampling({ model: "glm-5.3", messages: [] })).toBeUndefined();
  });

  it("非数值 → 忽略", () => {
    expect(extractSampling({ temperature: "hot" })).toBeUndefined();
  });

  it("「机会主义」语义：抽取器不按 provider 名分支，只看 payload 里有没有", () => {
    // 当前 provider（baiduqianfan / openai-completions）不给 temperature → 留空
    const blind = extractProviderTrace(payloadWithSystemRole("X"));
    expect(blind.sampling).toBeUndefined();

    // 换 provider（body 里带 temperature）→ 同一套抽取器能取到
    const withTemp = extractProviderTrace({
      model: "gpt-4o",
      temperature: 0.3,
      top_p: 0.8,
      messages: [{ role: "system", content: "X" }],
    });
    expect(withTemp.sampling?.temperature).toBe(0.3);
    expect(withTemp.sampling?.top_p).toBe(0.8);
  });

  it("机会主义路径下的完整 trace：model + systemSha + sampling 都在", () => {
    const t = extractProviderTrace({
      model: "gpt-4o",
      temperature: 0.5,
      messages: [{ role: "system", content: "SYS" }],
    });
    expect(t.model).toBe("gpt-4o");
    expect(t.systemSha).toBe(sha256("SYS"));
    expect(t.sampling).toEqual({ temperature: 0.5 });
  });
});

describe("L3.3 抽取结果：只含 hash / 长度 / 键名", () => {
  it("model + systemSha + 键名 + 字节数", () => {
    const p = payloadWithSystemRole("SECRET-CONTENT", { prompt_cache_key: "abc" });
    const t = extractProviderTrace(p);
    expect(t.model).toBe("glm-5.3");
    expect(t.systemSha).toBe(sha256("SECRET-CONTENT"));
    expect(t.systemLen).toBe("SECRET-CONTENT".length);
    expect(t.keys).toContain("messages");
    expect(t.keys).toContain("model");
    expect(t.payloadBytes).toBeGreaterThan(0);
    // 隐私边界：结果里不得出现内容本身
    expect(JSON.stringify(t)).not.toContain("SECRET-CONTENT");
  });

  it("不认识的形状 → shape=unknown + 留空字段（不崩不抛）", () => {
    const t = extractProviderTrace({ model: "x" });
    expect(t.shape).toBe("unknown");
    expect(t.systemSha).toBeNull();
    expect(t.systemLen).toBe(0);
    expect(t.model).toBe("x");
  });

  it("循环引用 payload → 字节数 0，不抛", () => {
    const p: Record<string, unknown> = { model: "x" };
    p.self = p;
    const t = extractProviderTrace(p);
    expect(t.payloadBytes).toBe(0);
  });
});

describe("L3.4 一致性校验", () => {
  const SEGMENT = "### domain-a\n\n规则一\n规则二";

  it("段定位：标记之后到下一个 H2 之前", () => {
    const text = `BASE\n\n${PT_INJECT_MARKER}\n\n${SEGMENT}\n\n## 上一轮产出（Pt 记录）\n\n- x`;
    expect(locateInjectedSegment(text)).toBe(SEGMENT);
  });

  it("H3 标题不算段尾（H2 才算）", () => {
    const text = `${PT_INJECT_MARKER}\n\n### a\n\nx\n\n### b\n\ny`;
    expect(locateInjectedSegment(text)).toBe("### a\n\nx\n\n### b\n\ny");
  });

  it("无标记 → null", () => {
    expect(locateInjectedSegment("BASE ONLY")).toBeNull();
  });

  it("一致 → matched", () => {
    const text = `${PT_INJECT_MARKER}\n\n${SEGMENT}`;
    const c = checkInjectionConsistency(SEGMENT, text);
    expect(c.status).toBe("matched");
    expect(c.expectedSha).toBe(sha256(SEGMENT));
    expect(c.actualSha).toBe(sha256(SEGMENT));
  });

  it("被改写（截断）→ mismatch", () => {
    const text = `${PT_INJECT_MARKER}\n\n### domain-a\n\n规则一（被截断了`;
    const c = checkInjectionConsistency(SEGMENT, text);
    expect(c.status).toBe("mismatch");
    expect(c.actualSha).not.toBe(c.expectedSha);
  });

  it("请求体里没有段 → not-found", () => {
    const c = checkInjectionConsistency(SEGMENT, "NO MARKER HERE");
    expect(c.status).toBe("not-found");
  });

  it("没定位到系统消息 → not-found", () => {
    const c = checkInjectionConsistency(SEGMENT, null);
    expect(c.status).toBe("not-found");
  });

  it("Pt 本轮没注入 → no-expectation（不是错误）", () => {
    const c = checkInjectionConsistency(null, "anything");
    expect(c.status).toBe("no-expectation");
  });

  it("extractInjectedSegment 与 locateInjectedSegment 形态一致（可比 sha）", () => {
    const raw = `${SEGMENT}\n\n## 上一轮产出（Pt 记录）\n\n- x`;
    expect(extractInjectedSegment(raw)).toBe(SEGMENT);
  });
});

describe("L3.5 接入 Layer 2 汇总", () => {
  it("provider 调用 → model / systemSha / providerCalls 进汇总", async () => {
    const { events, ctx } = makePi();
    await events.get("session_start")?.[0]?.({ type: "session_start" }, ctx);
    const bpr = events.get("before_provider_request")?.[0];
    expect(bpr).toBeDefined();

    const p = payloadWithSystemRole("SYSTEM-X");
    await bpr?.({ type: "before_provider_request", payload: p }, ctx);
    await bpr?.({ type: "before_provider_request", payload: p }, ctx);

    const sum = getSessionById(SESSION_ID).summary;
    expect(sum.providerCalls).toBe(2);
    expect(sum.models).toEqual(["glm-5.3"]);
    expect(sum.systemShas).toEqual([sha256("SYSTEM-X")]);
    expect(sum.lastSystemSha).toBe(sha256("SYSTEM-X"));
  });

  it("一致性校验：改坏注入 → 报不一致", async () => {
    const { events, ctx } = makePi();
    await events.get("session_start")?.[0]?.({ type: "session_start" }, ctx);
    const bpr = events.get("before_provider_request")?.[0];

    // 模拟 PiAdapter 注入：写 lastInjectedSegment
    getSessionById(SESSION_ID).lastInjectedSegment = "### a\n\n规则";

    // 请求体里那段被改坏了
    const p = payloadWithSystemRole(`${PT_INJECT_MARKER}\n\n### a\n\n规则（被改坏`);
    await bpr?.({ type: "before_provider_request", payload: p }, ctx);

    const sum = getSessionById(SESSION_ID).summary;
    expect(sum.injectionMatched).toBe(false);
    expect(sum.injectionMismatchCount).toBe(1);
  });

  it("一致性校验：内容一致 → matched", async () => {
    const { events, ctx } = makePi();
    await events.get("session_start")?.[0]?.({ type: "session_start" }, ctx);
    const bpr = events.get("before_provider_request")?.[0];

    const seg = "### a\n\n规则";
    getSessionById(SESSION_ID).lastInjectedSegment = seg;
    const p = payloadWithSystemRole(
      `BASE\n\n${PT_INJECT_MARKER}\n\n${seg}\n\n## 上一轮产出（Pt 记录）\n\n- x`
    );
    await bpr?.({ type: "before_provider_request", payload: p }, ctx);

    const sum = getSessionById(SESSION_ID).summary;
    expect(sum.injectionMatched).toBe(true);
    expect(sum.injectionMismatchCount).toBe(0);
  });

  it("不一致 → 后续的 matched 不得洗掉（取最严重结论）", async () => {
    const { events, ctx } = makePi();
    await events.get("session_start")?.[0]?.({ type: "session_start" }, ctx);
    const bpr = events.get("before_provider_request")?.[0];

    const seg = "### a\n\n规则";
    getSessionById(SESSION_ID).lastInjectedSegment = seg;

    // 先来一次坏的
    await bpr?.(
      {
        type: "before_provider_request",
        payload: payloadWithSystemRole(`${PT_INJECT_MARKER}\n\n### a\n\n被改坏`),
      },
      ctx
    );
    // 再来一次好的
    await bpr?.(
      {
        type: "before_provider_request",
        payload: payloadWithSystemRole(`${PT_INJECT_MARKER}\n\n${seg}`),
      },
      ctx
    );

    const sum = getSessionById(SESSION_ID).summary;
    expect(sum.injectionMatched).toBe(false);
    expect(sum.injectionMismatchCount).toBe(1);
  });

  it("lastSystemSha 跟最近一次观测（形状不认识时置 null）", async () => {
    const { events, ctx } = makePi();
    await events.get("session_start")?.[0]?.({ type: "session_start" }, ctx);
    const bpr = events.get("before_provider_request")?.[0];

    await bpr?.({ type: "before_provider_request", payload: payloadWithSystemRole("FIRST") }, ctx);
    expect(getSessionById(SESSION_ID).summary.lastSystemSha).toBe(sha256("FIRST"));

    await bpr?.({ type: "before_provider_request", payload: payloadWithSystemRole("SECOND") }, ctx);
    expect(getSessionById(SESSION_ID).summary.lastSystemSha).toBe(sha256("SECOND"));
    // 去重列表保留两个
    expect(getSessionById(SESSION_ID).summary.systemShas).toEqual([
      sha256("FIRST"),
      sha256("SECOND"),
    ]);

    // 形状不认识 → lastSystemSha 变 null（不知道就是不知道）
    await bpr?.({ type: "before_provider_request", payload: { nope: 1 } }, ctx);
    expect(getSessionById(SESSION_ID).summary.lastSystemSha).toBeNull();
  });

  it("汇总文件里出现 Layer 3 字段", async () => {
    const { events, ctx } = makePi();
    await events.get("session_start")?.[0]?.({ type: "session_start" }, ctx);
    const bpr = events.get("before_provider_request")?.[0];
    await bpr?.({ type: "before_provider_request", payload: payloadWithSystemRole("SYS") }, ctx);
    await events.get("session_shutdown")?.[0]?.({ type: "session_shutdown" }, ctx);

    const file = join(cwd, ".pt/logs", "summary.ndjson");
    expect(existsSync(file)).toBe(true);
    const rec = JSON.parse(readFileSync(file, "utf8").trim().split("\n")[0] ?? "{}");
    expect(rec.providerCalls).toBe(1);
    expect(rec.models).toEqual(["glm-5.3"]);
    expect(rec.systemShas).toEqual([sha256("SYS")]);
  });
});

describe("L3.6 边界纪律", () => {
  it("handler 返回 undefined（绝不替换 payload）", async () => {
    const { events, ctx } = makePi();
    await events.get("session_start")?.[0]?.({ type: "session_start" }, ctx);
    const bpr = events.get("before_provider_request")?.[0];
    const result = await bpr?.(
      { type: "before_provider_request", payload: payloadWithSystemRole("X") },
      ctx
    );
    expect(result).toBeUndefined();
  });

  it("不认识形状 → 不崩，汇总里记 shape=unknown 的调用", async () => {
    const { events, ctx } = makePi();
    await events.get("session_start")?.[0]?.({ type: "session_start" }, ctx);
    const bpr = events.get("before_provider_request")?.[0];
    await bpr?.({ type: "before_provider_request", payload: { weird: true } }, ctx);
    await bpr?.({ type: "before_provider_request", payload: null }, ctx);
    const sum = getSessionById(SESSION_ID).summary;
    expect(sum.providerCalls).toBe(2);
    expect(sum.systemSha).toBeUndefined();
    expect(sum.lastSystemSha).toBeNull();
  });

  it("隐私边界：payload 内容不出现在日志 / 汇总文件里", async () => {
    const SECRET = "TOP-SECRET-USER-CONTENT-9f3a";
    const { events, ctx } = makePi();
    await events.get("session_start")?.[0]?.({ type: "session_start" }, ctx);
    const bpr = events.get("before_provider_request")?.[0];
    await bpr?.({ type: "before_provider_request", payload: payloadWithSystemRole(SECRET) }, ctx);
    await events.get("session_shutdown")?.[0]?.({ type: "session_shutdown" }, ctx);

    // session 日志
    const logDir = join(cwd, ".pt/logs");
    const logFile = join(logDir, `pt-${SESSION_ID}.log`);
    if (existsSync(logFile)) {
      expect(readFileSync(logFile, "utf8")).not.toContain(SECRET);
    }
    // 汇总文件
    const summaryFile = join(logDir, "summary.ndjson");
    if (existsSync(summaryFile)) {
      expect(readFileSync(summaryFile, "utf8")).not.toContain(SECRET);
    }
  });
});
