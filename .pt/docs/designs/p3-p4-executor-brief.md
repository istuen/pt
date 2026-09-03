# P3 + P4 执行者简报：可选优化 + 发布形态演进

> **基线 commit**：`4918b6d`（test: P2 log PtLogger tests...）— HEAD 起点
> **任务来源**：`pt-code-quality-plan.md` §P3（7 项）+ §P4（5-7 项）+ §10（发布形态详细）
> **目标**：P3 优化收尾 + P4 改造为可发布的 dist 形态
> **约束**：v9 四层语义不动；每 commit 必过三件套；P4 验证 dist 形态与 src 行为一致

---

## ⚠️ 现状校准（HEAD 4918b6d）

### P3.1 校准偏差

简报说"3 处 switch(d.type)"——**已确认 3 处**（不是偏差，是简报正确）：
- `src/compile/context.ts:166` `renderSceneModule`
- `src/compile/context.ts:220` `renderManualModule`
- `src/render/context-message.ts:76` `renderDomainManual`

**额外发现**：P3.6 提到"`renderDomainManual` 与 `renderManualModule` 格式逻辑抽公共 `formatManualBody`"——这 2 处 switch 内容**确实有重复**（都是按 d.type 分支 + 列表渲染）。P3.1 改注册表 + P3.6 抽 formatManualBody 是**同源工作**，可合并。

### P3.2 状态

- `by-injection-point` 是 `CacheSplitStrategy` 类型选项但**未实现**
- `render/cache.ts:28-30` 有占位 if 块（fallback 到 single-file）
- `parse/blueprint.ts:106` 解析但无效果
- `schema.ts:162` 仍是类型联合

**决策点**：
- (a) **实现** by-injection-point（多文件缓存）—— 重量级，估 ~80 行新增
- (b) **删分支**（@deprecated 标记）—— 轻量，类型选项保留
- (c) **当前阶段不动**，留作 P5+ —— YAGNI

### P3.3 状态

- 当前**自写** frontmatter 解析（`src/parse/shared.ts:98` `parseFrontmatter`）
- 不支持嵌套对象、复杂 YAML 特性
- 加 `yaml` 库 = +~50KB dependencies + 需要新 lockfile

**决策点**：
- (a) 引入 `yaml` 库（pnpm/npm 加依赖）—— 重量级，但支持复杂 frontmatter
- (b) **不动**（YAGNI，当前资产都是简单 key:value 或 key:[a,b]）—— 推荐
- (c) 仅**升级自写解析**支持更多 YAML 特性 —— 中量级

### P3.4 状态

- `AssetKind` 联合含 9 个值（`domain/blueprint/profile/term/workflow/stack/glossary/scene/manual/channel`）
- `channel/scene/manual/glossary` 是**历史值**
- 删除前需 grep 资产目录确认无历史资产引用

**决策点**：
- (a) 删历史值（4 类型移除）—— 需先 grep 资产 + grep 测试
- (b) **不动**（保留兜底兼容）—— 推荐（防御性）

### P3.5 状态

`readStderr(e)` 在 2 处重复（lint-check.ts:14-16 + test-pass.ts:11-13）：

```typescript
const stderr =
  e instanceof Error && "stderr" in e
    ? Buffer.from((e as { stderr?: Uint8Array }).stderr ?? "").toString()
    : "";
```

完全一致。可抽到 `src/verify/_helpers.ts` 或 `src/verify/readStderr.ts`。

### P3.6 状态

- `renderDomainManual`（context-message.ts:73）按 d.type 渲染 Manual 段
- `renderManualModule`（context.ts:217）按 d.type 渲染 Manual 段
- **格式逻辑重复**：`workflow` case 都是 `- name: intent`；`term` case 都是 `invariant/ban` Rule 列表
- 抽 `formatManualBody(d, content)` 公共函数

### P3.7 状态

- `listManuals` 定义在 `schema.ts:346`（AgentAdapter 接口）
- 调用在 `commands.ts:63` + `src/agent/pi-adapter.ts:157`
- schema 已有 JSDoc，但 commands.ts 调用方有 `domains` 参数含义模糊（profile-scoped vs all）

**决策点**：
- (a) 改 schema 类型 + 调用方 JSDoc —— 轻度
- (b) 拆两个不同 list 方法（listAllManuals / listProfileManuals）—— 中量

### P4 状态

| 项 | 当前 | P4 目标 |
|---|---|---|
| `package.json.files` | `["src"]` | `["dist"]` |
| `package.json.main` | 无 | `"./dist/index.js"` |
| `package.json.types` | 无 | `"./dist/index.d.ts"` |
| `package.json.pi.extensions` | `["./src/index.ts"]` | `["./dist/index.js"]` |
| `package.json.scripts.build` | 无 | `"tsc -p tsconfig.build.json && cpy ..."` |
| `tsconfig.json.noEmit` | `true` | 保持 true（dev 用），新增 `tsconfig.build.json` |
| `.gitignore` | `dist/` 已排除 ✅ | 保持 |

**额外发现**：
- `tsconfig.json` 有 `allowImportingTsExtensions: true` —— jiti/tsx 加载 .ts 需要；**P4 dist 形态不再需要**（import 跨 .ts/.js）
- `BUILTIN_ASSETS_DIR` 在 `constants.ts` 用 `import.meta.url` 定位 `src/builtin/assets/` —— dev 形态正确，发布形态需 `dist/builtin/assets/`（通过 build 脚本复制）

---

## 任务清单

### P3 任务（7 项）

| 任务 | 动作 | 决策点 |
|---|---|---|
| **P3.1+P3.6** | 抽 `formatManualBody(d, content)` 公共函数；3 处 switch(d.type) 改双层注册表 | 无 |
| **P3.2** | by-injection-point 决策（实现/删/不动） | ⚠️ 需用户决策 |
| **P3.3** | frontmatter 解析换 yaml 库 | ⚠️ 需用户决策 |
| **P3.4** | AssetKind 历史值清理 | ⚠️ 需用户决策 |
| **P3.5** | 抽 `readStderr(e)` 公共辅助到 `src/verify/_helpers.ts` | 无 |
| **P3.7** | listManuals JSDoc 标注 | 无 |

### P4 任务（5-7 项）

| 任务 | 动作 | 依赖 |
|---|---|---|
| **P4.1** | 新增 `tsconfig.build.json`（emit + declaration + outDir: dist） | P3 完成 |
| **P4.2** | `package.json` 改 files/main/types/pi.extensions + 加 build/prepublishOnly 脚本 | P4.1 |
| **P4.3** | build 脚本加 builtin 资产复制（`cp -r src/builtin/assets dist/builtin/assets` 跨平台用 `cpy-cli` 或 Node 脚本） | P4.2 |
| **P4.4** | `.gitignore` 加 `dist/`（已存在 ✅） | 无 |
| **P4.5** | 验证：`npm run build` 产出 `dist/index.js` + `dist/index.d.ts` + `dist/builtin/assets/*.md` | P4.3 |
| **P4.6** | 验证：pi 加载 `./dist/index.js` 成功（改 .pi/settings 临时测） | P4.5 |
| **P4.7** | 验证：`npm run verify` 在 dist 形态下全过 | P4.6 |

---

## Commit 拆分建议（8 commit + 1 brief = 9 commit）

按依赖 + 性质合并：

### Commit 1: P3.1 + P3.6（switch 改注册表 + formatManualBody 抽离）

- `src/compile/context.ts`：renderSceneModule / renderManualModule 改注册表 + 调 formatManualBody
- `src/render/context-message.ts`：renderDomainManual 调 formatManualBody
- 新建 `src/compile/format-manual-body.ts`（或放 type-guards 同级）

### Commit 2: P3.5（readStderr 抽离）

- 新建 `src/verify/_helpers.ts`：export readStderr(e)
- 改 `lint-check.ts` + `test-pass.ts` import

### Commit 3: P3.7（listManuals JSDoc）

- 改 `schema.ts:346` JSDoc 详细化
- 改 `commands.ts:63` 调用方 JSDoc 标注

### Commit 4: P4.1 + P4.4（tsconfig.build + gitignore 确认）

- 新建 `tsconfig.build.json`
- `.gitignore` 检查（已排除 ✅）

### Commit 5: P4.2 + P4.3（package.json + build 脚本）

- 改 `package.json` files/main/types/pi.extensions
- 加 build 脚本（tsc -p tsconfig.build.json && cpy 复制 builtin）

### Commit 6: P4.5-4.7（验证 dist 形态）

- 跑 `npm run build` 验证产出
- 改 `.pi/settings.json` 临时测 pi 加载 dist
- 跑 `npm run verify` 在 dist 形态下

### Commit 7-8（可选 P3.2/3/4 决策后定）

- 若 P3.2 选 (a) 实现：1 commit
- 若 P3.2 选 (b) 删分支：1 commit（可与 P3.4 合并）
- 若 P3.3 选 (a) yaml：1 commit
- 若 P3.4 选 (a) 清理：1 commit

---

## 边界纪律

- **不动**：v9 四层语义
- **不动**：P0/P1/P2 抽出物（diagnostics.ts / api-bridge.ts / profile-persist.ts / s/sArr/isRecord）
- **P4 不动 tsconfig.json 主体**（保留 dev noEmit，新增 tsconfig.build.json）
- **P4 验证不破坏 dev 形态**（.pi/settings 改回 src 形态后 typecheck/verify 仍过）
- **P3.2/3/4 决策需用户拍板**，不做默认推进

---

## 验证循环（每 commit 后必跑）

```bash
npm run typecheck   # 0 output
npm run verify      # ≥ 162 passed
npm run lint        # 0 error
```

P4 commit 后额外：
```bash
npm run build                    # 产出 dist/
ls -la dist/                     # 检查 index.js + d.ts + builtin/
npm run verify                   # 仍全过（dev 形态不受影响）
```

---

## 完成判定（全部满足）

### P3
- [ ] `formatManualBody(d, content)` 公共函数存在，被 3 处 switch 调用
- [ ] `grep -rn "switch (d.type)" src/compile src/render` = 0
- [ ] `readStderr` 只在 `src/verify/_helpers.ts` 定义
- [ ] `listManuals` JSDoc 含 domains 参数语义

### P4
- [ ] `tsconfig.build.json` 存在
- [ ] `package.json.files` = `["dist"]`
- [ ] `package.json.main` = `"./dist/index.js"`
- [ ] `package.json.types` = `"./dist/index.d.ts"`
- [ ] `package.json.pi.extensions` = `["./dist/index.js"]`
- [ ] `npm run build` 产出 `dist/index.js` + `dist/index.d.ts` + `dist/builtin/assets/*.md`
- [ ] `npm run verify` 全过（dev + dist 形态）
- [ ] 162 tests passed（不退步）

---

## ⚠️ P3 决策点（需用户拍板）

| 任务 | 选项 | 我的建议 |
|---|---|---|
| **P3.2** | (a) 实现 (b) 删分支 (c) 不动 | **(b) 删分支**——YAGNI，留类型选项兼容 |
| **P3.3** | (a) yaml 库 (b) 不动 (c) 升级自写 | **(b) 不动**——当前资产简单，无需 |
| **P3.4** | (a) 删历史值 (b) 不动 | **(b) 不动**——防御性兼容 |

若采纳我的建议，P3 总共 3 commit（formatManualBody/注册表 + readStderr + JSDoc）+ P4 3 commit = 6 commit + 1 brief = 7 commit。
