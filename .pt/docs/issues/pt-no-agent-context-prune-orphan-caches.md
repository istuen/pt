---
type: issue
name: pt-no-agent-context-prune-orphan-caches
status: open
severity: medium
created: 2026-09-04
updated: 2026-09-04
domain: pt-dev
parent-issue: pt-no-agent-context-multi-root-causes
---

# 根因 2 修复：transpile 加 pruneOrphanCaches() + 清旧 contexts/ 目录

> **父 issue**：`pt-no-agent-context-multi-root-causes`（**P1 改名后残留 3 根因**——本 issue 是根因 2 的修复 sub-issue）
> **优先级**：**P1.5 中**——一次性清理 + 未来防护；P1 改名后双目录并存是新风险
> **范围**：代码层（src/transpile.ts）+ 数据层（清理 `.pt/cache/contexts/`）+ 新增单元测试

## 现象

当前 `.pt/cache/` 同时存在两个目录：

```
.pt/cache/
├── contexts/                              ← 旧目录，未删
│   ├── pt-chat.context.md                 ← 死代码但占空间
│   └── pt-dev.context.md                  ← 死代码但占空间
└── agent-contexts/                        ← 新目录，P1 改名后写入
    └── pt-dev.agent-context.md
```

Profile 删除/改名后，旧 `.context.md` 不会被自动清理。P1 改名后又叠加了"新目录正常写、旧目录物理残留"的双目录问题。

详细分析见父 issue `pt-no-agent-context-multi-root-causes` 的「根因 2」段。

## 根因

`src/render/cache.ts:34-49` `loadContext()` 只校验 hash 是否匹配当前 sourceHash，**不校验 Profile 是否仍存在**。Profile 被删除/改名后，cache 文件残留但无人清理。

`pruneOrphanCaches()` 机制 grep 0 命中——**完全未实现**。

P1 改名后新增问题：
- 旧路径常量 `.pt/cache/contexts/` 在 `src/constants.ts` 仍是 `CACHE_DIR` 值
- 编译产物目录改名是 commit `0455a47`，但**没有清理脚本**删旧目录

## 影响范围

| 维度 | 影响 |
|---|---|
| LLM 实际对话 | 不影响（成功加载后注入路径只走新目录）|
| 调试体验 | 旧目录残留误导排查者以为 cache 还活着 |
| 磁盘占用 | 约几 KB（每个缓存文件 ~10KB），可忽略 |
| 未来风险 | Profile 增删后 cache 不自洁，长期累积 |
| 自动化 | 不影响 |

## 排查方法（可独立复验）

```bash
# 1. 看当前 cache 双目录
ls /Users/issac/pro/pt/.pt/cache/contexts/
ls /Users/issac/pro/pt/.pt/cache/agent-contexts/

# 2. 对比：缓存里的 *.agent-context.md 是否都有对应的 *.profile.md
# 预期：当前应为 0 孤儿（改名后双目录同步已正确）
for ctx in /Users/issac/pro/pt/.pt/cache/agent-contexts/*.agent-context.md; do
  name=$(basename "$ctx" .agent-context.md)
  if [ ! -f "/Users/issac/pro/pt/.pt/assets/profiles/${name}.profile.md" ]; then
    echo "孤儿缓存: $name"
  fi
done

# 3. 手动删除一个 Profile，看下次 transpile 是否清掉对应 cache
rm /Users/issac/pro/pt/.pt/assets/profiles/pt-chat.profile.md
# 期望（修复前）：.pt/cache/agent-contexts/pt-chat.agent-context.md 仍在
# 期望（修复后）：transpile 自动 unlink

# 4. 手动加一个 Profile 但不写资产（模拟孤儿）
mkdir -p /Users/issac/pro/pt/.pt/cache/agent-contexts/
echo "fake" > /Users/issac/pro/pt/.pt/cache/agent-contexts/fake.agent-context.md
# 期望（修复后）：下次 transpile 自动 unlink fake.agent-context.md
```

## 修复方向

### 方案 A（推荐）：transpile 末尾加 `pruneOrphanCaches()`

位置：`src/transpile.ts` `loadAndTranspile` 末尾（cache load/save 之后，render 之前）

实现：

```ts
async function pruneOrphanCaches(
  cwd: string,
  cacheDir: string,
  validProfileNames: Set<string>
): Promise<string[]> {
  const dir = join(cwd, cacheDir);
  let files: string[];
  try {
    files = (await readdir(dir)).filter(f => f.endsWith(".agent-context.md"));
  } catch {
    return [];
  }
  const pruned: string[] = [];
  for (const f of files) {
    const name = f.slice(0, -".agent-context.md".length);
    if (!validProfileNames.has(name)) {
      await unlink(join(dir, f));
      pruned.push(name);
    }
  }
  return pruned;
}

// 在 loadAndTranspile 末尾调
const pruned = await pruneOrphanCaches(cwd, blueprint.compilation.cacheDir, new Set(bundle.profiles.map(p => p.name)));
adapterCtx?.log?.info("transpile:prune orphan caches", { pruned });
```

### 方案 B：加 `/pt cache:prune` 工具子命令

用户手动触发清理——和方案 A 互补，不冲突。

### 方案 C：`loadContext()` 内做交叉校验

`loadContext()` 内查 Profile 是否存在，不存在返 null（fail-open）。但**与缓存命中检查冗余**，不如 A 简洁。

### 一次性清理（建议同期做）

P1 改名后遗留：
```bash
rm -rf /Users/issac/pro/pt/.pt/cache/contexts/
```

`src/constants.ts` 的 `CACHE_DIR = ".pt/cache/contexts"` 已改为 `".pt/cache/agent-contexts"`（commit `0455a47`），所以删除旧目录后**无代码路径再引用**。

### 推荐 A + 一次性清理

A 自动化无感，与 P1 改名风格一致。

## 验收标准

- [ ] `npm run typecheck` 通过
- [ ] `npm run verify` 全测试通过
- [ ] 新增单元测试：`tests/verify/issue-pt-no-agent-context-prune-orphan-caches.test.ts`
  - 覆盖：3 场景（新建 / 删除 / 重命名 Profile 后 transpile，断言对应 cache unlinked）
  - 覆盖：孤儿 cache 文件自动 unlink
- [ ] 一次性清理脚本执行（删 `.pt/cache/contexts/`）
- [ ] 手动加孤儿 cache 文件 → 下次 transpile 后 unlinked
- [ ] 手动删 Profile.md → 下次 transpile 后对应 cache unlinked
- [ ] `ls .pt/cache/contexts/` 返回空（验证旧目录已清）
- [ ] 父 issue 关联段同步更新

## 关联

- **`.pt/docs/issues/pt-no-agent-context-multi-root-causes.md`** —— 父 issue（根因 2 段）
- **`src/transpile.ts`** —— `loadAndTranspile` 加 `pruneOrphanCaches()` 调用
- **`src/render/cache.ts:34-49`** —— `loadContext` 无交叉校验（不动；方案 A 在更高层做）
- **`src/constants.ts`** —— `CACHE_DIR = ".pt/cache/agent-contexts"`（已改）
- **`.pt/cache/contexts/pt-chat.context.md`** + **`.pt/cache/contexts/pt-dev.context.md`** —— 旧目录待清
- **`.pt/cache/agent-contexts/pt-dev.agent-context.md`** —— 当前唯一有效 cache
- **`.pt/assets/profiles/pt-dev.profile.md`** + **`pt-chat.profile.md`** —— 当前 Profile 资产

## 修复日志

<!-- 待 commit 后填 -->