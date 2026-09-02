---
type: issue
name: pt-context-persist-lost
status: open
severity: high
created: 2025-09-02
domain: pt-dev
---

# pt-context 选择未持久化，跨进程丢失

## 现象

Session 里已用 `/pt-context pt-dev` 切到 pt-dev（或 pt-chat），footer 显示 `pt: pt-dev`。**重启 pi 进程后**，footer 变 `pt: 无 context`，必须重新手动 `/pt-context pt-dev`。LLM 每次启动拿不到业务上下文。

## 根因

`session` 是模块级单例（`src/session.ts:47` `export const session`），进程内不丢，但**进程退出即失**。`session_start` 每次重新选 Profile，靠三源 fallback：

```
picked = flagVal ?? fromSettings ?? auto
```

| 源 | 代码 | 实际值（本项目） |
|---|---|---|
| flag (`--pt-context`) | `pi.getFlag("pt-context")` | `undefined`（未传 flag） |
| settings (`.pi/settings.json` 的 `au.pt-context`) | `readProjectSetting(ctx.cwd, "au.pt-context")` | `undefined`（settings.json 无此键） |
| auto（唯一 Profile 时返回） | `detectSingleProfile(cwd)` | `null`（项目有 2 个 profile：pt-dev/pt-chat，auto 只在唯一时返回） |

三源全空 → `picked = null` → `ctx.ui.setStatus("pt", "pt: 无 context")`（`src/index.ts:136`）。

## 影响范围

- **用户体验**：每次启动 pi 要手动 `/pt-context <name>`，体验差
- **LLM 上下文丢失**：每次启动 LLM 拿不到业务上下文（Scene axioms + Trigger 索引），退化成无 Pt 状态
- **deliver-feature 自动化受阻**：LLM 调 `pt_flows`/`pt_manual` 时若 session 未激活 Profile，返回"无激活 Profile"错误

## 排查方法

1. 看 pt-logs 的 `session:no profile picked` 条目（`src/index.ts:138` 已 log `{ flagVal, fromSettings, auto }`）——确认三源实际值
2. 确认 `.pi/settings.json` 是否有 `au.pt-context` 键
3. 确认 `.pt/assets/profiles/` profile 数量（>1 时 auto 不返回）

## 立即自愈（用户侧）

`.pi/settings.json` 加 `au.pt-context`：

```json
{
  "packages": [".."],
  "au": { "pt-context": "pt-dev" }
}
```

这样 `fromSettings` 命中，每次启动自动加载 pt-dev。

> **注**：`au.` 是 pt 自定义命名空间前缀（非 pi 规范，见 issue `au-prefix-tech-debt`）。pi 的 `settings.json` 是通用项目配置文件，pt 用 `readProjectSetting(cwd, "au.pt-context")` 读 dotted key。

## 修复方向（v10.x，待排期）

**方案**：pt 把 activeProfile 持久化到 `.pt/active-profile`（或 `.pt/state.json`），`session_start` 加第四源：

```
picked = flagVal ?? fromSettings ?? activeProfileFile ?? auto
```

`/pt-context` 切换时同步写文件。

### 风险

- **多并发 pi 进程写同一文件冲突**——两个 pi 进程同时切 profile，后写覆盖前写。缓解：写时带 pid + timestamp，读时取最近；或只读不写（由用户 `/pt-context` 显式落盘）
- **项目级 vs 用户级**——`.pt/active-profile` 是项目级（入 git？还是 .gitignore？）。若入 git，团队成员共享默认 profile；若 .gitignore，每人自定义。倾向 `.gitignore`（个人偏好不强制团队）

### 备选方案

- **A**：持久化到 `.pt/state.json`（与 cache 同目录，gitignore）
- **B**：持久化到 `.pi/settings.json` 的 `au.pt-context`（用户手动写或 `/pt-context` 自动写回）
- **C**：用 pi 的 `SettingsManager` API（若暴露给 extension）——需查 pi 文档确认

推荐 A（与 pt 资产同根，不污染 pi settings）。

## 关联

- **issue: au-prefix-tech-debt**——`au.` 前缀是历史遗留，该清理成 `pt.` 或直接 `pt-context`
- **docs/pt-command-tool-dual-registration.md §2.4**——pt-context 不做 tool 的决策依据
- **src/index.ts:118-160**（session_start 加载逻辑）+ **src/session.ts:47**（session 单例）
- **src/config.ts:57**（detectSingleProfile 仅唯一时返回）
