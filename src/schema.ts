// src/schema.ts — v9 IR 契约
//
// 设计原则（见 docs/pt-asset-layering.md §0）：
// 1. Schema 是语义化的，不带任何格式痕迹（无 Section/Item/raw/heading）
// 2. Pt 定义契约，来源（OXN/YAML/...）实现 SourceAdapter
// 3. 三段式编译架构：parse（前端）→ compile（中端）→ render（后端）
//
// Phase 9.2：v9 四层模型重写（Blueprint 吸收 v8 Channel 结构 + 新增 Profile 配置层 + AgentAdapter 抽象）。
//
// 四层语义：
//   - Domain    ：内容层。异构领域知识，按 H2 切模块（Scene/Trigger/Manual/...），Type 标签区分内容性质。
//   - Blueprint ：结构层。Agent 端注入点结构（H2=注入点人类自定义名），声明 agent + 注入点 target/Modules/mode + 编译方式。
//   - Profile   ：配置层。业务端实例，引用 Blueprint + 选 Domains（YAML 全局 + 注入点追加）。
//   - Context   ：产物层。Profile 编译输出，按注入点聚合多 Domain 内容，物理文件 + hash 缓存。
// （Channel 保留为未来 Connector，预留层不实现）
//
// v9 相对 v8 的核心变化：
//   - Blueprint 吸收 v8 Channel 的 injectionPoints（结构层职责从 Channel 迁到 Blueprint）
//   - v8 Blueprint 的配置层职责 → Profile（用户面是 Profile）
//   - InjectionPointInstance 删 trigger/boundaries 字段（Boundaries 丢弃；Trigger 移到 Domain H2 段）
//   - 新增 AgentAdapter 接口（Pt 核心不感知 Agent API）
//   - SchemaBundle 加 profiles/activeProfile，去 channels

// ==================== 语义层原子 ====================

/** 业务术语原子 */
export interface Term {
  name: string;
  desc: string;
  /** 可选标签，不强制：作者判定放哪层（公理 = 业务语义源；定理 = 公理的组合或业务具体描述） */
  level?: "axiom" | "theorem";
}

/** 外部数据源引用（声明式：路径 + 协议，不在此处拉取） */
export interface ExternalRef {
  name: string;
  path: string;
  protocol?: "file" | "api" | "db";
}

/** 业务规则（挂到步骤或全局） */
export interface Rule {
  /** 挂到哪个步骤的 slot 名；"global" 表示跨模块聚合（hybrid 模式下抽到全局段） */
  slot: string;
  /** ban = 禁止项；invariant = 不变量 */
  type: "ban" | "invariant";
  /** 规则描述（人类可读） */
  check: string;
  /** ban 类型时列出具体禁止项 */
  items?: string[];
}

/** 手册步骤（workflow-Domain.## Manual 段内容） */
export interface FlowStep {
  /** 做什么 */
  desc: string;
  /** 从哪取数据（数据语义层） */
  dataSource?: ExternalRef;
  /** 套哪条规则（引用知识库的 Rule） */
  rule?: string;
  /** 期望产出什么 */
  output?: string;
}

/** 手册模板（workflow-Domain.## Manual 段声明，实例化后进 Context Message） */
export interface FlowTemplate {
  /** /name 触发 */
  name: string;
  /** 参数提示，如 "<客户ID> <金额>" */
  argumentHint?: string;
  /** 数据语义层：带 {{}} 占位符的前提 */
  intent: string;
  /** 手册结构层：步骤 + 数据源 + 期望产出 */
  steps: FlowStep[];
  /** 数据语义层：引用知识库的数据源 */
  externals: ExternalRef[];
}

/** 工具引用（stack-Domain.## Scene 段） */
export interface ToolRef {
  name: string;
  role?: string;
  operations?: string[];
}

// ==================== 结构层原子 ====================

/** 编排策略。InjectionPointConfig.mode 决定段落拼接顺序。 */
export interface StructureLayout {
  mode: "byDomain" | "byType" | "hybrid";
  /** byDomain / hybrid 时的模块顺序；未指定则原序 */
  domainOrder?: string[];
}

/** 流程节点（保留类型，v9 不再使用——Boundaries 丢弃，但类型留作未来扩展参考）。 */
export interface BoundaryNode {
  /** 步骤名 */
  slot: string;
  /** 依赖的前置 slot 名列表 */
  deps: string[];
  /** 步骤描述 */
  desc: string;
}

// ==================== v9 注入点（Blueprint 拥有，注入点是 Agent 端技术位置映射） ====================

/** Pi 注入位置（代码层技术名，由 InjectionPointConfig.target 映射）。
  *  v9：注入点名是 Blueprint H2 的人类自定义语义名（不写死"会话知识/参考手册"）。 */
export type InjectionTarget = "system_prompt" | "context_message" | string;

/** Blueprint 的注入点定义（对应 Blueprint md 的 H2，注入点名=人类自定义语义名）。 */
export interface InjectionPointConfig {
  /** 注入点名（语义名，Blueprint H2 标题，如 "会话知识"/"参考手册"）。 */
  name: string;
  /** Agent 注入位置（system_prompt / context_message / 扩展）。 */
  target: InjectionTarget;
  /** 聚合点：参与的 Domain H2 段名列表（来自 ### Modules 无符号项，data-driven）。 */
  modules: string[];
  /** 聚合方式（仅 system_prompt 类注入点有意义）。 */
  mode?: StructureLayout["mode"];
}

/** Profile 的注入点实例化（对应 Profile md 的 H2，与 Blueprint 的 InjectionPointConfig 同名）。
 *  v9：只保留 domains（追加到本注入点的 Domain 名列表）。trigger/boundaries 删除。 */
export interface InjectionPointInstance {
  /** 注入点名（与 Blueprint 的 InjectionPointConfig.name 对应）。 */
  name: string;
  /** 追加到本注入点的 Domain 名列表（只贡献该注入点）。 */
  domains: string[];
}

// ==================== v9 Compilation（Context 缓存配置） ====================

/** Context 缓存拆分策略。 */
export type CacheSplitStrategy = "single-file" | "by-injection-point";

/** Blueprint 的编译方式配置（## Compilation 段）。 */
export interface CompilationConfig {
  /** 缓存目录（默认 .pt/contexts/cache/）。 */
  cacheDir: string;
  /** 拆分策略（默认 single-file）。 */
  split: CacheSplitStrategy;
}

// ==================== 内容层：Domain ====================

/**
 * v9 Domain：内容层模块。承载语义定义与上下文模块内容。
 *   - type：内容性质标签（term/workflow/stack/扩展），决定各 H2 段**内部内容格式**。
 *   - modules：H2 段名 → 段内容（key = "Scene"/"Trigger"/"Manual"/...，开放扩展）。
 *
 * H2 段名是开放的——加新模块类型 = 加新 H2 段名 + Blueprint 声明该模块。
 * type 决定 H2 段内部格式，H2 段名决定内容去向——两者独立扩展。
 */
export interface Domain {
  name: string;
  /** 内容性质标签：term/workflow/stack/扩展 */
  type: string;
  /** H2 段名 → 段内容。Pt 核心按 H2 名读段，不硬编码段名。 */
  modules: Record<string, unknown>;
}

// ==================== 结构层：Blueprint（v8 Channel 吸收进来） ====================

/**
 * v9 Blueprint：Agent 端注入点结构，结构层模块。
 *   - agent：声明用哪个 AgentAdapter（默认 "pi"）。
 *   - injectionPoints：注入点列表（H2=注入点人类自定义名），定义 target + Modules 聚合点 + mode。
 *   - compilation：编译方式（缓存目录 + 拆分策略）。
 *
 * 跨项目复用。加新 Agent 只加 AgentAdapter；加新注入点 = Blueprint 加 H2 + ### Modules。
 */
export interface Blueprint {
  name: string;
  /** 声明用哪个 AgentAdapter（默认 "pi"）。 */
  agent: string;
  /** 注入点列表（H2=注入点人类自定义名），定义 target + Modules + mode。 */
  injectionPoints: InjectionPointConfig[];
  /** 编译方式（缓存目录 + 拆分策略）。 */
  compilation: CompilationConfig;
}

// ==================== 配置层：Profile（v8 Blueprint 业务实例化角色） ====================

/**
 * v9 Profile：业务端实例，配置层模块。
 *   - blueprint：引用哪个 Blueprint（结构复用）。
 *   - domains：YAML 全局 Domain 列表，自动分发到所有注入点（有匹配 H2 段则贡献）。
 *   - injectionPoints：注入点实例化（H2 = 注入点名，与 Blueprint 同名），其下 ### Domains 是追加列表。
 *
 * 项目级，不跨项目复用。
 */
export interface Profile {
  name: string;
  /** 引用的 Blueprint 名（结构复用）。 */
  blueprint: string;
  /** 全局 Domain 列表，自动分发到所有注入点。 */
  domains: string[];
  /** 注入点实例化（与 Blueprint 的 InjectionPointConfig 同名）。 */
  injectionPoints: InjectionPointInstance[];
}

// ==================== 产物层：Context ====================

/**
 * v9 Context：产物层，Profile 编译输出。
 *   - sourceHash：hash(Profile + Blueprint + Domains) 组合——任一变化即失效。
 *   - modules   ：注入点名（语义名）→ 聚合后的 markdown 字符串。
 *
 * Context 是物理文件（.pt/contexts/cache/*.context.md），缓存复用。
 * Pt 读取 Context 时比 sourceHash：一致用缓存，不一致重编译覆盖。
 *
 * v9 相对 v8 变化：sourceHash 输入从 (Blueprint + Channel + Domains) 改为 (Profile + Blueprint + Domains)。
 */
export interface Context {
  /** Profile 名（Context 跟 Profile 一对一）。 */
  name: string;
  /** hash(profile + blueprint + domains)，缓存失效依据。 */
  sourceHash: string;
  /** 注入点名（语义名）→ 聚合后的 markdown 字符串。 */
  modules: Record<string, string>;
}

// ==================== IR 集合（编译期内存态） ====================

/**
 * v9 SchemaBundle：编译期内存态，包含所有加载的 IR。
 *   - domains：所有 Domain（按 type 区分承载内容）。
 *   - blueprints：所有 Blueprint（结构层模块，Agent 端）。
 *   - profiles：所有 Profile（配置层模块，业务端）。
 *   - activeProfile：当前激活的 Profile 名，决定产物走哪个组合。
 *
 * （v8 的 channels 字段删除——Channel 保留为未来 Connector，本版本不实现）
 */
export interface SchemaBundle {
  domains: Domain[];
  blueprints: Blueprint[];
  profiles: Profile[];
  /** 当前激活的 Profile 名。 */
  activeProfile: string;
}

// ==================== Source Adapter 接口（依赖反转后） ====================

/** Adapter load 上下文（v9.1: 传 notify 上去代替 console.error，符合 pt-quality #9）。 */
export interface SourceAdapterContext {
  /** 错误/警告通知回调（可选；不传则走 console fallback）。 */
  notify?: (msg: string, level: "warning" | "error") => void;
}

/** 反转后的 SourceAdapter：load() 返回 SchemaBundle 而非 string。
 *  Pt 核心只认 SchemaBundle，不认任何来源格式。
 *  v9：参数是 profileName（用户面是 Profile，不是 Blueprint）。
 *  v9.1：增 adapterCtx 参数（可选）——adapter 可选传 notify 代替 console。 */
export interface SourceAdapter {
  name: string;
  load(cwd: string, profileName: string, adapterCtx?: SourceAdapterContext): Promise<SchemaBundle>;
}

// ==================== Agent 适配器接口 ====================

/** Agent UI 能力（可选，adapter 按需用）。 */
export interface AgentUI {
  notify(msg: string, level: "info" | "warning" | "error"): void;
  setStatus(name: string, text: string): void;
}

/** Agent 注入 API 的最小接口（AgentAdapter 用，不直接依赖 Pi ExtensionAPI）。
 *  v9.1 (P1.1)：加 ui 可选能力——adapter 可报错 / 设状态，不必。 */
export interface AgentAPI {
  on(event: string, handler: (...args: unknown[]) => unknown): void;
  registerCommand(name: string, spec: unknown): void;
  registerFlag(name: string, spec: unknown): void;
  getFlag(name: string): unknown;
  /** v9.1 可选 UI：index.ts 传入 Pi ctx.ui 适配后的对象。Adapter 可选。 */
  ui?: AgentUI;
}

/** Agent 适配器——适配不同 Agent 的注入机制。
 *  Pt 核心调 Adapter 接口，不直接调 Agent API。加新 Agent 只加 Adapter。 */
export interface AgentAdapter {
  /** Agent 名（pi / codex / opencode / ...） */
  name: string;
  /** 该 Agent 支持的技术注入点 target 名（Pi: system_prompt, context_message） */
  supportedTargets: string[];
  /** 设置编译产物（compile 后调） */
  setContext(ctx: Context, blueprint: Blueprint, domains: Domain[]): void;
  /** 启动时注册：把 Context 注入到 Agent（session_start 调用） */
  registerInject(api: AgentAPI, ctx: Context, blueprint: Blueprint): void;
  /** 查询可用手册（/pt flows 用） */
  listManuals?(ctx: Context, blueprint: Blueprint, domains: Domain[]): Array<{ name: string; hint?: string; domain: string }>;
}

// ==================== v9：Blueprint/Profile 名解析辅助 ====================

/** 从 Blueprint 列表里找指定名的 Blueprint。未找到返 undefined。 */
export function findBlueprint(blueprints: Blueprint[], name: string): Blueprint | undefined {
  return blueprints.find((b) => b.name === name);
}

/** 从 Profile 列表里找指定名的 Profile。未找到返 undefined。 */
export function findProfile(profiles: Profile[], name: string): Profile | undefined {
  return profiles.find((p) => p.name === name);
}