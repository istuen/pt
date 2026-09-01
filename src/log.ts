// src/log.ts — Pt 持久化日志（NDJSON, append-only, 串行写链）
//
// 设计原则：
// - 零运行时依赖：只用 node:fs/promises + node:path，std lib 搞定
// - 异步串行链 (writeChain) 保证写入顺序，避免 race condition
// - 文件路径：<cwd>/.pt/logs/pt.log（NDJSON 行式 JSON, 崩溃时只丢一行）
// - 失败静默：日志写盘错误不影响主流程（仅 console.error 保留可见性）
// - 不做自动 rotate：rollover 留作外部脚本 / 手工处理（Pt 转译是低频事件）
//
// 技术债 Tech Debt T-new: 与 pt-quality #9（error-via-notify）配套——
//   notify 走 UI 瞬时反馈，log 走磁盘持久 trace，两者互补。

import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** 日志根目录（项目根下，git 排除）。 */
export const LOG_DIR = ".pt/logs";

/** 主日志文件名（单文件 append）。 */
export const LOG_FILE = "pt.log";

/** Pt 支持的日志级别（与 ctx.ui.notify 的 level 集合兼容 + debug）。 */
export type PtLogLevel = "debug" | "info" | "warning" | "error";

/** 单条日志记录（NDJSON 行）。 */
export interface PtLogEntry {
  /** ISO 时间戳（毫秒精度） */
  ts: string;
  /** 日志级别 */
  level: PtLogLevel;
  /** 人类可读消息（与 notify msg 一致或更细） */
  msg: string;
  /** 结构化上下文（cwd / profile / 关联数据）。SourceAdapterContext 里 log api 走 unknown 留扩展位 */
  ctx?: Record<string, unknown>;
}

/** 给 SourceAdapterContext.log 用的接口（不带 baseCtx，logger 内部注入）。
 *  v10.x 设计：log 接口不暴露 file path, 仅暴露级别方法 → 适配器层无法绕过 logger 写文件。 */
export interface PtLoggerWriter {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
}

/** PtLogger：per-session 单例（由 SessionState.logger 持有，避免跨 session 串台）。
 *
 *  v10.x：构造时传入 sessionId → 多并发 `pi` 进程的日志文件分离：
 *    - 主文件：`pt-<sessionId>.log`
 *    - 反查：ctx.sessionId 字段注入每条 entry
 *
 *  使用方式（index.ts session_start）：
 *    session.sessionId = randomUUID().slice(0, 8);
 *    session.logger = new PtLogger(cwd, "", session.sessionId);
 */
export class PtLogger implements PtLoggerWriter {
  private writeChain: Promise<void> = Promise.resolve();
  private readonly baseCtx: Record<string, unknown>;

  constructor(
    public readonly cwd: string,
    public readonly profile: string = "",
    public readonly sessionId: string = "",
  ) {
    this.baseCtx = { cwd, profile, sessionId };
  }

  /** 当前 session 的日志文件路径：`pt-<sessionId>.log`。
   *  sessionId 为空时 fallback 为 `pt.log`（兼容未走 session_start 的旧调用）。 */
  get filePath(): string {
    const name = this.sessionId ? `pt-${this.sessionId}.log` : LOG_FILE;
    return join(this.cwd, LOG_DIR, name);
  }

  /** 给 SourceAdapterContext.log 用的适配对象（绑定 baseCtx 的 writer）。 */
  toWriter(): PtLoggerWriter {
    return {
      debug: (m, c) => this.debug(m, c),
      info: (m, c) => this.info(m, c),
      warn: (m, c) => this.warn(m, c),
      error: (m, c) => this.error(m, c),
    };
  }

  /** 内部：链式串行 + 静默失败（写盘错误不传染到链上下一步）。 */
  private write(level: PtLogLevel, msg: string, ctx?: Record<string, unknown>): void {
    const entry: PtLogEntry = {
      ts: new Date().toISOString(),
      level,
      msg,
      ctx: { ...this.baseCtx, ...ctx },
    };
    this.writeChain = this.writeChain
      .then(async () => {
        try {
          await mkdir(join(this.cwd, LOG_DIR), { recursive: true });
          await appendFile(this.filePath, JSON.stringify(entry) + "\n", "utf8");
        } catch (e) {
          console.error("[pt-log] write failed:", e instanceof Error ? e.message : e);
        }
      })
      .catch(() => {/* 链上一步失败不传染到下一步 */});
  }

  debug(msg: string, ctx?: Record<string, unknown>): void {
    this.write("debug", msg, ctx);
  }

  info(msg: string, ctx?: Record<string, unknown>): void {
    this.write("info", msg, ctx);
  }

  warn(msg: string, ctx?: Record<string, unknown>): void {
    this.write("warning", msg, ctx);
  }

  error(msg: string, ctx?: Record<string, unknown>): void {
    this.write("error", msg, ctx);
  }

  /** 等待在飞写入全部落地（session_shutdown 时调，避免丢尾）。 */
  async flush(): Promise<void> {
    await this.writeChain.catch(() => {});
  }

  /** /pt logs 命令支持：从磁盘读最近 N 条（按文件顺序，NDJSON 逐行解析）。
   *  v10.x：默认从 `pt.log`（无 sessionId）读——兼容旧文件；如想读 session 文件，传 sessionId。 */
  static async tail(cwd: string, n = 50, sessionId?: string): Promise<PtLogEntry[]> {
    const file = sessionId
      ? join(cwd, LOG_DIR, `pt-${sessionId}.log`)
      : join(cwd, LOG_DIR, LOG_FILE);
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch {
      return [];  // 文件不存在 → 返空（首次启动）
    }
    const lines = raw.trim().split("\n");
    const slice = lines.slice(-n);
    const out: PtLogEntry[] = [];
    for (const line of slice) {
      try {
        out.push(JSON.parse(line) as PtLogEntry);
      } catch {
        /* 跳过损坏行（半行 / 篡改） */
      }
    }
    return out;
  }

  /** /pt logs clear 命令。清空日志文件（保留目录）。
   *  v10.x：清单一文件（默认 `pt.log` 或 sessionId 指定）。 */
  static async clear(cwd: string, sessionId?: string): Promise<void> {
    const dir = join(cwd, LOG_DIR);
    await mkdir(dir, { recursive: true });
    const file = sessionId
      ? join(dir, `pt-${sessionId}.log`)
      : join(dir, LOG_FILE);
    await writeFile(file, "", "utf8");
  }

  /** /pt logs 命令支持：枚举所有日志文件（多 session 时列出全部）。 */
  static async list(cwd: string): Promise<string[]> {
    const dir = join(cwd, LOG_DIR);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return [];
    }
    return entries.filter((f) => f.startsWith("pt-") && f.endsWith(".log")).sort();
  }
}
