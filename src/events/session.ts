// src/events/session.ts
// session 生命周期事件 handler（session_start / session_compact / session_shutdown）。
// 从 index.ts 抽出（Step 2），逻辑零变更——只搬位置 + 改 import。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import {
  computeHealthHash,
  readPersistedHealthHash,
  writePersistedHealthHash,
} from "../health-state.js";
import { scanProjectHealth, formatHealthSummary } from "../asset-health.js";
import { loadBuiltinPack, loadProjectPack, loadSettingsPacks } from "../asset-pack/loader.js";
import { validatePack } from "../asset-pack/validate.js";
import {
  detectDefaultProfile,
  detectSingleProfile,
  readProjectSetting,
  readToolInputLogMode,
} from "../config.js";
import { errMsg } from "../diagnostics.js";
import { readProfileFromSession, persistProfileToSession } from "../profile-persist.js";
import { PtLogger } from "../log.js";
import {
  type ProfileLoadSource,
  clearSessionById,
  getSessionById,
  resetSessionState,
} from "../session.js";
import {
  refreshInjectionFooter,
  tryRestoreLastTurnRef,
  tryRestoreManual,
} from "../manual-session.js";
import {
  getSessionIdFromCtx,
  registerInjectionIfReady,
  transpileActive,
} from "../shared/session-helpers.js";
import { readTurnOutputs } from "../turn-output.js";

/** 注册 session 生命周期事件 handler。从 index.ts 抽出，逻辑零变更。 */
export function registerSessionEvents(pi: ExtensionAPI): void {
  // ========== session_start：生成 sessionId + 创 logger + 读默认 profile + 转译 + 注册 adapter ==========
  // v10.x（issue pt-context-persist-lost 修复）：fallback 链加第四源（session JSONL）。
  //   优先级：flag > settings > session > auto。
  //   session 优先于 auto——保留用户上次选择，避免项目级 auto（>1 project profile 时）抹除用户偏好。
  //   加载成功后调 `persistProfileToSession(pi, picked)` 把来源同步到 JSONL
  //     （flag/settings/session 任意来源加载的 profile 都写回 session，作为下次 fallback 的首选）。
  // v11.x：fallback 链额外加 manual 恢复（独立于 profile 链——profile 失败不影响 manual 恢复）。
  //   manual 读出后校验文件存在 + status !== completed；满足才挂载 widget。
  // v12.x：从 ctx.sessionManager.getSessionId() 拿 sessionId，按 sessionId 写 per-session state。
  pi.on("session_start", async (_event, ctx) => {
    const sessionId = getSessionIdFromCtx(ctx);
    if (!sessionId) {
      ctx.ui.notify("Pt：无法获取 session id（pi 版本不兼容）", "error");
      return;
    }
    const s = getSessionById(sessionId);
    // v18.x（issue pt-footer-status-stale-cache）：session 重建时（pi-web wrapper 重建 /
    // idle timeout / reload）clearSessionById 可能未到达（shutdown event 丢失），导致
    // SessionState 残留 stale lastFooterText。session_start 是 pt 唯一可靠的 session
    // 边界感知入口——重置缓存确保首次 refreshInjectionFooter 必写 setStatus。
    s.lastFooterText = null;
    // v19（B3）：从 session JSONL 回填历史轮次产出（跨进程续跑可恢复）+ 读回注开关。
    s.turnOutputs = readTurnOutputs(ctx.sessionManager);
    s.turnOutputInject =
      (await readProjectSetting<string>(ctx.cwd, "pt.turn-output-inject")) !== "off";
    // v19（issue pt-adoption-observability Layer 1 F1.1）：session id 统一用 Pi 的完整 id——
    //   旧实现自造 8-hex 短 id 并把它记进 session:start 日志，导致：
    //   ① session:start 与 tool:call / turn:* 日志的 ctx.sessionId 形态不同 → 无法 join
    //      （per-session 聚合做不成，issue §十 曾因此误判"写操作率 17%"）；
    //   ② /pt logs、/pt logs clear 用 s.sessionId 拼文件名 → 指向不存在的 pt-<短id>.log。
    //   完整 id 是 Pi 持有的事实来源，不再自造短 id。
    s.sessionId = sessionId;
    s.logger = new PtLogger(ctx.cwd, "", sessionId);
    s.logger.info("session:turn-output hydrated", {
      count: s.turnOutputs.length,
      files: s.turnOutputs.flatMap((o) => o.files),
      domains: s.turnOutputs.flatMap((o) => o.domains),
      inject: s.turnOutputInject,
    });
    // v19（Layer 1 F1.2）：tool:call 日志记 input 的范围（env > settings > 默认 pt-only）。
    s.toolInputLogMode = await readToolInputLogMode(ctx.cwd);
    s.logger.info("session:start", {
      sessionId,
      cwd: ctx.cwd,
      toolInputLogMode: s.toolInputLogMode,
    });

    s.lastCwd = ctx.cwd;

    // v18.x（决策 6）：先试恢复 lastTurnRef——compaction 线索是 session lifecycle 维度，
    // 独立于 profile 链（profile 失败也能恢复）。即使从未调过 pt_inject / pt_doc start
    // 也会快速返回（无 entry）。
    tryRestoreLastTurnRef(ctx, s);

    // v15.x PR4（§6.7.1 + §6.7.5）：pack 校验 + settings pack 接通
    // 两段独立 try/catch 兑底——任一异常都不能阻塞 session_start。
    // v15.x PR7（issue pt-remove-global-pack 移除）：globalPack 槽位删除，3 类 pack。
    // issue pt-cold-start-warning-noise（§短期方案 3）：transient validation 静默化——
    //   同 pack 名连续失败 N 次才 notify，避免 cache miss + reload race 弹窗轰炸。
    //   - 本次失败 → 增计数，连续 < TRANSIENT_NOTIFY_THRESHOLD 仅 log
    //   - 达到阈值 → notify "这真有问题"
    //   - 本次成功 → 清零计数（连续失败终止）
    const TRANSIENT_NOTIFY_THRESHOLD = 3;
    try {
      const projectPack = await loadProjectPack(ctx.cwd);
      const settingsPacks = await loadSettingsPacks(ctx.cwd); // PR4 接通
      const builtinPack = await loadBuiltinPack();
      // settings 包保持声明顺序（不 reverse）——校验顺序不影响结果（每个 pack 独立校验）
      const packsForValidate = [projectPack, ...settingsPacks, builtinPack];

      const results = await Promise.all(packsForValidate.map(validatePack));
      s.packValidation = results;

      // 更新 transientValidationFailures 计数——validation 结果中能定位到原始 pack 实例的
      // 只有 manifestWarnings 这类静态信息（assets 已加载），与 validation 状态独立。
      // 计数仅跟踪 validation 成功/失败（ok=true/false），与 manifest warnings 无关。
      const seenPackNames = new Set<string>();
      for (const r of results) {
        seenPackNames.add(r.pack);
        const prevCount = s.transientValidationFailures.get(r.pack) ?? 0;
        if (r.ok) {
          // 本次成功 → 清零（连续失败终止）
          if (prevCount > 0) {
            s.transientValidationFailures.set(r.pack, 0);
            s.logger?.debug("transientValidation:cleared", {
              pack: r.pack,
              source: r.source,
            });
          }
        } else {
          // 本次失败 → 增计数
          const newCount = prevCount + 1;
          s.transientValidationFailures.set(r.pack, newCount);
          s.logger?.warn("transientValidation:failed", {
            pack: r.pack,
            source: r.source,
            count: newCount,
            firstErr: r.errors[0]?.msg ?? "unknown",
          });
        }
      }
      // 清除已不存在的 pack 计数（settings pack 被项目移除后不增长）
      for (const k of [...s.transientValidationFailures.keys()]) {
        if (!seenPackNames.has(k)) s.transientValidationFailures.delete(k);
      }

      // project pack 降级（§6.7.3）—— 行为变化必须保留（强制回 guide），
      // 但通知受 transient threshold 控制（issue §短期方案 3）。
      const projectResult = results.find((r) => r.source === "project");
      if (projectResult && !projectResult.ok) {
        s.projectPackDegraded = true;
        const firstErr = projectResult.errors[0];
        const projectFailCount = s.transientValidationFailures.get(projectResult.pack) ?? 0;
        if (projectFailCount >= TRANSIENT_NOTIFY_THRESHOLD) {
          // 达到阈值才 notify——前 N-1 次仅 log（已在 transientValidation:failed 记录）
          ctx.ui.notify(
            `⚠ Pt: project pack 连续 ${projectFailCount} 次校验失败（${firstErr?.msg ?? "未知错误"}）。已降级到 builtin guide。`,
            "warning"
          );
          // issue pt-pack-repair-cwd-home-edge-case：cwd=~ 时附加决策引导
          const isCwdHome = ctx.cwd === homedir();
          if (isCwdHome) {
            ctx.ui.notify(
              `  ⚠ 检测到 cwd=~（${homedir()}）—— project pack 在 home 无项目上下文。建议：1) 切到项目目录后再跑；2) 临时调试可 mkdir -p ${projectPack.rootDir}/{domains,blueprints,profiles}；3) 啥都不做（builtin guide 已可用）`,
              "info"
            );
          } else {
            ctx.ui.notify(`  修复：调 pt_inject tool 获取 pack-repair 手册`, "info");
          }
        }
      }

      // v15.x PR4（§6.7.5）：settings pack 校验失败预警——跳过该 pack，不阻断其他
      // issue pt-cold-start-warning-noise（§短期方案 3）：同样受 transient threshold 控制。
      for (const r of results) {
        if (r.source === "settings" && !r.ok) {
          const failCount = s.transientValidationFailures.get(r.pack) ?? 0;
          if (failCount >= TRANSIENT_NOTIFY_THRESHOLD) {
            const firstErr = r.errors[0];
            ctx.ui.notify(
              `⚠ Pt: settings pack [@${r.pack}] 连续 ${failCount} 次校验失败（${firstErr?.msg ?? "未知"}）。已跳过该 pack。`,
              "warning"
            );
            ctx.ui.notify(`  修复：调 pt_inject tool 获取 pack-repair 手册`, "info");
          }
        }
      }

      s.logger?.info("session:pack validation", {
        projectOk: projectResult?.ok ?? false,
        results: results.map((r) => ({
          pack: r.pack,
          source: r.source,
          ok: r.ok,
          errorCount: r.errors.length,
          transientFailCount: s.transientValidationFailures.get(r.pack) ?? 0,
        })),
      });
    } catch (e) {
      // 校验异常仅 log，不阻塞 session_start（陷阱 3：不能阻塞）
      s.logger?.warn("session:pack validation failed", { err: errMsg(e) });
    }

    // v15.x PR7（issue pt-remove-global-pack 移除）：删除全局 Pack 初始化引导——
    //   全局 pack 不再存在（被 settings pack 替代）。settings pack 显式声明在
    //   .pi/settings.json 的 pt.asset-packs[]，无"首次创建"隐式引导。

    try {
      // Phase term-P2：flag/settings 链主读新名（pt-profile），旧名（pt-context）作 fallback 兼容。
      const flag = pi.getFlag("pt-profile") ?? pi.getFlag("pt-context");
      const flagVal = typeof flag === "string" && flag.trim() ? flag.trim() : undefined;

      const fromSettings =
        (await readProjectSetting<string>(ctx.cwd, "pt.pt-profile")) ??
        (await readProjectSetting<string>(ctx.cwd, "au.pt-profile")) ??
        (await readProjectSetting<string>(ctx.cwd, "pt.pt-context")) ?? // 向后兼容：旧 settings key
        (await readProjectSetting<string>(ctx.cwd, "au.pt-context"));
      const fromSession = readProfileFromSession(ctx.sessionManager); // v10.x
      const auto = await detectSingleProfile(ctx.cwd);
      const defaultProfile = auto ?? (await detectDefaultProfile(ctx.cwd));

      // 显式分支记录来源（便于 /pt status 展示 + trace）
      let picked: string | undefined;
      let pickedFrom: ProfileLoadSource;
      if (flagVal) {
        picked = flagVal;
        pickedFrom = "flag";
      } else if (fromSettings) {
        picked = fromSettings;
        pickedFrom = "settings";
      } else if (fromSession) {
        picked = fromSession;
        pickedFrom = "session";
      } else if (auto) {
        picked = auto;
        pickedFrom = "auto";
      } else if (defaultProfile) {
        picked = defaultProfile;
        pickedFrom = "default";
      } else {
        picked = undefined;
        pickedFrom = null;
      }

      if (!picked) {
        s.injectionState = "idle";
        s.injectionError = null;
        refreshInjectionFooter(ctx.ui, s);
        ctx.ui.notify(
          "Pt：未找到 Profile。用 /pt-profile <name> 选择，或在 .pi/settings.json 设 pt.pt-profile。",
          "info"
        );
        s.loadedFrom = null;
        s.logger.info("session:no profile picked", {
          flagVal,
          fromSettings,
          fromSession,
          auto,
        });
        // v11.x：manual fallback 即使无 profile 也要试（手动追踪可独立于 profile）
        await tryRestoreManual(ctx, s);
        return;
      }

      await transpileActive(pi, ctx.cwd, picked, sessionId, (msg, level) =>
        ctx.ui.notify(msg, level)
      );
      // v15.x PR6（fix pt-active-profile-fallback-mismatch）：transpileActive 可能 fallback
      // （s.activeProfile 已被改写为 fallback 名）。此处用 s.activeProfile 同步 downstream。
      // - s.loadedFrom 设为 "fallback" 覆盖原 pickedFrom（如 "session"）——用户能看到
      // - persistProfileToSession 持久化 fallback 名（避免下次仍走 stale 路径）
      const finalProfileName = s.activeProfile ?? picked;
      s.loadedFrom = s.activeProfile !== picked ? "fallback" : pickedFrom; // v10.x：可观测性
      persistProfileToSession(pi, finalProfileName); // v10.x：把当前来源同步到 JSONL（下次进程默认走 session）
      // 注册 AgentAdapter 注入（封装 before_agent_start + input）
      const injected = registerInjectionIfReady(pi, ctx, sessionId);
      // v11.x：profile 已加载但还没轮到下一轮 before_agent_start → pending
      s.injectionState = "pending";
      s.injectionError = null;
      refreshInjectionFooter(ctx.ui, s);
      s.logger.info("session:profile loaded", {
        profileName: finalProfileName,
        requested: picked, // v15.x PR6：用户原始请求（与 finalProfileName 不同 = fallback 发生）
        loadedFrom: s.loadedFrom,
        injected,
      });

      // v14.x（issue pt-asset-migration-visibility Layer 2）：
      //   session_start 末尾批量体检项目所有 profile——主动告知存量项目 schema 错误，
      //   避免"切换才暴露"。失败降级（不阻塞 session 启动）——scan 内部已 try/catch。
      // issue pt-cold-start-warning-noise（§短期方案 1）：hash 去重 + 跨 session 持久化——
      //   项目存量 issues 不变时不 notify，仅 footer 染色 + /pt check 查详情。
      //   user 反馈"我没改任何东西却反复被警告轰炸"——这里根治。
      const bundles = s.cachedBundles ?? [];
      const healthBundle = bundles[0];
      if (healthBundle) {
        const report = await scanProjectHealth(
          ctx.cwd,
          healthBundle.profiles,
          healthBundle.blueprints,
          healthBundle.domains,
          healthBundle.packs,
          healthBundle.activeProfilePack,
          healthBundle.workingSet,
          { log: s.logger?.toWriter() }
        );
        s.assetHealthIssues = report.issues;

        // 计算新 hash，与上次跨 session 持久化的 hash 比较——
        // 不同才 notify（变化告知）。同时刷新 footer（footer 数字变化才染色，刷新本身无害）。
        const newHash = computeHealthHash(report.issues);
        const lastHash = s.lastHealthHash ?? (await readPersistedHealthHash(ctx.cwd));
        const hashChanged = newHash !== lastHash;
        if (report.errors > 0 || report.warnings > 0) {
          if (hashChanged) {
            // 仅在 hash 变化时 notify——否则仅 footer 染色（表示"持续问题"但不消费通知额度）
            // v0.3.0（issue pt-asset-health-diag-report-format）：用 formatHealthSummary 输出分类 + 路径
            // 取代原“纯计数 + 运行 /pt check”的冷冰冰文案。
            const summary = formatHealthSummary(report);
            ctx.ui.notify(
              summary ||
                `[pt] 项目有 ${report.issues.length} 项配置问题（运行 /pt check 查看详情）`,
              "warning"
            );
          }
          // 体检结果（不论 hash 是否变）都刷新 footer 染色（statusText / footer 会显示 issue 数）
          refreshInjectionFooter(ctx.ui, s);
        }
        s.lastHealthHash = newHash;
        // 跨 session 持久化——next session_start 时能正确去重
        await writePersistedHealthHash(
          ctx.cwd,
          newHash,
          report.issues.length,
          s.logger?.toWriter()
        );
        s.logger?.info("session:health scan done", {
          issueCount: report.issues.length,
          errors: report.errors,
          warnings: report.warnings,
          hashChanged,
          hash: newHash || "(empty)",
        });
      }

      // v11.x：profile 加载后试恢复 manual（独立于 profile 链）
      await tryRestoreManual(ctx, s);
    } catch (e) {
      ctx.ui.notify(`Pt 加载失败：${errMsg(e)}`, "error");
      // v13.x（issue pt-no-agent-context-reset-session-state 修复）：
      // 统一调 resetSessionState 清编译产物 + loadedFrom；保留 activeProfile（便于用户重试）
      resetSessionState(s);
      s.loadedFrom = null;
      s.injectionState = "failed";
      s.injectionError = errMsg(e);
      refreshInjectionFooter(ctx.ui, s);
      s.logger?.error("session:start failed", { err: errMsg(e) });
      // v11.x：profile 失败但 manual 仍可能独立恢复（手动追踪不依赖 profile）
      await tryRestoreManual(ctx, s);
    }
  });

  // ========== session_compact：compaction 后重注入 TurnContext 线索 ==========
  // v18.x（issue pt-turncontext-llm-call-trigger 决策 6）：
  //  线索 = TurnContext domain 名 + Manual 路径（引用指针，非内容缓存）。
  //  session_compact 事件触发 → 读 s.lastTurnRef → 通过 pi.sendMessage({ triggerTurn: true })
  //  注入固定线索作为 custom message → LLM 读到后据线索重新调 pt_inject / read Manual。
  //  v19（issue pt-llm-tool-consolidation）：线索文本改写——`pt_turn_inject` tool 名 → `pt_inject` tool 名。
  //  无条件重注入——线索很轻（domain 名 + 路径），多注一次不撑窗口，简化逻辑。
  //  session_compact 事件在 src/index.ts 注册而非 pi-adapter.ts——因为：
  //   1) pi.sendMessage 是 Pi 专属 API，AgentAPI 不暴露（保持 AgentAdapter 抽象纯净）
  //   2) 与 session_start / session_shutdown 同寿命周期事件归位一致
  pi.on("session_compact", async (event, ctx) => {
    const sessionId = getSessionIdFromCtx(ctx);
    if (!sessionId) return;
    const s = getSessionById(sessionId);
    if (!s.lastTurnRef) return; // 无线索可重注入（从未调过 pt_inject / pt_doc start）
    const { turnInjectDomain, manualPath } = s.lastTurnRef;
    // 空 lastTurnRef（两字段都空）也不注入
    if (!turnInjectDomain && !manualPath) return;
    const lines: string[] = [
      "[pt] 上次 TurnContext 线索（compaction 后恢复）：",
      `- TurnContext Domain: ${turnInjectDomain || "(未调 pt_inject)"}（调 pt_inject tool domain=${turnInjectDomain || "<domain>"} 重新获取详情）`,
    ];
    if (manualPath) {
      lines.push(`- Manual 实例: ${manualPath}（用 read 工具读取继续执行）`);
    }
    try {
      await pi.sendMessage(
        {
          customType: "pt-compaction-clue",
          content: lines.join("\n"),
          display: true,
        },
        { triggerTurn: true }
      );
      s.logger?.info("compaction:clue-injected", {
        turnInjectDomain,
        manualPath,
        reason: event.reason,
      });
    } catch (e) {
      s.logger?.warn("compaction:sendMessage failed", { err: String(e) });
    }
  });

  // ========== session_shutdown：flush logger + 清内存态 ==========
  // v10.x：先 flush 避免丢尾，再 reset 清状态
  // v11.x：resetSession 覆盖 injectionState / activeManual / cachedManualProgress（widget 不持久）
  // v12.x：调 clearSessionById(sessionId) 精确清本 session state，pi-web 多 session 互不污染
  pi.on("session_shutdown", async (_event, ctx) => {
    const sessionId = getSessionIdFromCtx(ctx);
    if (!sessionId) return;
    const s = getSessionById(sessionId);
    if (s.logger) {
      s.logger.info("session:shutdown");
      await s.logger.flush();
    }
    // 同一运行时保留 Pi handler 绑定，但清除旧 session 的 segment/context，
    // 避免新 session 在尚未重新选择 Profile 时继续注入旧内容。
    s.activeAdapter?.resetInjection?.();
    clearSessionById(sessionId);
  });
}
