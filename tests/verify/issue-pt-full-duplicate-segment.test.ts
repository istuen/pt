// tests/verify/issue-pt-full-duplicate-segment.test.ts — issue pt-full-duplicate-segment 修复验证
//
// v10.x（fix pt-full-duplicate-segment）：
//   `/pt full` 在第一轮 prompt 之后会写 2 份 segment（实测：19085 → 36222 bytes）。
//   根因：旧版手动拼接与 PiAdapter `before_agent_start` 双重注入逻辑经 `agent.state.systemPrompt` 隐式耦合。
//   修复：`buildFullPrompt(base, cachedSegment, lastBuiltPrompt)` 把 `lastBuiltPrompt` 作为单一信息源。
//
// 测试策略（v10.x）：纯函数单元测试，覆盖三种状态：
//   1. 第一轮之前 + 有 cachedSegment → 模拟注入（base + header + segment）
//   2. 第一轮之前 + 无 cachedSegment → 只 base
//   3. 第一轮之后（lastBuiltPrompt 非 null）→ 用 canonical source（关键：永远 1× segment）

import { describe, it, expect } from "vitest";
import { buildFullPrompt } from "../../src/commands.js";

describe("issue pt-full-duplicate-segment 修复（v10.x）", () => {
  // 模拟实测样本的 base + segment + 注入后完整 prompt
  const BASE = "[Pi 通用 system prompt，~5410 bytes]\n";
  const SEGMENT = "### ysl-company\n- 东莞亿盛隆...\n### fastener-industry\n- 紧固件...\n";
  const HEADER = "## 当前任务上下文";
  const INJECTED = BASE + "\n\n" + HEADER + "\n\n" + SEGMENT; // 第一轮 LLM 实际看到的 = 1× segment

  describe("1. 第一轮之前（lastBuiltPrompt === null）", () => {
    it("有 cachedSegment → 模拟注入 = base + header + segment（1×）", () => {
      const full = buildFullPrompt(BASE, SEGMENT, null);
      // 关键断言：只出现 1 次 header
      expect(full.split(HEADER).length - 1).toBe(1);
      // 内容结构正确
      expect(full).toBe(BASE + "\n\n" + HEADER + "\n\n" + SEGMENT);
    });

    it("无 cachedSegment → 只返回 base（保留旧版 warning 触发条件）", () => {
      const full = buildFullPrompt(BASE, null, null);
      expect(full).toBe(BASE);
      expect(full).not.toContain(HEADER);
    });

    it("空字符串 cachedSegment → 走 fallback 分支", () => {
      // 边界：cachedSegment === ""（空字符串 falsy，但 != null）
      // 旧版 `session.cachedSegment ? ...` 把 "" 当作无 segment 处理
      // buildFullPrompt 同样用 `if (cachedSegment)` 保持兼容
      const full = buildFullPrompt(BASE, "", null);
      expect(full).toBe(BASE);
    });
  });

  describe("2. 第一轮之后（lastBuiltPrompt !== null）— 关键修复", () => {
    it("返回 lastBuiltPrompt 不再追加（= LLM 实际看到的）", () => {
      // lastBuiltPrompt 已经被 PiAdapter 的 onInjected 写入，恰好是 base + 1× segment
      const full = buildFullPrompt(BASE, SEGMENT, INJECTED);
      // 关键断言：只出现 1 次 header（核心修复点）
      expect(full.split(HEADER).length - 1).toBe(1);
      // 完全等于 lastBuiltPrompt，不追加任何东西
      expect(full).toBe(INJECTED);
    });

    it("即使 cachedSegment 与 lastBuiltPrompt 不同，也优先用 lastBuiltPrompt（canonical）", () => {
      // 模拟：profile 切换后还没跑新 turn，cachedSegment 是新 segment，
      // 但 lastBuiltPrompt 还是旧 turn 注入的（旧 segment）。这是设计预期——
      // lastBuiltPrompt 代表"上次 LLM 实际看到的"，是 canonical source。
      const OLD_SEGMENT = "### old-profile\n- 旧内容\n";
      const NEW_SEGMENT = "### new-profile\n- 新内容\n";
      const LAST_BUILT = BASE + "\n\n" + HEADER + "\n\n" + OLD_SEGMENT;
      const full = buildFullPrompt(BASE, NEW_SEGMENT, LAST_BUILT);
      // 必须用 lastBuiltPrompt，不用 cachedSegment
      expect(full).toBe(LAST_BUILT);
      expect(full).not.toContain(NEW_SEGMENT); // 新 segment 不该出现
      expect(full).toContain(OLD_SEGMENT);
    });

    it("核心修复：不再产生 2× segment（issue 实测 36222 bytes）", () => {
      // 模拟 issue 实测的 36222 bytes 文件路径：
      //   旧版：`ctx.getSystemPrompt()`(= INJECTED) + "\n\n## 当前任务上下文\n\n" + cachedSegment
      //        = INJECTED + "\n\n## 当前任务上下文\n\n" + SEGMENT
      //        = header 出现 2 次
      //   新版：`buildFullPrompt(BASE, SEGMENT, INJECTED)` = INJECTED
      //        = header 出现 1 次
      const oldBehavior = INJECTED + "\n\n" + HEADER + "\n\n" + SEGMENT;
      expect(oldBehavior.split(HEADER).length - 1).toBe(2); // 旧版确实 2×

      const newBehavior = buildFullPrompt(BASE, SEGMENT, INJECTED);
      expect(newBehavior.split(HEADER).length - 1).toBe(1); // 新版只 1×
    });
  });

  describe("3. 一致性契约", () => {
    it("无 cachedSegment + 有 lastBuiltPrompt → 只用 lastBuiltPrompt", () => {
      // 边界：profile 清空但 lastBuiltPrompt 还在
      const full = buildFullPrompt(BASE, null, INJECTED);
      expect(full).toBe(INJECTED);
    });

    it("三种参数组合产出互不相同（除非语义相同）", () => {
      const a = buildFullPrompt(BASE, null, null);
      const b = buildFullPrompt(BASE, SEGMENT, null);
      const c = buildFullPrompt(BASE, SEGMENT, INJECTED);
      const d = buildFullPrompt(BASE, null, INJECTED);
      expect(a).toBe(BASE);
      expect(b).toBe(INJECTED); // base + header + segment（1×）
      expect(c).toBe(INJECTED); // lastBuiltPrompt
      expect(d).toBe(INJECTED); // lastBuiltPrompt（无 segment 也用）
      // a ≠ b ≠ c（语义不同）
      expect(a).not.toBe(b);
      expect(b).toBe(c); // 同语义（都是 1× segment 完整 prompt）
    });
  });
});
