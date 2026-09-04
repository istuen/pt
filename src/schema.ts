// src/schema.ts — v9 IR 契约
//
// 设计原则（见 .pt/docs/designs/pt-asset-layering.md §0）：
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

/** 业务术语原子（Domain.## Scene / ## Term / ## Glossary 等场景段的内容） */
export interface Term {
  name: string;
  /** 描述（人类可读语义） */
  desc?: string;
  /** 可选标签，不强制：作者判定放哪层（公理 = 业务语义源；定理 = 公理的组合或业务具体描述） */
  level?: "axiom" | "theorem";
  /** 结构化字段清单（如 task-description 的 [必读, 设计原则, 步骤, ...]）。
   *  来自资产 `- fields: [a, b, c]` 行；renderer 输出 `（字段：a/b/c）`。
   *  v9.2 扩展：之前作者写的 fields/purpose/rule 等附加信息在 parse 阶段被静默丢弃，
   *  加此字段让作者的结构化表达进入 IR。 */
  fields?: string[];
  /** 补充说明（purpose / rule 等非 desc 的语义信息统一收纳）。
   *  renderer 在 desc 后追加 ` — note`。
   *  v9.2 扩展：与 fields 同步，让作者写在 Scene 段的 purpose/rule 不再被丢。 */
  note?: string;
  /** Phase term-P9.1：外部数据源路径（替代 workflow Scene 的 ExternalRef）。
   *  Scene 段统一为 Term[] 后，workflow 的 externals 用带 path 的 Term 表示；
   *  渲染：有 path 输出 `- name: path — desc`，无 path 输出 `- name: desc`。 */
  path?: string;
}

/** 外部数据源引用（声明式：路径 + 协议，不在此处拉取） */
export interface ExternalRef {
  name: string;
  path: string;
  /** 描述（workflow Scene 概念项无 path 时用 desc 承载语义） */
  desc?: string;
  protocol?: "file" | "api" | "db";
}

/** 业务规则（挂到步骤或全局） */
export interface Rule {
  /** 规则名（H3 标题，如 modules-type-safety）；renderer 输出 `name: check` 格式 */
  name: string;
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
  /** 验证参照（Probe 名列表，如 ["fs-content-match", "ts-compiles"]）。
   *  P0 新增：声明这步执行后用什么 probe 验证。probe 实现在 src/verify/（P1）。 */
  observe?: string[];
}

/** 验证结果三态（借鉴 OXN ADR-0066/0067，简化为纯枚举 + 消息，不引入 strategy 模式）。
 *  - COMPLETED：执行符合预期
 *  - DEVIATED：偏离预期（不是失败，是偏了，仍可继续）
 *  - INCONCLUSIVE：无法判定（如人工评估、probe 缺参数） */
export type ProbeOutcomeKind = "COMPLETED" | "DEVIATED" | "INCONCLUSIVE";

/** verify 函数返回值（P1 的 src/verify/ 模块用）。 */
export interface ProbeOutcome {
  outcome: ProbeOutcomeKind;
  message: string;
  actual?: string;
}

/** Manual 实例文档的步骤执行记录（buildManualDoc 生成表头，执行者用 edit 填值）。 */
export interface StepResult {
  stepIndex: number;
  outcome: ProbeOutcomeKind;
  message?: string;
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

/** Agent 注入位置（结构层术语，由 AgentAdapter 映射到 Agent 技术 API 名）。
 *  v9（Phase term-P4.3）：语义值 "session"/"turn" 取代旧 "system_prompt"/"context_message"——session
 *  对应 LLM 失忆后重注入（system_prompt 级），turn 对应按需触发（context_message 级）。
 *  Agent-agnostic：AgentAdapter 内部映射到 Pi 的 system_prompt/context_message 等技术名。 */
export type InjectionTarget = "session" | "turn" | string;

/** Blueprint 的注入点定义（对应 Blueprint md 的 H2，注入点名=人类自定义语义名）。 */
export interface InjectionPointConfig {
  /** 注入点名（语义名，Blueprint H2 标题，如 "会话知识"/"参考手册"）。 */
  name: string;
  /** Agent 注入位置（session / turn / 扩展）。 */
  target: InjectionTarget;
  /** 聚合点：参与的 Domain H2 段名列表（来自 ### Modules 无符号项，data-driven）。 */
  modules: string[];
  /** 聚合方式（仅 session 类注入点有意义）。 */
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
 *   - （Phase term-P4.1）移除 agent 字段：Blueprint 应 Agent-agnostic，agent 是运行时选择不是结构定义。
 *     消费方 fallback 硬编码 "pi"（见 src/index.ts transpileActive）；等第二个 Adapter（OpenCodeAdapter）
 *     落实后改 transpile(profile, agent) 编译维度参数（§11 实现节奏）。
 *   - compilation：编译方式（缓存目录 + 拆分策略）。P4.2 将移除。
 *   - injectionPoints：注入点列表（H2=注入点人类自定义名），定义 target + Modules 聚合点 + mode。
 *
 * 跨项目复用。加新 Agent 只加 AgentAdapter；加新注入点 = Blueprint 加 H2 + ### Modules。
 */
export interface Blueprint {
  name: string;
  /** 注入点列表（H2=注入点人类自定义名），定义 target + Modules + mode。 */
  injectionPoints: InjectionPointConfig[];
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
 * v9 AgentContext（Phase term-P1 前名 Context）：产物层，Profile 编译输出。
 *   - sourceHash：hash(Profile + Blueprint + Domains) 组合——任一变化即失效。
 *   - modules   ：注入点名（语义名）→ 聚合后的 markdown 字符串。
 *
 * AgentContext 是物理文件（.pt/cache/agent-contexts/*.agent-context.md），缓存复用。
 * Pt 读取 AgentContext 时比 sourceHash：一致用缓存，不一致重编译覆盖。
 *
 * v9 相对 v8 变化：sourceHash 输入从 (Blueprint + Channel + Domains) 改为 (Profile + Blueprint + Domains)。
 */
export interface AgentContext {
  /** Profile 名（AgentContext 跟 Profile 一对一）。 */
  name: string;
  /** Blueprint 名（AgentContext 来源 Blueprint，缓存标识 + YAML 头）。 */
  blueprint: string;
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

/** Adapter load 上下文（v9.1: 传 notify 上去代替 console.error，符合 pt-quality #9）。
 *  v10.x：增 assetDir 让测试夹具可指向 tests/fixtures/assets 而不污染 .pt/assets/。
 *  v10.x：增 log 让 adapter 把 trace 持久化到 .pt/logs/pt.log（PtLogger 提供）。 */
export interface SourceAdapterContext {
  /** 错误/警告通知回调（可选；不传则走 console fallback）。 */
  notify?: (msg: string, level: "warning" | "error") => void;
  /** 资产根目录覆盖（默认 `.pt/assets`）。测试夹具可传 `tests/fixtures/assets`。 */
  assetDir?: string;
  /** 持久化日志 writer（可选；不传则不写盘，仅走 notify）。
   *  形态参考 PtLogger.toWriter()——debug/info/warn/error 四方法。
   *  adapter 拿到后只需按级别调用，无需关心文件路径。 */
  log?: {
    debug(msg: string, ctx?: Record<string, unknown>): void;
    info(msg: string, ctx?: Record<string, unknown>): void;
    warn(msg: string, ctx?: Record<string, unknown>): void;
    error(msg: string, ctx?: Record<string, unknown>): void;
  };
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
 *  v9.1 (P1.1)：加 ui 可选能力——adapter 可报错 / 设状态，不必。
 *  v10.x：加 log 可选能力——adapter 内的 try/catch 异常可走 logger。
 *  注：log 接口与 SourceAdapterContext.log 同形，便于 toAgentAPI 复用同一个 logger。 */
export interface AgentAPI {
  on(event: string, handler: (...args: unknown[]) => unknown): void;
  registerCommand(name: string, spec: unknown): void;
  registerFlag(name: string, spec: unknown): void;
  getFlag(name: string): unknown;
  /** v9.1 可选 UI：index.ts 传入 Pi ctx.ui 适配后的对象。Adapter 可选。 */
  ui?: AgentUI;
  /** v10.x 可选 log：per-session PtLogger 适配。Adapter 可选。 */
  log?: {
    debug(msg: string, ctx?: Record<string, unknown>): void;
    info(msg: string, ctx?: Record<string, unknown>): void;
    warn(msg: string, ctx?: Record<string, unknown>): void;
    error(msg: string, ctx?: Record<string, unknown>): void;
  };
  /** Adapter 可选回调：完成一次 system prompt 注入后通知编排层更新观测状态。 */
  onInjected?: (systemPrompt: string) => void;
}

/** Agent 适配器——适配不同 Agent 的注入机制。
 *  Pt 核心调 Adapter 接口，不直接调 Agent API。加新 Agent 只加 Adapter。 */
export interface AgentAdapter {
  /** Agent 名（pi / codex / opencode / ...） */
  name: string;
  /** 该 Agent 支持的技术注入点 target 名（Pi: system_prompt, context_message）——
   *  注意：这是 AgentAdapter 映射边界。Blueprint 用 session/turn 语义值，Adapter 内部映射到此字段声明的 Pi API 名。 */
  supportedTargets: string[];
  /** 设置编译产物（compile 后调） */
  setAgentContext(ctx: AgentContext, blueprint: Blueprint, domains: Domain[]): void;
  /** 启动时注册：把 AgentContext 注入到 Agent（session_start 调用） */
  registerInject(api: AgentAPI, ctx: AgentContext, blueprint: Blueprint, domains?: Domain[]): void;
  /** 清理 session 上下文；handler 仍可由当前 Pi runtime 复用。 */
  resetInjection?(): void;
  /** 查询可用手册（/pt flows 命令 + /manual:xxx 触发 共同消费）。
   *
   * 参数语义：
   *  - `ctx`：当前激活的 AgentContext IR（含缓存 sourceHash / 各注入点 modules 内容）
   *  - `blueprint`：当前 Profile 引用的 Blueprint（遍历 injectionPoints 找 target=turn 注入点）
   *  - `domains`：**Profile 注入点 scope 过滤后的 Domain 集**——非全集
   *    - 由调用方（如 commands.ts flowsText）通过 filterDomainsByProfile 预过滤
   *    - Adapter 内部无需再过滤（信任传入的就是 scope 内）
   *    - v9 当前实现（pi-adapter.ts:listManuals）按"全集"处理——这是历史简化，v10+ 应改
   *
   * 返回值：可触发手册列表。每项含 name（FlowTemplate.name / Rule.name）+ hint（argumentHint）+ domain（来源 Domain）。
   *  - term-Domain 的 Rule[] 也作为 /manual:<domain> 暴露
   *  - workflow-Domain 的 FlowTemplate[] 作为 /<flow-name> 暴露
   *
   * 可选方法——Adapter 不实现时 /pt flows 返空。 */
  listManuals?(
    ctx: AgentContext,
    blueprint: Blueprint,
    domains: Domain[]
  ): Array<{ name: string; hint?: string; domain: string }>;
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
