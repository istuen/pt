---
type: issue
name: au-prefix-tech-debt
status: open
severity: low
created: 2025-09-02
domain: pt-dev
---

# au. 前缀是历史遗留，该清理成 pt.

## 现象

pt 代码里用 `au.pt-context` 作为 `.pi/settings.json` 的配置键：

```typescript
// src/index.ts:130
const fromSettings = await readProjectSetting<string>(ctx.cwd, "au.pt-context");
```

用户要在 `.pi/settings.json` 写：
```json
{ "au": { "pt-context": "pt-dev" } }
```

## 根因

`au.` 是 pt 早期命名空间前缀（项目曾叫 `au-core`，后改名 `pt`）。改名后 `au.` 前缀的 settings 键没一并迁移。证据：

- pi 文档（`extensions.md` / `tui.md`）**无 `au.` 前缀的任何约定**——`settings.json` 是通用项目配置，键名由 extension 自定义
- pt 代码/文档里 `au.` 仅出现在 `au.pt-context` / `au.blueprint` / `au.scene`（`docs/pt-dev-phases.md:893,902` 记录了 blueprint→scene 迁移时 `au.blueprint`→`au.scene` 的历史）
- `docs/pt-architecture.json:32` 把 `.pi/settings.json` 标注为 `au.pt-context key`——架构图也沿用此名

## 影响

- **认知负担**：用户困惑 `au.` 是 pi 规范还是 pt 自定义（实测：是 pt 自定义，非 pi 规范）
- **迁移残留**：`au.blueprint`→`au.scene` 已部分迁移，`au.pt-context` 没迁
- **命名不一致**：项目叫 pt，配置前缀却叫 au——破坏命名一致性

## 修复方向

**方案**：`au.` → `pt.`，向后兼容读旧键。

```typescript
// src/index.ts session_start
const fromSettings =
  (await readProjectSetting<string>(ctx.cwd, "pt.pt-context")) ??
  (await readProjectSetting<string>(ctx.cwd, "au.pt-context"));  // 向后兼容
```

迁移期双读，文档/notify 引导用户改用 `pt.pt-context`。下个大版本删 `au.` 兼容读。

### 迁移清单

- `src/index.ts:130` `au.pt-context` → `pt.pt-context`（+ 旧键兼容读）
- `src/index.ts:137` notify 提示文案改 `pt.pt-context`
- `docs/pt-architecture.json:32,50` 标注改 `pt.pt-context`
- `docs/pt-dev-phases.md:893,902` 历史记录补注"au.→pt. 迁移"
- 用户 `.pi/settings.json` `au.pt-context` → `pt.pt-context`

## 关联

- **issue: pt-context-persist-lost**——该 issue 的自愈方案用 `au.pt-context`，本 issue 修复后应改用 `pt.pt-context`
- **src/config.ts:12** `readProjectSetting` 实现（通用 dotted key 读取，不绑前缀）
