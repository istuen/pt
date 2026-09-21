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
//   - Blueprint ：结构层。Agent 端聚合组结构（YAML groups 项），声明聚合组 inject/Modules/mode。
//   - Profile   ：配置层。业务端实例，引用 Blueprint + 选 Domains（YAML 全局 + 聚合组追加）。
//   - AgentContext ：产物层。Profile 编译输出，按聚合组聚合多 Domain 内容，物理文件 + hash 缓存。
// （Channel 保留为未来 Connector，预留层不实现）
//
// v9 相对 v8 的核心变化：
//   - Blueprint 吸收 v8 Channel 的 groups（结构层职责从 Channel 迁到 Blueprint）
//   - v8 Blueprint 的配置层职责 → Profile（用户面是 Profile）
//   - ProfileGroup 删 trigger/boundaries 字段（Boundaries 丢弃；Trigger 移到 Domain H2 段）
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
  /** 外部数据源路径（用于渲染 `- name: path — desc`；无 path 时降级为 `- name: desc`）。 */
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

/** 手册模板（Domain.## Flows 段声明，实例化后进 Turn Inject） */
export interface FlowTemplate {
  /** /name 触发 */
  name: string;
  /** 参数提示，如 "<客户ID> <金额>" */
  argumentHint?: string;
  /** 数据语义层：带 {{}} 占位符的前提 */
  intent: string;
  /** 手册结构层：步骤 + 数据源 + 期望产出 */
  steps: FlowStep[];
}

/** Phase term-P9.2：验收清单（Domain.## Checklists 段内容）。
 *  与 Rule[] 不同：Checklist 只列条目，不带 slot/type/check——是“待验证项列表”。
 *  Renderer：``### name\\n- item1\\n- item2``。 */
export interface Checklist {
  name: string;
  items: string[];
}

// ==================== 结构层原子 ====================

/** 编排策略。BlueprintGroup.mode 决定段落拼接顺序。 */
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

// ==================== v9 聚合组（Blueprint 拥有，聚合组是 Agent 端注入位置映射） ====================

/** Agent 注入位置（结构层术语，由 AgentAdapter 映射到 Agent 技术 API 名）。
 *  v9（Phase term-P4.3）：语义值 "session"/"turn" 取代旧 "system_prompt"/"context_message"——session
 *  对应 LLM 失忆后重注入（system_prompt 级），turn 对应按需触发（context_message 级）。
 *  Agent-agnostic：AgentAdapter 内部映射到 Pi 的 system_prompt/context_message 等技术名。
 *  Phase term-naming：字段名 target → inject（更直白表达动作意图）。InjectTarget 类型名。 */
export type InjectTarget = "session" | "turn" | string;

/** Blueprint 的聚合组定义（对应 Blueprint yaml 的 groups 项，聚合组名=人类自定义语义名）。
 *  v9.1（modules-to-profile 迁移）：BlueprintGroup 删 `modules` 字段——Blueprint 退化为插槽契约
 *  （name + inject + mode），modules 由 ProfileGroup 提供。Profile 通过 H2 匹配插槽名，用
 *  `### Modules` 段填 modules 列表。Blueprint 加新插槽向后兼容（旧 Profile 无 H2 → 产出空段）。 */
export interface BlueprintGroup {
  /** Aggregation group name (semantic, configured in Blueprint, e.g. "session-context" / "reference-manual"). */
  name: string;
  /** 注入位置（session / turn / 扩展）——值语义名，经由 AgentAdapter 映射到具体 Agent Runtime API。 */
  inject: InjectTarget;
  /** 聚合方式（仅 session 类聚合组有意义）。 */
  mode?: StructureLayout["mode"];
}

/** modules-to-profile-complete：modName 解析形态。2 形态：
 *  - 段名（"Scene" / "User" / "Agent"）— 跨所有引用域找该段，整段聚合
 *  - 段.项（"User.user-profile" / "Agent.senior-developer"）— 跨所有引用域找该段下 H3 项
 *  限定到单个 domain 通过专用段名（User / Agent）实现，不引入形态 3（domain:段.项）——避免 profile 重复写引用。
 *  v9.1（迁移后）原本用裸 string 名（"Scene" / "User"），v9.1+ 用本结构对象。 */
export interface ModName {
  /** H2 段名（命名空间） */
  section: string;
  /** H3 项名（可选）。undefined = 段粒度匹配；string = 该段下 H3 项名 */
  item?: string;
}

/** Profile 的聚合组实例化（对应 Profile md 的 H2，与 Blueprint 的 BlueprintGroup 同名）。
 *  v9：domains（追加到本聚合组的 Domain 名列表）。trigger/boundaries 删除。
 *  v9.1（modules-to-profile 迁移）：加 `modules` 字段——Profile H2 下的 `### Modules` 列表
 *  填本插槽的聚合模块（具名身份段 + 段类型）。原 BlueprintGroup.modules 已删除。
 *  v9.1+（modules-to-profile-complete）：modules 元素从 `string` 改为 `ModName` 对象——
 *  支持段粒度 + 段.项粒度两种形态。 */
export interface ProfileGroup {
  /** 聚合组名（与 Blueprint 的 BlueprintGroup.name 对应）。 */
  name: string;
  /** 追加到本聚合组的 Domain 名列表（只贡献该聚合组）。 */
  domains: string[];
  /** 本插槽填的聚合模块列表（Profile `### Modules` 段下的项解析为 ModName 对象）。
   *  - 段名：跨所有引用域该段整段聚合
   *  - 段.项：跨所有引用域该段下 H3 项（精确选）
   *  为空数组 = 该 Profile 故意不填此插槽（"缺填"——log debug only 不 notify，见设计文档 §5）。 */
  modules: ModName[];
}

// ==================== 内容层：Domain ====================

/**
 * v9 Domain：内容层模块。承载语义定义与上下文模块内容。
 *   - （Phase term-P9.3）type 字段已删除——H2 段名直接决定 schema（一个 H2 段一个 schema）。
 *     原 type: term/workflow/stack 是「知识性质标签」+「schema 选择器」一身二任，
 *     拆 Type 后由 H2 段名 + Term.path 等字段直接表达。
 *   - modules：H2 段名 → 段内容（key = "Scene"/"Trigger"/"Manual"/...，开放扩展）。
 *
 * H2 段名是开放的——加新模块类型 = 加新 H2 段名 + Blueprint 声明该模块。
 * type 决定 H2 段内部格式，H2 段名决定内容去向——两者独立扩展。
 */
export interface Domain {
  name: string;
  /** Phase term-P9.3：删除 type 字段——Type 一身二任（知识性质标签 + schema 选择器）导致 stack 死类型
   *  + 加新 Type 要改所有 H2 段的 renderer。Type 拆后由 H2 段名直接决定 schema（一个 H2 段一个 schema）。
   *  不再加 frontmatter.type；Domain 不再有 type 字段。 */
  /** H2 段名 → 段内容。Pt 核心按 H2 名读段，不硬编码段名。 */
  modules: Record<string, unknown>;
}

// ==================== 结构层：Blueprint（v8 Channel 吸收进来） ====================

/**
 * v9 Blueprint：Agent 端聚合组结构，结构层模块。
 *   - （Phase term-P4.1）移除 agent 字段：Blueprint 应 Agent-agnostic，agent 是运行时选择不是结构定义。
 *     消费方 fallback 硬编码 "pi"（见 src/index.ts transpileActive）；等第二个 Adapter（OpenCodeAdapter）
 *     落实后改 transpile(profile, agent) 编译维度参数（§11 实现节奏）。
 *   - compilation：编译方式（缓存目录 + 拆分策略）。P4.2 将移除。
 *   - groups：聚合组列表（YAML groups: [...] 项），定义 inject + Modules 聚合点 + mode。
 *
 * 跨项目复用。加新 Agent 只加 AgentAdapter；加新聚合组 = Blueprint groups 加一项 + modules 列。
 */
export interface Blueprint {
  name: string;
  /** 聚合组列表（YAML groups: [...] 项），定义 inject + Modules + mode。 */
  groups: BlueprintGroup[];
}

// ==================== 配置层：Profile（v8 Blueprint 业务实例化角色） ====================

/**
 * v9 Profile：业务端实例，配置层模块。
 *   - blueprint：引用哪个 Blueprint（结构复用）。
 *   - domains：YAML 全局 Domain 列表，自动分发到所有聚合组（有匹配 H2 段则贡献）。
 *   - groups：聚合组实例化（H2 = 聚合组名，与 Blueprint 同名），其下 ### Domains 是追加列表。
 *   - tagline：身份一句话介绍（选填）。展示路径：
 *       - /pt-profile 选择器选项中：`name — tagline`
 *       - /pt status：pt tagline 行
 *       - footer：`pt: <profile>: <tagline> <state>`
 *     建议 ≤ 30 字符（footer 会截断）；超过 80 字符应拆成多行场景描述走 Domain。
 *
 * 项目级，不跨项目复用。
 */
export interface Profile {
  name: string;
  /** 引用的 Blueprint 名（结构复用）。 */
  blueprint: string;
  /** 全局 Domain 列表，自动分发到所有聚合组。 */
  domains: string[];
  /** 聚合组实例化（与 Blueprint 的 BlueprintGroup 同名）。 */
  groups: ProfileGroup[];
  /**
   * v14.x：身份一句话介绍（选填）。例如：
   *   tagline: Senior dev + QA + Reviewer (3 agents)
   *   tagline: Product owner + Architect
   *
   * 解析：frontmatter `tagline: <string>` → schema 字段。
   * 展示路径：/pt-profile 选择器、/pt status、footer 三处。
   * back-compat：缺省 = undefined（旧 Profile 不填照样可加载）。
   */
  tagline?: string;
  /**
   * v15.x PR3（§4.4.1）：MdFilePack 加载时打上——不限定 ref 自动绑定用。
   * back-compat：未加载的新代码可能缺省（undefined）；parseRef 用 `?? ""` 容错后抛
   * "unqualified ref ... but profile has no sourcePack" 错误——保留配置错误可见性。 */
  sourcePack?: string;
  /**
   * v15.x PR5（§5.1）：use 单继承——引用另一 Profile 作为基础，递归展开。
   *  - 不写 = 完全独立 Profile（back-compat 干净，expandProfile 步骤 4 早退）
   *  - 写了 = 增量继承：blueprint 覆盖 / tagline 覆盖 / domains 追加 / groups 替换（§5.2 表）
   *  格式：`@pack/name`（限定）或 `name`（无限定→self.sourcePack/name）
   *  解析：parseRef（PR3a 已实现，含 @prj/@pt 别名归一；@gbl PR7 已删）
   *  循环检测 + 菱形处理：路径 visited（每层 new Set，§5.3.3 M4）
   *  越权校验：use 场景 error（§5.5.1 S7） */
  use?: string;
  /**
   * v16：可选 domain ref 列表。找不到不阻断（info 级诊断）。
   * 用于 fullstack profile 声明 prj 可选 slot——prj 有同名 domain 则填充，无则 slot 空。
   * 与 domains 的区别：domains 必填（找不到走 error/warning）；optional-domains 可选（找不到走 info）。
   * 不参与 use 链合并（use 暂不支持 optional-domains 继承）。 */
  optionalDomains?: string[];
}

// ==================== 产物层：AgentContext ====================

/**
 * v9 AgentContext（Phase term-P1 前名 Context）：产物层，Profile 编译输出。
 *   - sourceHash：hash(Profile + Blueprint + Domains) 组合——任一变化即失效。
 *   - modules   ：聚合组名（语义名）→ 聚合后的 markdown 字符串。
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
  /** hash(profile + blueprint + domains + packs)，缓存失效依据。 */
  sourceHash: string;
  /** 聚合组名（语义名）→ 聚合后的 markdown 字符串。 */
  modules: Record<string, string>;
  /** v15.x PR2（§8.3）：cache 文件名 <pack>__<profile> 用——所属 pack name。
   *  PR3 接通 @pack/name 后改为 Profile.sourcePack；PR2 用 pack name 字符串。 */
  packName: string;
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

/** v15.x §4.4.2（双层语义）：三类 asset 的 working set 通用双索引结构。
 *  - location：按位置 alias（prj/gbl/pt）——reserved pack（project/global/builtin）才有；settings pack 不进
 *  - identity：按 pack.name（manifest.name 或退化别名）——所有 pack 都进
 *  双索引保证：
 *    - @prj/foo（位置 alias）走 location 索引
 *    - @<manifest-name>/foo（身份 alias）走 identity 索引
 *    - 不限定 `foo` 走 identity 索引（self.sourcePack 是 manifest.name）
 *  back-compat（缺口 1-b）：reserved pack 无 manifest 时 pack.name=位置别名，identity 与 location 索引 key 重合——双入口命中同一 asset。 */
export interface WorkingSet<T> {
  location: Map<string, { pack: AssetPack; asset: T }>;
  identity: Map<string, { pack: AssetPack; asset: T }>;
}

export interface SchemaBundle {
  domains: Domain[];
  blueprints: Blueprint[];
  profiles: Profile[];
  /** 当前激活的 Profile 名。 */
  activeProfile: string;
  /** v15.x PR6（fix pt-active-profile-fallback-mismatch）：activeProfile 由来——
   *  - "exact"：用户请求的 profile 名在某个 pack 找到
   *  - "fallback"：未找到，fallback 到 allProfiles[0]
   *  caller 层依据 origin 决定是否同步改写 s.activeProfile / loadedFrom / notify。 */
  activeProfileOrigin: "exact" | "fallback";
  /** 当 origin="fallback"：记录用户原始请求的 profile 名（用于 notify 文案 / log / debug）。
   *  origin="exact" 时不设。 */
  originalProfileName?: string;
  /** v15.x PR2（§8.1）：加载的所有 AssetPack——sourceHash + cache 文件名用。 */
  packs: AssetPack[];
  /** v15.x PR2（§8.3）：激活 Profile 所属的 pack name（cache 文件名 <pack>__<profile> 用）。
   *  PR3 接通 @pack/name 后改为 Profile.sourcePack；PR2 用 pack name 字符串。 */
  activeProfilePack: string;
  /** v15.x §4.4.2（双层语义）：三类 asset 的 working set，dedup 下推到引用层。
   *  双索引：
   *    - location：按位置 alias（prj/pt）——reserved pack 才有，非 reserved 不进
   *    - identity：按 pack.name（manifest.name 或退化别名）——所有 pack 都进
   *  场景 G（@prj/foo + @pt-internal/foo 命中同一 asset）依赖双索引。 */
  workingSet: {
    domains: WorkingSet<Domain>;
    blueprints: WorkingSet<Blueprint>;
    profiles: WorkingSet<Profile>;
  };
}

// ==================== Source Adapter 接口（依赖反转后） ====================

/** Adapter load 上下文（v9.1: 传 notify 上去代替 console.error，符合 pt-quality #9）。
 *  v10.x：增 assetDir 让测试夹具可指向 tests/fixtures/assets 而不污染 .pt/assets/。
 *  v10.x：增 log 让 adapter 把 trace 持久化到 .pt/logs/pt.log（PtLogger 提供）。
 *  v15.x PR7（issue pt-remove-global-pack 移除）：globalPackDir 已删除——全局 pack
 *  被 settings pack 取代（指向 `~/.pt/packs/foo/` 即可跨项目共享）。 */
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

// ==================== v15.x PR1：AssetPack 抽象 ====================

/** Pack 来源类型（诊断显示用，pt-asset-pack.md §2.1）。
 *  v15.x PR7（issue pt-remove-global-pack 移除）：从 4 类收敛为 3 类——
 *  project（项目本地） / settings（pt.asset-packs[]，替代 global 职责） /
 *  builtin（随 npm 包发布）。global pack（@gbl）删除——settings pack 显式声明
 *  路径可指向 ~/.pt/packs/foo/ 实现跨项目共享，能力严格覆盖 global。 */
export type PackSource = "project" | "settings" | "builtin";

/**
 * v15.x PR1：AssetPack 是单个资产来源的抽象。
 * mdAdapter.load() 内部构造 AssetPack[]，依次 load → 合并 SchemaBundle。
 *
 * PR1 范围：name 解析走简化版（reserved 固定名 / basename 兜底），
 *           manifest 字段（version/description）全空——manifest 解析是 PR2。
 *           settings pack 加载走 stub 返空数组（PR4 接通）。
 */
export interface AssetPack {
  /** Pack 身份（PR1：reserved 固定名 "prj"/"pt"，或目录 basename 兜底）
   *  PR7（issue pt-remove-global-pack 移除）：reserved 固定名从 3 个减为 2 个。 */
  readonly name: string;
  /** Pack 版本（PR1：固定 "0.0.0"；PR2 从 manifest 读） */
  readonly version: string;
  /** Pack 根目录绝对路径 */
  readonly rootDir: string;
  /** manifest 描述（PR1：undefined；PR2 从 manifest 读） */
  readonly description?: string;
  /** Pack 来源类型（诊断显示用） */
  readonly source: PackSource;
  /** 加载本 Pack 的所有 Domain */
  loadDomains(): Promise<Domain[]>;
  /** 加载本 Pack 的所有 Blueprint */
  loadBlueprints(): Promise<Blueprint[]>;
  /** 加载本 Pack 的所有 Profile */
  loadProfiles(): Promise<Profile[]>;
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
  /** 该 Agent 支持的技术注入 API 名（Pi: system_prompt, context_message）——
   *  注意：这是 AgentAdapter 映射边界。Blueprint 用 session/turn 语义值，Adapter 内部映射到此字段声明的 Pi API 名。 */
  supportedTargets: string[];
  /** 设置编译产物（compile 后调）。
   *  v13.x（issue pt-turn-inject-not-profile-scoped）：加 profile 参数——Adapter 持有 profile
   *  后，turn 路径（renderTurnInject / listManuals）内部统一按 Profile scope 过滤 domains，
   *  消除"触发用全集 / 列表预过滤"的双轨。 */
  setAgentContext(
    ctx: AgentContext,
    blueprint: Blueprint,
    domains: Domain[],
    profile: Profile
  ): void;
  /** 启动时注册：把 AgentContext 注入到 Agent（session_start 调用）。
   *  v13.x（issue pt-turn-inject-not-profile-scoped）：加 profile 参数——与 setAgentContext 对齐，
   *  Adapter 持有 profile 后 turn 路径自过滤。 */
  registerInject(
    api: AgentAPI,
    ctx: AgentContext,
    blueprint: Blueprint,
    domains?: Domain[],
    profile?: Profile | null
  ): void;
  /** 清理 session 上下文；handler 仍可由当前 Pi runtime 复用。 */
  resetInjection?(): void;
  /** 查询可用手册（/pt flows 命令 + /pt_turn_inject 触发 共同消费）。
   *
   * 参数语义：
   *  - `ctx`：当前激活的 AgentContext IR（含缓存 sourceHash / 各聚合组 modules 内容）
   *  - `blueprint`：当前 Profile 引用的 Blueprint（遍历 groups 找 inject=turn 聚合组）
   *  - `domains`：Profile 引用的 Domain 全集——Adapter 内部用 setAgentContext 时存下的
   *    profile 调 filterDomainsByProfile 自行过滤（issue pt-turn-inject-not-profile-scoped 修复），
   *    调用方无需预过滤
   *
   * 返回值：可触发手册列表。每项含 name（FlowTemplate.name / Rule.name）+ hint（argumentHint）+ domain（来源 Domain）。
   *  - term-Domain 的 Rule[] 也作为 /pt_turn_inject <domain> 暴露
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

/** 从 ref 取 asset name——`@pack/name` 限定取尾段，否则原样。
 *  filterDomainsByProfile 和 ref-check 都用它：profile.domains 可写 `@fullstack/dev-process`
 *  限定来源 pack，与 d.name（无前缀的 domain.name）比较时取尾段。 */
export function refName(ref: string): string {
  if (ref.startsWith("@")) {
    const slashIdx = ref.indexOf("/");
    if (slashIdx > 0) return ref.slice(slashIdx + 1);
  }
  return ref;
}

/** 按 Profile 引用范围过滤 domains（turn 路径 scope 过滤用）。
 *  规则：domain 在 Profile YAML 全局 domains 列表 或 任一聚合组 ProfileGroup.domains 追加列表中 → 保留。
 *  v13.x（issue pt-turn-inject-not-profile-scoped）：从 commands.ts 挪到 schema.ts——
 *  render 层（turn-inject）需要反向依赖它，放 schema.ts 避免层次倒挂。commands.ts 改 import。
 *  v15.x（issue pt-domain-abstraction-and-generic-profiles）：ref normalize——profile.domains
 *  可写 `@fullstack/dev-process`（限定来源 pack），refName 取尾段匹配 d.name。
 *  v16（issue pt-project-profiles-refactor-optional-domains）：加 optionalDomains 考虑——
 *  prj 通过 optional-domains slot 填的 domain 也应被选中（否则 renderTurnInject /pt_turn_inject xxx 找不到）。
 *  profile 为 null 时返 domains 原样（向后兼容——无激活 Profile 时不限制）。 */
export function filterDomainsByProfile<T extends { name: string }>(
  domains: T[],
  profile: Profile | null
): T[] {
  if (!profile) return domains;
  const profileDomainNames = new Set(profile.domains.map(refName));
  const optionalDomainNames = new Set((profile.optionalDomains ?? []).map(refName));
  const groupDomainNames = new Set(profile.groups.flatMap((g) => g.domains.map(refName)));
  return domains.filter(
    (d) =>
      profileDomainNames.has(d.name) ||
      optionalDomainNames.has(d.name) ||
      groupDomainNames.has(d.name)
  );
}
