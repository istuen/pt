// src/stats-text.ts — `/pt stats` 作者采用反馈报告（issue pt-observability-read-gap §五 A）
//
// 目的：回答**资产作者**的四个问题——
//   1. 新增 Domain / 内容后，变化怎么看得出来？（Profile 效果表 + 注入成本段）
//   2. Manual 用起来没？（检查值班块尾的 manual 启动计数）
//   3. 哪些内容频率高低？（Domain 采用排行）
//   4. Profile 的效果与下一步改善方向？（采用率 ÷ 成本 = Domain ROI）
//
// 定位分界（issue §五 定夺 1）：`/pt info` = 「Pt 自身状态自省」（本 session 实时态），
//   `/pt stats` = 「我的内容表现如何」（跨 session 历史 + 作者视角）。
//
// 设计原则：
// - **纯读侧**：不动 summary/log/transpile 的任何写入逻辑；不改 schema；不加 settings。
// - **归因规则写死**（issue §五 定夺 3）：active profile 以 session 结束值
//   （summary.ndjson 的 `profile` 字段）为准；`session:profile loaded` 只用于区分
//   fallback（`loadedFrom: "default"`）与显式选择，**不作归因主源**。
//   （按首条 session:profile loaded 归因会把 guide 吹大——实测 default fallback → guide）
// - **诚实尾注**：数据 = Pt 观测点事实、不做因果声明；查阅 ≠ 遵守；
//   domain 归因自 Layer 1 F1.2 起（commit `7aa45ff`），早期 pt_inject 调用无 domain 归因。
// - **判定语义照抄 scripts/log-stats.sh v2 §4.4/§4.5**（移植，不改判定语义）。
//   验收硬指标 3 要求数字与 v2 报告吻合——语义漂移会直接挂验收。
//
// 数据源（三源）：
//   1. `<cwd>/.pt/logs/summary.ndjson`  —— per-session 汇总（profile 归因主源 + 检查值班）
//   2. `<cwd>/.pt/logs/pt-*.log`        —— session NDJSON trace（查阅侧 + 重建事件）
//   3. `<cwd>/.pt/cache/agent-contexts/*.agent-context.md` —— 曝光侧（trigger-index 段）

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { CACHE_DIR } from "./constants.js";
import { LOG_DIR } from "./log.js";
import { SUMMARY_FILE, type SessionSummaryRecord } from "./summary.js";

/** 一次 pt_inject 调用的查阅记录（Layer 1 F1.2 起可归因到 domain）。 */
export interface DomainConsult {
  domain: string;
  sessionId: string;
}

/** 一次 pt_doc 调用（manual 启动计数用）。 */
export interface DocCall {
  action: string;
  procedure: string | null;
  sessionId: string;
}

/** 一次 AgentContext 重建（transpile:cache miss → save）。 */
export interface RebuildEvent {
  /** profile 名（来自 `agentContextName` 字段）。 */
  profile: string;
  /** 该次重建的 segment 长度（若日志带 segmentLen）。 */
  segmentLen: number | null;
  ts: string;
}

/** 曝光侧：编译产物的 trigger-index 条目（一个 profile 的一本 domain）。 */
export interface TriggerExposure {
  profile: string;
  /** trigger 条目名（如 `dev-process-trigger`）。 */
  entry: string;
  /** domain 名（entry 名去掉 `-trigger` 后缀）。 */
  domain: string;
}

/** 编译产物（AgentContext 物理文件）的解析结果。 */
export interface ProductInfo {
  /** 文件名（`<pack>__<profile>.agent-context.md`）。 */
  file: string;
  pack: string | null;
  profile: string | null;
  blueprint: string | null;
  /** trigger-index 段的条目（曝光侧）。 */
  triggers: TriggerExposure[];
  /** 三段字符数（注入成本段）。 */
  sectionChars: { "session-context": number; "trigger-index": number; "reference-manual": number };
  /** 产物总字符数。 */
  totalChars: number;
}

/** 日志扫描的聚合结果（查阅侧 + 重建事件 + fallback 计数）。 */
export interface LogScan {
  /** 所有 `tool:call` 且 name=pt_inject 的调用（含无 domain 归因的）。 */
  ptInjectTotal: number;
  /** 其中带 `input.domain` 的（可归因）。 */
  ptInjectWithDomain: number;
  /** 可归因的查阅记录。 */
  consults: DomainConsult[];
  /** pt_doc 调用。 */
  docCalls: DocCall[];
  /** AgentContext 重建事件。 */
  rebuilds: RebuildEvent[];
  /** `transpile:done` 事件（带 profileName + segmentLen）——segment 长度的主源。 */
  transpileDones: Array<{ profile: string; segmentLen: number; cacheHit: boolean; ts: string }>;
  /** `session:profile loaded` 里 `loadedFrom == "default"` 的计数（fallback 归因标注用）。 */
  fallbackProfileLoads: number;
  /** 出现过 `session:profile loaded` 的 session 数（总 session 参照）。 */
  profileLoadSessions: number;
  /** 有效 session（有 turn:start）的 sessionId 集合。 */
  effectiveSessions: string[];
  /** 日志行总数（解析成功的）。 */
  parsedLines: number;
  /** 残行数（JSON.parse 失败，被跳过）。 */
  skippedLines: number;
}

// ==================== P1：数据源读取（纯读侧） ====================

/** 读 summary.ndjson → session 汇总记录（残行跳过）。 */
export async function readSummaryLines(cwd: string): Promise<SessionSummaryRecord[]> {
  let raw: string;
  try {
    raw = await readFile(join(cwd, LOG_DIR, SUMMARY_FILE), "utf8");
  } catch {
    return [];
  }
  const out: SessionSummaryRecord[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (t === "") continue;
    try {
      out.push(JSON.parse(t) as SessionSummaryRecord);
    } catch {
      /* 残行（并发 append 撕裂 / 进程中断）→ 跳过 */
    }
  }
  return out;
}

/** 从 ctx 字段安全取字符串。 */
function ctxStr(ctx: Record<string, unknown> | undefined, key: string): string | null {
  const v = ctx?.[key];
  return typeof v === "string" && v !== "" ? v : null;
}

/** 从 ctx 字段安全取数字。 */
function ctxNum(ctx: Record<string, unknown> | undefined, key: string): number | null {
  const v = ctx?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** 判断一个 sessionId 是否是测试 fixture（与 log-stats.sh v2 的 jq 过滤同语义）。
 *
 *  v2 的 jq：`select(.ctx.sessionId // "" | test("^test-session$") | not)
 *            select(.ctx.sessionId // "" | test("^session-[A-Z]$") | not)`
 *  → 排除 `test-session` 与 `session-A/B/C...`（单字母大写）。
 *  移植为 TS 正则，保持判定语义一致。 */
export function isTestSessionId(sessionId: string | null): boolean {
  if (sessionId === null) return false;
  return sessionId === "test-session" || /^session-[A-Z]$/.test(sessionId);
}

/** 全量扫描 `.pt/logs/pt-*.log`，聚合查阅侧 + 重建事件 + fallback 计数。
 *
 *  **为什么自建而不复用 PtLogger**：`PtLogger.tail` 是按 sessionId 反查单文件的
 *  （`src/log.ts:130`），stats 要的是**全量跨 session 扫描**——PtLogger 无批量读接口。
 *  故 stats-text 内自建（不动 log.ts 的写路径与既有 API）。
 *
 *  性能：一次性命令，1000 文件 × 数 KB，实测秒级可接受。
 *  若未来日志量级暴涨，再按 mtime 过滤近 N 天（写进注释，不做 flag）。 */
export async function readLogEntries(cwd: string): Promise<LogScan> {
  const dir = join(cwd, LOG_DIR);
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".log")).sort();
  } catch {
    files = [];
  }

  const scan: LogScan = {
    ptInjectTotal: 0,
    ptInjectWithDomain: 0,
    consults: [],
    docCalls: [],
    rebuilds: [],
    transpileDones: [],
    fallbackProfileLoads: 0,
    profileLoadSessions: 0,
    effectiveSessions: [],
    parsedLines: 0,
    skippedLines: 0,
  };

  const effectiveSessionSet = new Set<string>();
  const profileLoadSessionSet = new Set<string>();

  for (const file of files) {
    let raw: string;
    try {
      raw = await readFile(join(dir, file), "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (t === "") continue;
      let entry: { ts?: string; msg?: string; ctx?: Record<string, unknown> };
      try {
        entry = JSON.parse(t) as { msg?: string; ctx?: Record<string, unknown> };
      } catch {
        scan.skippedLines++;
        continue;
      }
      scan.parsedLines++;

      const ctx = entry.ctx;
      const sessionId = ctxStr(ctx, "sessionId");

      switch (entry.msg) {
        case "turn:start": {
          if (sessionId && !isTestSessionId(sessionId)) effectiveSessionSet.add(sessionId);
          break;
        }
        case "session:profile loaded": {
          if (sessionId && !isTestSessionId(sessionId)) profileLoadSessionSet.add(sessionId);
          // fallback 计数：同口径（测试 fixture 不算）。
          if (!isTestSessionId(sessionId) && ctxStr(ctx, "loadedFrom") === "default") {
            scan.fallbackProfileLoads++;
          }
          break;
        }
        case "tool:call": {
          const name = ctxStr(ctx, "name");
          // 同口径：测试 fixture session 的调用不算（v2 的 jq 在整行层面过滤）。
          if (isTestSessionId(sessionId)) break;
          if (name === "pt_inject") {
            scan.ptInjectTotal++;
            const input = (ctx?.input ?? {}) as Record<string, unknown>;
            const domain = typeof input.domain === "string" ? input.domain : null;
            if (domain && domain !== "") {
              scan.ptInjectWithDomain++;
              scan.consults.push({ domain, sessionId: sessionId ?? "" });
            }
          } else if (name === "pt_doc") {
            const input = (ctx?.input ?? {}) as Record<string, unknown>;
            const action = typeof input.action === "string" ? input.action : "";
            const procedure = typeof input.procedure === "string" ? input.procedure : null;
            scan.docCalls.push({ action, procedure, sessionId: sessionId ?? "" });
          }
          break;
        }
        case "transpile:cache miss → save": {
          const profile = ctxStr(ctx, "agentContextName") ?? ctxStr(ctx, "contextName") ?? "";
          // 同上：测试 fixture session 不参与统计。
          if (isTestSessionId(sessionId)) break;
          scan.rebuilds.push({
            profile,
            segmentLen: ctxNum(ctx, "segmentLen"),
            ts: typeof entry.ts === "string" ? entry.ts : "",
          });
          break;
        }
        case "transpile:done": {
          const profile = ctxStr(ctx, "profileName") ?? "";
          const segmentLen = ctxNum(ctx, "segmentLen");
          const sessionId = ctxStr(ctx, "sessionId");
          // 测试 fixture session 不参与统计（与 v2 的 jq 过滤同口径）——
          // 否则几周前的 fixture 数据会污染 segment 平均与「最近 segment」。
          if (profile && segmentLen !== null && !isTestSessionId(sessionId)) {
            scan.transpileDones.push({
              profile,
              segmentLen,
              cacheHit: ctx?.cacheHit === true,
              ts: typeof entry.ts === "string" ? entry.ts : "",
            });
          }
          break;
        }
        default:
          break;
      }
    }
  }

  scan.effectiveSessions = [...effectiveSessionSet];
  scan.profileLoadSessions = profileLoadSessionSet.size;
  return scan;
}

/** 解析 AgentContext 产物文件的 frontmatter + 三段 + trigger-index 条目。
 *
 *  **判定语义照抄 log-stats.sh v2**（移植，不改语义）：
 *  - frontmatter：`/^profile:/` 取值（第一行匹配）
 *  - trigger-index 段：`/^## trigger-index/` 进段、`/^## /` 出段、段内 `^- ` 开头的行
 *  - 条目名 = `- <name>: <desc>` 里第一个 `:` 之前的部分（去空白）
 *  - domain 名 = 条目名去掉 `-trigger` 后缀
 *
 *  注意：`-trigger` 后缀剥离是 v2 的口径（`sub(/-trigger$/, "", dom)`）——
 *  entry 名不带该后缀时 domain 名 == entry 名。 */
export function parseProductContent(file: string, content: string): ProductInfo {
  const info: ProductInfo = {
    file,
    pack: null,
    profile: null,
    blueprint: null,
    triggers: [],
    sectionChars: { "session-context": 0, "trigger-index": 0, "reference-manual": 0 },
    totalChars: content.length,
  };

  // frontmatter：仅在文件头部 `---` 块内解析（v2 用 grep -m1 全文件搜，这里限定头部更严谨，
  // 但取值语义一致：profile 名相同）。
  const lines = content.split("\n");
  if (lines[0]?.trim() === "---") {
    for (let i = 1; i < lines.length; i++) {
      const l = lines[i] ?? "";
      if (l.trim() === "---") break;
      const m = /^(pack|profile|blueprint):\s*(.*)$/.exec(l);
      if (m) {
        const key = m[1] as "pack" | "profile" | "blueprint";
        const val = (m[2] ?? "").trim();
        if (val !== "") info[key] = val;
      }
    }
  }

  // 三段字符数 + trigger-index 条目（一次遍历）。
  const sectionNames = ["session-context", "trigger-index", "reference-manual"] as const;
  type SectionName = (typeof sectionNames)[number];
  let current: SectionName | null = null;
  for (const l of lines) {
    const h2 = /^##\s+(.+?)\s*$/.exec(l);
    if (h2) {
      const name = (h2[1] ?? "").trim();
      current = (sectionNames as readonly string[]).includes(name) ? (name as SectionName) : null;
      continue;
    }
    if (current === null) continue;
    info.sectionChars[current] += l.length + 1;
    if (current !== "trigger-index") continue;
    const bullet = /^- /.test(l);
    if (!bullet) continue;
    const line = l.slice(2);
    const idx = line.indexOf(":");
    if (idx === 0) continue;
    let name = idx === -1 ? line : line.slice(0, idx);
    name = name.replace(/^[ \t]+|[ \t]+$/g, "");
    if (name === "") continue;
    const domain = name.replace(/-trigger$/, "");
    if (info.profile) {
      info.triggers.push({ profile: info.profile, entry: name, domain });
    }
  }

  return info;
}

/** 扫 `CACHE_DIR/*.agent-context.md` → 产物列表（曝光侧数据源）。 */
export async function readContextProducts(cwd: string): Promise<ProductInfo[]> {
  const dir = join(cwd, CACHE_DIR);
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".agent-context.md")).sort();
  } catch {
    return [];
  }
  const out: ProductInfo[] = [];
  for (const file of files) {
    try {
      const content = await readFile(join(dir, file), "utf8");
      out.push(parseProductContent(file, content));
    } catch {}
  }
  return out;
}

// ==================== P2：聚合逻辑（五块） ====================

/** Profile 效果表的一行。 */
export interface ProfileRow {
  profile: string;
  /** 有汇总记录的 session 数（summary.ndjson 归因主源）。 */
  sessions: number;
  /** turn 总数。 */
  turns: number;
  /** pt_inject 查阅次数（可归因的）。 */
  consults: number;
  /** 平均 segment 长度（来自 transpile:done / 重建事件）。 */
  avgSegmentLen: number | null;
  /** 该 profile 曝光的 domain 数。 */
  exposedDomains: number;
  /** 该 profile 曝光但 0 查阅的 domain 数（零查阅）。 */
  zeroConsultDomains: number;
}

/** Domain 采用排行的一行（判定语义照抄 log-stats.sh v2 §4.4/§4.5）。 */
export interface DomainRow {
  domain: string;
  /** 曝光该 domain 的 profile 数（v2 §4.5「曝光 profile 数」列口径）。 */
  exposedProfiles: number;
  /** 曝光该 domain 的 profile 列表。 */
  profiles: string[];
  /** 曝光该 domain 的 session 数（= 曝光 profile 下跑过的 session 总数）。
   *  ⚠ 这是**本命令新增**的 session 加权口径——v2 的「曝光」只按 profile 计数，
   *  在 profile 数少的项目里（实测 ≤6）无法区分「偶尔露脸」与「天天摆在面前」。
   *  零查阅诊断块用这个口径做阈值判定（「摆在 N 个 session 面前却 0 次被查」）。 */
  exposureSessions: number;
  /** 被查次数（全日志批次的 pt_inject 计数——v2 口径：不按 profile 分摊）。 */
  consulted: number;
  /** 被查的 session 数（v2 §4.5 口径）。 */
  consultedSessions: number;
  /** 采用率 = 被查 session 数 / 曝光 session 数（session 加权；null = 无曝光数据）。 */
  adoptionRate: number | null;
}

/** 零查阅清单的一行。 */
export interface ZeroConsultRow {
  domain: string;
  /** 曝光该 domain 的 profile 数。 */
  exposedProfiles: number;
  /** 曝光该 domain 的 session 数（≥ 曝光阈值）。 */
  exposureSessions: number;
  /** 被查次数（恒为 0）。 */
  consulted: number;
}

/** 注入成本段的一行（一个产物 = 一个 profile 的固定注入面）。 */
export interface CostRow {
  profile: string;
  pack: string;
  blueprint: string;
  sessionContextChars: number;
  triggerIndexChars: number;
  referenceManualChars: number;
  totalChars: number;
  /** 三段占比（session-context / trigger-index / reference-manual）。 */
  share: [number, number, number];
  /** 该 profile 的重建次数。 */
  rebuilds: number;
  /** 最近一次重建的 segment 长度（无则 null）。 */
  lastSegmentLen: number | null;
}

/** 检查值班块。 */
export interface CheckDuty {
  /** checkResults outcome 分布。 */
  outcomes: Record<string, number>;
  /** 失败（DEVIATED）数。 */
  deviates: number;
  /** 阻断次数。 */
  blocked: number;
  /** 绕过次数。 */
  bypass: number;
  /** 注入一致性校验结果（null = 未开启 / 未观测到）。 */
  injectionMatched: boolean | null;
  /** injectionMatched 全为 null（= 内容到场层无数据）。 */
  noDeliveryData: boolean;
  /** manual 启动次数（pt_doc action=start）。 */
  manualStarts: number;
  /** manual 按 procedure 聚合。 */
  manualByProcedure: Array<{ procedure: string; count: number }>;
}

/** 全部聚合结果。 */
export interface StatsAggregation {
  profiles: ProfileRow[];
  domains: DomainRow[];
  zeroConsult: ZeroConsultRow[];
  costs: CostRow[];
  checkDuty: CheckDuty;
  /** Blueprint 使用分布（一行带过）。 */
  blueprints: Array<{ blueprint: string; count: number }>;
  /** fallback 归因标注：N 个 session 从 default fallback 启动。 */
  fallbackSessions: number;
  /** pt_inject 总数 / 可归因数 / 不可归因数。 */
  ptInjectTotal: number;
  ptInjectAttributable: number;
  ptInjectUnattributable: number;
  /** 数据窗（日志文件数 / 时间跨度）。 */
  logFileCount: number;
  dataWindow: { earliest: string | null; latest: string | null };
  /** 曝光侧覆盖率（活跃 profile 中有产物的比例）。 */
  exposureCoverage: { activeProfiles: number; coveredProfiles: number };
  /** 无曝光数据的 profile。 */
  profilesWithoutExposure: string[];
  /** 有效 session 数（有 turn）。 */
  effectiveSessions: number;
}

/** 零查阅判定阈值：曝光 profile 数 ≥ 此值且被查 0 次。 */
export const ZERO_CONSULT_EXPOSURE_THRESHOLD = 5;

/** 聚合：Profile 效果表。
 *
 *  **归因规则**（issue §五 定夺 3）：profile 归因主源 = summary.ndjson 的 `profile` 字段
 *  （session 结束值）；`session:profile loaded` 不参与归因（只用来数 fallback）。 */
export function aggregateProfiles(
  summaries: SessionSummaryRecord[],
  scan: LogScan,
  products: ProductInfo[]
): ProfileRow[] {
  const rows = new Map<string, ProfileRow>();
  const ensure = (p: string): ProfileRow => {
    let r = rows.get(p);
    if (!r) {
      r = {
        profile: p,
        sessions: 0,
        turns: 0,
        consults: 0,
        avgSegmentLen: null,
        exposedDomains: 0,
        zeroConsultDomains: 0,
      };
      rows.set(p, r);
    }
    return r;
  };

  // 汇总侧：sessions / turns（归因主源）。
  for (const s of summaries) {
    if (isTestSessionId(s.sessionId ?? null)) continue;
    const p = s.profile;
    if (!p) continue;
    const r = ensure(p);
    r.sessions += 1;
    r.turns += s.turns ?? 0;
  }

  // 查阅侧：按 domain → 曝光 profile 关联（v2 §4.5 口径：被查次数按 domain 全局计）。
  const consultedDomains = new Set(scan.consults.map((c) => c.domain));
  const domainProfiles = new Map<string, Set<string>>();
  for (const prod of products) {
    if (!prod.profile) continue;
    for (const t of prod.triggers) {
      let set = domainProfiles.get(t.domain);
      if (!set) {
        set = new Set();
        domainProfiles.set(t.domain, set);
      }
      set.add(prod.profile);
    }
  }

  // 曝光侧 → 每个 profile 的曝光 domain 数 / 零查阅数。
  for (const prod of products) {
    if (!prod.profile) continue;
    const r = ensure(prod.profile);
    const domains = new Set(prod.triggers.map((t) => t.domain));
    r.exposedDomains = Math.max(r.exposedDomains, domains.size);
    let zero = 0;
    for (const d of domains) {
      if (!consultedDomains.has(d)) zero++;
    }
    r.zeroConsultDomains = Math.max(r.zeroConsultDomains, zero);
  }

  // segment 长度：来自 `transpile:done` 的 segmentLen（按 profileName 平均）——
  // 这是 segment 长度的**主源**（每次编译都记，含 cache hit 的）。
  // 重建事件（cache miss → save）不带 segmentLen（只有 agentContextName），
  // 只用于「重建频率」计数，不参与平均。
  const segSum = new Map<string, { sum: number; n: number }>();
  for (const td of scan.transpileDones) {
    if (!td.profile) continue;
    const cur = segSum.get(td.profile) ?? { sum: 0, n: 0 };
    cur.sum += td.segmentLen;
    cur.n += 1;
    segSum.set(td.profile, cur);
  }
  // 重建事件的 segmentLen（若日志有）并入同一个累加器。
  for (const rb of scan.rebuilds) {
    if (!rb.profile || rb.segmentLen === null) continue;
    const cur = segSum.get(rb.profile) ?? { sum: 0, n: 0 };
    cur.sum += rb.segmentLen;
    cur.n += 1;
    segSum.set(rb.profile, cur);
  }

  // consults：按 domain → 关联到所有曝光该 domain 的 profile（v2 口径下「被查次数」
  // 在 §4.5 表里是按 (profile, domain) 行重复出现的全局值——这里保持同样口径：
  // 一个 profile 的 consults 数 = 该 profile 曝光 domain 涉及的查阅次数之和）。
  for (const [domain, profs] of domainProfiles) {
    const n = scan.consults.filter((c) => c.domain === domain).length;
    if (n === 0) continue;
    for (const p of profs) {
      const r = ensure(p);
      r.consults += n;
    }
  }

  for (const r of rows.values()) {
    const seg = segSum.get(r.profile);
    r.avgSegmentLen = seg && seg.n > 0 ? Math.round(seg.sum / seg.n) : null;
  }

  return [...rows.values()].sort(
    (a, b) => b.sessions - a.sessions || a.profile.localeCompare(b.profile)
  );
}

/** 从汇总记录算「profile → session 数」映射（曝光 session 口径的底数）。
 *
 *  归因主源 = summary.ndjson 的 `profile` 字段（session 结束值）——
 *  不用 `session:profile loaded`（fallback 噪声会把 guide 吹大）。 */
export function profileSessionCounts(summaries: SessionSummaryRecord[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of summaries) {
    if (isTestSessionId(s.sessionId ?? null)) continue;
    if (!s.profile) continue;
    m.set(s.profile, (m.get(s.profile) ?? 0) + 1);
  }
  return m;
}

/** 聚合：Domain 采用排行（判定语义照抄 log-stats.sh v2 §4.4/§4.5）。
 *
 *  v2 §4.4：被查次数 = 全日志批次里 `tool:call name=pt_inject` 且 `input.domain == d` 的行数。
 *  v2 §4.5：被查 session 数 = 同上的行去重 sessionId 数。
 *  曝光 profile 数 = 曝光该 domain 的 profile 数（v2 表里恒为 1，因按 (profile, domain) 行展开）。
 *
 *  **本命令新增**：曝光 session 数 = 曝光该 domain 的 profile 下跑过的 session 总数
 *  （session 加权口径）——零查阅诊断块用它做阈值判定。 */
export function aggregateDomains(
  scan: LogScan,
  products: ProductInfo[],
  profileSessions?: Map<string, number>
): DomainRow[] {
  const domainProfiles = new Map<string, Set<string>>();
  for (const prod of products) {
    if (!prod.profile) continue;
    for (const t of prod.triggers) {
      let set = domainProfiles.get(t.domain);
      if (!set) {
        set = new Set();
        domainProfiles.set(t.domain, set);
      }
      set.add(prod.profile);
    }
  }

  // 查阅侧：domain → 次数 + session 集合（v2 domain_consulted / domain_consulted_sessions）。
  const consultCount = new Map<string, number>();
  const consultSessions = new Map<string, Set<string>>();
  for (const c of scan.consults) {
    consultCount.set(c.domain, (consultCount.get(c.domain) ?? 0) + 1);
    let set = consultSessions.get(c.domain);
    if (!set) {
      set = new Set();
      consultSessions.set(c.domain, set);
    }
    set.add(c.sessionId);
  }

  const names = new Set<string>([...domainProfiles.keys(), ...consultCount.keys()]);
  const rows: DomainRow[] = [];
  for (const domain of names) {
    const profs = domainProfiles.get(domain) ?? new Set<string>();
    const exposed = profs.size;
    const consulted = consultCount.get(domain) ?? 0;
    const cs = consultSessions.get(domain)?.size ?? 0;
    let exposureSessions = 0;
    for (const p of profs) exposureSessions += profileSessions?.get(p) ?? 0;
    rows.push({
      domain,
      exposedProfiles: exposed,
      profiles: [...profs].sort(),
      exposureSessions,
      consulted,
      consultedSessions: cs,
      adoptionRate: exposureSessions > 0 ? cs / exposureSessions : null,
    });
  }
  // 排序：被查次数降序 → 曝光 profile 数降序 → 名字（v2 是 `sort | uniq -c | sort -rn`，
  // 即按次数降序；同次数的次序不保证——这里补确定性次序）。
  return rows.sort(
    (a, b) =>
      b.consulted - a.consulted ||
      b.exposedProfiles - a.exposedProfiles ||
      a.domain.localeCompare(b.domain)
  );
}

/** 聚合：零查阅清单（曝光 session 数 ≥ 阈值且被查 0）。
 *
 *  ⚠ **不判死刑**：只给证据 + 两个假设分支（desc 质量 / 任务真不需要），
 *  决策留给人（issue §五 A 第 3 块）。
 *
 *  阈值口径：**曝光 session 数**（不是 profile 数）——「这本手册摆在 N 个 session
 *  面前却一次都没被查」才是有意义的零查阅信号（profile 数在项目里天然很少，
 *  用 profile 数当阈值会让清单恒空）。 */
export function aggregateZeroConsult(
  domains: DomainRow[],
  threshold = ZERO_CONSULT_EXPOSURE_THRESHOLD
): ZeroConsultRow[] {
  return domains
    .filter((d) => d.exposureSessions >= threshold && d.consulted === 0)
    .map((d) => ({
      domain: d.domain,
      exposedProfiles: d.exposedProfiles,
      exposureSessions: d.exposureSessions,
      consulted: 0,
    }));
}

/** 聚合：注入成本段（三段字符占比 + 重建频率）。 */
export function aggregateCosts(scan: LogScan, products: ProductInfo[]): CostRow[] {
  const rebuildCount = new Map<string, number>();
  const lastSegment = new Map<string, { len: number; ts: string }>();
  for (const rb of scan.rebuilds) {
    if (!rb.profile) continue;
    rebuildCount.set(rb.profile, (rebuildCount.get(rb.profile) ?? 0) + 1);
  }
  // 最近一次 segment 长度：取 `transpile:done` 里时间戳最新的那条
  // （日志按文件名读 ≠ 时间序，必须按 ts 取）。
  for (const td of scan.transpileDones) {
    if (!td.profile) continue;
    const cur = lastSegment.get(td.profile);
    if (cur === undefined || td.ts > cur.ts) {
      lastSegment.set(td.profile, { len: td.segmentLen, ts: td.ts });
    }
  }
  return products
    .filter((p) => p.profile !== null)
    .map((p) => {
      const total =
        p.sectionChars["session-context"] +
        p.sectionChars["trigger-index"] +
        p.sectionChars["reference-manual"];
      const share = (n: number): number => (total > 0 ? (n / total) * 100 : 0);
      return {
        profile: p.profile as string,
        pack: p.pack ?? "(unknown)",
        blueprint: p.blueprint ?? "(unknown)",
        sessionContextChars: p.sectionChars["session-context"],
        triggerIndexChars: p.sectionChars["trigger-index"],
        referenceManualChars: p.sectionChars["reference-manual"],
        totalChars: total,
        share: [
          share(p.sectionChars["session-context"]),
          share(p.sectionChars["trigger-index"]),
          share(p.sectionChars["reference-manual"]),
        ],
        rebuilds: rebuildCount.get(p.profile as string) ?? 0,
        lastSegmentLen: lastSegment.get(p.profile as string)?.len ?? null,
      };
    });
}

/** 聚合：检查值班块（outcome 分布 + blocked/bypass + injectionMatched + manual 启动）。 */
export function aggregateCheckDuty(summaries: SessionSummaryRecord[], scan: LogScan): CheckDuty {
  const outcomes: Record<string, number> = {};
  let deviates = 0;
  let blocked = 0;
  let bypass = 0;
  let sawMatched = false;
  let sawFalse = false;

  for (const s of summaries) {
    for (const c of s.checkResults ?? []) {
      const o = c.outcome ?? "UNKNOWN";
      outcomes[o] = (outcomes[o] ?? 0) + 1;
      if (o === "DEVIATED") deviates++;
    }
    blocked += s.blockedCount ?? 0;
    bypass += s.bypassCount ?? 0;
    if (s.injectionMatched === true) sawMatched = true;
    else if (s.injectionMatched === false) sawFalse = true;
  }

  const manualStarts = scan.docCalls.filter((d) => d.action === "start").length;
  const procCount = new Map<string, number>();
  for (const d of scan.docCalls) {
    if (d.action !== "start") continue;
    const p = d.procedure ?? "(unknown)";
    procCount.set(p, (procCount.get(p) ?? 0) + 1);
  }

  return {
    outcomes,
    deviates,
    blocked,
    bypass,
    injectionMatched: sawMatched ? true : sawFalse ? false : null,
    // 「全 null」= 内容到场层无数据（--pt-observe 未开启）。
    noDeliveryData: !sawMatched && !sawFalse,
    manualStarts,
    manualByProcedure: [...procCount.entries()]
      .map(([procedure, count]) => ({ procedure, count }))
      .sort((a, b) => b.count - a.count || a.procedure.localeCompare(b.procedure)),
  };
}

/** 渲染：五块 + Blueprint 一行 + 诚实尾注。
 *
 *  **单屏纪律**：Domain 排行取前 15 + 「…共 N 个」；零查阅清单同理。 */
export function formatStatsText(agg: StatsAggregation, scan: LogScan): string {
  const L: string[] = [];
  const MAX_ROWS = 15;

  L.push("pt stats — 作者采用反馈报告");
  L.push(
    `数据窗: ${agg.dataWindow.earliest ?? "(无)"} ~ ${agg.dataWindow.latest ?? "(无)"} | ` +
      `有效 session ${agg.effectiveSessions} | 日志 ${scan.parsedLines} 行 / 残行 ${scan.skippedLines}`
  );
  L.push("");

  // ===== 1. Profile 效果表 =====
  L.push("【1】Profile 效果（归因主源: session 结束时的 active profile）");
  if (agg.profiles.length === 0) {
    L.push("  (无汇总数据)");
  } else {
    L.push(
      `  ${pad("profile", 14)}${padR("sess", 6)}${padR("turns", 7)}${padR("查阅", 6)}` +
        `${padR("segment", 9)}${padR("曝光", 6)}${padR("零查阅", 8)}`
    );
    for (const p of agg.profiles) {
      L.push(
        `  ${pad(p.profile, 14)}${padR(String(p.sessions), 6)}${padR(String(p.turns), 7)}` +
          `${padR(String(p.consults), 6)}${padR(p.avgSegmentLen === null ? "-" : String(p.avgSegmentLen), 9)}` +
          `${padR(String(p.exposedDomains), 6)}${padR(String(p.zeroConsultDomains), 8)}`
      );
    }
  }
  L.push("");

  // ===== 2. Domain 采用排行 =====
  L.push("【2】Domain 采用（曝光侧=产物 trigger-index；查阅侧=pt_inject）");
  if (agg.domains.length === 0) {
    L.push("  (无数据)");
  } else {
    L.push(
      `  ${pad("domain", 24)}${padR("曝光pf", 8)}${padR("曝光sess", 10)}${padR("被查", 6)}${padR("被查sess", 10)}${padR("采用率", 8)}`
    );
    for (const d of agg.domains.slice(0, MAX_ROWS)) {
      const rate = d.adoptionRate === null ? "-" : `${(d.adoptionRate * 100).toFixed(1)}%`;
      L.push(
        `  ${pad(d.domain, 24)}${padR(String(d.exposedProfiles), 8)}${padR(String(d.exposureSessions), 10)}` +
          `${padR(String(d.consulted), 6)}${padR(String(d.consultedSessions), 10)}${padR(rate, 8)}`
      );
    }
    if (agg.domains.length > MAX_ROWS) {
      L.push(`  …共 ${agg.domains.length} 个 domain（前 ${MAX_ROWS} shown）`);
    }
  }
  L.push("");

  // ===== 3. 零查阅清单 + 诊断 =====
  L.push(`【3】零查阅清单（曝光 session 数 ≥ ${ZERO_CONSULT_EXPOSURE_THRESHOLD} 且被查 0）`);
  if (agg.zeroConsult.length === 0) {
    L.push("  (无——没有手册摆在多个 session 面前却 0 次被查)");
  } else {
    for (const z of agg.zeroConsult.slice(0, MAX_ROWS)) {
      const expo = `曝光 ${z.exposureSessions} sess / ${z.exposedProfiles} pf`;
      L.push(`  ${pad(z.domain, 24)}${pad(expo, 26)}被查 0`);
    }
    if (agg.zeroConsult.length > MAX_ROWS) {
      L.push(`  …共 ${agg.zeroConsult.length} 个`);
    }
    L.push("  诊断（只给证据，不判死刑——决策留给人）:");
    L.push("    (a) trigger desc 没写清「什么时候该查它」→ 跑 /pt info lint 查 desc 质量");
    L.push("    (b) 任务真不需要这本 → 降级 optional-domains，省 segment 字节");
  }
  L.push("");

  // ===== 4. 注入成本 =====
  L.push("【4】注入成本（固定注入面 = 每轮硬注入的 segment）");
  if (agg.costs.length === 0) {
    L.push("  (无编译产物)");
  } else {
    L.push(
      `  ${pad("profile", 14)}${padR("session", 9)}${padR("trigger", 9)}${padR("manual", 9)}` +
        `${padR("合计", 9)}${padR("占比 s/t/m", 16)}${padR("重建", 6)}${padR("最近seg", 10)}`
    );
    for (const c of agg.costs.slice(0, MAX_ROWS)) {
      L.push(
        `  ${pad(c.profile, 14)}${padR(String(c.sessionContextChars), 9)}${padR(String(c.triggerIndexChars), 9)}` +
          `${padR(String(c.referenceManualChars), 9)}${padR(String(c.totalChars), 9)}` +
          `${padR(`${c.share[0].toFixed(0)}/${c.share[1].toFixed(0)}/${c.share[2].toFixed(0)}%`, 16)}` +
          `${padR(String(c.rebuilds), 6)}${padR(c.lastSegmentLen === null ? "-" : String(c.lastSegmentLen), 10)}`
      );
    }
    if (agg.costs.length > MAX_ROWS) {
      L.push(`  …共 ${agg.costs.length} 个 profile`);
    }
    L.push(
      "  ROI 提示: 采用率 ÷ segment 字节 = Domain ROI——零查阅 + 大 segment 的是第一优先修剪对象"
    );
  }
  L.push("");

  // ===== 5. 检查值班 =====
  L.push("【5】检查值班（A2 主动检查 / A3 硬约束 / Manual 使用）");
  const o = agg.checkDuty.outcomes;
  const completed = o.COMPLETED ?? 0;
  const deviates = o.DEVIATED ?? 0;
  L.push(`  检查结果: COMPLETED ${completed} / DEVIATED ${deviates}`);
  L.push(`  硬约束: 阻断 ${agg.checkDuty.blocked} / 绕过 ${agg.checkDuty.bypass}`);
  if (agg.checkDuty.noDeliveryData) {
    L.push("  内容到场层: 无数据（--pt-observe 未开启）");
  } else {
    L.push(
      `  内容到场层: injectionMatched=${agg.checkDuty.injectionMatched === null ? "null" : String(agg.checkDuty.injectionMatched)}（观测点一致性，非端到端保证）`
    );
  }
  L.push(`  Manual 启动: ${agg.checkDuty.manualStarts} 次`);
  for (const m of agg.checkDuty.manualByProcedure.slice(0, 5)) {
    L.push(`    ${pad(m.procedure, 24)}${m.count}`);
  }
  L.push("");

  // ===== Blueprint 一行带过 =====
  const bpText = agg.blueprints.map((b) => `${b.blueprint}×${b.count}`).join(", ") || "(无)";
  L.push(`Blueprint: ${bpText}`);
  if (agg.blueprints.length <= 1) {
    L.push("  (单一蓝图——零方差，无对比面；只作结构成本视图，不作效果结论)");
  }
  L.push("");

  // ===== 诚实尾注（固定）=====
  L.push("—— 诚实尾注 ——");
  L.push(
    "· 数据 = Pt 观测点事实，不做因果声明；查阅 ≠ 遵守（执行侧另见 pt-execution-observability-gap）"
  );
  if (agg.ptInjectUnattributable > 0) {
    L.push(
      `· domain 归因自 Layer 1 F1.2 起（commit 7aa45ff）：${agg.ptInjectTotal} 次 pt_inject 中 ` +
        `${agg.ptInjectUnattributable} 次无 domain 归因 → 零查阅判定只对 F1.2 后数据有效`
    );
  } else {
    L.push("· domain 归因自 Layer 1 F1.2 起（commit 7aa45ff）：本批 pt_inject 全部可归因");
  }
  if (scan.fallbackProfileLoads > 0) {
    L.push(
      `· ${scan.fallbackProfileLoads} 次 profile 从 default fallback 加载（只计数不参与归因——归因主源是 session 结束值）`
    );
  }
  L.push("· 曝光侧按 profile 统计（编译产物每 profile 只留最近一次）——表里看不到 ≠ 没被查过");
  if (agg.exposureCoverage.coveredProfiles < agg.exposureCoverage.activeProfiles) {
    L.push(
      `· 曝光侧覆盖率: ${agg.exposureCoverage.coveredProfiles}/${agg.exposureCoverage.activeProfiles} 活跃 profile 有产物` +
        `（无产物: ${agg.profilesWithoutExposure.join(", ")}）`
    );
  }
  return L.join("\n");
}

/** 左对齐补空格（按显示宽度近似——ASCII 场景足够）。 */
function pad(s: string, width: number): string {
  return s.length >= width ? `${s} ` : s + " ".repeat(width - s.length);
}

/** 右对齐补空格。 */
function padR(s: string, width: number): string {
  return s.length >= width ? `${s} ` : " ".repeat(width - s.length) + s;
}

/** 入口：读数据 → 聚合 → 渲染。 */
export async function buildStatsText(cwd: string): Promise<string> {
  const [summaries, scan, products] = await Promise.all([
    readSummaryLines(cwd),
    readLogEntries(cwd),
    readContextProducts(cwd),
  ]);
  return formatStatsText(aggregateFrom(summaries, scan, products), scan);
}

/** 从已读的三源数据聚合（纯函数，供 buildStatsText 与测试复用）。 */
export function aggregateFrom(
  summaries: SessionSummaryRecord[],
  scan: LogScan,
  products: ProductInfo[]
): StatsAggregation {
  const profiles = aggregateProfiles(summaries, scan, products);
  const sessionCounts = profileSessionCounts(summaries);
  const domains = aggregateDomains(scan, products, sessionCounts);
  const zeroConsult = aggregateZeroConsult(domains);
  const costs = aggregateCosts(scan, products);
  const checkDuty = aggregateCheckDuty(summaries, scan);

  const bpCount = new Map<string, number>();
  for (const p of products) {
    const bp = p.blueprint ?? "(unknown)";
    bpCount.set(bp, (bpCount.get(bp) ?? 0) + 1);
  }
  const blueprints = [...bpCount.entries()]
    .map(([blueprint, count]) => ({ blueprint, count }))
    .sort((a, b) => b.count - a.count || a.blueprint.localeCompare(b.blueprint));

  let earliest: string | null = null;
  let latest: string | null = null;
  for (const s of summaries) {
    for (const t of [s.startedAt, s.endedAt]) {
      if (!t) continue;
      if (earliest === null || t < earliest) earliest = t;
      if (latest === null || t > latest) latest = t;
    }
  }

  const activeProfiles = new Set(profiles.map((p) => p.profile));
  const covered = new Set(products.map((p) => p.profile).filter((x): x is string => x !== null));
  const withoutExposure = [...activeProfiles].filter((p) => !covered.has(p)).sort();

  return {
    profiles,
    domains,
    zeroConsult,
    costs,
    checkDuty,
    blueprints,
    fallbackSessions: scan.fallbackProfileLoads,
    ptInjectTotal: scan.ptInjectTotal,
    ptInjectAttributable: scan.ptInjectWithDomain,
    ptInjectUnattributable: scan.ptInjectTotal - scan.ptInjectWithDomain,
    logFileCount: 0,
    dataWindow: { earliest, latest },
    exposureCoverage: {
      activeProfiles: activeProfiles.size,
      coveredProfiles: [...activeProfiles].filter((p) => covered.has(p)).length,
    },
    profilesWithoutExposure: withoutExposure,
    effectiveSessions: scan.effectiveSessions.length,
  };
}
