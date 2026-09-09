// src/commands.ts — pt 命令纯函数内核（v10.x：command + tool 双注册架构）
//
// 设计动机（.pt/docs/designs/pt-command-tool-dual-registration.md）：
//   - 人类（command） + LLM（tool）共享同一组纯函数内核，零逻辑重复
//   - command 壳：ctx.ui.notify 呈现（src/index.ts）
//   - tool 壳：return { content: [{ text }] } 呈现（src/index.ts）
//   - 纪律：内核不依赖 ExtensionAPI / ExtensionCommandContext，只读 session + 调内部模块
//
// v12.x（issue pt-session-singleton-pi-web-pollution 修复）：
//   - 内核函数签名加 `session: SessionState` 参数，调用方传 per-session state
//   - 不再 import module-level `session` 单例（已删除）

import { join } from "node:path";
import { MANUAL_DIR, MOD_FLOWS } from "./constants.js";
import { bindFlowTemplate, findFlowInBlueprint } from "./render/turn-inject.js";
import type { SessionState } from "./session.js";
import { filterDomainsByProfile } from "./schema.js";
import { isFlowTemplateLike } from "./compile/type-guards.js";

/** /pt status 内核：返回状态摘要文本（单行 | 分隔）。 */
export function statusText(session: SessionState): string {
  const flowCount =
    session.cachedBundles?.reduce((acc, b) => {
      let n = 0;
      // Phase term-P9.2：FlowTemplate 在 ## Flows 段（不再是 ## Manual）。仍只看 workflow 类型 Domain。
      for (const d of b.domains) {
        const flows = d.modules[MOD_FLOWS];
        if (Array.isArray(flows)) n += flows.length;
      }
      return acc + n;
    }, 0) ?? 0;
  const domainCount = session.cachedBundles?.reduce((acc, b) => acc + b.domains.length, 0) ?? 0;
  const blueprintCount =
    session.cachedBundles?.reduce((acc, b) => acc + b.blueprints.length, 0) ?? 0;
  const profileCount = session.cachedBundles?.reduce((acc, b) => acc + b.profiles.length, 0) ?? 0;
  return [
    `pt profile: ${session.activeProfile ?? "(未激活)"}`,
    `pt loadedFrom: ${session.loadedFrom ?? "(none)"}`, // v10.x：可观测性（issue pt-context-persist-lost）
    `pt agent: ${session.activeAdapter?.name ?? "(none)"}`,
    `pt domains: ${domainCount}, blueprints: ${blueprintCount}, profiles: ${profileCount}, flows: ${flowCount}`,
    `pt segment length: ${session.cachedSegment?.length ?? 0} chars`,
    `pt cache hit: ${session.lastCacheHit ? "yes" : "no"}`,
    `pt last built prompt: ${session.lastBuiltPrompt ? `${session.lastBuiltPrompt.length} chars` : "(未跑过 turn)"}`,
    `pt cwd: ${session.lastCwd}`,
  ].join(" | ");
}

/** /pt flows 内核：返回可用手册列表文本。无激活 Profile 返回提示串。
 *
 * v13.x（issue pt-turn-inject-not-profile-scoped）：不再预过滤——传全集 domains 给 listManuals，
 * adapter 内部用 setAgentContext 时存下的 profile 自行 filterDomainsByProfile 过滤。 */
export function flowsText(session: SessionState): string {
  if (!session.cachedBundles || session.cachedBundles.length === 0 || !session.activeAdapter) {
    return "无激活 Profile，先用 /pt-profile <name> 激活";
  }
  if (!session.cachedAgentContext || !session.cachedBlueprint) {
    return "无激活 Profile，先用 /pt-profile <name> 激活";
  }
  const flows =
    session.activeAdapter.listManuals?.(
      session.cachedAgentContext,
      session.cachedBlueprint,
      session.cachedBundles[0].domains
    ) ?? [];
  if (flows.length === 0) {
    return "当前 Profile 无可触发手册（turn 聚合组无含 Flows 段的 Domain）";
  }
  const lines = flows.map((f) => `  ${f.name} ${f.hint ?? ""}  ← ${f.domain}`);
  return `可用手册（输入 /手册名 参数 或 /manual:<domain-name> 触发 Turn Inject）:\n${lines.join("\n")}`;
}

/** /pt full 内核：构建写入 .pt/cache/fulls/ 的完整 systemPrompt 字符串（v10.x 修复 pt-full-duplicate-segment）。
 *
 * 设计动机：消除 `/pt full` 与 PiAdapter `before_agent_start` 的双重拼接路径——
 *   - PiAdapter 每轮把 segment 拼到 base，写回 `agent.state.systemPrompt`（= `ctx.getSystemPrompt()`）
 *   - 第一轮 prompt 之后，`ctx.getSystemPrompt()` 已含 segment；旧版 `/pt full` 再拼一次 → 2× 重复
 *   - 根因：两份拼接实现通过隐式时序耦合，缺乏单一信息源
 *
 * 修复：把 `lastBuiltPrompt`（由 PiAdapter 的 `onInjected` 回调写入，正是 LLM 实际看到的 systemPrompt）
 *   作为 canonical source。第一轮之前的 fallback：模拟下一次 LLM 会看到的注入（保留旧版语义）。
 *
 * 边界纪律：
 *   - 不动 PiAdapter（PiAdapter 行为正确，不重复注入）
 *   - 不动 Pi 上游 API（`getSystemPrompt` 语义不变）
 *   - 只动这一个函数体，外加调用方 `src/index.ts`
 */
export function buildFullPrompt(
  baseSystemPrompt: string,
  cachedSegment: string | null,
  lastBuiltPrompt: string | null
): string {
  if (lastBuiltPrompt !== null) {
    // 第一轮 prompt 之后：canonical source（= LLM 实际收到的 systemPrompt）
    return lastBuiltPrompt;
  }
  if (cachedSegment) {
    // 第一轮之前：模拟下一次 LLM 会看到的注入
    return `${baseSystemPrompt}\n\n## 当前任务上下文\n\n${cachedSegment}`;
  }
  // 无 cachedSegment（未加载 Profile）
  return baseSystemPrompt;
}

/** /pt manual 内核：构建手册实例文档内容 + 目标文件路径。不写文件（写文件由壳负责）。 */
export interface ManualDocResult {
  content: string;
  filePath: string;
  error?: string;
}

export function buildManualDoc(
  cwd: string,
  session: SessionState,
  procedure: string,
  args: string
): ManualDocResult {
  if (!procedure) {
    return { content: "", filePath: "", error: "用法: /pt manual <procedure-name> [args...]" };
  }
  if (!session.cachedBundles || session.cachedBundles.length === 0 || !session.cachedBlueprint) {
    return { content: "", filePath: "", error: "无激活 Profile，先用 /pt-profile <name> 激活" };
  }
  // v13.x（issue pt-turn-inject-not-profile-scoped）：按 Profile scope 过滤 + 传 profile
  //   让 /pt manual 在未引用该 domain 的 Profile 下找不到手册（与 /pt flows 一致）
  const scoped = filterDomainsByProfile(session.cachedBundles[0].domains, session.cachedProfile);
  const tpl = findFlowInBlueprint(
    session.cachedBlueprint,
    scoped,
    procedure,
    session.cachedProfile
  );
  if (!tpl) {
    return {
      content: "",
      filePath: "",
      error: `未找到手册: ${procedure}（用 /pt flows 查可用手册）`,
    };
  }
  const bound = bindFlowTemplate(tpl, args);
  const domainName =
    session.cachedBundles[0].domains.find((d) => {
      // Phase term-P9.2：FlowTemplate 存 ## Flows 段（不是 ## Manual）。
      const flows = d.modules[MOD_FLOWS];
      return (
        Array.isArray(flows) &&
        flows.some((t: unknown) => isFlowTemplateLike(t) && t.name === procedure)
      );
    })?.name ?? "";
  const now = new Date().toISOString();
  const ts = Date.now();
  const lines: string[] = [];
  lines.push("---");
  lines.push(`procedure: ${procedure}`);
  lines.push(`domain: ${domainName}`);
  lines.push(`created: ${now}`);
  lines.push("status: in-progress");
  lines.push(`args: ${args || "(无)"}`);
  lines.push("---");
  lines.push("");
  lines.push(`# ${procedure} 实例`);
  lines.push("");
  const boundLines = bound.split("\n");
  let stepCount = 0;
  for (const line of boundLines) {
    if (line.startsWith("#")) continue;
    if (line.startsWith("_")) continue;
    const stepMatch = line.match(/^(\d+)\.\s+(.*)$/);
    if (stepMatch) {
      stepCount++;
      lines.push(`- [ ] ${stepMatch[2]}`);
      continue;
    }
    // observe 行（bindFlowTemplate 渲染的 "   - 验证参照：xxx"）→ checklist 子项
    if (line.includes("验证参照：")) {
      lines.push(`  ${line.trim()}`);
      continue;
    }
    lines.push(line);
  }
  lines.push("");
  lines.push("## 执行状态");
  lines.push("| Step | Outcome | Message |");
  lines.push("|---|---|---|");
  for (let i = 1; i <= stepCount; i++) {
    lines.push(`| ${i} | — | |`);
  }
  lines.push("");
  lines.push("## 产物");
  lines.push("<!-- 执行后用 edit 在此追加：路径 + 动作(created/modified) + 日期 -->");
  lines.push("");
  lines.push("## 更新指引");
  lines.push("执行完每个 step 后：用 edit 把对应 `- [ ]` 改成 `- [x]`。");
  lines.push(
    "验证后：用 edit 把 ## 执行状态表 对应行的 `—` 改为 COMPLETED / DEVIATED / INCONCLUSIVE + Message。"
  );
  lines.push("全部完成后：用 edit 在 ## 产物 下追加创建/修改的文件路径（每行一条）。");
  lines.push("status 全部完成后可改为 completed。");
  const content = lines.join("\n");
  const filePath = join(cwd, MANUAL_DIR, `${procedure}-${ts}.md`);
  return { content, filePath };
}
