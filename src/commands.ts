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
//
// v14.x（issue pt-asset-migration-visibility Layer 3）：
//   - 加 checkText() 内核 + CheckOptions：/pt check + pt_check tool 共享
//   - 同步格式化 6 列 biome/tsc 风格 + hint/fix 展示

import { homedir } from "node:os";
import { join } from "node:path";
import { MANUAL_DIR, MOD_FLOWS } from "./constants.js";
import { bindFlowTemplate, findFlowInBlueprint } from "./render/turn-inject.js";
import type { AssetHealthIssue } from "./asset-health.js";
import type { SessionState } from "./session.js";
import {
  scanDocs,
  filterByProfile,
  filterByStatus,
  countParseErrors,
  type DocRecord,
  type DocKind,
} from "./doc-index.js";
import { validateDoc, type DocValidationResult } from "./verify/doc-structure-match.js";
import { filterDomainsByProfile } from "./schema.js";
import { isFlowTemplateLike } from "./compile/type-guards.js";

/**
 * Issue L1 命令层选项（Phase 3，§Issue pt-doc-index-and-schema L1）。
 *  - profile / status：null 表示不过滤（caller 决定要不要降级）
 *  - kind：仅 checkDocsText 使用，限定检查的文档类型 */
export interface ListDocsOptions {
  profile?: string | null;
  status?: string | null;
  kind?: DocKind;
}

/** Phase 3（issue pt-doc-index-and-schema L1）：/pt issues / manuals / designs 列表选项。
 *  - profile / status 字段同时出现在 ListDocsOptions（设计文档共用）——为双注册提供统一形参 */
export interface IssuesTextOptions extends ListDocsOptions {}

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
  // v14.x（issue pt-asset-migration-visibility Layer 2）：暴露 session_start 健康扫描结果
  const healthIssues = session.assetHealthIssues;
  // v16：healthLine 加 info 计数（info=0 时省略，与 warning 处理一致——不刷屏）
  const healthLine =
    healthIssues === null
      ? "pt health: (not scanned)"
      : healthIssues.length === 0
        ? "pt health: ok"
        : (() => {
            const errors = healthIssues.filter((i) => i.severity === "error").length;
            const warnings = healthIssues.filter((i) => i.severity === "warning").length;
            const infos = healthIssues.filter((i) => i.severity === "info").length;
            const parts = [
              `${errors} errors`,
              `${warnings} warnings`,
              ...(infos > 0 ? [`${infos} infos`] : []),
            ];
            return `pt health: ${healthIssues.length} issue${healthIssues.length > 1 ? "s" : ""} (${parts.join(", ")})`;
          })();
  // v15.x PR1（§6.7.6）：暴露 session_start pack 校验结果——每个 pack ✅ / ⚠ DEGRADED + 原因。
  // pack 健康区别于 healthLine 的 profile 配置体检：pack 健康是"加载层健康"，profile 健康是"资产内容健康"。
  const packValidation = session.packValidation;
  const packLine = formatPackHealthLine(packValidation, session.lastCwd);
  // v14.x（tagline）：statusText 显式展开 tagline（不受 footer 35 字符限制）
  const tagline = session.cachedProfile?.tagline;
  const taglineLine = tagline ? `pt tagline: ${tagline}` : "pt tagline: (none)";
  return [
    `pt profile: ${session.activeProfile ?? "(未激活)"}`,
    `pt loadedFrom: ${session.loadedFrom ?? "(none)"}`, // v10.x：可观测性（issue pt-context-persist-lost）
    `pt agent: ${session.activeAdapter?.name ?? "(none)"}`,
    taglineLine,
    `pt domains: ${domainCount}, blueprints: ${blueprintCount}, profiles: ${profileCount}, flows: ${flowCount}`,
    `pt segment length: ${session.cachedSegment?.length ?? 0} chars`,
    `pt cache hit: ${session.lastCacheHit ? "yes" : "no"}`,
    `pt last built prompt: ${session.lastBuiltPrompt ? `${session.lastBuiltPrompt.length} chars` : "(未跑过 turn)"}`,
    // issue pt-status-no-injection-state：暴露 4 态自报状态
    `pt state: ${session.injectionState}${session.injectionError ? `: ${session.injectionError.slice(0, 40)}` : ""}`,
    healthLine,
    packLine,
    `pt cwd: ${session.lastCwd}`,
  ].join(" | ");
}

/** v15.x PR1（§6.7.6）— /pt status 暴露 pack 健康。
 *  单行格式：`pt packs: N/M ok | [@prj] ✅ | [@pt] ✅`（示例,实际按加载的 pack 动态生成）
 *  降级时附加原因：`[@prj] ⚠ DEGRADED — <errors[0].msg 截断 60 字符>`。
 *  packValidation=null → `pt packs: (not validated)`（尚未 session_start）。
 *  packValidation=[] → `pt packs: (none loaded)`（不应出现——session_start 总构造 3 个 pack）。 */
function formatPackHealthLine(
  packValidation: SessionState["packValidation"],
  lastCwd?: string
): string {
  if (packValidation === null) return "pt packs: (not validated)";
  if (packValidation.length === 0) return "pt packs: (none loaded)";
  // issue pt-pack-repair-cwd-home-edge-case：project pack 失效 + cwd=home 时附加决策引导
  const isCwdHome = lastCwd === homedir();
  const items = packValidation.map((r) => {
    // v15.x §4.4.4（缺口 4）：reserved 显位置别名（reservedAlias），非 reserved 显 pack（manifest.name）
    // 砍 desc——pack 详情走 /pt packs（缺口 5）
    const label = r.reservedAlias ?? r.pack;
    const version = r.version ? ` v${r.version}` : "";
    if (r.ok) {
      return `[@${label}]${version} ✅`;
    }
    const reason = r.errors[0]?.msg ?? "unknown";
    // cwd=home + project 失效时附加 "| 建议切到项目目录"（总长不超 60）
    const guidance = r.source === "project" && isCwdHome ? " | 建议切到项目目录" : "";
    return `[@${label}]${version} ⚠ DEGRADED — ${truncate(reason + guidance, 60)}`;
  });
  const okCount = packValidation.filter((r) => r.ok).length;
  const summary =
    okCount === packValidation.length
      ? `${okCount}/${packValidation.length} ok`
      : `${okCount}/${packValidation.length} degraded`;
  return `pt packs: ${summary} | ${items.join(" | ")}`;
}

/** v15.x PR2（§6.7.6）：description / error msg 截断辅助——单行 status 不被撑爆。 */
function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

/** v15.x §4.4.4（缺口 5）：/pt packs 详情命令——pack 诊断信息落点。
 *  pack.name/version/desc/asset 计数走这里，status 单行不再塞 desc。
 *  asset 计数：从 active bundle 的 workingSet.identity 索引按 pack.name 前缀过滤。 */
export function packsText(session: SessionState): string {
  const pv = session.packValidation;
  if (!pv || pv.length === 0) {
    return "pt packs: (none loaded)";
  }
  const bundle = session.cachedBundles?.[0];
  const ws = bundle?.workingSet;
  const lines: string[] = [`pt packs (${pv.length} loaded):`];
  for (const r of pv) {
    // v15.x §4.4.4（缺口 4）：reserved 显位置别名，settings 显 pack 名
    const label = r.reservedAlias ?? r.pack;
    const status = r.ok ? "✅" : "⚠ DEGRADED";
    lines.push(`  [@${label}] v${r.version} ${status} (${r.source})`);
    // reserved 退化场景：pack.name=位置别名，不显 name 行
    if (r.pack !== label) {
      lines.push(`    name: ${r.pack}`);
    }
    if (r.description) {
      lines.push(`    ${r.description}`);
    }
    // asset 计数（从 workingSet.identity 按 pack.name 前缀统计）
    if (ws) {
      const prefix = `${r.pack}/`;
      const domains = countByPrefix(ws.domains.identity, prefix);
      const blueprints = countByPrefix(ws.blueprints.identity, prefix);
      const profiles = countByPrefix(ws.profiles.identity, prefix);
      lines.push(`    ${domains} domains, ${blueprints} blueprints, ${profiles} profiles`);
    }
  }
  return lines.join("\n");
}

/** 按 key 前缀计数（§4.4.4 packsText 辅助）。 */
function countByPrefix<K, V>(map: Map<K, V>, prefix: K): number {
  if (typeof prefix !== "string") return 0;
  let n = 0;
  for (const k of map.keys()) {
    if (typeof k === "string" && k.startsWith(prefix)) n++;
  }
  return n;
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
  return `可用手册（输入 /手册名 参数 或 /pt_turn_inject <domain-name> 触发 Turn Inject）:\n${lines.join("\n")}`;
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

/** /pt make-manual 内核：构建手册实例文档内容 + 目标文件路径。不写文件（写文件由壳负责）。 */
export interface ManualDocResult {
  content: string;
  filePath: string;
  error?: string;
}

export function buildManualDoc(
  cwd: string,
  session: SessionState,
  procedure: string,
  args: string,
  // P3：manual frontmatter issue 关联字段。可选——纯需求驱动特性（如 feature-lifecycle）的
  // 独立 manual 不传 issue，frontmatter 不写该行（与 v11.x manual 零破坏 back-compat）。
  // issue 是单向引用：manual 自描述"为哪个 issue 服务"，不反向改 issue 文档（联动职责被
  // 否决的 pt_complete 占据，本版本不实现）。
  issue?: string
): ManualDocResult {
  if (!procedure) {
    return { content: "", filePath: "", error: "用法: /pt make-manual <procedure-name> [args...]" };
  }
  if (!session.cachedBundles || session.cachedBundles.length === 0 || !session.cachedBlueprint) {
    return { content: "", filePath: "", error: "无激活 Profile，先用 /pt-profile <name> 激活" };
  }
  // v13.x（issue pt-turn-inject-not-profile-scoped）：按 Profile scope 过滤 + 传 profile
  //   让 /pt make-manual 在未引用该 domain 的 Profile 下找不到手册（与 /pt flows 一致）
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
  // P3：issue 关联字段——manual 实例自描述"为哪个 issue 服务"。仅传值时写行（back-compat）。
  // 空字符串与 undefined 等价（不写行），避免污 frontmatter。
  if (issue?.trim()) {
    lines.push(`issue: ${issue.trim()}`);
  }
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
    // P2：观察 / 产出 / 输入三类子项行（bindFlowTemplate 渲染的 "   - 验证参照：xxx" /
    //   "   - 期望产出：xxx" / "   - 输入参照：xxx"）→ checklist 子项。
    // 顺序：output / dataSource 在 observe 之后渲染（输入→产出→验证），但识别时统一处理，
    //   渲染行 trim 后跟原顺序进 manual 文件——保持与 bindFlowTemplate 输出一致。
    if (line.includes("验证参照：") || line.includes("期望产出：") || line.includes("输入参照：")) {
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

/** /pt check 选项（issue pt-asset-migration-visibility Layer 3）。
 *  - profileName：单 profile 体检（v1 范围；--all 全集是默认）
 *  - fix：v2 范围（v1 不实现；只输出"运行 `/pt check --fix`"提示）
 *  v1：format = "biome"（仅一种风格；预留给未来 tsc/eslint 切换）。 */
export interface CheckOptions {
  profileName?: string;
  fix?: boolean;
  format?: "biome";
}

/** /pt check 输出结果（供 shell 检查输出与是否 issues）。 */
export interface CheckResult {
  /** 格式化后的多行文本（biome 风格）。 */
  output: string;
  /** issue 数（errors + warnings + infos）。 */
  issueCount: number;
  errors: number;
  warnings: number;
  /** v16：info 数（optional-domains slot 空等预期行为）——缺省 0（back-compat）。 */
  infos?: number;
}

/** /pt check 内核：从 session.assetHealthIssues（已扫）格式化输出。
 *  v14.x（issue §Layer 3）：session_start 已扫，/pt check 直接格式化——不重复扫描。
 *  未扫（null）→ 返回提示串 + 0 issue。
 *
 *  输出风格（biome/tsc 同源）：
 *
 *      ysl-developer.profile.md
 *        × [error] ## session-context 缺 ### Modules
 *           hint: 在 H2 段下加 `### Modules: [Scene, ...]`
 *
 *      × 6 errors, 0 warnings
 *        hint: 运行 `/pt check --fix` 自动应用已知 migration
 *
 *  --profile X：只列该 profile 的 issue；其它 profile 的忽略（v1 简化）。
 */
export function checkText(session: SessionState, opts: CheckOptions = {}): CheckResult {
  const allIssues = session.assetHealthIssues;
  if (allIssues === null) {
    return {
      output: "未扫描。重启 session 或运行 scanProjectHealth。",
      issueCount: 0,
      errors: 0,
      warnings: 0,
      infos: 0,
    };
  }
  // 过滤
  let issues: AssetHealthIssue[];
  if (opts.profileName) {
    issues = allIssues.filter((i) => i.name === opts.profileName);
  } else {
    issues = allIssues;
  }
  if (issues.length === 0) {
    const okMsg = opts.profileName
      ? `✓ Profile「${opts.profileName}」配置正常`
      : "✓ 项目所有 Profile 配置正常";
    return { output: okMsg, issueCount: 0, errors: 0, warnings: 0, infos: 0 };
  }

  // 按 profile 分组（biome 风格：file → issues 列表）
  const byProfile = new Map<string, AssetHealthIssue[]>();
  for (const i of issues) {
    const arr = byProfile.get(i.name) ?? [];
    arr.push(i);
    byProfile.set(i.name, arr);
  }

  const lines: string[] = [];
  for (const [profileName, profIssues] of byProfile) {
    lines.push(`${profileName}.profile.md`);
    for (const i of profIssues) {
      // v16：info 分支——可选 domain slot 空是预期行为，用 ℹ 标识
      const mark = i.severity === "error" ? "×" : i.severity === "warning" ? "⚠" : "ℹ";
      const sev = i.severity;
      const where = i.field ? ` ${i.field}` : "";
      lines.push(`  ${mark} [${sev}]${where} ${i.msg}`);
      if (i.hint) lines.push(`     hint: ${i.hint}`);
      if (i.fix && !opts.fix) lines.push(`     fix:  ${i.fix}`);
    }
    lines.push("");
  }
  // trim trailing blank
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  // summary
  const errorCount = issues.filter((i) => i.severity === "error").length;
  const warningCount = issues.filter((i) => i.severity === "warning").length;
  // v16：info 计数——optional-domain-unresolved 等预期行为的诊断
  const infoCount = issues.filter((i) => i.severity === "info").length;
  lines.push("");
  // v16：info 数 > 0 时附加（info=0 时省略，与 warning 处理一致——不刷屏）
  const infoSuffix = infoCount > 0 ? `, ${infoCount} info${infoCount > 1 ? "s" : ""}` : "";
  lines.push(
    `× ${errorCount} error${errorCount > 1 ? "s" : ""}, ${warningCount} warning${warningCount > 1 ? "s" : ""}${infoSuffix}`
  );
  lines.push(`  hint: 查看 .pt/docs/migrations/v9.0-to-v9.1-modules.md 修复指南`);
  if (errorCount > 0 && !opts.fix) {
    lines.push(`  hint: 运行 \`/pt check --fix\` 自动应用已知 migration（v2 范围）`);
  }
  return {
    output: lines.join("\n"),
    issueCount: issues.length,
    errors: errorCount,
    warnings: warningCount,
    infos: infoCount,
  };
}

// =====================================================================
// Phase 3（.pt/docs/issues/pt-doc-index-and-schema.md L1）：文档列表命令内核
//
// 设计动机：
//   - /pt issues | /pt manuals | /pt designs | /pt check-docs 四个命令共享同一内核模式
//   - frontmatter 是真相源，命令层实时聚合，不落盘 index.md
//   - 纯函数：cwd + activeProfile + opts → 格式化字符串，可单测
//   - 表格列：NAME / STATUS / SEVERITY / CREATED / PROFILE
//   - 缺 frontmatter 的文档仍列出（PROFILE 列显 —），降级兼容未迁移文档
//
// 排序：
//   - status 优先（open > in-progress > resolved > closed > 其他）
//   - 同 status 按 created 倒序（newest first）
// =====================================================================

/** status 排序权重——值小=优先级高 */
const STATUS_ORDER: Record<string, number> = {
  open: 0,
  "in-progress": 1,
  resolved: 2,
  closed: 3,
  wontfix: 4,
  rejected: 5,
  active: 0, // design: active 排第一
  draft: 1,
  implemented: 2,
  superseded: 3,
  abandoned: 4,
  completed: 0, // manual: completed 排第一（手动实例完成态是常态）
  // 默认: 99 (其他值按 created 倒序)
};

/** DocRecord 排序比较器：status 优先 + created 倒序 */
function compareDocRecords(a: DocRecord, b: DocRecord): number {
  const sa = (a.frontmatter?.status as string | undefined) ?? "";
  const sb = (b.frontmatter?.status as string | undefined) ?? "";
  const oa = STATUS_ORDER[sa] ?? 99;
  const ob = STATUS_ORDER[sb] ?? 99;
  if (oa !== ob) return oa - ob;
  const ca = (a.frontmatter?.created as string | undefined) ?? "";
  const cb = (b.frontmatter?.created as string | undefined) ?? "";
  return cb.localeCompare(ca); // 倒序——newest first
}

/** 把 profile 字段格式化为字符串（数组 → 逗号分隔 / 字符串原样 / 缺省 —） */
function formatProfileField(fm: Record<string, unknown> | null): string {
  if (!fm) return "—";
  const p = fm.profile;
  if (p === undefined || p === null) return "—";
  if (typeof p === "string") return p;
  if (Array.isArray(p)) return p.filter((s) => typeof s === "string").join(",");
  return "—";
}

/** severity 缺省占位（issues 有 severity，designs/manuals 无） */
function formatSeverityField(fm: Record<string, unknown> | null): string {
  const sev = fm?.severity;
  return typeof sev === "string" ? sev : "—";
}

/** created 字段格式化（兼容 ISO date / date-time） */
function formatCreatedField(fm: Record<string, unknown> | null): string {
  const c = fm?.created;
  return typeof c === "string" ? c : "—";
}

/** 把 DocRecord 列表格式化为表格行（按指定列宽对齐，可单测断言）。
 *  - columns：列名 → 取值函数（统一接口，issues/manuals/designs 三种格式复用） */
function formatDocTable(
  docs: DocRecord[],
  title: string,
  columns: Array<{ header: string; value: (d: DocRecord) => string; width: number }>
): string {
  const lines: string[] = [];
  const total = docs.length;
  const filtered = total; // 计数在调用方算
  const parseErrs = countParseErrors(docs);

  // header
  lines.push(
    `${title} (${filtered} shown${filtered !== total ? ` of ${total}` : ""}, ${parseErrs} parse errors)`
  );

  if (total === 0) {
    lines.push("  (no documents match filter)");
    return lines.join("\n");
  }

  // 排序
  const sorted = [...docs].sort(compareDocRecords);

  // 列宽
  const computedWidths = columns.map((col) => {
    let w = col.header.length;
    for (const d of sorted) {
      const v = col.value(d);
      if (v.length > w) w = v.length;
    }
    return Math.min(w, col.width);
  });

  // 表头
  const headerRow = columns.map((col, i) => col.header.padEnd(computedWidths[i])).join("  ");
  lines.push(`  ${headerRow}`);
  // 分隔行（视觉分隔）
  lines.push(`  ${columns.map((_, i) => "─".repeat(computedWidths[i])).join("  ")}`);

  // 数据行
  for (const d of sorted) {
    const row = columns
      .map((col, i) => col.value(d).slice(0, computedWidths[i]).padEnd(computedWidths[i]))
      .join("  ");
    lines.push(`  ${row}`);
  }
  return lines.join("\n");
}

/** 优先级：opts.profile > activeProfile > null（不过滤）
 *  整 null/undefined 为 null，让 doc-index 走"不过滤"分支 */
function resolveProfile(
  opts: { profile?: string | null } | undefined,
  activeProfile: string | null
): string | null {
  const o = opts?.profile;
  if (o !== undefined && o !== null && o !== "") return o;
  return activeProfile;
}

/** /pt issues 内核：扫 .pt/docs/issues，按 profile/status 过滤 + 表格格式化 */
export async function issuesText(
  cwd: string,
  activeProfile: string | null,
  opts?: IssuesTextOptions
): Promise<string> {
  const profile = resolveProfile(opts, activeProfile);
  let docs = await scanDocs(cwd, "issue");
  const totalCount = docs.length;
  docs = filterByProfile(docs, profile);
  docs = filterByStatus(docs, opts?.status ?? null);
  const afterFilter = totalCount - docs.length;
  const title = `Issues (profile: ${profile ?? "(any)"}, status: ${opts?.status ?? "(any)"})`;
  const table = formatDocTable(docs, title, [
    { header: "NAME", value: (d) => d.fileName, width: 60 },
    { header: "STATUS", value: (d) => (d.frontmatter?.status as string) ?? "—", width: 12 },
    { header: "SEVERITY", value: (d) => formatSeverityField(d.frontmatter), width: 9 },
    { header: "CREATED", value: (d) => formatCreatedField(d.frontmatter), width: 10 },
    { header: "PROFILE", value: (d) => formatProfileField(d.frontmatter), width: 40 },
  ]);
  if (afterFilter > 0) {
    return `${table}\n(${docs.length}/${totalCount} shown; ${afterFilter} filtered out)`;
  }
  return table;
}

/** /pt manuals 内核 */
export async function manualsText(
  cwd: string,
  activeProfile: string | null,
  opts?: IssuesTextOptions
): Promise<string> {
  const profile = resolveProfile(opts, activeProfile);
  let docs = await scanDocs(cwd, "manual");
  const totalCount = docs.length;
  docs = filterByProfile(docs, profile);
  docs = filterByStatus(docs, opts?.status ?? null);
  const afterFilter = totalCount - docs.length;
  const title = `Manuals (profile: ${profile ?? "(any)"}, status: ${opts?.status ?? "(any)"})`;
  const table = formatDocTable(docs, title, [
    { header: "NAME", value: (d) => d.fileName, width: 60 },
    {
      header: "PROCEDURE",
      value: (d) => (d.frontmatter?.procedure as string) ?? "—",
      width: 25,
    },
    { header: "STATUS", value: (d) => (d.frontmatter?.status as string) ?? "—", width: 12 },
    { header: "CREATED", value: (d) => formatCreatedField(d.frontmatter), width: 25 },
    { header: "PROFILE", value: (d) => formatProfileField(d.frontmatter), width: 40 },
  ]);
  if (afterFilter > 0) {
    return `${table}\n(${docs.length}/${totalCount} shown; ${afterFilter} filtered out)`;
  }
  return table;
}

/** /pt designs 内核 */
export async function designsText(
  cwd: string,
  activeProfile: string | null,
  opts?: IssuesTextOptions
): Promise<string> {
  const profile = resolveProfile(opts, activeProfile);
  let docs = await scanDocs(cwd, "design");
  const totalCount = docs.length;
  docs = filterByProfile(docs, profile);
  docs = filterByStatus(docs, opts?.status ?? null);
  const afterFilter = totalCount - docs.length;
  const title = `Designs (profile: ${profile ?? "(any)"}, status: ${opts?.status ?? "(any)"})`;
  const table = formatDocTable(docs, title, [
    { header: "NAME", value: (d) => d.fileName, width: 60 },
    { header: "DOMAIN", value: (d) => (d.frontmatter?.domain as string) ?? "—", width: 25 },
    { header: "PHASE", value: (d) => (d.frontmatter?.phase as string) ?? "—", width: 10 },
    { header: "CREATED", value: (d) => formatCreatedField(d.frontmatter), width: 10 },
    { header: "PROFILE", value: (d) => formatProfileField(d.frontmatter), width: 40 },
  ]);
  if (afterFilter > 0) {
    return `${table}\n(${docs.length}/${totalCount} shown; ${afterFilter} filtered out)`;
  }
  return table;
}

/** Phase 3：subArgs 解析 --key 与 --key=value 形态（与 /pt make-manual 的 --issue 解析同模式）。
 *  返回的对象只包含实际出现的 key；不出现的字段为 undefined。
 *  v12.x：纯函数——单测只测字符串解析逻辑，不依赖 UI/session。 */
export function parseListFlags(args: string): {
  profile?: string;
  status?: string;
  kind?: string;
} {
  const tokens = args
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  const out: { profile?: string; status?: string; kind?: string } = {};
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === undefined) continue;
    if (t === "--profile" || t === "-p") {
      const next = tokens[i + 1];
      if (next && !next.startsWith("--")) {
        out.profile = next;
        i++;
      }
      continue;
    }
    if (t.startsWith("--profile=")) {
      out.profile = t.slice("--profile=".length);
      continue;
    }
    if (t === "--status") {
      const next = tokens[i + 1];
      if (next && !next.startsWith("--")) {
        out.status = next;
        i++;
      }
      continue;
    }
    if (t.startsWith("--status=")) {
      out.status = t.slice("--status=".length);
      continue;
    }
    if (t === "--kind") {
      const next = tokens[i + 1];
      if (next && !next.startsWith("--")) {
        out.kind = next;
        i++;
      }
      continue;
    }
    if (t.startsWith("--kind=")) {
      out.kind = t.slice("--kind=".length);
    }
  }
  return out;
}

/** kind → schema 名映射（查 .pt/schemas/） */
const KIND_SCHEMA: Record<DocKind, string> = {
  issue: "issue.frontmatter.schema.json",
  manual: "manual.frontmatter.schema.json",
  design: "design.frontmatter.schema.json",
};

/** /pt check-docs 内核：批量 schema 校验（biome 风格输出）。
 *  - kind：指定扫哪类文档；不传则扫全部 issue/manual/design
 *  - 每类文档同时过滤 profile（与 issuesText / manualsText / designsText 一致） */
export async function checkDocsText(
  cwd: string,
  activeProfile: string | null,
  opts?: IssuesTextOptions
): Promise<string> {
  const kinds: DocKind[] = opts?.kind ? [opts.kind] : ["issue", "manual", "design"];
  const profile = opts?.profile !== undefined ? opts.profile : activeProfile;

  let totalFiles = 0;
  let totalViolations = 0;
  const allViolations: Array<{
    path: string;
    errors: string[];
    reason?: string;
    kind: DocKind;
  }> = [];
  const allParseErrors: Array<{ path: string; err: string }> = [];

  for (const kind of kinds) {
    let docs = await scanDocs(cwd, kind);
    docs = filterByProfile(docs, profile);
    totalFiles += docs.length;
    for (const d of docs) {
      if (d.parseError) {
        allParseErrors.push({ path: d.filePath, err: d.parseError });
      }
    }
    for (const d of docs) {
      if (d.parseError) continue; // frontmatter 都解析不动 + 前一个循环入了 parse errors
      try {
        const r: DocValidationResult = await validateDoc(cwd, d.filePath, KIND_SCHEMA[kind]);
        if (r.ok) continue;
        if (r.reason) {
          allViolations.push({ path: d.filePath, errors: [], reason: r.reason, kind });
        } else {
          totalViolations += 1;
          allViolations.push({ path: d.filePath, errors: r.errors, kind });
        }
      } catch (e) {
        // IO 错（如 schema 文件被删）——归为 parse error
        allParseErrors.push({ path: d.filePath, err: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  // 格式化输出
  const lines: string[] = [];
  const kindLabel = opts?.kind ? `${opts.kind}` : "all";
  lines.push(
    `Doc schema check (kind: ${kindLabel}, profile: ${profile ?? "(any)"}) — ${totalFiles} files, ${totalViolations} violations, ${allParseErrors.length} parse errors`
  );
  lines.push("");
  // biome 风格：× 违规文件清单
  if (allViolations.length === 0) {
    lines.push(`✓ ${totalFiles}/${totalFiles} files OK`);
    if (allParseErrors.length > 0) {
      lines.push("");
      lines.push(`Parse errors (${allParseErrors.length}):`);
      for (const pe of allParseErrors.slice(0, 20)) {
        lines.push(`  ✖ ${pe.path}`);
        lines.push(`    ${pe.err}`);
      }
      if (allParseErrors.length > 20) {
        lines.push(`  ... and ${allParseErrors.length - 20} more`);
      }
    }
    return lines.join("\n");
  }
  for (const v of allViolations) {
    lines.push(`✖ ${v.path}`);
    if (v.reason) {
      lines.push(`  ${v.reason}`);
    } else {
      for (const e of v.errors) {
        lines.push(`  ${e}`);
      }
    }
    lines.push("");
  }
  // trim trailing blank
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const okCount = totalFiles - allViolations.length;
  lines.push("");
  lines.push(`  ${okCount}/${totalFiles} files OK`);
  return lines.join("\n");
}
