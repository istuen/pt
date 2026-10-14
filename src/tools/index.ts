// src/tools/index.ts
// tool 壳 barrel：注册 3 个 Pt tool（pt_info / pt_doc / pt_inject）。
// 从 index.ts 抽出（Step 7），逻辑零变更。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPtInfoTool } from "./pt-info.js";
import { registerPtDocTool } from "./pt-doc.js";
import { registerPtInjectTool } from "./pt-inject.js";

/**
 * 注册全部 Pt tool（pt_info / pt_doc / pt_inject）。从 index.ts 抽出，逻辑零变更。
 *
 * ========== tool 壳：LLM 可调（与 command 共享纯函数内核，.pt/docs/designs/pt-command-tool-dual-registration.md） ==========
 * 只读查询 + 手册实例化做 tool；pt-profile（改 system prompt）不做 tool（见设计文档 §2.4）
 * v19（issue pt-llm-tool-consolidation）：8 tool 收敛到 3 根基 + 二级命令
 */
export function registerAllTools(pi: ExtensionAPI): void {
  registerPtInfoTool(pi);
  registerPtDocTool(pi);
  registerPtInjectTool(pi);
}
