# 外部项目同步执行简报：modules-to-profile

> **基线**：pt 仓库 `d0dceb9`（modules-to-profile step5）+ pt-writing `3ac02cb`（v9 资产迁移完成后 HEAD）
> **目标**：使用 Pt 的外部项目（pt-writing / pt-xxx）按方案 D 同步迁移
> **性质**：方案 D 是破坏性 schema 变更，所有 Pt 项目资产形态必须统一

---

## 必读

1. **设计文档**：`pt-modules-ownership.md`——方案 D 设计意图
2. **原执行简报**：`pt-modules-to-profile-executor-brief.md`——步骤 1-5 完整执行链
3. **本简报与原简报关系**：原简报只覆盖 Pt 项目自身（项目侧 + builtin 资产），不覆盖外部项目。
   本简报定义"外部项目同步"作为可复用模式，未来若加 pt-xxx 项目复用此流程。

---

## 背景

方案 D 把 `modules` 归属从 Blueprint 挪到 Profile——Blueprint 退化为插槽契约（`name` + `inject` + `mode`），
Profile 通过 H2 段下 `### Modules` 填 modules 列表。`src/parse/blueprint.ts` 不再解析 modules 字段（旧 YAML
中 `modules:` 行被静默忽略）；`src/compile/agent-context.ts` 的 `resolveDomains` + `dispatchGroup` 改读
`profileGroup?.modules ?? []`。

**破坏性变更范围**：所有使用 Pt 的项目资产（blueprint + profile）都需同步迁移。**首次发现遗漏**：
pt-writing 跨项目测试 `tests/verify/phase9.test.ts:322-325` 失败（`segment.length = 0`）。

---

## 迁移流程（外部项目侧）

### 步骤 1：取证 baseline

```bash
# 1.1 stash 当前脏状态（不属本任务）
cd <external-project>
git stash push -u -m "modules-to-profile baseline 取证前 stash"

# 1.2 备份 cache（如果存在）——注意 cache 可能不在 git 里（被 stash 走）
# 用 git stash show -p 看 untracked tree，提取到 /tmp
# 详见原简报步骤 4 操作模式

# 1.3 验证 baseline：跑一次 transpile（在 pt 仓库跑 loadAndTranspile 跨项目）
# 期望：pt-writing 类情况——baseline 产物可能为空（旧资产不能在 v9 解析），baseline diff
# 不适用 "产物逐字一致"，改用 "段结构对齐"（3 段标题 + 实际内容）
```

### 步骤 2：迁移 blueprint

删除所有 `modules:` 行（含 `modules: [Scene]` / `modules: [Trigger]` / `modules: [Rules, Flows, Checklists]`）。

迁移前：
```yaml
name: writing
groups:
  - name: 会话背景
    inject: session
    mode: hybrid
    modules: [Scene]
  - name: 触发索引
    inject: session
    modules: [Trigger]
  - name: 参考手册
    inject: turn
    modules: [Rules, Flows, Checklists]
```

迁移后：
```yaml
name: writing
groups:
  - name: 会话背景
    inject: session
    mode: hybrid
  - name: 触发索引
    inject: session
  - name: 参考手册
    inject: turn
```

### 步骤 3：迁移所有 profile

每份 profile 的每个 H2 段下加 `### Modules` 段。**modules 名一字不变**（与原 blueprint.modules 字段一致）：

```markdown
## 会话背景
### Modules
- Scene

## 触发索引
### Modules
- Trigger

## 参考手册
### Modules
- Rules
- Flows
- Checklists
```

**modules 名按原 blueprint.modules 一字搬**——不是按 design doc §3.2 的"理想目标" H3 名列表搬。理由：
H3 提升为 H2 段是 schema 重构范畴，超出本任务（modules-to-profile 仅"职责重分配"，不改 schema）。

### 步骤 4：验证（在 pt 仓库跨项目跑）

```bash
cd <pt-repo>
npm run typecheck    # tsc --noEmit
npm run verify       # vitest + biome，含 phase9.test.ts 跨项目测试

# 跨项目 transpile（cwd 指向外部项目）
npx tsx -e '
import { loadAndTranspile } from "./src/transpile.js";
import { writeFile } from "node:fs/promises";
(async () => {
  const cwd = "/path/to/external-project";
  for (const p of ["<profile-name>", ...]) {
    const r = await loadAndTranspile(cwd, p);
    console.log(`${p}: ${r.segment.length} chars`);
  }
})();
'
```

**验收标准**：
- 外部项目 segment.length > 0
- 引用完整性无悬空
- phase9.test.ts 跨项目测试通过
- 3 段标题存在（## 会话背景 / ## 触发索引 / ## 参考手册），各段有内容

### 步骤 5：commit（在外部项目仓库）

```bash
cd <external-project>
git add .pt/assets/blueprints/ .pt/assets/profiles/
git commit -m "Phase modules-to-profile: 资产同步方案 D"
```

**commit message 必带**：
- "blueprint 删 modules" + "profile 加 ### Modules"
- 迁移后产物长度（writing X chars / new-vision Y chars）
- phase9.test.ts 跨项目测试通过

---

## 硬指标

| 指标 | 验证方式 | 通过标准 |
|---|---|---|
| pt 仓库三件套 | tsc + verify | 全过（含 phase9 跨项目测试） |
| 外部项目编译成功 | loadAndTranspile | segment.length > 0 |
| 段结构对齐 | 3 段标题 + 内容 | 会话背景 / 触发索引 / 参考手册 3 段非空 |
| 引用完整 | pt_check_refs | 无悬空 |
| 外部项目 git 提交 | git log | 有迁移 commit |

---

## 边界纪律

1. **modules 名一字不变**——与原 blueprint.modules 字段逐项对应。
2. **不引入兼容层**——让旧资产通过 fallback 路径跑通违背方案 D 规则统一性。
3. **只动 2 类文件**——blueprint + profile，不动 domain（domain H2 段与 modules 名映射关系不变）。
4. **产物逐字一致的适用边界**——项目侧 Pt 资产适用（baseline diff 全空）；外部项目**不适用**（旧资产
   形态本就未在 v9 编译通路里），改用"段结构对齐"为硬指标。
5. **stash 干净处理**——迁移前 stash 脏状态，迁移 commit 只含 modules-to-profile 改动；commit 后
   不主动 pop stash（脏状态归原作者处理）。

---

## 已执行案例

### 2026-09：pt-writing 同步

- commit：`7270336`（main 分支）
- 改动：3 文件（`writing.blueprint.yaml` + `writing.profile.md` + `new-vision.profile.md`）
- 产物：writing 4372 chars / new-vision 10841 chars
- 验收：pt 仓库 `verify` 199/199 通过（含 phase9 跨项目测试）

---

## 复用到新项目

未来若加新项目 pt-xxx 复用 Pt：

1. 评估新项目是否需要 Pt——若需要，直接按 v9 格式创建资产（无需走本简报）
2. 若新项目已有 v8 资产——按本简报"步骤 1-5"流程同步
3. 完成后在本文件 "已执行案例" 段追加记录
