// src/schema.ts — v8 IR 契约
//
// 设计原则（见 docs/pt-asset-layering.md §0）：
// 1. Schema 是语义化的，不带任何格式痕迹（无 Section/Item/raw/heading）
// 2. Pt 定义契约，来源（OXN/YAML/...）实现 SourceAdapter
// 3. 三段式编译架构：parse（前端）→ compile（中端）→ render（后端）
//
// Phase 8.2：v7 四层模型重定义 Channel/Blueprint 职责（H2=注入点 + 模块级 Domain 引用 + Compilation）。
//
// 四层语义：
//   - Domain   ：内容层。异构领域知识，按 H2 切模块，Type 标签区分内容性质。
//   - Channel  ：结构层。编译上下文通道，H2=注入点，定义注入点聚合哪些 H2 + target 映射 + mode。
//   - Blueprint：配置层。异构领域知识编译上下文通道蓝图，按注入点选 Domain + Trigger/Boundaries + Compilation。
//   - Context  ：产物层。编译后目标上下文，按注入点聚合多 Domain 内容，物理文件 + hash 缓存。
//
// v8 相对 v7 的核心变化：
//   - Channel.injectionPoints（替代 modules + layout）：每个 H2 = 一个注入点。
//   - Blueprint.injectionPoints（替代 domains + trigger + boundaries）：按注入点选 Domain。
//   - Blueprint.compilation（新增）：缓存目录 + 拆分策略。
//   - Context.modules key 从模块名变注入点名（结构不变，key 语义变）。

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

/** 手册步骤（workflow-Domain.## Blueprint 段内容） */
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

/** 手册模板（workflow-Domain.## Blueprint 段声明，实例化后进 Context Message） */
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

/** 流程节点（InjectionPointInstance.boundaries 的语义化形态） */
export interface BoundaryNode {
  /** 步骤名 */
  slot: string;
  /** 依赖的前置 slot 名列表 */
  deps: string[];
  /** 步骤描述 */
  desc: string;
}

// ==================== v8 注入点（Channel 与 Blueprint 共用基础） ====================

/** Pi 注入位置（代码层技术名，由 Channel.target 映射）。 */
export type InjectionTarget = "system_prompt" | "context_message" | string;

/** Channel 的注入点定义（对应 Channel md 的 H2）。 */
export interface InjectionPointConfig {
  /** 注入点名（语义名，如 "会话知识"/"对话记忆"，来自 Channel H2 标题）。 */
  name: string;
  /** Pi 注入位置（system_prompt / context_message / 扩展）。 */
  target: InjectionTarget;
  /** 聚合点：参与的 Domain H2 段名列表（来自 ### Modules 无符号项）。 */
  modules: string[];
  /** 聚合方式（仅 system_prompt 类注入点有意义）。 */
  mode?: StructureLayout["mode"];
}

/** Blueprint 的注入点实例化（对应 Blueprint md 的 H2，跟 Channel 的 InjectionPointConfig 同名）。 */
export interface InjectionPointInstance {
  /** 注入点名（跟 Channel 的 InjectionPointConfig.name 对应）。 */
  name: string;
  /** 参与本注入点的 Domain 名列表（模块级引用——只贡献该注入点聚合的 H2 段）。 */
  domains: string[];
  /** 本注入点的触发条件（实例级）。 */
  trigger?: string;
  /** 本注入点的流程节点 DAG（实例级）。 */
  boundaries?: BoundaryNode[];
}

// ==================== v8 Compilation（Context 缓存配置） ====================

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
 * v8 Domain：内容层模块。承载语义定义与上下文模块内容。
 *   - type：内容性质标签（term/workflow/stack/扩展），决定各 H2 段**内部内容格式**。
 *   - modules：H2 段名 → 段内容（key = "Scene"/"Manual"/"Term"/...）。
 *
 * H2 段名是开放的——加新模块类型 = 加新 H2 段名 + Channel 声明该模块。
 * type 决定 H2 段内部格式，H2 段名决定内容去向——两者独立扩展。
 */
export interface Domain {
  name: string;
  /** 内容性质标签：term/workflow/stack/扩展 */
  type: string;
  /** H2 段名 → 段内容。Pt 核心按 H2 名读段，不硬编码段名。 */
  modules: Record<string, unknown>;
}

// ==================== 结构层：Channel ====================

/**
 * v8 Channel：结构层模块，编译上下文通道。
 *   - injectionPoints：注入点列表（H2=注入点），定义每个注入点的 target/modules/mode。
 *
 * Channel 只管结构，不含具体 Domain、不含触发条件——后者是 Blueprint 的职责。
 * Channel 可跨项目复用。
 *
 * v7 → v8 变化：替换 v7 的 modules + layout。注入点定义从隐式 Modules 列表 → 显式 H2。
 */
export interface Channel {
  name: string;
  /** 注入点列表（H2=注入点），替代 v7 的 modules + layout。 */
  injectionPoints: InjectionPointConfig[];
}

// ==================== 配置层：Blueprint ====================

/**
 * v8 Blueprint：配置层模块，异构领域知识编译上下文通道蓝图。
 *   - channel：引用哪个 Channel（结构复用）。
 *   - injectionPoints：按注入点选 Domain（模块级引用）+ Trigger/Boundaries。
 *   - compilation：编译方式（缓存目录 + 拆分策略）。
 *
 * 一个 Channel 可被多个 Blueprint 引用（跨项目复用），每个 Blueprint 填入自己的 Domain 组合。
 *
 * v7 → v8 变化：替换 v7 的 domains + trigger + boundaries，按注入点组织；新增 compilation。
 */
export interface Blueprint {
  name: string;
  /** 引用的 Channel 名（结构复用）。 */
  channel: string;
  /** 按注入点选 Domain（模块级引用），替代 v7 的 domains: string[]。 */
  injectionPoints: InjectionPointInstance[];
  /** 编译方式（缓存目录 + 拆分策略）。 */
  compilation: CompilationConfig;
}

// ==================== 产物层：Context ====================

/**
 * v8 Context：产物层，Blueprint 编译输出。
 *   - sourceHash：hash(Domains + Channel + Blueprint) 组合——三者任一变化即失效。
 *   - modules   ：注入点名 → 聚合后的 markdown 字符串。
 *
 * Context 是物理文件（.pt/contexts/cache/*.context.md），缓存复用。
 * Pt 读取 Context 时比 sourceHash：一致用缓存，不一致重编译覆盖。
 *
 * v7 → v8 变化：modules key 从模块名（Scene/Manual）变成注入点名（会话知识/对话记忆）——结构不变，key 语义变。
 */
export interface Context {
  /** Blueprint 名（Context 跟 Blueprint 一对一）。 */
  name: string;
  /** hash(domains + channel + blueprint)，缓存失效依据。 */
  sourceHash: string;
  /** 注入点名 → 聚合后的 markdown 字符串（如 "会话知识" → "..."）。 */
  modules: Record<string, string>;
}

// ==================== IR 集合（编译期内存态） ====================

/**
 * v8 SchemaBundle：编译期内存态，包含所有加载的 IR。
 *   - domains：所有 Domain（按 type 区分承载内容）。
 *   - channels：所有 Channel（结构层模块）。
 *   - blueprints：所有 Blueprint（配置层模块）。
 *   - activeBlueprint：当前激活的 Blueprint 名，决定产物走哪个组合。
 */
export interface SchemaBundle {
  domains: Domain[];
  channels: Channel[];
  blueprints: Blueprint[];
  /** 当前激活的 Blueprint 名。 */
  activeBlueprint: string;
}

// ==================== Source Adapter 接口（依赖反转后） ====================

/** 反转后的 SourceAdapter：load() 返回 SchemaBundle 而非 string。
 *  Pt 核心只认 SchemaBundle，不认任何来源格式。 */
export interface SourceAdapter {
  name: string;
  load(cwd: string, blueprintName: string): Promise<SchemaBundle>;
}

// ==================== v8：Blueprint 名解析辅助 ====================

/** 从 Blueprint 列表里找指定名的 Blueprint。未找到返 undefined。 */
export function findBlueprint(blueprints: Blueprint[], name: string): Blueprint | undefined {
  return blueprints.find((b) => b.name === name);
}

/** 从 Channel 列表里找指定名的 Channel。未找到返 undefined。 */
export function findChannel(channels: Channel[], name: string): Channel | undefined {
  return channels.find((c) => c.name === name);
}
