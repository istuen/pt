---
type: issue
name: pt-asset-migration-visibility
status: resolved
severity: medium
created: 2026-09-09
resolved: 2026-09-09
resolved-by: pt-asset-migration-visibility-fix
domain: pt-dev
related: pt-status-no-injection-state
---

# pt 存量项目在 Pt 升级后无迁移可见性

## 现象

issue pt-status-no-injection-state 揭示：v9.1 modules-to-profile 迁移后，**只填 `### Domains` 不填 `### Modules`** 的存量 profile 会产出空 segment，footer 永远 `idle`。

修复后的 runtime 检测（修复 2 + 修复 3）覆盖**单 profile 切换时机**，但有以下盲区：

1. **启动盲区**：用户不切换 profile 就发现不了——session_start 默认 profile 已是"坏"的（如 `ysl-developer`）→ 启动就空 segment → 用户以为 Pt 坏了
2. **跨项目盲区**：存量项目升级 Pt 后，**没有提示告知 schema 变了**——只能踩坑后查 issue 才能知道要加 `### Modules`
3. **主动发现盲区**：没有 `/pt check` 命令主动体检，用户必须被动等 bug 暴露
4. **视觉盲区**：现有 footer `pt: guide idle` 是纯文本——没有视觉强调，warning / error 状态和 ok 状态视觉一样，用户容易忽略

## 根因

Pt 的资产是 Markdown 文件（versionless），Pt 升级不强制 schema 验证：

- 没有 schema-version 字段（frontmatter 不带）
- 没有"项目 vs Pt 版本"对比机制
- 启动时只编 active profile，其他 profile 静默
- 没有 `/pt check` 类自检命令

历史上 v8 → v9（type 字段删除）、v9 → v9.1（modules-to-profile）每次迁移都依赖用户主动查 CHANGELOG。

## 影响

每次 Pt 大版本变更，存量项目都会有一段"踩坑期"：

| 升级类型 | 影响存量项目 |
|---|---|
| v9.0 type 删除 | type 字段被忽略，模块选错 |
| v9.1 modules-to-profile | profile 缺 `### Modules` → 空 segment |
| 未来 v9.2 / v10.0 | 再次重复 |

每次修复都是"事后追查"模式，违反"主动告知"原则。

## 修复方案（4 层）

### Layer 2：session_start 启动时批量体检

新增 `src/asset-health.ts`，`session_start` 触发（transpile 成功后）扫描项目所有 profile（不只是 active 的），检测已知反模式：

```ts
export interface AssetHealthIssue {
  severity: "error" | "warning";
  scope: "profile" | "blueprint" | "domain";
  name: string;
  field?: string;     // e.g. "groups.会话背景.modules"
  msg: string;
  hint?: string;      // 修复建议
  fix?: string;       // 自动 fix 命令（Layer 3 用）
}

export function scanProjectHealth(
  profiles: Profile[],
  blueprints: Blueprint[],
  domains: Domain[]
): AssetHealthIssue[];
```

**检测规则**（v1 范围）：

| 规则 | severity | 触发条件 | 提示 |
|---|---|---|---|
| `missing-modules` | error | profile H2 段下有 `### Domains` 但无 `### Modules` | 加 `### Modules: [Scene, User, ...]` |
| `dangling-blueprint-ref` | error | profile frontmatter `blueprint: X` 但 X 不存在 | 检查拼写 / fallback 到 builtin |
| `orphan-h2` | warning | profile H2 段名不在 blueprint.groups 中 | 删 H2 或加到 blueprint |
| `empty-segment` | error | 编译后 segment.length === 0 | 检查 modules 配置 |
| `unknown-modname` | warning | `### Modules` 项不在 KNOWN_SECTION_NAMES | 检查段名拼写 |

**集成点**：`session_start` 成功加载 profile 后调一次：

```ts
// src/index.ts session_start 末尾
const issues = scanProjectHealth(bundle.profiles, bundle.blueprints, bundle.domains);
if (issues.length > 0) {
  const summary = issues.length === 1
    ? `[pt] 项目有 1 个配置问题：${issues[0].msg}（运行 /pt check 查看详情）`
    : `[pt] 项目有 ${issues.length} 个配置问题（运行 /pt check 查看详情）`;
  ctx.ui.notify(summary, "warning");
  // 也写入 SessionState 让 footer 反映
  s.assetHealthIssues = issues;
}
```

### Layer 3：`/pt check` 显式体检命令

新增 `src/commands.ts checkText()`：

```bash
/pt check                # 列出所有 issue（tsc 风格）
/pt check --profile X    # 单 profile 体检
/pt check --fix          # 自动套用已知 fix（v2 范围）
```

**输出格式**（参考 biome / tsc）：

```
$ /pt check

ysl-developer.profile.md
  × [error] ## 会话背景 缺 ### Modules
     hint: 在 H2 段下加 `### Modules: [Scene, ...]`
     fix:  /pt check --fix ysl-developer --add-modules Scene

ysl-manager.profile.md
  × [error] ## 会话背景 缺 ### Modules

ysl-erp-consultant.profile.md
  × [error] ## 会话背景 缺 ### Modules

× 6 errors, 0 warnings
  hint: 运行 `/pt check --fix` 自动应用已知 migration
```

**配套 LLM tool**：`pt_check`（与 `pt_status` / `pt_flows` / `pt_manual` 同模式），让 LLM 能主动体检。

### Layer 5：迁移文档化（`.pt/docs/migrations/`）

每次 Pt 大版本变更**必须**：

1. 写 `.pt/docs/migrations/vX-to-vY-*.md`
2. 在 `scanProjectHealth` 加对应检测规则
3. CHANGELOG 引用 migration 路径
4. `/pt check` 输出迁移链接

```
migrations/
├── v8-to-v9-type-removal.md         # type 字段删除，H2 段名决定 schema
├── v9.0-to-v9.1-modules.md          # ### Modules 必填（本次踩的坑）
└── v9.1-to-v9.2-xxx.md              # 未来
```

### Footer 颜色变化（强制视觉）

**问题**：纯文本 footer `pt: guide idle` 容易被忽略。

**方案**：在 `renderInjectionFooter` / `statusText` 加 ANSI 颜色码：

| 状态 | 颜色 | 视觉 |
|---|---|---|
| `ok` / `injected` | green | `\x1b[32mpt: guide ok\x1b[0m` |
| `pending` | yellow | `\x1b[33mpt: guide pending\x1b[0m` |
| `idle` | dim gray | `\x1b[90mpt: guide idle\x1b[0m` |
| `failed` | red | `\x1b[31mpt: guide failed: <err>\x1b[0m` |
| `health-issue` | red + ⚠ 前缀 | `\x1b[31m⚠ pt: guide ok (3 issues)\x1b[0m` |

**pi-web 兼容**：
- 调研 pi 的 `setStatus(name, text, level?)` 是否支持 level 参数
- 若不支持，TUI 用 ANSI、web 用纯文本 + ⚠ emoji 前缀（双方案）

**检测范围扩展**：
- `assetHealthIssues.length > 0` → footer 末尾追加 ` (⚠ N issues)`
- 即使 `injected` 成功，只要体检有问题，footer 就染色 + 加告警标识

**实现细节**：

```ts
// src/injection-status.ts
export type StatusLevel = "ok" | "pending" | "idle" | "failed";

const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[90m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
};

export function renderInjectionFooter(
  state: InjectionState,
  profile: string | null,
  error: string | null,
  healthIssueCount: number = 0
): string {
  if (profile === null) return "pt: 无 context";

  const colorByState: Record<InjectionState, string> = {
    injected: ANSI.green,
    pending: ANSI.yellow,
    idle: ANSI.dim,
    failed: ANSI.red,
  };

  const stateSuffix = state === "failed" && error
    ? ` failed: ${truncate(error, 40)}`
    : state === "injected" ? " ok"
    : ` ${state}`;

  const healthSuffix = healthIssueCount > 0
    ? ` ⚠ ${healthIssueCount} issue${healthIssueCount > 1 ? "s" : ""}`
    : "";

  const text = `pt: ${profile}${stateSuffix}${healthSuffix}`;
  // TUI 用颜色，pi-web 暂用纯文本 + emoji（兼容）
  return useColor() ? `${colorByState[state]}${text}${ANSI.reset}` : text;
}
```

## 验收

1. ✅ `pnpm dev` 在 ysl 项目启动 → notify 提示"项目有 6 个配置问题"（如果有未修的 profile）
2. ✅ `/pt check` 输出 biome 风格问题清单
3. ✅ 切到有 health issue 的 profile，footer 显示红色 + ⚠ 前缀
4. ✅ 切到无 issue 的 profile，footer 显示绿色 + ok
5. ✅ `.pt/docs/migrations/v9.0-to-v9.1-modules.md` 写好
6. ✅ 单元测试：`scanProjectHealth` 5 条规则、`renderInjectionFooter` 4 状态 × 颜色 + health suffix

## 实施顺序

1. **Phase 1**（必做）：Layer 2 + footer 颜色（issue 主线）
2. **Phase 2**（必做）：Layer 3 `/pt check` + Layer 5 migration docs
3. **Phase 3**（可选）：`pt_check` LLM tool
4. **Phase 4**（可选）：`--fix` 自动应用 + schema-version 字段

## 修复（2026-09-09）

实施：commit `6629a5c` (Layer 2) + `2d6cac1` (Layer 3+5) + `76866e8` (测试)。

**Layer 2 — session_start 批量体检**
- `src/asset-health.ts`：5 条规则（missing-modules / dangling-blueprint-ref / orphan-h2 / empty-segment / unknown-modname）+ `scanProjectHealth()`
- `src/injection-status.ts`：`renderInjectionFooter(state, profile, error, healthIssueCount=0)` 加参数 + ANSI 颜色染色（injected=green / pending=yellow / idle=dim / failed=red）
- `src/session.ts`：`SessionState.assetHealthIssues: AssetHealthIssue[] | null`
- `src/index.ts`：session_start 末尾调 scanProjectHealth → 写 state + notify + refresh footer

**Layer 3 — `/pt check` 命令 + `pt_check` tool**
- `src/commands.ts`：`checkText()` 内核 + `CheckOptions` + `CheckResult`
- `src/index.ts`：`/pt check [--profile X] [--fix]` 子命令 + `pt_check` LLM tool
- 输出格式：biome 风格 `× [error] <msg>` / `⚠ [warning] <msg>` + hint/fix + migration hint

**Layer 5 — 迁移文档**
- `.pt/docs/migrations/v9.0-to-v9.1-modules.md`：背景 / 影响 / 检测 / 修复步骤 / 示例 / 关联

**Footer 颜色 + health suffix**
- TUI（isTTY=true）：状态染色 + ⚠ 后缀
- Web（isTTY=false）：纯文本 + ⚠ 前缀（避免 ANSI 乱码）
- 健康问题染色优先于状态颜色（视觉上"严重"更突出）

**测试覆盖**：210 → 250 tests（+40）
- `tests/verify/asset-health.test.ts` (17)：5 规则正反测 + cwd 必需 + builtin 跳过
- `tests/verify/injection-status.test.ts` (+9)：healthIssueCount + ANSI 颜色 + stripAnsi
- `tests/verify/commands-check.test.ts` (14)：checkText 格式化 + --profile 过滤

**端到端验证**：手工跑 scanProjectHealth + checkText + statusText，3 issues 检测（2 errors + 1 warning）正确格式化，`/pt check X` 过滤正常。

**后续（未实施）**
- `--fix` 自动应用：v2 范围。Issue 仅给出 fix 命令提示，不修改文件。
- `schema-version` 字段：v2 范围。当前靠 migration docs 人工告知。
- `pt_check` tool 在 LLM 接陌生项目 / 改资产前调用——本 issue 已实现。

## 关联

- 上游 issue: `pt-status-no-injection-state`（本次 issue 修复的 runtime 检测是 Layer 1，本 issue 是 Layer 2-5）
- 设计依据：`.pt/docs/designs/pt-injection-status-manual-track.md`（footer 4 态 + 自报机制）
