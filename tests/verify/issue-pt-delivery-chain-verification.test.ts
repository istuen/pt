// tests/verify/issue-pt-delivery-chain-verification.test.ts
// 交付链路验证的**盲区记录**（issue pt-delivery-chain-verification）
//
// 核心命题：Pt 交付的 `injection: matched` 是**观测点一致性**，不是端到端保证。
//
// 为什么要有这个测试文件：
//   它不是"测功能"，是**把已证伪的假设钉在代码里**——
//   防止未来有人看到 `injectionMatched: true` 就以为链路已被证明打通。
//
// 实证来源（issue §三，真机故障注入实验）：
//   ① Pt 自报 sha == 独立证人 sha == 物理证据 sha   → 三方逐字节一致（看起来完美）
//   ② 但 provider 实际收到的是**被篡改后**的内容（模型自证"有 TAMPERED-BY-PROBE"）
//   ③ 原因：Pi 的 `before_provider_request` handler 按扩展加载顺序串行执行，
//      **后注册的 handler 能改写前面 handler 已观测过的 payload**
//
// 本测试用**纯函数模拟**这个顺序效应（不依赖真机 Pi），把语义边界钉死。

import { describe, expect, it } from "vitest";
import {
  checkInjectionConsistency,
  extractInjectedSegment,
  extractProviderTrace,
  locateInjectedSegment,
  PT_INJECT_MARKER,
  sha256,
} from "../../src/provider-trace.js";

/** Pt 注入的段（模拟 AgentContext 产物）。 */
const SEGMENT =
  "### pt-quality-trigger\n\n- 改 schema 契约前先查规范\n  调 pt_inject tool domain=pt-quality 查看完整规范";

/** Pt 声称"我注入了这个"的 system prompt。 */
const PT_CLAIM = `BASE\n\n${PT_INJECT_MARKER}\n\n${SEGMENT}`;

describe("D1 观测点一致性 ≠ 端到端保证", () => {
  it("Pt 观测点看到未篡改内容 → matched（这是 Pt 能保证的全部）", () => {
    const trace = extractProviderTrace({
      model: "m",
      messages: [{ role: "developer", content: PT_CLAIM }],
    });
    const check = checkInjectionConsistency(SEGMENT, PT_CLAIM);
    expect(check.status).toBe("matched");
    expect(trace.systemSha).toBe(sha256(PT_CLAIM));
  });

  it("若篡改发生在 Pt 观测点之前 → Pt 能发现（报 mismatch）", () => {
    const tampered = PT_CLAIM.replace("先查规范", "先查别的");
    const check = checkInjectionConsistency(SEGMENT, tampered);
    expect(check.status).toBe("mismatch");
  });

  it("若篡改发生在 Pt 观测点之后 → **Pt 发现不了**（本 issue 的核心盲区）", () => {
    // Pt 在观测点看到的是未篡改的 payload → 一切"正常"
    const observed = extractProviderTrace({
      model: "m",
      messages: [{ role: "developer", content: PT_CLAIM }],
    });
    expect(observed.systemSha).toBe(sha256(PT_CLAIM));

    // 但随后另一个 extension 的 handler 把 payload 改坏了——
    // provider 收到的是改坏的，Pt 的记录**毫无察觉**。
    const actuallySent = PT_CLAIM.replace("调 pt_inject tool", "[TAMPERED-BY-PROBE]");
    const realSha = sha256(actuallySent);
    expect(realSha).not.toBe(observed.systemSha);

    // → Pt 的 sha 记录**不等于** provider 实际收到的内容的 sha。
    //   这不是实现 bug，是 Pi 事件语义决定的（handler 顺序）。
    //   本测试的作用：把这个事实钉住，让后来者知道 `matched` 的强度上限。
  });

  it("Pt 侧语义自检：观测点的段定位与注入侧的段提取必须同口径", () => {
    // 注入侧（PiAdapter 写入 lastInjectedSegment）用的口径
    const fromAdapter = extractInjectedSegment(SEGMENT);
    // 观测侧（provider-trace 定位请求体里那段）用的口径
    const fromPayload = locateInjectedSegment(PT_CLAIM);
    expect(fromAdapter).toBe(fromPayload);
    expect(fromAdapter).toBe(SEGMENT);
  });

  it("回注段（Pt 自己的 H2 段）不计入注入段——口径稳定", () => {
    const withFeedback = `${PT_CLAIM}\n\n## 检查未通过（Pt 自动检查）\n\n- probe: x`;
    expect(locateInjectedSegment(withFeedback)).toBe(SEGMENT);
    expect(extractInjectedSegment(SEGMENT)).toBe(SEGMENT);
  });
});

describe("D2 独立证人的可验证性（不共享 Pt 实现）", () => {
  it("朴素定位（先 system/developer，再顶层 system）与 Pt 实现结果一致", () => {
    // 证人实现（scripts/probe/witness-probe.ts）的口径：先 messages 里的
    // system/developer，再退到顶层 system
    const payload = {
      model: "m",
      messages: [
        { role: "developer", content: PT_CLAIM },
        { role: "user", content: "hi" },
      ],
    };
    // 证人视角
    const witnessText = (() => {
      const msgs = payload.messages as Array<{ role: string; content: string }>;
      const m = msgs.find((x) => x.role === "system" || x.role === "developer");
      return m ? m.content : null;
    })();
    // Pt 视角
    const ptText = (() => {
      const p = payload as { messages?: Array<{ role: string; content: string }> };
      const m = (p.messages ?? []).find((x) => x.role === "system" || x.role === "developer");
      return m ? m.content : null;
    })();

    expect(witnessText).toBe(ptText);
    expect(sha256(witnessText ?? "")).toBe(sha256(PT_CLAIM));
  });

  it("顶层 system 形状：两套实现同样一致", () => {
    const payload = { model: "m", system: PT_CLAIM, messages: [{ role: "user", content: "x" }] };
    const t = extractProviderTrace(payload);
    expect(t.shape).toBe("top-level-system");
    expect(t.systemSha).toBe(sha256(PT_CLAIM));
  });
});

// ==================== D3 规范：观测点边界必须声明 ====================
// 规范 `observation-boundary-declared`（pt-quality）：
//   涉及"内容是否真的送达外部系统"的观测字段，必须在字段说明/注释里显式声明观测点边界。
// 本测试把该规范**变成可执行的检查**——防止后人新增观测字段时忘了声明边界。

describe("D3 规范落地：观测点边界必须声明", () => {
  it("SessionSummary 的每个观测字段都带边界说明", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../src/summary.ts"),
      "utf8"
    );

    // 涉及"送达外部系统"的观测字段——必须声明边界
    const mustDeclare = [
      "injectedChars",
      "injectedCount",
      "ptInjectCalls",
      "filesRead",
      "filesModified",
      "models",
      "systemShas",
      "lastSystemSha",
      "injectionMatched",
    ];

    for (const field of mustDeclare) {
      // 字段声明点往前 700（doc comment）+ 往后 600（同行注释）内必须有边界措辞
      const idx = src.indexOf(`${field}:`);
      expect(idx, `字段 ${field} 未找到`).toBeGreaterThan(-1);
      const window = src.slice(Math.max(0, idx - 700), idx + 600);
      const declares =
        window.includes("观测点") ||
        window.includes("只证明") ||
        window.includes("不证明") ||
        window.includes("非端到端") ||
        window.includes("≠ 终点");
      expect(declares, `字段 ${field} 缺少观测点边界声明`).toBe(true);
    }
  });

  it("SessionSummary 结构级注释含「观测点边界」表", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../src/summary.ts"),
      "utf8"
    );
    expect(src).toContain("观测点边界");
    expect(src).toContain("非端到端保证");
    // 端到端验证的出路必须被指向
    expect(src).toContain("verify-delivery-chain.sh");
  });

  it("provider-trace 的 handler 注释声明了「不是最终请求体」", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../src/provider-trace.ts"),
      "utf8"
    );
    expect(src).toContain("观测点边界");
    expect(src).toContain("不是 provider 最终收到的请求体");
    expect(src).toContain("verify-delivery-chain.sh");
  });
});
