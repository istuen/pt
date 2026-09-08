# 完整执行简报：modules-to-profile H3 项粒度落地

> **基线**：`11b771f`（删项目侧 blueprint + 复用 builtin 之后 HEAD）
> **任务来源**：用户在前几轮对话中识别"半成品"——4 profile 的 modules 是段类型粒度，不是身份角色粒度；方案 D 的核心承诺"Profile 自带角色选择 + 角色隔离"未真正落地
> **目标**：把 modules 名空间扩展到 H3 项粒度，让 4 profile 真正实现角色隔离
> **性质**：补完"半成品"，让方案 D 真正落地。**产物会变**——这是设计目标，不是事故

---

## 必读

1. **设计文档**：
   - `pt-modules-ownership.md`——方案 D 设计意图（核心承诺：Profile 自带角色选择 + 隔离性）
   - `pt-asset-layering.md` §变化 19——v9.1 modules 归属迁移（之前写得过于乐观，需重写）
2. **前几轮简报**：
   - `pt-modules-to-profile-executor-brief.md`——step1-5（"半成品"，4 profile 看到的 agent-info 内容一样）
   - `pt-modules-to-profile-fix-plan.md`——pt-writing 跨项目兼容（已执行）
   - `pt-modules-to-profile-external-migration-brief.md`——外部项目同步模式
3. **本简报与前几轮的关系**：前几轮把方案 D 当成"modules 归属从 Blueprint 挪到 Profile"——技术上正确，但**粒度选错**了。modules 名空间只用了"段类型"（Scene/Participant），没用"段.项"（User.user-profile）。本简报修正这一缺陷。

---

## 设计原则（必须守住）

1. **段名 = 命名空间，Profile 选段（不是选 domain）**——modName 2 形态（段名 / 段.项），无形态 3（domain:段.项）。限定到单个 domain 通过**段名命名空间**实现（User / Agent 这种专用段名）。
2. **段名是开放集合**——通用段（Scene/Participant/Trigger/Rules/Flows/Checklists）+ 专用段（User/Agent/...）。作者维护唯一，文档约束。
3. **user-info / agent-info 段名重命名**——`## Participant` → `## User`（user-info）/ `## Agent`（agent-info）。`User` 整段聚合 = user-info 所有 H3（user-profile/pt-goal/collab-mode/user-role-po/user-role-tl/collab-principle）；`Agent.<H3项>` 精确选 = 单角色。
4. **多级目录最小化**——只 `workflow/` 子目录归类 6 个 workflow 类 domain，其他全部保留根目录。
5. **H3 项重名处理**：同段内后覆盖前；跨段不跨段匹配（`User.user-profile` 只匹配 User 段下，不匹配 Agent 段下同名 H3）。
6. **角色隔离是设计目标**——4 profile 的 Agent 角色各自只看自己角色 + active-role-rule，不是 4 profile 都看全角色。
7. **每 commit 过三件套**——tsc + verify + biome。
8. **不破坏 builtin 资产形态**——builtin domains 不重组（按"先创建 workflow 目录即可，其他都不要"约束）。

---

## 改动全景

```
步骤 1: parse / compile / render 改（2 形态 + H3 粒度 + 多级目录加载）
    ↓  tsc + verify 过
步骤 2: user-info / agent-info 段名重命名（User / Agent）
    ↓
步骤 3: 4 profile + builtin guide modules 改（H3 粒度）
    ↓  pt_check_refs 无悬空
步骤 4: 目录重组（只 workflow/）
    ↓
步骤 5: pt-writing 同步
    ↓
步骤 6: fixture 同步（5 个测试）
    ↓
步骤 7: 文档更新
    ↓
验收（端到端：4 profile 角色隔离 + 三件套 + ref 无悬空 + pt-writing 跨项目）
```

---

## 步骤 1：parse / compile / render 改

### 目标

让 compile 按 modName 2 形态（段名 / 段.项）做 H3 粒度过滤与渲染；loadAllDomains 支持多级目录递归扫描；Domain.name = POSIX 相对路径。

### 1.1 `src/parse/index.ts`

`loadAllDomains` 改 `readdir(dir, { recursive: true })`：

```ts
async function loadAllDomains(cwd: string, adapterCtx?: SourceAdapterContext): Promise<Domain[]> {
  const assetDir = adapterCtx?.assetDir ?? DEFAULT_ASSET_DIR;
  const dir = join(cwd, assetDir, "domains");
  let files: string[];
  try {
    // Node.js 20+ recursive 读取——返回 POSIX 路径（如 "meta/login.md"）
    files = (await readdir(dir, { recursive: true })).filter((f) => f.endsWith(SUFFIX_MD));
  } catch {
    return [];
  }
  const results: Array<Domain | null> = await Promise.all(
    files.map(async (relPath) => {
      try {
        // Domain.name = POSIX 相对路径（去 .md 后缀）
        return await parseDomain(dir, relPath);
      } catch (e) {
        reportError(adapterCtx, `parse ${dir}/${relPath} failed: ${errMsg(e)}`, { file: relPath });
        return null;
      }
    })
  );
  return results.filter((r): r is Domain => !!r);
}
```

### 1.2 `src/parse/domain.ts`

`parseDomain` 签名改（接受 relPath），Domain.name = POSIX 相对路径去后缀：

```ts
export async function parseDomain(absDir: string, relPath: string): Promise<Domain> {
  const asset = await readAsset(join(absDir, relPath));
  // ... H2 段解析不变
  return {
    name: typeof asset.frontmatter.name === "string"
      ? asset.frontmatter.name
      : normalizeName(relPath),  // POSIX 相对路径去 .md
    modules,
  };
}

/** POSIX 相对路径去 .md 后缀。Node.js recursive readdir 在 Windows 也返回 '/' 分隔。 */
function normalizeName(relPath: string): string {
  return relPath.split(/[\\/]/).join("/").replace(/\.md$/, "");
}
```

### 1.3 `src/parse/profile.ts`

新增 modName 解析器（2 形态）：

```ts
/** 已知 H2 段名（段名 = 命名空间）。扩展新段名 = 加这一行注册 + renderer。 */
const KNOWN_SECTION_NAMES = new Set([
  "Scene", "Participant", "Trigger", "Rules", "Flows", "Checklists",
  "User", "Agent",  // 专用段名（user-info / agent-info 重命名后）
  // 扩展：加新段名 = 加一行 + parser
]);

/** 解析 modName → { section, item? }。
 *  - "Scene" → { section: "Scene" }
 *  - "User.user-profile" → { section: "User", item: "user-profile" }
 *  解析失败（modName 段名不在 KNOWN_SECTION_NAMES）→ 返 null（caller 走 warn + skip）。 */
export function parseModName(modName: string): { section: string; item?: string } | null {
  if (modName.includes(".")) {
    const [section, item] = modName.split(".", 2);
    if (KNOWN_SECTION_NAMES.has(section) && item) {
      return { section, item };
    }
    return null;
  }
  if (KNOWN_SECTION_NAMES.has(modName)) {
    return { section: modName };
  }
  return null;
}
```

`parseProfile` 在每 H2 段下用解析器过滤：

```ts
for (const [h2Name, section] of Object.entries(asset.sections)) {
  const rawMods = extractModulesList(section);
  const modules = rawMods
    .map((m) => parseModName(m.trim()))
    .filter((m): m is { section: string; item?: string } => m !== null);
  if (modules.length !== rawMods.length) {
    // 至少一个 modName 解析失败——log warn
    // (调用方传 adapterCtx，本函数签名需要扩)
  }
  groups.push({ name: h2Name, domains: extractDomainsList(section), modules });
}
```

### 1.4 `src/compile/agent-context.ts`

`resolveDomains` 改：每个 modName 拆 section + 可选 item；Domain.modules[section] 必须存在 + item 时 section 内 H3 项必须有 item：

```ts
function matchesMod(d: Domain, mod: { section: string; item?: string }): boolean {
  const content = d.modules[mod.section];
  if (content === undefined) return false;
  if (!mod.item) return true;  // 段粒度匹配
  // 项粒度匹配：H3 项 name = mod.item
  if (!Array.isArray(content)) return false;
  return content.some((it: any) => it?.name === mod.item);
}
```

`dispatchGroup` 改：modName 拆 section + item；按形态分发渲染：

```ts
function dispatchGroup(
  profileGroup: ProfileGroup | undefined,
  bpGroup: BlueprintGroup,
  refDomains: Domain[]
): string {
  const parts: string[] = [];
  const mods = profileGroup?.modules ?? [];  // ModName[] 形式为 { section, item? }[]
  for (const mod of mods) {
    const modParts: string[] = [];
    for (const d of refDomains) {
      const content = d.modules[mod.section];
      if (content === undefined) continue;
      if (mod.item) {
        // 项粒度：渲染单个 H3 项
        if (Array.isArray(content)) {
          const item = content.find((it: any) => it?.name === mod.item);
          if (item) {
            const rendered = renderItemModule(d, item, mod.section);
            if (rendered) modParts.push(rendered);
          }
        }
      } else {
        // 段粒度：整段渲染
        const rendered = (moduleRenderers[mod.section] ?? renderGenericModule)(d, content, bpGroup.mode);
        if (rendered) modParts.push(rendered);
      }
    }
    if (modParts.length > 0) parts.push(modParts.join("\n\n"));
  }
  return parts.join("\n\n").trimEnd();
}
```

注册新段名 `User` / `Agent` 复用 Scene renderer（Term[] 同构）：

```ts
import { MOD_USER, MOD_AGENT, /* ... */ } from "../constants.js";
const moduleRenderers: Record<string, ModuleRenderer> = {
  [MOD_SCENE]: renderSceneModule,
  [MOD_USER]: renderSceneModule,    // 复用 Scene renderer（Term[] 同构）
  [MOD_AGENT]: renderSceneModule,
  // ...
};
```

新增 `renderItemModule`（H3 项粒度）：

```ts
/** H3 项粒度渲染：输出 `### <domain>.<item>` 形式。
 *  通用：取项的 name/desc/fields/note/path，按 Scene renderer 风格输出单行。 */
function renderItemModule(d: Domain, item: any, section: string): string {
  if (!item?.name) return "";
  const lines: string[] = [`### ${d.name}.${item.name}`];
  if (item.desc) lines.push(`- ${item.name}: ${item.desc}`);
  else if (item.path) lines.push(`- ${item.name}: ${item.path}`);
  else lines.push(`- ${item.name}`);
  if (item.fields?.length) lines[lines.length - 1] += `（字段：${item.fields.join("/")}）`;
  if (item.note) lines[lines.length - 1] += ` — ${item.note}`;
  return lines.join("\n");
}
```

`compileAgentContext` 主循环：`mods` 改成 `{ section, item? }[]`，`resolveDomains` 传 mods 给匹配函数。

### 1.5 `src/constants.ts`

加新段名常量：

```ts
export const MOD_USER = "User";
export const MOD_AGENT = "Agent";
```

### 1.6 ProfileGroup schema 改

`ProfileGroup.modules` 元素从 `string` 改成 `{ section: string; item?: string }`：

```ts
// src/schema.ts
export interface ModName {
  section: string;
  item?: string;
}

export interface ProfileGroup {
  name: string;
  domains: string[];
  modules: ModName[];  // 改：string[] → ModName[]
}
```

**封闭性已验证**：
- `bpGroup.modules` 消费点：只有 compile 路径——本步改
- `ProfileGroup.modules` 消费点：只有 compile 路径——本步改
- render 层（`session-inject.ts` / `turn-inject.ts`）只读 `group.inject`，不碰 modules
- `pi-adapter.listManuals` 走 MOD_FLOWS 硬编码常量——不读 modules

### 1.7 验收

- `npm run typecheck` 过
- `npm run verify` 过（可能部分测试因 schema 改失败——步骤 6 同步修）
- 临时跑 `loadAndTranspile(cwd, "pt-dev")` 验证产物含 `### agent-info.senior-developer` 形式输出

---

## 步骤 2：user-info / agent-info 段名重命名

### 目标

`## Participant` → `## User`（user-info） / `## Agent`（agent-info）。让 4 profile 真正实现角色隔离。

### 2.1 项目侧

`.pt/assets/domains/user-info.md`：

```diff
- ## Participant
+ ## User
  ### user-profile
  - desc: ...
  ### pt-goal
  ...
```

`.pt/assets/domains/agent-info.md`：

```diff
- ## Participant
+ ## Agent
  ### agent-role-architect
  - desc: ...
  ### agent-role-senior-developer
  ...
```

### 2.2 builtin 同步

`src/builtin/assets/domains/user-info.md` / `agent-info.md` 同样改。

### 2.3 验收

- 4 文件 diff 只动 `## Participant` → `## User` / `## Agent`
- tsc 过（无代码层 schema 错误）
- 跑 transpile 验证：user-info 的 H3 项现在归在 `User` 段名下

---

## 步骤 3：4 profile + builtin guide modules 改

### 目标

按方案 D 目标形态——4 profile 真正实现角色隔离。modules 用 2 形态（段名 / 段.项）。

### 3.1 4 profile 的 modules 配置

**pt-arch.profile.md** 会话背景：
```yaml
## 会话背景
### Modules
- Scene
- User
- Agent.agent-role-architect
- Agent.active-role-rule
```

**pt-design.profile.md** 会话背景：同 pt-arch（design 也是 architect 角色）。

**pt-dev.profile.md** 会话背景：
```yaml
## 会话背景
### Modules
- Scene
- User
- Agent.agent-role-senior-developer
- Agent.agent-role-qa-engineer
- Agent.agent-role-code-reviewer
- Agent.active-role-rule
```

**pt-devops.profile.md** 会话背景：
```yaml
## 会话背景
### Modules
- Scene
- User
- Agent.agent-role-devops-engineer
- Agent.active-role-rule
```

4 profile 触发索引 + 参考手册的 modules 不变（段类型粒度，与现状一致）：
- 触发索引：`### Modules: - Trigger`
- 参考手册：`### Modules: - Rules, - Flows, - Checklists`

### 3.2 builtin guide.modules

完整角色（onboarding 用）：

**guide.profile.md** 会话背景：
```yaml
## 会话背景
### Modules
- Scene
- User
- Agent
```

触发索引 + 参考手册不变。

### 3.3 验收

- 4 + 1 profile 的 `### Modules` 段内容已改
- tsc + verify 过
- `loadAndTranspile` 跨 4 + 1 profile 跑通
- 人工核对：pt-dev 产物含 senior-developer / qa-engineer / code-reviewer 但**不**含 architect / devops-engineer
- pt-arch 产物含 architect 但**不**含 senior-developer / qa-engineer / code-reviewer / devops-engineer

---

## 步骤 4：目录重组（只 workflow/）

### 目标

6 个 workflow 类 domain 移入 `workflow/` 子目录；5 个根目录 domain 保留。profile `domains:` 列表用 path 形式。

### 4.1 移动文件

用 `git mv` 保留历史：

```bash
cd .pt/assets/domains
git mv dev-workflow.md workflow/dev-workflow.md
git mv issue-workflow.md workflow/issue-workflow.md
git mv testing-workflow.md workflow/testing-workflow.md
git mv deployment.md workflow/deployment.md
git mv release-workflow.md workflow/release-workflow.md
git mv asset-workflow.md workflow/asset-workflow.md
```

移动后结构：
```
.pt/assets/domains/
  user-info.md                # 根目录
  agent-info.md               # 根目录
  product-design.md           # 根目录
  pt-quality.md               # 根目录
  pt-collab.md                # 根目录
  workflow/
    dev-workflow.md
    issue-workflow.md
    testing-workflow.md
    deployment.md
    release-workflow.md
    asset-workflow.md
```

### 4.2 4 profile 的 `domains:` 列表改 path 形式

```yaml
# pt-arch.profile.md
domains: [user-info, agent-info, product-design, pt-collab]

# pt-design.profile.md
domains: [user-info, agent-info, product-design, pt-collab]

# pt-dev.profile.md
domains: [user-info, agent-info, product-design, workflow/dev-workflow, workflow/issue-workflow, workflow/testing-workflow, pt-quality, pt-collab]

# pt-devops.profile.md
domains: [user-info, agent-info, workflow/deployment, workflow/release-workflow, pt-quality, pt-collab]
```

### 4.3 builtin 暂不重组

按"先创建 workflow 目录即可，其他都不要"约束——builtin domains 保留 flat 目录（user-info / agent-info / project-analysis / authoring / usage 都在根目录）。

### 4.4 builtin guide 的 `domains:` 改 path 形式（如有需要）

当前 guide domains: `[user-info, agent-info, project-analysis, authoring, usage]`——都是根目录 builtin 域，name 与 path 一致。**不改**。

### 4.5 验收

- 6 个 domain 移到 `workflow/`
- 4 profile `domains:` 列表用 path 形式
- tsc + verify 过
- 5 份产物（pt 4 + builtin guide）跑通
- `pt_check_refs` 无悬空

---

## 步骤 5：pt-writing 同步

### 目标

pt-writing 跨项目兼容——profile `domains:` 改 path 形式（如有 workflow 类 domain），modules 改 H3 粒度。

### 5.1 pt-writing 域现状

pt-writing 域（untracked，未提交）：
- `me.md` / `writing-style.md` / `writing-concepts.md` / `writing-flow.md` / `md-stack.md` — 根目录
- `ai-cognition.md` / `agent-as-boundary.md` / `internet-restructure.md` / `new-vision-series.md` — 根目录

**是否有 workflow 类 domain？** 看名字不像（`writing-style` / `writing-concepts` 等是知识类）。**不重组**——保持 flat。

### 5.2 pt-writing 2 profile 的 modules 改

pt-writing 域没有 `User` / `Agent` 段（都是 `Scene` / `Trigger` 段），所以 modules 改 H3 粒度的影响**有限**。

`writing.profile.md` 会话背景：
```yaml
## 会话背景
### Modules
- Scene
```

（保持现状——writing 没身份域需要 H3 粒度）

`new-vision.profile.md` 同 writing。

触发索引 + 参考手册的 modules 不变（pt-writing 的 writing blueprint 是 `[Scene]` / `[Trigger]` / `[Rules, Flows, Checklists]`）。

### 5.3 pt-writing profile `domains:` 改 path 形式

当前 `domains: [me, writing-style, ...]`——都是根目录，name = path。**不改**。

### 5.4 验收

- pt-writing 2 profile 的 modules 改 H3 粒度（如果需要——当前可能不需要改）
- 跨项目 transpile 跑通
- phase9.test.ts pt-writing 跨项目测试通过

---

## 步骤 6：fixture 同步

### 目标

5 个测试 fixture 改——`ProfileGroup.modules` 元素从 `string` 改成 `{ section, item? }` 形式；现有断言改 H3 粒度相关。

### 6.1 `tests/verify/compile-agent-context.test.ts`

`makeProfile` 的 `groups` 改 `modules` 元素为对象：

```ts
function makeProfile(overrides?: Partial<Profile>): Profile {
  return {
    name: "test-profile",
    blueprint: "test-blueprint",
    domains: ["d1"],
    groups: [{
      name: "会话背景",
      domains: [],
      modules: [{ section: "Scene" }],  // 改：string[] → { section, item? }[]
    }],
    ...overrides,
  };
}
```

新增 H3 粒度相关测试用例：
- 段名整段聚合测试
- 段.项 单 H3 项聚合测试
- 段名不存在 → 跳过
- 段.项 不存在 → 跳过

### 6.2 `tests/verify/phase9.test.ts`

参会背景相关断言改：
- 之前断言"所有 H3 全出现"——改断言"按 profile 配置的 modules 选 H3"
- pt-dev 断言：含 senior-developer / qa-engineer / code-reviewer；**不**含 architect / devops-engineer
- pt-arch 断言：含 architect；**不**含 senior-developer / qa-engineer / code-reviewer / devops-engineer
- pt-design 断言：同 pt-arch
- pt-devops 断言：含 devops-engineer；**不**含其他

### 6.3 `tests/verify/flows.test.ts`

可能改：listManuals 范围过滤——确认 modules 解析对 listManuals 无影响（listManuals 走 MOD_FLOWS 硬编码常量，不读 modules）。**理论不改**——验证后确认。

### 6.4 `tests/verify/ref-check.test.ts`

可能改：BlueprintGroup 字面量同步（之前已同步过 modules 删除——本步不需改）。

### 6.5 `tests/verify/parse-blueprint.test.ts`

可能改：Blueprint 加载测试——本步不直接动 Blueprint，**理论不改**。

### 6.6 验收

- 5 个测试同步改完
- tsc + verify 全过
- 单元测试 + 集成测试 + 回归测试都通过

---

## 步骤 7：文档更新

### 目标

`pt-asset-layering.md` 变化 19 重写（之前"半成品"叙述修正）+ 新增 §多级目录段 + 新增 §段名命名空间段 + 新增 §H3 重名段；`pt-modules-to-profile-fix-plan.md` 更新（"修兼容" → "完整落地"）。

### 7.1 `pt-asset-layering.md` 变化 19 重写

之前根因段写：
> "modules 混了'具名身份模块'（tech-lead / senior-developer）和'段类型'（Scene / Trigger / Rules）两种语义..."

——这没错但**没真正解决问题**。重写加：
- 根因扩展：modName 名空间从段类型扩展到段.项粒度
- 段名 = 命名空间（通用段 + 专用段）
- User / Agent 专用段名实现角色隔离
- modName 2 形态规则
- 4 profile 真正实现角色隔离（具体到 H3 项名）

加新段：
- §多级目录（Domain.name = path）
- §段名命名空间（专用段 vs 通用段）
- §H3 重名（同段内后覆盖前，跨段不跨段匹配）

### 7.2 `pt-modules-to-profile-fix-plan.md` 更新

§一 表格换成真实此前失误（"把 pt-writing 跨项目失败判为范围外"——1 条）。§三-四 决策与本简报对齐。

### 7.3 `pt-modules-to-profile-external-migration-brief.md` 更新

modules 命名空间从"段名列表"改为"ModName 对象列表"——同步到外部项目同步模式。

### 7.4 验收

- 文档改完
- 文档措辞不重复"半成品"叙述
- commit 独立

---

## 硬指标

| 指标 | 验证方式 | 通过标准 |
|---|---|---|
| 三件套 | `npm run typecheck` + `npm run verify` + `npx biome check` | 全过 |
| 引用完整 | `pt_check_refs` | 无悬空 |
| 4 profile 角色隔离 | 跑 transpile，逐 profile 人工核对产物 | pt-dev 含 dev 3 角色不含 arch/devops；pt-arch/design 含 architect 不含其他；pt-devops 含 devops 不含其他 |
| builtin guide 完整 | 跑 transpile 验证 | guide 产物含 User / Agent 整段（onboarding 完整） |
| pt-writing 跨项目 | phase9.test.ts 跨项目测试 | 通过 |
| H3 粒度渲染 | 产物含 `### <domain>.<item>` 形式 | 至少 pt-dev 产物含 `### agent-info.senior-developer` 等 |
| modName 2 形态 | 单元测试（compile-agent-context.test.ts） | 段名整段 + 段.项单项两类用例全过 |
| H3 重名 | 单元测试 | 同段内后覆盖前用例过 |
| 段名不存在 | 单元测试 | modName 解析失败 → log warn 跳过 |
| 路径兼容 | 多级目录加载 | 6 个 workflow/ 子目录 domain 正确加载，name = path |

---

## 边界纪律

1. **modName 2 形态**——不引入形态 3（domain:段.项）。限定到单个 domain 通过段名命名空间（User / Agent）。
2. **不重组 builtin domains**——按"先创建 workflow 目录即可，其他都不要"约束。builtin 域保留 flat 目录。
3. **user-info / agent-info 段名改 User / Agent**——不保留 Participant 双义（既用户身份又 Agent 角色）。
4. **产物会变是设计目标**——不强制产物逐字一致。4 profile 产物**必变**（角色隔离）。
5. **H3 重名不引入 ERROR**——按"parse 时后覆盖前"处理（同段内）。跨段同名 H3 不跨段匹配（设计约束，文档化）。
6. **每 commit 过三件套**——不跳过不绕过。
7. **baseline 可回退**——`11b771f` 可 revert。
8. **不破坏 builtin profile 形态**——builtin guide.modules 改 H3 粒度但保留 onboarding 完整性。

---

## 开工

按步骤 1 → 7 顺序执行。每步完成 commit 一次（三件套过才 commit）。步骤 3 角色隔离是关键验收关——profile 配置错位会让隔离失效；步骤 4 路径加载是隐性陷阱——漏改 profile `domains:` 列表会导致悬空引用。

执行基于干净工作区——开工前 `git status` 确认无未提交改动（stash 之前的 stash@{0,1} 不影响本任务）。
