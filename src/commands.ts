// src/commands.ts — pt 命令纯函数内核（v10.x：command + tool 双注册架构）
//
// 设计动机（.pt/docs/designs/pt-command-tool-dual-registration.md）：
//   - 人类（command） + LLM（tool）共享同一组纯函数内核，零逻辑重复
//   - command 壳：ctx.ui.notify 呈现（src/index.ts）
//   - tool 壳：return { content: [{ text }] } 呈现（src/index.ts）
//   - 纪律：内核不依赖 ExtensionAPI / ExtensionCommandContext，只读 session + 调内部模块

import { join } from "node:path";
import { MANUAL_DIR, MOD_MANUAL } from "./constants.js";
import { bindFlowTemplate, findFlowInBlueprint } from "./render/context-message.js";
import { session } from "./session.js";
import type { Profile } from "./schema.js";

/** 按 Profile 范围过滤 domains（listManuals 需作用域）。
 *  从 src/index.ts 迁移到此处——纯函数，command + tool 双壳共享。 */
export function filterDomainsByProfile<T extends { name: string }>(domains: T[], profile: Profile | null): T[] {
  if (!profile) return domains;
  return domains.filter((d) => {
    if (profile.domains.includes(d.name)) return true;
    return profile.injectionPoints.some((ip) => ip.domains.includes(d.name));
  });
}

/** /pt status 内核：返回状态摘要文本（单行 | 分隔）。 */
export function statusText(): string {
  const flowCount = session.cachedBundles?.reduce((acc, b) => {
    let n = 0;
    for (const d of b.domains) if (d.type === "workflow") {
      const tpls = Array.isArray(d.modules[MOD_MANUAL]) ? d.modules[MOD_MANUAL] : [];
      n += tpls.length;
    }
    return acc + n;
  }, 0) ?? 0;
  const domainCount = session.cachedBundles?.reduce((acc, b) => acc + b.domains.length, 0) ?? 0;
  const blueprintCount = session.cachedBundles?.reduce((acc, b) => acc + b.blueprints.length, 0) ?? 0;
  const profileCount = session.cachedBundles?.reduce((acc, b) => acc + b.profiles.length, 0) ?? 0;
  return [
    `pt profile: ${session.activeProfile ?? "(未激活)"}`,
    `pt loadedFrom: ${session.loadedFrom ?? "(none)"}`,  // v10.x：可观测性（issue pt-context-persist-lost）
    `pt agent: ${session.activeAdapter?.name ?? "(none)"}`,
    `pt domains: ${domainCount}, blueprints: ${blueprintCount}, profiles: ${profileCount}, flows: ${flowCount}`,
    `pt segment length: ${session.cachedSegment?.length ?? 0} chars`,
    `pt cache hit: ${session.lastCacheHit ? "yes" : "no"}`,
    `pt last built prompt: ${session.lastBuiltPrompt ? `${session.lastBuiltPrompt.length} chars` : "(未跑过 turn)"}`,
    `pt cwd: ${session.lastCwd}`,
  ].join(" | ");
}

/** /pt flows 内核：返回可用手册列表文本。无激活 Profile 返回提示串。 */
export function flowsText(): string {
  if (!session.cachedBundles || session.cachedBundles.length === 0 || !session.activeAdapter) {
    return "无激活 Profile，先用 /pt-context <name> 激活";
  }
  const flows = session.activeAdapter.listManuals?.(
    session.cachedContext!,
    session.cachedBlueprint!,
    filterDomainsByProfile(session.cachedBundles[0].domains, session.cachedProfile),
  ) ?? [];
  if (flows.length === 0) {
    return "当前 Profile 无可触发手册（context_message 注入点无 workflow-type Domain）";
  }
  const lines = flows.map((f) => `  ${f.name} ${f.hint ?? ""}  ← ${f.domain}`);
  return `可用手册（输入 /手册名 参数 或 /manual:<domain-name> 触发 Context Message）:\n${lines.join("\n")}`;
}

/** /pt manual 内核：构建手册实例文档内容 + 目标文件路径。不写文件（写文件由壳负责）。 */
export interface ManualDocResult {
  content: string;
  filePath: string;
  error?: string;
}

export function buildManualDoc(cwd: string, procedure: string, args: string): ManualDocResult {
  if (!procedure) {
    return { content: "", filePath: "", error: "用法: /pt manual <procedure-name> [args...]" };
  }
  if (!session.cachedBundles || session.cachedBundles.length === 0 || !session.cachedBlueprint) {
    return { content: "", filePath: "", error: "无激活 Profile，先用 /pt-context <name> 激活" };
  }
  const tpl = findFlowInBlueprint(
    session.cachedBlueprint,
    session.cachedBundles[0].domains,
    procedure,
  );
  if (!tpl) {
    return { content: "", filePath: "", error: `未找到手册: ${procedure}（用 /pt flows 查可用手册）` };
  }
  const bound = bindFlowTemplate(tpl, args);
  const domainName = session.cachedBundles[0].domains.find((d) => {
    if (d.type !== "workflow") return false;
    const manual = d.modules[MOD_MANUAL];
    return Array.isArray(manual) && manual.some((t: unknown) => (t as { name?: string }).name === procedure);
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
  for (const line of boundLines) {
    if (line.startsWith("#")) continue;
    if (line.startsWith("_")) continue;
    const stepMatch = line.match(/^(\d+)\.\s+(.*)$/);
    if (stepMatch) {
      lines.push(`- [ ] ${stepMatch[2]}`);
    } else {
      lines.push(line);
    }
  }
  lines.push("");
  lines.push("## 产物");
  lines.push("<!-- 执行后用 edit 在此追加：路径 + 动作(created/modified) + 日期 -->");
  lines.push("");
  lines.push("## 更新指引");
  lines.push("执行完每个 step 后：用 edit 把对应 `- [ ]` 改成 `- [x]`。");
  lines.push("全部完成后：用 edit 在 ## 产物 下追加创建/修改的文件路径（每行一条）。");
  lines.push("status 全部完成后可改为 completed。");
  const content = lines.join("\n");
  const filePath = join(cwd, MANUAL_DIR, `${procedure}-${ts}.md`);
  return { content, filePath };
}
