// scripts/probe/tamper-probe/tamper-probe.ts — **故障注入**探针：故意改坏 Pt 注入，验证校验能不能报出来
//
// 用途：issue pt-delivery-chain-verification 的验收标准之一——
//   「故意改坏注入 → 校验能报出不一致」。
//
// ⚠️ **本探针模拟的是"Pt 观测点之后"被改写**（Pi 的 handler 顺序效应）——
//   它的重要价值不是"测试 Pt 能否发现"（Pt **发现不了**，见 issue §三），
//   而是**证明 provider 真的收到了改坏的内容**（模型自证），
//   从而坐实「Pt 的 `injection: matched` 是弱保证」这个结论。
//
// 机制：在 `before_provider_request` 里**篡改** payload 里的系统消息
//   （把 Pt 注入段的一处文字改掉），让 provider 实际收到的 ≠ Pt 注入的。
//   这模拟真实故障场景：Pi 改写 prompt / provider 截断 / 中间层动过内容。
//
// 纪律：
//   - **只在显式开关下生效**（env PT_TAMPER=1）——默认完全不干预
//   - 篡改内容是 Pt 的公开标记，不引入任何敏感数据
//   - 篡改后返回新 payload（Pi runner 层面生效——这正是要测的）
//
// 用法：
//   PT_TAMPER=1 pi -p --pt-profile <profile> "<prompt>"
//   然后问模型："你的系统提示里有没有 TAMPERED-BY-PROBE？"

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** Pt 注入段标记（与 pt/agent/pi-adapter.ts 一致）。 */
const PT_MARKER = "## 当前任务上下文";

/** 篡改标记（会替换注入段里的第一个字符序列）。 */
const TAMPER_TOKEN = "调 pt_inject tool";

/** 篡改后的替换文本（唯一可识别串——用于确认篡改真的到了 provider）。 */
const TAMPER_REPLACEMENT = "[TAMPERED-BY-PROBE]";

/** 把系统消息里的 Pt 注入段改掉——模拟"中间层动过内容"。 */
function tamperSystemText(text: string): string {
  const idx = text.indexOf(PT_MARKER);
  if (idx < 0) return text;
  const tamperIdx = text.indexOf(TAMPER_TOKEN, idx);
  if (tamperIdx < 0) return text;
  return (
    text.slice(0, tamperIdx) + TAMPER_REPLACEMENT + text.slice(tamperIdx + TAMPER_TOKEN.length)
  );
}

export default function (pi: ExtensionAPI): void {
  // 默认不干预——只有显式开开关才篡改
  if (process.env.PT_TAMPER !== "1") return;

  const log = (cwd: string, msg: string): void => {
    try {
      mkdirSync(join(cwd, ".pt/verify"), { recursive: true });
      appendFileSync(
        join(cwd, ".pt/verify", "tamper.log"),
        `${new Date().toISOString()} ${msg}\n`,
        "utf8"
      );
    } catch {
      /* ignore */
    }
  };

  pi.on("before_provider_request" as never, (async (event: unknown, ctx: unknown) => {
    const cwd = (ctx as { cwd?: string })?.cwd ?? process.cwd();
    try {
      const payload = (event as { payload?: unknown })?.payload;
      if (!payload || typeof payload !== "object") return undefined;
      const p = payload as Record<string, unknown>;
      const messages = p.messages;
      if (!Array.isArray(messages)) return undefined;

      // 找到系统消息并篡改
      for (const m of messages) {
        if (!m || typeof m !== "object") continue;
        const msg = m as { role?: unknown; content?: unknown };
        if (msg.role !== "system" && msg.role !== "developer") continue;
        // content 可能是 string，也可能是 content blocks 数组——两种都要处理
        if (typeof msg.content === "string") {
          const tampered = tamperSystemText(msg.content);
          if (tampered === msg.content) continue;
          msg.content = tampered;
          log(cwd, "TAMPERED applied (string content)");
          return { ...p, messages };
        }
        if (Array.isArray(msg.content)) {
          let changed = false;
          for (const block of msg.content) {
            if (!block || typeof block !== "object") continue;
            const b = block as { type?: unknown; text?: unknown };
            if (typeof b.text !== "string") continue;
            const tampered = tamperSystemText(b.text);
            if (tampered === b.text) continue;
            b.text = tampered;
            changed = true;
          }
          if (!changed) continue;
          log(cwd, "TAMPERED applied (content blocks)");
          return { ...p, messages };
        }
      }
    } catch (e) {
      log(cwd, `error: ${e instanceof Error ? e.message : String(e)}`);
    }
    return undefined;
  }) as unknown as (...args: unknown[]) => unknown);
}
