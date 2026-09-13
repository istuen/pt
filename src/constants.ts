// src/constants.ts — 路径常量 + Domain H2 段名常量（pt-quality #4 + #5）
//
// 路径常量集中管理：资产/缓存/输出目录
// 模块名常量：Domain 的 H2 段名（Scene/Trigger/Manual/Term）
//
// 注意：聚合组名（Blueprint groups[].name，如"会话背景"/"参考手册"）是人类自定义的语义名，
// 不应常量化——常量化的是 Domain 内的 H2 段名（v9 资产的标准段）。

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ==================== 路径常量 ====================
//
// .pt/ 目录布局规范（v11 重排）：
//   .pt/assets/   入 git — 转译资产（domains / blueprints / profiles）
//   .pt/docs/     入 git — 文档（designs 设计与执行 / issues 问题跟踪）
//   .pt/manuals/  gitignore — pt_manual 工作文档
//   .pt/cache/    gitignore — 运行产物（contexts 编译 / fulls 完整 prompt / raws segment）
//   .pt/logs/     gitignore — NDJSON trace
//
// 规范源：asset-workflow domain 的 `directory-layout` 场景是 .pt/ 布局的声明式 spec
// （用户可改该 Domain 调整布局）。当前代码路径仍读本文件常量；未来计划让转译层
// 直接读 Domain 配置（届时删除下方硬编码，由 parse → compile 注入）。
// 改路径时务必同步改 asset-workflow.md 的 directory-layout 场景。

/** .pt/ 资产根目录 */
export const ASSETS_DIR = ".pt/assets";

/** Domain md 目录（type=term/workflow/stack/扩展） */
export const DOMAINS_DIR = `${ASSETS_DIR}/domains`;

/** Blueprint yaml 目录（v9 结构层——groups: name + inject + modules，跨项目复用） */
export const BLUEPRINTS_DIR = `${ASSETS_DIR}/blueprints`;

/** Profile md 目录（v9 配置层——blueprint + domains + groups H2 实例化） */
export const PROFILES_DIR = `${ASSETS_DIR}/profiles`;

/** AgentContext 物理缓存目录（Blueprint.compilation.cacheDir 默认值）。
 *  Phase term-P1：.pt/cache/contexts → .pt/cache/agent-contexts（Context IR 改名 AgentContext 同步）。 */
export const CACHE_DIR = ".pt/cache/agent-contexts";

/** /pt raw 输出目录（segment dump） */
export const RAW_DIR = ".pt/cache/raws";

/** /pt full 输出目录（完整 systemPrompt dump） */
export const FULL_DIR = ".pt/cache/fulls";

/** /pt manual 输出目录（手册实例文档） */
export const MANUAL_DIR = ".pt/manuals";

/** 内建资产根目录（随 npm 包发布，跨项目复用）。
 *  用 import.meta.url 定位包自身路径——不能用 cwd 相对路径（外部用户 cwd ≠ 包路径）。
 *  mdAdapter fallback：项目 .pt/assets/ 优先，内建补充；同名时项目覆盖内建。 */
const SRC_DIR = dirname(fileURLToPath(import.meta.url));
export const BUILTIN_ASSETS_DIR = join(SRC_DIR, "builtin", "assets");

// ==================== Domain H2 段名常量 ====================

/** Domain 的 Scene 段（Phase term-P9.3：统一为 Term[]，含可选 path 字段）
 *  拆 Type 后 Scene 不再按 type 分发 schema——一个 H2 段一个 schema（Term[]）。 */
export const MOD_SCENE = "Scene";

/** Domain 的 Trigger 段（v9 索引段——H3 + desc/hint 列表） */
export const MOD_TRIGGER = "Trigger";

/** Domain 的 Rules 段（Phase term-P9.2：从 Manual 拆出）—— Rule[]（pt-quality 等） */
export const MOD_RULES = "Rules";
/** Domain 的 Flows 段（Phase term-P9.2：从 Manual 拆出）—— FlowTemplate[]（dev-workflow 等） */
export const MOD_FLOWS = "Flows";
/** Domain 的 Checklists 段（Phase term-P9.2：新增）—— Checklist[]（pt-collab 等） */
export const MOD_CHECKLISTS = "Checklists";
/** Phase term-P8：会话参与者信息段——me Domain 专用，Term[] 与 Scene 同构，复用 renderSceneModule。
 *  与 Scene 的区别：语义上是"会话参与者描述"（who am I + goal + how we collaborate），
 *  不是"领域场景元数据"。拆出来让 Blueprint 模块清单更具语义化。 */
export const MOD_PARTICIPANT = "Participant";

/** Phase modules-to-profile-complete：user-info Domain 专用段名。Phase term-P8 时叫 "Participant"，
 *  本 phase 拆分为 "User"（user-info）和 "Agent"（agent-info）——段名 = 命名空间，
 *  限定到单个 domain 通过专用段名实现，避免 modName 形态 3（domain:段.项）的重复写引用。 */
export const MOD_USER = "User";
/** agent-info Domain 专用段名——同上拆分理由。 */
export const MOD_AGENT = "Agent";

/** Domain 的 Term 段（fallback term 形态，未指定 type 默认走 Term[]） */
export const MOD_TERM = "Term";

// ==================== 资产文件名后缀 ====================

/** Blueprint 文件名后缀标记（v9 命名约定：<name>.blueprint.yaml，Phase term-P4.5）
 *  用于识别 Blueprint 资产——保留 .blueprint 部分以便从文件名提取蓝本名。 */
export const SUFFIX_BLUEPRINT = ".blueprint";
/** Blueprint 文件扩展名（Phase term-P4.5：载体从 .md 转 .yaml） */
export const SUFFIX_BLUEPRINT_YAML = ".blueprint.yaml";

/** Profile 文件名后缀（v9 命名约定：<name>.profile.md） */
export const SUFFIX_PROFILE = ".profile";

/** Domain 文件后缀（.md 即可，无 type 后缀） */
export const SUFFIX_MD = ".md";

// ==================== Agent 名常量 ====================

/** Pi Agent adapter 名 */
export const AGENT_PI = "pi";
