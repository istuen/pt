// schema.ts — Pt IR 契约，与任何来源格式无关
//
// 设计原则（见 docs/pt-asset-layering.md §0、§6.3、§11）：
// 1. Schema 是语义化的，不带任何格式痕迹（无 Section/Item/raw/heading）
// 2. Pt 定义契约，来源（OXN/YAML/...）实现 SourceAdapter
// 3. 这是三段式编译架构的 IR：前端（adapter）→ 后端（renderer）。中端已于 Phase 5.5 退出。
//
// Phase 5.5：移除 v3 legacy 字段，
//           SchemaBundle 只含 v6 canonical 字段（domains/structs/activeScene）。

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

// ==================== 结构层原子 ====================

/** 编排策略。Scene 的 layout 字段决定段落拼接顺序。 */
export interface StructureLayout {
  mode: "byDomain" | "byType" | "hybrid";
  /** byDomain / hybrid 时的模块顺序；未指定则原序 */
  domainOrder?: string[];
}

/** 流程节点（Scene.boundaries 的语义化形态） */
export interface BoundaryNode {
  /** 步骤名 */
  slot: string;
  /** 依赖的前置 slot 名列表 */
  deps: string[];
  /** 步骤描述 */
  desc: string;
}

/** 工具引用（stack-Domain.## Scene 段的语义化形态） */
export interface ToolRef {
  name: string;
  role?: string;
  operations?: string[];
}

// ==================== 动态手册 ====================

/** 手册步骤 */
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

/** 手册模板（声明在 workflow-Domain.## Blueprint，实例化后进 Manual） */
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

// ==================== v6：Domain 即 Module ====================

/**
 * v6: Domain 是 Pt 唯一的模块类型（Module 即 Domain）。
 * Domain 通过 type 标签区分承载内容的性质（term/workflow/stack/未来扩展）。
 * Scene 读 Domain.## Scene 段，Blueprint 读 Domain.## Blueprint 段。
 * 实际 scene/blueprint 形状由 type 决定（term→Term[]/Rule[]、workflow→{externals}/FlowTemplate[]、stack→ToolRef[]/...）。
 */
export interface Domain<TScene = unknown, TBlueprint = unknown> {
  name: string;
  type: string;
  scene: TScene;
  blueprint: TBlueprint;
}

// ==================== v6：Struct（Scene / Blueprint） ====================

/**
 * v6: Struct 是结构层，把 Domain 组装成产物。
 *   - Scene (kind="scene")：静态结构，产出 System Prompt，读 Domain[].## Scene。
 *   - Blueprint (kind="blueprint")：动态结构，产出 Manual，读 Domain[].## Blueprint。
 *
 * Phase 5.5：Scene 侧 trigger/boundaries/layout 填齐；Blueprint 侧 refs + manualLayout(暂不细化) 即可。
 */
export interface Struct {
  name: string;
  kind: "scene" | "blueprint";
  /** 引用的 Domain 名列表。Pt 核心不感知 Domain type，只按名查表。 */
  refs: string[];
  // ---- Scene 专属 ----
  /** 触发条件（如 "当用户请求风控检查..."） */
  trigger?: string;
  /** 流程节点 DAG（Scene 专属，Blueprint 不需要） */
  boundaries?: BoundaryNode[];
  /** 编排策略（Scene 专属，决定 prompt 段落拼接顺序） */
  layout?: StructureLayout;
  // ---- Blueprint 专属 ----
  /** 手册渲染布局（Phase 5 MVP: 传 "basic"，后续 Phase 再细化） */
  manualLayout?: "basic";
}

// ==================== SchemaBundle：v6 唯一形态 ====================

/**
 * SchemaBundle：v6 canonical 形态。
 *   - domains：所有 Domain（按 type 区分承载内容）。
 *   - structs：所有 Struct（Scene + Blueprint 平级）。
 *   - activeScene：当前激活的 Scene 名，决定 System Prompt 走哪个 Struct 的 refs。
 *
 * Phase 5.5：移除 v3 legacy knowledgeBase 字段（midend 已退出，不再需要派生）。
 */
export interface SchemaBundle {
  domains: Domain[];
  structs: Struct[];
  /** 当前激活的 Scene 名。System Prompt 按其 refs 拼装。 */
  activeScene: string;
}

// ==================== Source Adapter 接口（依赖反转后） ====================

/** 反转后的 SourceAdapter：load() 返回 SchemaBundle 而非 string。
 *  Pt 核心只认 SchemaBundle，不认任何来源格式。 */
export interface SourceAdapter {
  name: string;
  load(cwd: string, blueprintName: string): Promise<SchemaBundle>;
}

// ==================== v6：Struct 名解析辅助 ====================

/** 从 Struct 列表里找指定 kind 的 Struct。未找到返 undefined。 */
export function findStruct(structs: Struct[], name: string, kind?: Struct["kind"]): Struct | undefined {
  return structs.find((s) => s.name === name && (kind === undefined || s.kind === kind));
}