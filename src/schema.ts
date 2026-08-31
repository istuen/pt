// src/schema.ts — v7 四层 IR 契约
//
// 设计原则（见 docs/pt-asset-layering.md §0）：
// 1. Schema 是语义化的，不带任何格式痕迹（无 Section/Item/raw/heading）
// 2. Pt 定义契约，来源（OXN/YAML/...）实现 SourceAdapter
// 3. 三段式编译架构：parse（前端）→ compile（中端）→ render（后端）
//
// Phase 7.2：v6 三类型（Domain/Struct/KnowledgeBase）→ v7 四层（Domain/Channel/Blueprint/Context）。
//
// 四层语义：
//   - Domain   ：内容层。承载语义定义与上下文模块内容，H2 段名开放（Scene/Manual/Term/...）。
//   - Channel  ：结构层。定义通道含哪些上下文模块 + 编排策略，跨项目复用。
//   - Blueprint：配置层。Channel + 具体 Domains + trigger + boundaries，每场景一份。
//   - Context  ：产物层。Blueprint 编译输出，按模块聚合多 Domain 内容，物理文件 + hash 缓存。

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

/** 编排策略。Channel.layout 决定段落拼接顺序。 */
export interface StructureLayout {
  mode: "byDomain" | "byType" | "hybrid";
  /** byDomain / hybrid 时的模块顺序；未指定则原序 */
  domainOrder?: string[];
}

/** 流程节点（Blueprint.boundaries 的语义化形态） */
export interface BoundaryNode {
  /** 步骤名 */
  slot: string;
  /** 依赖的前置 slot 名列表 */
  deps: string[];
  /** 步骤描述 */
  desc: string;
}

// ==================== 内容层：Domain ====================

/**
 * v7 Domain：内容层模块。承载语义定义与上下文模块内容。
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
 * v7 Channel：结构层模块，定义通道含哪些上下文模块 + 编排策略。
 *   - modules：声明含哪些上下文模块（对应 Domain 的 H2 段名，如 "Scene"/"Manual"/"Term"）。
 *   - layout ：编排策略（byDomain/byType/hybrid）。
 *
 * Channel 只管结构，不含具体 Domain、不含触发条件——后者是 Blueprint 的职责。
 * Channel 可跨项目复用。
 */
export interface Channel {
  name: string;
  /** 上下文模块列表（对应 Domain 的 H2 段名）。决定 Context 含哪些 ## 段。 */
  modules: string[];
  /** 编排策略。决定 Context 内模块的拼接顺序。 */
  layout: StructureLayout;
}

// ==================== 配置层：Blueprint ====================

/**
 * v7 Blueprint：配置层模块，Channel + 具体 Domains + trigger + boundaries，每场景一份。
 *   - channel ：引用哪个 Channel（结构复用）。
 *   - domains ：具体用哪些 Domain（配置组合）。
 *   - trigger ：触发条件（实例级）。
 *   - boundaries：流程节点 DAG（实例级）。
 *
 * 一个 Channel 可被多个 Blueprint 引用（跨项目复用），每个 Blueprint 填入自己的 Domain 组合。
 */
export interface Blueprint {
  name: string;
  /** 引用的 Channel 名（结构复用）。 */
  channel: string;
  /** 引用的 Domain 名列表（具体内容）。 */
  domains: string[];
  /** 触发条件（注入 System Prompt 头部）。 */
  trigger?: string;
  /** 流程节点 DAG（实例级）。 */
  boundaries?: BoundaryNode[];
}

// ==================== 产物层：Context ====================

/**
 * v7 Context：产物层，Blueprint 编译输出。
 *   - sourceHash：hash(Domains + Channel + Blueprint) 组合——三者任一变化即失效。
 *   - modules   ：H2 段名 → 聚合后的 markdown 字符串。
 *
 * Context 是物理文件（.pt/cache/*.context.md），缓存复用。
 * Pt 读取 Context 时比 sourceHash：一致用缓存，不一致重编译覆盖。
 */
export interface Context {
  /** Blueprint 名（Context 跟 Blueprint 一对一）。 */
  name: string;
  /** hash(domains + channel + blueprint)，缓存失效依据。 */
  sourceHash: string;
  /** H2 段名 → 聚合后的 markdown 字符串（如 "Scene" → "..."）。 */
  modules: Record<string, string>;
}

// ==================== IR 集合（编译期内存态） ====================

/**
 * v7 SchemaBundle：编译期内存态，包含所有加载的 IR。
 *   - domains：所有 Domain（按 type 区分承载内容）。
 *   - channels：所有 Channel（结构层模块）。
 *   - blueprints：所有 Blueprint（配置层模块）。
 *   - activeBlueprint：当前激活的 Blueprint 名，决定产物走哪个组合。
 *
 * 注：v7 不再有 v6 的 `activeScene`（v6 用 Scene Struct 名）。Blueprint 自带 trigger/boundaries，
 *     一个 Blueprint 一份产物，不需要额外选 "activeScene"。
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

// ==================== v7：Blueprint 名解析辅助 ====================

/** 从 Blueprint 列表里找指定名的 Blueprint。未找到返 undefined。 */
export function findBlueprint(blueprints: Blueprint[], name: string): Blueprint | undefined {
  return blueprints.find((b) => b.name === name);
}

/** 从 Channel 列表里找指定名的 Channel。未找到返 undefined。 */
export function findChannel(channels: Channel[], name: string): Channel | undefined {
  return channels.find((c) => c.name === name);
}