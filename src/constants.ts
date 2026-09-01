// src/constants.ts — 路径常量 + Domain H2 段名常量（pt-quality #4 + #5）
//
// 路径常量集中管理：资产/缓存/输出目录
// 模块名常量：Domain 的 H2 段名（Scene/Trigger/Manual/Term）
//
// 注意：注入点名（Blueprint H2，如"会话知识"/"参考手册"）是人类自定义的语义名，
// 不应常量化——常量化的是 Domain 内的 H2 段名（v9 资产的标准段）。

// ==================== 路径常量 ====================

/** .pt/ 资产根目录 */
export const ASSETS_DIR = ".pt/assets";

/** Domain md 目录（type=term/workflow/stack/扩展） */
export const domainsDir = () => `${ASSETS_DIR}/domains`;

/** Blueprint md 目录（v9 结构层——agent + injectionPoints + Compilation） */
export const blueprintsDir = () => `${ASSETS_DIR}/blueprints`;

/** Profile md 目录（v9 配置层——blueprint + domains + injectionPoints） */
export const profilesDir = () => `${ASSETS_DIR}/profiles`;

/** Context 物理缓存目录（Blueprint.compilation.cacheDir 默认值） */
export const CACHE_DIR = ".pt/contexts/cache";

/** /pt raw 输出目录 */
export const RAW_DIR = ".pt/raws";

/** /pt full 输出目录 */
export const FULL_DIR = ".pt/fulls";

// ==================== Domain H2 段名常量 ====================

/** Domain 的 Scene 段（term→Term[] / workflow→externals / stack→ToolRef[]） */
export const MOD_SCENE = "Scene";

/** Domain 的 Trigger 段（v9 索引段——H3 + desc/hint 列表） */
export const MOD_TRIGGER = "Trigger";

/** Domain 的 Manual 段（term→Rule[] / workflow→FlowTemplate[]） */
export const MOD_MANUAL = "Manual";

/** Domain 的 Term 段（fallback term 形态，未指定 type 默认走 Term[]） */
export const MOD_TERM = "Term";

// ==================== 注入点 target 常量 ====================

/** Pi Agent 系统提示注入位置（before_agent_start 事件） */
export const TARGET_SYSTEM_PROMPT = "system_prompt";

/** Pi Agent 上下文消息注入位置（input 事件 transform） */
export const TARGET_CONTEXT_MESSAGE = "context_message";

// ==================== 资产文件名后缀 ====================

/** Blueprint 文件名后缀（v9 命名约定：<name>.blueprint.md） */
export const SUFFIX_BLUEPRINT = ".blueprint";

/** Profile 文件名后缀（v9 命名约定：<name>.profile.md） */
export const SUFFIX_PROFILE = ".profile";

/** Domain 文件后缀（.md 即可，无 type 后缀） */
export const SUFFIX_MD = ".md";

// ==================== Agent 名常量 ====================

/** Pi Agent adapter 名 */
export const AGENT_PI = "pi";