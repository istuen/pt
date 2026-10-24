// scripts/probe/witness-probe.ts — 链路验证的**独立证人**（witness）
//
// 为什么需要它：Layer 3 的 `provider:trace` 是 **Pt 自己**写的观测——它能说
//   "我看到的请求体里有 Pt 注入段"。但**自己验自己**是循环论证：
//   如果 Pt 的抽取逻辑本身有 bug，它会一致地错，看起来一切正常。
//
// 证人做的是**最小独立实现**（不 import Pt 任何代码）：
//   ① 直接 hook `before_provider_request`——拿 payload
//   ② 定位系统消息（system / developer / 顶层 system）
//   ③ 算 sha256 + 长度
//   ④ **原样落盘**完整系统提示（供人工核对 + 事后 diff）
//   ⑤ 把摘要写进 NDJSON 索引（供脚本比对）
//
// 与 Pt 的关键差异（正是交叉验证的价值）：
//   - 不 import Pt 的 provider-trace.ts（不共享抽取逻辑）
//   - 系统消息定位写成最朴素的 form（先找 messages 里的 system/developer，
//     再退到顶层 system）——不处理任何 Pi 特有的边界情况
//   - 落盘**原文**（Pt 绝不落盘原文）——这是"证据"，不是"观测"
//
// 纪律：
//   - 不注册 tool / flag / command / promptSnippet
//   - 绝不修改 payload（handler 返回 undefined）
//   - 产出进 .pt/verify/（gitignore，不入仓）
//
// 用法（由 verify-delivery-chain.sh 装载）：
//   pi 会加载本目录的 extension → 写 .pt/verify/witness/<sessionId>/*.md + index.ndjson

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

/** 证人产出根目录（相对 cwd）。 */
const OUT_DIR = ".pt/verify/witness";

/** 独立实现的系统消息定位——**故意写得朴素**，不处理 Pi 特有边界。
 *  目的：与 Pt 的实现形成对照——两边独立算出同一个 sha 才可信。 */
function locateSystemText(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;

  // ① messages 里 role ∈ {system, developer} 的第一条
  const messages = p.messages;
  if (Array.isArray(messages)) {
    for (const m of messages) {
      if (!m || typeof m !== "object") continue;
      const msg = m as { role?: unknown; content?: unknown };
      if (msg.role !== "system" && msg.role !== "developer") continue;
      const text = flatten(msg.content);
      if (text.length > 0) return text;
    }
  }
  // ② 顶层 system
  if (typeof p.system === "string" && p.system.length > 0) return p.system;
  if (Array.isArray(p.system)) {
    const text = flatten(p.system);
    if (text.length > 0) return text;
  }
  return null;
}

/** content → 纯文本（string 或 [{type:"text",text}]）。 */
function flatten(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const b of content) {
    if (typeof b === "string") {
      parts.push(b);
    } else if (b && typeof b === "object") {
      const text = (b as { text?: unknown }).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.join("");
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export default function (pi: ExtensionAPI): void {
  let callNo = 0;

  pi.on("before_provider_request" as never, (async (event: unknown, ctx: unknown) => {
    callNo += 1;
    try {
      const ctxObj = ctx as {
        cwd?: string;
        sessionManager?: { getSessionId?: () => string };
      };
      const sessionId = ctxObj?.sessionManager?.getSessionId?.() ?? "unknown";
      const cwd = ctxObj?.cwd ?? process.cwd();
      const payload = (event as { payload?: unknown })?.payload;
      const systemText = locateSystemText(payload);

      const dir = join(cwd, OUT_DIR, sessionId);
      mkdirSync(dir, { recursive: true });

      // 证据落盘：完整系统提示原文（供人工核对 / 事后 diff）
      if (systemText !== null) {
        writeFileSync(join(dir, `call-${callNo}-system.md`), systemText, "utf8");
      }

      // 摘要索引：供 verify-delivery-chain.sh 比对
      const record = {
        sessionId,
        call: callNo,
        ts: new Date().toISOString(),
        model:
          typeof (payload as { model?: unknown })?.model === "string"
            ? (payload as { model: string }).model
            : null,
        hasSystem: systemText !== null,
        systemSha: systemText === null ? null : sha256(systemText),
        systemLen: systemText === null ? 0 : systemText.length,
        payloadKeys:
          payload && typeof payload === "object" ? Object.keys(payload as object).sort() : [],
      };
      appendFileSync(
        join(cwd, OUT_DIR, "index.ndjson"),
        `${JSON.stringify(record)}\n`,
        "utf8"
      );
    } catch (e) {
      // 证人失败不影响被测链路（但要留痕）
      try {
        const cwd = (ctx as { cwd?: string })?.cwd ?? process.cwd();
        mkdirSync(join(cwd, OUT_DIR), { recursive: true });
        appendFileSync(
          join(cwd, OUT_DIR, "witness-errors.log"),
          `${new Date().toISOString()} ${e instanceof Error ? e.message : String(e)}\n`,
          "utf8"
        );
      } catch {
        /* ignore */
      }
    }
    // ⚠️ 返回 undefined——绝不替换 payload
    return undefined;
  }) as unknown as (...args: unknown[]) => unknown);
}
