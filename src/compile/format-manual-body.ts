// src/compile/format-manual-body.ts — Manual 段格式公共函数（P3.6 抽出）
//
// renderManualModule（compile 上下文）与 renderDomainManual（context-message 上下文）
// 对 term/workflow case 的列表渲染逻辑完全一致——抽到此处消重复。
//
// 注意：P3.6 范围仅"集中 switch 消重"，不引入注册表。v10 spec 系统才是
// 真正消除 switch(d.type) 的方向（见 v10-spec-system-design.md §4.2）。

import type { Domain } from "../schema.js";
import { isFlowTemplateArray, isRuleArray } from "./type-guards.js";

/** 把 Manual 段内容格式化为 `- name: ...` 列表。
 *  - term → Rule 列表（ban/invariant）
 *  - workflow → FlowTemplate 列表（name + hint + intent）
 *  - 其他 type → 返 ""（调用方各自处理）
 *
 *  返回值不含标题或前后缀——调用方各自加。 */
export function formatManualBody(d: Domain, content: unknown): string {
  const lines: string[] = [];

  if (d.type === "workflow") {
    if (!isFlowTemplateArray(content)) return "";
    for (const t of content) {
      const hint = t.argumentHint ? ` ${t.argumentHint}` : "";
      lines.push(`- ${t.name}${hint}: ${t.intent}`);
    }
  } else if (d.type === "term") {
    if (!isRuleArray(content)) return "";
    for (const r of content) {
      if (r.type === "invariant") {
        if (r.check) lines.push(`- ${r.name}: ${r.check}`);
        else lines.push(`- ${r.name}`);
      } else if (r.type === "ban" && r.items && r.items.length > 0) {
        if (r.check) lines.push(`- ${r.name}: ${r.check} (${r.items.join(" / ")})`);
        else lines.push(`- ${r.name}: ${r.items.join(" / ")}`);
      }
    }
  }
  // 其他 type（stack 等）：返空。调用方决定是否返 null / 走 generic fallback。

  return lines.join("\n");
}
