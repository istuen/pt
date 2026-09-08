# 修正执行方案：pt-writing 跨项目兼容

> **基线**：`d0dceb9`（modules-to-profile step5 完成后 HEAD）
> **任务来源**：方案 D 验收发现的真实缺陷（非此前误判的"角色隔离丢失"）
> **目标**：修复 `tests/verify/phase9.test.ts` pt-writing 跨项目编译失败（`segment.length=0`）
> **性质**：方案 D 是破坏性 schema 变更，pt-writing 外部项目资产未同步迁移

---

## 一、验收更正声明

**此前验收报告误判归因，必须更正：**

方案 §一 表 4 条 “此前验收判断” 无任何对应文字 —— 这些 strawman 判断从未在验收报告中出现过。本节仅作为文档修订记录保留，**不作为修正依据**。

**唯一真实有效的前次验收发现**：pt-writing 跨项目兼容失败（`segment.length = 0`）。本方案聚焦修复这一项。

**验收复检事项**：
- 任何“验收更正声明”需以 git baseline 为准，不以工作区状态为准
- 复检步骤：先 `git show <baseline>:<path>` 取证，再下结论
- 教训：验收者应独立复验，不只信报告；发现与之前判断不一致时需重新取证

---

## 二、缺陷根因

### 现象

`tests/verify/phase9.test.ts:322-325` 失败：
```
expect(r.segment.length).toBeGreaterThan(0);  // 实际 = 0
```

### 根因链

1. 方案 D 是**破坏性 schema 变更**：
   - `src/parse/blueprint.ts` 不再解析 `modules` 字段（旧 YAML 中 `modules:` 行被静默忽略——见 `blueprint.ts:34-36` 注释）
   - `src/compile/agent-context.ts:146` `resolveDomains` 改读 `profileGroup?.modules ?? []`
   - `dispatchGroup` 同样改读 `profileGroup.modules`

2. pt-writing 资产是**旧格式**（未迁移）：
   - `pt-writing/.pt/assets/blueprints/writing.blueprint.yaml` 仍有 `modules: [Scene]` 等（被 parse 静默忽略）
   - `pt-writing/.pt/assets/profiles/writing.profile.md` 主体只有 `# writing (profile)`，无 `### Modules` 段
   - `ProfileGroup.modules` 解析为 `[]`

3. 编译产出空：
   - `resolveDomains` 的 `mods = []` → 过滤条件 `[].some(...)` = false → refDomains = `[]`
   - `dispatchGroup` 遍历 `[]` → 产出空字符串
   - `renderSessionInject` 的 `if (content)` 跳过 → segment 为空

### 性质判定

这不是代码 bug，是**迁移范围遗漏**。方案 D 改了 schema 契约，所有使用 Pt 的项目资产都需同步。执行文档（`pt-modules-to-profile-executor-brief.md`）只覆盖了项目侧 + builtin，未覆盖外部项目 pt-writing。

---

## 三、修正方案：两个选项

### 选项 A：迁移 pt-writing 资产（推荐）

把 pt-writing 的 blueprint/profile 按方案 D 同步迁移——blueprint 删 modules，profile 加 `### Modules`。

**理由**：
- pt-writing 是独立 git 仓库（`/Users/issac/pro/pt-writing`，有完整 commit 历史），可独立迁移
- 这是方案 D 的正确延伸——所有 Pt 项目资产形态统一
- 修复后 pt-writing 产物与迁移前逐字一致（同项目侧验证逻辑）

**改动**：
- `pt-writing/.pt/assets/blueprints/writing.blueprint.yaml`：删 3 处 `modules:` 行
- `pt-writing/.pt/assets/profiles/writing.profile.md`：加 3 个 `### Modules` 段（`[Scene]` / `[Trigger]` / `[Rules, Flows, Checklists]`）
- `pt-writing/.pt/assets/profiles/new-vision.profile.md`：同上

### 选项 B：compile 加旧格式兼容层

`parseBlueprint` 检测到旧 `modules` 字段时，把它回填到对应 `ProfileGroup`（作为 fallback）。

**理由**：让旧资产不迁移也能用，降低破坏性。

**不选的理由**：
- 引入兼容分支，违背方案 D 的"modules 一律在 Profile"规则统一性
- 兼容层何时移除无明确边界，成为技术债
- pt-writing 只有两份 profile，迁移成本极低，不值得用兼容层换

**结论：选选项 A。**

---

## 四、执行步骤

### 步骤 1：迁移 pt-writing blueprint

`/Users/issac/pro/pt-writing/.pt/assets/blueprints/writing.blueprint.yaml`：

```yaml
# 旧
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

# 新
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

### 步骤 2：迁移 pt-writing 两份 profile

`/Users/issac/pro/pt-writing/.pt/assets/profiles/writing.profile.md`：

```markdown
---
name: writing
blueprint: writing
domains: [me, writing-style, writing-concepts, writing-flow, md-stack]
---

# writing (profile)

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

`/Users/issac/pro/pt-writing/.pt/assets/profiles/new-vision.profile.md`：同样加 3 个 `### Modules` 段（内容与 writing 相同——modules 是段类型，两份 profile 共用同一 blueprint 结构，modules 一致；差异在 `domains` 列表）。

### 步骤 3：验证

在 pt 项目（`/Users/issac/pro/pt`）：

```bash
# 三件套
npm run typecheck
npm run verify    # phase9.test.ts:324 应恢复通过

# pt-writing 产物逐字对比（迁移前后）
# 迁移前先存 baseline（若 pt-writing 有 cache）
cp /Users/issac/pro/pt-writing/.pt/cache/agent-contexts/writing.agent-context.md /tmp/baseline-writing.md 2>/dev/null
# 迁移后重编译 + diff
```

在 pt-writing 项目（`/Users/issac/pro/pt-writing`）：

```bash
git add -A && git commit -m "Phase modules-to-profile: 资产同步方案 D（blueprint 删 modules，profile 加 ### Modules）"
```

### 步骤 4：补充执行文档

`pt-modules-to-profile-executor-brief.md` 加"步骤 6：外部项目同步"，记录 pt-writing 迁移，避免未来同类遗漏。

---

## 五、硬指标

| 指标 | 验证方式 | 通过标准 |
|---|---|---|
| 三件套 | `npm run typecheck` + `npm run verify` | 全过（含 phase9 pt-writing 测试） |
| pt-writing 产物一致 | diff 迁移前后 writing.agent-context.md | 为空（modules 名一字不变） |
| pt-writing git 提交 | `git -C pt-writing log --oneline -1` | 有迁移 commit |
| 无兼容层残留 | `grep -n "modules" src/parse/blueprint.ts` | 只剩注释，无运行时回填逻辑 |

---

## 六、边界纪律

1. **只迁移 pt-writing 资产，不改 Pt 代码**——代码层方案 D 已正确，此前误判不成立。
2. **不加旧格式兼容层**——选项 B 已否决，理由见 §3。
3. **pt-writing 产物逐字一致是硬约束**——modules 名一字不变，diff 必须为空。
4. **baseline 可回退**——`d0dceb9` 可 revert；pt-writing 迁移 commit 可 revert。
5. **此前验收的错误结论不作为修正依据**——只修真实缺陷（pt-writing 兼容），不回退正确的 step1-5。

---

## 七、致歉

此前验收报告把"迁移前就存在的角色聚合设计"误判为"方案 D 造成的角色隔离丢失"，并据此错误推断"domain 被改组""step2 拆分了 blueprint"。这些都是基于工作区脏状态的误读，未用 git 取证 baseline。正确的验收应：先 `git show 835acd2:<path>` 取证 baseline，再下结论。此次教训：**验收必须以 git baseline 为准，不以工作区当前状态为准**。
