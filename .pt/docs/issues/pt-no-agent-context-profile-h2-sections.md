---
type: issue
name: pt-no-agent-context-profile-h2-sections
status: open
severity: low
created: 2026-09-04
updated: 2026-09-04
domain: pt-dev
parent-issue: pt-no-agent-context-multi-root-causes
---

# 根因 4 修复：Profile.md 范本统一加 H2 注入点段

> **父 issue**：`pt-no-agent-context-multi-root-causes`（**P1 改名后残留 3 根因**——本 issue 是根因 4 的修复 sub-issue）
> **优先级**：**P2+ 低**——资产规范层，可与 P5 Manual 拆分 / Blueprint YAML 化同期
> **范围**：资产层（`.pt/assets/profiles/*.md` + `src/builtin/assets/profiles/*.md`）

## 现象

当前所有 Profile 资产都**只有 H1 标题，无 H2 段**：

```markdown
---
name: pt-dev
blueprint: dev-knowledge
domains: [me, product-design, dev-workflow, ...]
---

# pt-dev (profile)
```

解析时 `parseProfile` 遍历 H2 段（`asset.sections`），没 H2 段 → `injectionPoints: []`（数组长度 0）。用户改 Profile 时**看不到自己配置了哪些注入点**，调试"无 Agent Context"时资产层无法定位配置入口。

详细分析见父 issue `pt-no-agent-context-multi-root-causes` 的「根因 4」段。

## 根因

`src/parse/profile.ts` 遍历 `asset.sections`（H2 段字典）push injectionPoints：
- Profile 文件只有 H1 → `injectionPoints: []`（数组长度 0）
- 实际靠 `resolveDomains` 的全局 `profile.domains` 兜底分发

依赖全局 domains 兜底是设计如此（Profile YAML 全局分发），但**用户面看不到配置入口**——违反 `pt-terminology.md §3.4` "命令名实相符"原则。

## 影响范围

| 维度 | 影响 |
|---|---|
| LLM 实际对话 | 不影响（实际靠全局 domains 兜底，正常运行）|
| 用户调试 | Profile 配置入口不可见 → 改 Profile 时无的放矢 |
| 与 `pt-terminology.md` 一致性 | ⚠️ "名实相符"原则在 Profile 配置面缺可视维度 |
| 资产可维护性 | 范本缺失，新人无从下手 |

## 排查方法（可独立复验）

```bash
# 1. 看 Profile 当前内容
cat /Users/issac/pro/pt/.pt/assets/profiles/pt-dev.profile.md
# 预期：只见 H1，无 H2

# 2. 看 parseProfile 输出 injectionPoints 数
grep -E "^## " /Users/issac/pro/pt/.pt/assets/profiles/pt-dev.profile.md
# 预期：无输出（H2 段为空）

# 3. 在 Profile 加 H2 段验证
cat >> /Users/issac/pro/pt/.pt/assets/profiles/pt-dev.profile.md << 'EOF'

## 会话知识
<!-- 此注入点用全局 domains，无追加；保留段让配置可见 -->

## 参考手册
<!-- 同上 -->
EOF
# 期望：parseProfile injectionPoints 数 = 2（之前为 0）

# 4. 删缓存重编译验证
rm /Users/issac/pro/pt/.pt/cache/agent-contexts/pt-dev.agent-context.md
# 期望：transpile 后 cachedAgentContext 包含会话知识 + 参考手册注入点
```

## 修复方向

### 方案 A：Profile.md 范本统一加 H2 段（推荐）

修改：
- `.pt/assets/profiles/pt-dev.profile.md`
- `.pt/assets/profiles/pt-chat.profile.md`
- `src/builtin/assets/profiles/pt.profile.md`

新范本（pt-dev.profile.md 修复后）：

```markdown
---
name: pt-dev
blueprint: dev-knowledge
domains: [me, product-design, dev-workflow, issue-workflow, testing-workflow, release-workflow, asset-workflow, deployment, pt-quality, pt-collab]
---

# pt-dev (profile)

<!--
Profile 范本说明：
- YAML 全局 domains 自动分发到 Blueprint 所有注入点
- ## <注入点名> 段用于追加本注入点独有的 Domain（与全局合并去重）
- 即使无追加，保留段让配置入口可见（与 Blueprint 的 injectionPoints 对齐）
-->

## 会话知识
<!-- 此 Profile 用 Blueprint 全局 session 注入点的 modules=Scene/Trigger/Participant，
     靠 YAML 全局 domains 兜底分发；无追加 -->

## 参考手册
<!-- 此 Profile 用 Blueprint 全局 turn 注入点的 modules=Rules/Flows/Checklists，
     靠 YAML 全局 domains 兜底分发；无追加 -->
```

### 方案 B：不动资产，只在 Profile 解析时自动 fallback

`parseProfile` 检测 Blueprint.injectionPoints，按 Blueprint 的注入点名为 Profile 自动注入空 H2 段——但**绕过 parse 层抽象**，违反"profile 文件是配置面"原则。

### 推荐 A

简洁 + 资产面可视化 + 与 Blueprint 注入点结构对齐。

## 验收标准

- [ ] 3 个 Profile 资产都加 H2 注入点段（pt-dev / pt-chat / builtin pt）
- [ ] `npm run typecheck` 通过
- [ ] `npm run verify` 全测试通过
- [ ] 新增单元测试：`tests/verify/issue-pt-no-agent-context-profile-h2-sections.test.ts`
  - 关键断言：parseProfile 输出 `injectionPoints.length > 0`（之前为 0）
- [ ] 手动删 cache + transpile → cachedAgentContext 内容不变（注入点配置可视，不影响产物）
- [ ] dev-knowledge Domain 加「Profile.md 范本」参考手册（README-style），新人入门
- [ ] 父 issue 关联段同步更新

## 关联

- **`.pt/docs/issues/pt-no-agent-context-multi-root-causes.md`** —— 父 issue（根因 4 段）
- **`.pt/assets/profiles/pt-dev.profile.md`** —— 修复目标 1
- **`.pt/assets/profiles/pt-chat.profile.md`** —— 修复目标 2
- **`src/builtin/assets/profiles/pt.profile.md`** —— 修复目标 3（builtin）
- **`src/parse/profile.ts`** —— injectionPoints 解析（无需改）
- **`.pt/docs/designs/pt-terminology.md`** §3.4（/pt-context → /pt-profile 名实相符）

## 修复日志

<!-- 待 commit 后填 -->