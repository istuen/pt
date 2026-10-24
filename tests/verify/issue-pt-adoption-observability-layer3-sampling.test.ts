// tests/verify/issue-pt-adoption-observability-layer3-sampling.test.ts
// Layer 3「机会主义采样参数」路径验证（issue pt-adoption-observability §五 Layer 3）
//
// 背景（pt-layer3-plan §2.3）：当前 provider（baiduqianfan / openai-completions / glm-5.3）
//   **不把 temperature 放进请求体**——"温度盲区"是 provider 侧事实，不是 Pt 的限制。
//   换 provider（OpenAI / Anthropic 直接在 body 里带 temperature）时，同一套抽取器能取到。
//
// 本测试用 **pi-ai 的真实 openai-completions 请求体构造逻辑**（见
//   @earendil-works/pi-ai/dist/api/openai-completions.js:597 `if (options?.temperature !== undefined) params.temperature = ...`）
//  复刻两种 body：
//   ① 带 temperature 的 body（provider 给）→ 抽取器取到
//   ② 不带 temperature 的 body（当前 provider）→ 抽取器留空，**不算错误**
//
// 结论：抽取器是 **payload 形状驱动**的，不按 provider 名分支——这是"机会主义"的定义。

import { describe, expect, it } from "vitest";
import { extractProviderTrace, extractSampling } from "../../src/provider-trace.js";

/** 复刻 openai-completions 的请求体形状（Pi 发出的真实结构）。 */
function buildOpenAICompletionsBody(options: { temperature?: number; model?: string } = {}) {
  const params: Record<string, unknown> = {
    model: options.model ?? "gpt-4o",
    messages: [
      { role: "system", content: "SYSTEM" },
      { role: "user", content: "hi" },
    ],
    stream: true,
    stream_options: { include_usage: true },
    store: false,
    max_completion_tokens: 4096,
  };
  // 与 pi-ai openai-completions.js:597 一致：只在 options.temperature !== undefined 时才放进 body
  if (options.temperature !== undefined) {
    params.temperature = options.temperature;
  }
  return params;
}

describe("L3-sampling 机会主义：同一套抽取器，provider 给就取到", () => {
  it("provider 给了 temperature → 抽取器取到（机会主义路径成立）", () => {
    const body = buildOpenAICompletionsBody({ temperature: 0.7 });
    const t = extractProviderTrace(body);
    expect(t.sampling?.temperature).toBe(0.7);
    expect(t.model).toBe("gpt-4o");
    expect(t.systemSha).not.toBeNull();
  });

  it("provider 没给 temperature → 留空，**不算错误**（温度盲区是 provider 侧事实）", () => {
    const body = buildOpenAICompletionsBody();
    expect("temperature" in body).toBe(false);
    const t = extractProviderTrace(body);
    expect(t.sampling?.temperature).toBeUndefined();
    // 其余字段照常取到——采样参数缺失不影响其他观测
    expect(t.model).toBe("gpt-4o");
    expect(t.systemSha).not.toBeNull();
    expect(t.systemLen).toBe("SYSTEM".length);
  });

  it("temperature = 0 是有效值（不被当成缺失）", () => {
    const s = extractSampling({ temperature: 0 });
    expect(s).toEqual({ temperature: 0 });
  });

  it("两种 provider 的 body 走同一个抽取器（不按 provider 名分支）", () => {
    // provider A（不给温度）
    const a = extractProviderTrace(buildOpenAICompletionsBody({ model: "glm-5.3" }));
    // provider B（给温度）
    const b = extractProviderTrace(
      buildOpenAICompletionsBody({ model: "gpt-4o", temperature: 0.2 })
    );
    expect(a.sampling?.temperature).toBeUndefined();
    expect(b.sampling?.temperature).toBe(0.2);
    // 两者的 systemSha 都取得到（形状相同）
    expect(a.systemSha).toBe(b.systemSha);
  });

  it("anthropic 形状（顶层 system）也能取到采样参数", () => {
    const body = {
      model: "claude-sonnet-4",
      system: "SYSTEM",
      temperature: 0.4,
      max_tokens: 8192,
      messages: [{ role: "user", content: "hi" }],
    };
    const t = extractProviderTrace(body);
    expect(t.shape).toBe("top-level-system");
    expect(t.sampling?.temperature).toBe(0.4);
    expect(t.sampling?.max_tokens).toBe(8192);
  });
});
