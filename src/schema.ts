// src/schema.ts — v9 IR 契约。
// 设计原则/四层模型/扩展点见 .pt/docs/designs/pt-asset-layering.md §0；迁移决策史见 §0.10。

// ==================== 语义层原子 ====================
export interface Term {
  name: string;
  /** 描述（人类可读语义）。 */
  desc?: string;
  /** 可选：作者判定放哪层（axiom = 业务语义源；theorem = 公理的组合）。不强制。 */
  level?: "axiom" | "theorem";
  /** 结构化字段清单。renderer 输出 `（字段：a/b/c）`。 */
  fields?: string[];
  /** 补充说明。renderer 在 desc 后追加 ` — note`。 */
  note?: string;
  /** 外部数据源路径。无 path 时降级为 `- name: desc`。 */
  path?: string;
}
/** 外部数据源引用（声明式：路径 + 协议，不在此处拉取）。 */
export interface ExternalRef {
  name: string;
  path: string;
  desc?: string;
  protocol?: "file" | "api" | "db";
}
/** 业务规则（挂到步骤或全局；hybrid 模式下 slot=global 抽到全局段）。 */
export interface Rule {
  name: string;
  /** 挂到哪个步骤的 slot 名；"global" 表示跨模块聚合。 */
  slot: string;
  /** 不变量约束：ban = 禁止项；invariant = 不变量。 */
  type: "ban" | "invariant";
  check: string;
  /** ban 类型时列出具体禁止项。 */
  items?: string[];
}
/** 手册步骤（workflow-Domain.## Flows 段内容）。 */
export interface FlowStep {
  desc: string;
  dataSource?: ExternalRef;
  rule?: string;
  output?: string;
  /** 验证参照（Probe 名列表）。 */
  observe?: string[];
}
/** 验证结果三态：COMPLETED = 符合预期；DEVIATED = 偏离（仍可继续）；INCONCLUSIVE = 无法判定。 */
export type ProbeOutcomeKind = "COMPLETED" | "DEVIATED" | "INCONCLUSIVE";
/** verify 函数返回值（src/verify/ 模块用）。 */
export interface ProbeOutcome {
  outcome: ProbeOutcomeKind;
  message: string;
  actual?: string;
}
/** Manual 实例文档的步骤执行记录。 */
export interface StepResult {
  stepIndex: number;
  outcome: ProbeOutcomeKind;
  message?: string;
}
/** 手册模板（Domain.## Flows 段声明，实例化后进 Turn Inject）。 */
export interface FlowTemplate {
  /** /name 触发。 */
  name: string;
  /** 参数提示。 */
  argumentHint?: string;
  /** 数据语义层：带 {{}} 占位符的前提。 */
  intent: string;
  /** 手册结构层：步骤 + 数据源 + 期望产出。 */
  steps: FlowStep[];
}
/** 验收清单（与 Rule[] 不同：只列条目，不带 slot/type/check）。
 *  Renderer：`### name\n- item1\n- item2`。 */
export interface Checklist {
  name: string;
  items: string[];
}

// ==================== 结构层原子 ====================
export interface StructureLayout {
  mode: "byDomain" | "byType" | "hybrid";
  /** byDomain / hybrid 时的模块顺序；未指定则原序。 */
  domainOrder?: string[];
}

// ==================== v9 聚合组（Blueprint 拥有） ====================
/** Agent 注入位置（结构层语义值，由 AgentAdapter 映射到 Agent 技术 API）。
 *  - session：LLM 失忆后重注入（如 Pi system_prompt）
 *  - turn：按需触发（如 Pi context_message）
 *  扩展点：加新注入位置 = AgentAdapter.supportedTargets 加映射。 */
export type InjectTarget = "session" | "turn" | string;
/** Blueprint 的聚合组定义（YAML groups 项，聚合组名=人类自定义语义名）。
 *  Blueprint 退化为插槽契约（name + inject + mode），modules 由 ProfileGroup 提供。 */
export interface BlueprintGroup {
  /** Aggregation group name (semantic, e.g. "session-context" / "reference-manual"). */
  name: string;
  /** 注入位置（session / turn / 扩展）——值语义名，AgentAdapter 映射到具体 Agent API。 */
  inject: InjectTarget;
  /** 聚合方式（仅 session 类有意义）。 */
  mode?: StructureLayout["mode"];
}
/** ModName 解析形态：
 *  - 段名（"Scene"）：跨所有引用域整段聚合
 *  - 段.项（"User.user-profile"）：跨所有引用域该段下 H3 项
 *  限定到单个 domain 通过专用段名（User / Agent）实现，不引入形态 3。 */
export interface ModName {
  /** H2 段名。 */
  section: string;
  /** H3 项名。undefined = 段粒度匹配；string = 该段下 H3 项名。 */
  item?: string;
}
/** Profile 的聚合组实例化（H2 = 聚合组名，与 BlueprintGroup 同名）。
 *  空数组 = 缺填（log debug only 不 notify）。 */
export interface ProfileGroup {
  name: string;
  /** 追加到本聚合组的 Domain 名列表（只贡献该聚合组）。 */
  domains: string[];
  /** 本插槽填的聚合模块列表（段名 = 整段聚合；段.项 = 精确选 H3 项）。 */
  modules: ModName[];
}

// ==================== 内容层：Domain ====================
/** v9 Domain：内容层模块。
 *  扩展点：H2 段名是开放的——加新模块类型 = 加新 H2 段名 + Blueprint 声明该模块。 */
export interface Domain {
  name: string;
  /** H2 段名 → 段内容。Pt 核心按 H2 名读段，不硬编码段名。 */
  modules: Record<string, unknown>;
}

// ==================== 结构层：Blueprint ====================
/** Blueprint：Agent 端聚合组结构，结构层模块（跨项目复用）。
 *  扩展点：加新 Agent 只加 AgentAdapter。 */
export interface Blueprint {
  name: string;
  /** 聚合组列表（YAML groups 项），定义 inject + mode。 */
  groups: BlueprintGroup[];
}

// ==================== 配置层：Profile ====================
/** Profile：业务端实例，配置层模块（项目级，不跨项目复用）。 */
export interface Profile {
  name: string;
  /** 引用的 Blueprint 名（结构复用）。 */
  blueprint: string;
  /** 全局 Domain 列表，自动分发到所有聚合组。 */
  domains: string[];
  /** 聚合组实例化（与 BlueprintGroup 同名）。 */
  groups: ProfileGroup[];
  /** 身份一句话介绍（选填）。展示路径：/pt-profile 选择器、/pt status、footer。 */
  tagline?: string;
  /** MdFilePack 加载时打上——不限定 ref 自动绑定用。 */
  sourcePack?: string;
  /** use 单继承——引用另一 Profile 作为基础，递归展开。
   *  不写 = 完全独立 Profile（expandProfile 早退）；写了 = 增量继承。
   *  格式：`@pack/name` 或 `name`（无限定→self.sourcePack/name）。
   *  循环检测 + 菱形处理：路径 visited；越权校验：use 场景 error。 */
  use?: string;
  /** 可选 domain ref 列表。找不到不阻断（info 级诊断）；不参与 use 链合并。 */
  optionalDomains?: string[];
}

// ==================== 产物层：AgentContext ====================
/** AgentContext：Profile 编译输出，物理文件（.pt/cache/agent-contexts/*.agent-context.md），缓存复用。 */
export interface AgentContext {
  name: string;
  /** Blueprint 名（缓存标识 + YAML 头）。 */
  blueprint: string;
  /** 缓存失效依据：hash(profile + blueprint + domains + packs)。 */
  sourceHash: string;
  /** 聚合组名（语义名）→ 聚合后的 markdown 字符串。 */
  modules: Record<string, string>;
  /** cache 文件名 <pack>__<profile> 用。 */
  packName: string;
}

// ==================== IR 集合（编译期内存态） ====================
/** WorkingSet 双索引结构：
 *  - location：按位置 alias（prj/pt）——reserved pack 才有
 *  - identity：按 pack.name（manifest.name 或退化别名）——所有 pack 都进
 *  reserved pack 无 manifest 时双索引 key 重合——双入口命中同一 asset。 */
export interface WorkingSet<T> {
  location: Map<string, { pack: AssetPack; asset: T }>;
  identity: Map<string, { pack: AssetPack; asset: T }>;
}
/** SchemaBundle：编译期内存态，包含所有加载的 IR。 */
export interface SchemaBundle {
  domains: Domain[];
  blueprints: Blueprint[];
  profiles: Profile[];
  /** 当前激活的 Profile 名。 */
  activeProfile: string;
  /** activeProfile 由来——"exact"：用户请求的 profile 名在某个 pack 找到；"fallback"：未找到，fallback 到 allProfiles[0]。
   *  caller 层依据 origin 决定是否同步改写 s.activeProfile / loadedFrom / notify。 */
  activeProfileOrigin: "exact" | "fallback";
  /** 当 origin="fallback"：记录用户原始请求的 profile 名（用于 notify 文案 / log / debug）。 */
  originalProfileName?: string;
  /** 加载的所有 AssetPack——sourceHash + cache 文件名用。 */
  packs: AssetPack[];
  /** 激活 Profile 所属的 pack name（cache 文件名用）。 */
  activeProfilePack: string;
  /** 三类 asset 的 working set，dedup 下推到引用层。 */
  workingSet: {
    domains: WorkingSet<Domain>;
    blueprints: WorkingSet<Blueprint>;
    profiles: WorkingSet<Profile>;
  };
}

// ==================== Source Adapter 接口（依赖反转后） ====================
/** Adapter load 上下文。 */
export interface SourceAdapterContext {
  /** 错误/警告通知回调（可选；不传则走 console fallback）。 */
  notify?: (msg: string, level: "warning" | "error") => void;
  /** 资产根目录覆盖（默认 `.pt/assets`）。 */
  assetDir?: string;
  /** 持久化日志 writer（可选；不传则不写盘，仅走 notify）。 */
  log?: {
    debug(msg: string, ctx?: Record<string, unknown>): void;
    info(msg: string, ctx?: Record<string, unknown>): void;
    warn(msg: string, ctx?: Record<string, unknown>): void;
    error(msg: string, ctx?: Record<string, unknown>): void;
  };
}
/** SourceAdapter：Pt 核心只认 SchemaBundle，不认任何来源格式。
 *  扩展点：加新知识源 = 实现 SourceAdapter 接口。 */
export interface SourceAdapter {
  name: string;
  load(cwd: string, profileName: string, adapterCtx?: SourceAdapterContext): Promise<SchemaBundle>;
}

// ==================== AssetPack 抽象 ====================
/** Pack 来源类型（诊断显示用）：project / settings / builtin。 */
export type PackSource = "project" | "settings" | "builtin";
/** AssetPack：单个资产来源的抽象。
 *  mdAdapter.load() 内部构造 AssetPack[]，依次 load → 合并 SchemaBundle。 */
export interface AssetPack {
  /** Pack 身份（reserved 固定名 "prj"/"pt"，或目录 basename 兜底）。 */
  readonly name: string;
  /** Pack 版本（manifest 读，缺省 "0.0.0"）。 */
  readonly version: string;
  readonly description?: string;
  readonly rootDir: string;
  readonly source: PackSource;
  loadDomains(): Promise<Domain[]>;
  loadBlueprints(): Promise<Blueprint[]>;
  loadProfiles(): Promise<Profile[]>;
}

// ==================== Agent 适配器接口 ====================
/** Agent UI 能力（可选，adapter 按需用）。 */
export interface AgentUI {
  notify(msg: string, level: "info" | "warning" | "error"): void;
  setStatus(name: string, text: string): void;
}
/** Agent 注入 API 的最小接口（AgentAdapter 用，不直接依赖 Pi ExtensionAPI）。 */
export interface AgentAPI {
  on(event: string, handler: (...args: unknown[]) => unknown): void;
  registerCommand(name: string, spec: unknown): void;
  registerFlag(name: string, spec: unknown): void;
  getFlag(name: string): unknown;
  /** 可选 UI：index.ts 传入 Pi ctx.ui 适配后的对象。 */
  ui?: AgentUI;
  /** 可选 log：per-session PtLogger 适配。 */
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
 *  Pt 核心调 Adapter 接口，不直接调 Agent API。Blueprint 用 session/turn 语义值，Adapter 内部映射到 Agent API。 */
export interface AgentAdapter {
  name: string;
  /** 该 Agent 支持的技术注入 API 名（Pi: system_prompt, context_message）。 */
  supportedTargets: string[];
  /** 设置编译产物（compile 后调）。
   *  Adapter 持有 profile 后，turn 路径（renderTurnInject / listManuals）内部统一按 Profile scope 过滤。 */
  setAgentContext(
    ctx: AgentContext,
    blueprint: Blueprint,
    domains: Domain[],
    profile: Profile
  ): void;
  /** 启动时注册：把 AgentContext 注入到 Agent（session_start 调用）。 */
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
   *  Adapter 内部用 setAgentContext 时存下的 profile 调 filterDomainsByProfile 自行过滤。
   *  可选方法——Adapter 不实现时 /pt flows 返空。 */
  listManuals?(
    ctx: AgentContext,
    blueprint: Blueprint,
    domains: Domain[]
  ): Array<{ name: string; hint?: string; domain: string }>;
}

// ==================== Blueprint/Profile 名解析辅助 ====================
/** 从 Blueprint 列表里找指定名的 Blueprint。未找到返 undefined。 */
export function findBlueprint(blueprints: Blueprint[], name: string): Blueprint | undefined {
  return blueprints.find((b) => b.name === name);
}
/** 从 Profile 列表里找指定名的 Profile。未找到返 undefined。 */
export function findProfile(profiles: Profile[], name: string): Profile | undefined {
  return profiles.find((p) => p.name === name);
}
/** 从 ref 取 asset name——`@pack/name` 限定取尾段，否则原样。 */
export function refName(ref: string): string {
  if (ref.startsWith("@")) {
    const slashIdx = ref.indexOf("/");
    if (slashIdx > 0) return ref.slice(slashIdx + 1);
  }
  return ref;
}
/** 按 Profile 引用范围过滤 domains（turn 路径 scope 过滤用）。
 *  profile 为 null 时返 domains 原样（向后兼容）。 */
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
