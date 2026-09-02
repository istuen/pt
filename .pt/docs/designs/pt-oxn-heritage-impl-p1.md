# P1 执行文档：verify/ 模块

> **基线**：pt `@issac/pi-pt@0.1.0` Phase 9.9 v9
> **关联**：`pt-oxn-heritage.md`（遗产清单）、`pt-oxn-heritage-impl-p0.md`（P0 前置）
> **用途**：执行者按本文档逐项落地 P1。含改动清单、代码片段、验收标准、测试用例。

---

## 目标

为 P0 的 observe 字段提供实现库：
1. 8 个通用验证函数（从 OXN Probe 重写，纯函数无 strategy 链依赖）
2. `runVerify(name, params)` 注册表入口
3. `pt_verify` tool——LLM 可调用验证步骤执行结果

> **设计原则**：重写不搬 OXN 代码。OXN Probe 走 `execute-probe.ts` → strategy 注册表 → verdict.ts judge 链（实测 2044 行）。pt 的 verify 只需要：纯函数 `(cwd, params) => ProbeOutcome`，直接调 `node:fs` + `node:child_process`。

## 前置条件

- **P0 已完成**：`ProbeOutcome` / `ProbeOutcomeKind` 类型在 `src/schema.ts` 中定义
- 至少 1 个 workflow Domain 的 step 有 observe 字段（P0 fixture）

## 关键代码事实（执行前必读）

| 事实 | 位置 | 对 P1 的影响 |
|---|---|---|
| pt 用 Typebox 定义 tool 参数 | `index.ts` 的 `Type.Object(...)` | pt_verify tool 参数用 Typebox |
| tool 注册模式 | `pi.registerTool({ name, parameters, execute })` | 照 pt_status/pt_flows/pt_manual 模式 |
| pt 无 child_process 使用 | src/ 全目录 | verify 函数首次引入 child_process——懒加载更安全 |
| 测试用 vitest | `tests/verify/*.test.ts` | 新测试放 `tests/verify/` |

---

## 改动清单

| # | 文件 | 改动 | 行数 |
|---|---|---|---|
| 1 | `src/verify/index.ts` | 新建：注册表 + `runVerify` + `listProbes` | ~50 |
| 2 | `src/verify/fs-content-match.ts` | 新建：验证文件含某文本 | ~30 |
| 3 | `src/verify/fs-exists.ts` | 新建：验证文件存在 | ~20 |
| 4 | `src/verify/fs-not-exists.ts` | 新建：验证文件不存在 | ~20 |
| 5 | `src/verify/lint-check.ts` | 新建：验证 lint 通过 | ~35 |
| 6 | `src/verify/ts-compiles.ts` | 新建：验证 TS 编译通过 | ~35 |
| 7 | `src/verify/test-pass.ts` | 新建：验证测试通过 | ~35 |
| 8 | `src/verify/git-status-clean.ts` | 新建：验证 git 工作树干净 | ~25 |
| 9 | `src/verify/file-hash.ts` | 新建：验证文件 hash 匹配 | ~35 |
| 10 | `src/index.ts` | 注册 `pt_verify` tool | ~25 |

---

## 改动 1：`src/verify/index.ts`（新建）

```typescript
// src/verify/index.ts — verify 注册表 + runVerify 入口
//
// P1：observe 字段的实现库。纯函数 (cwd, params) => ProbeOutcome，不依赖 OXN 的 kernel/verdict 链。
// 加新 probe = 注册表加一行 + 实现文件一个。

import type { ProbeOutcome } from "../schema.js";
import { fsContentMatch } from "./fs-content-match.js";
import { fsExists } from "./fs-exists.js";
import { fsNotExists } from "./fs-not-exists.js";
import { lintCheck } from "./lint-check.js";
import { tsCompiles } from "./ts-compiles.js";
import { testPass } from "./test-pass.js";
import { gitStatusClean } from "./git-status-clean.js";
import { fileHash } from "./file-hash.js";

/** verify 函数签名：纯函数，接收 cwd + 参数，返回 ProbeOutcome。 */
export type VerifyFunction = (cwd: string, params: Record<string, string>) => Promise<ProbeOutcome>;

/** 注册表：probe 名 → verify 函数。 */
const registry: Record<string, VerifyFunction> = {
  "fs-content-match": fsContentMatch,
  "fs-exists": fsExists,
  "fs-not-exists": fsNotExists,
  "lint-check": lintCheck,
  "ts-compiles": tsCompiles,
  "test-pass": testPass,
  "git-status-clean": gitStatusClean,
  "file-hash": fileHash,
};

/** 列出所有已注册的 probe 名（pt_verify tool 的错误提示用）。 */
export function listProbes(): string[] {
  return Object.keys(registry);
}

/** 按名执行 verify。未注册的 probe 名返回 INCONCLUSIVE。 */
export async function runVerify(cwd: string, name: string, params: Record<string, string>): Promise<ProbeOutcome> {
  const fn = registry[name];
  if (!fn) {
    return {
      outcome: "INCONCLUSIVE",
      message: `未知 probe: ${name}（可用: ${listProbes().join(", ")}）`,
    };
  }
  try {
    return await fn(cwd, params);
  } catch (e) {
    return {
      outcome: "INCONCLUSIVE",
      message: `probe ${name} 执行异常: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
```

---

## 改动 2-9：8 个 verify 函数

每个函数签名统一：`async (cwd: string, params: Record<string, string>) => Promise<ProbeOutcome>`。用 `node:fs` + `node:child_process`，不依赖 OXN 任何模块。

### `src/verify/fs-content-match.ts`

```typescript
// src/verify/fs-content-match.ts — 验证文件包含某文本
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProbeOutcome } from "../schema.js";

export async function fsContentMatch(cwd: string, params: Record<string, string>): Promise<ProbeOutcome> {
  const path = params.path;
  if (!path) return { outcome: "INCONCLUSIVE", message: "缺少参数: path" };
  const pattern = params.pattern;
  if (!pattern) return { outcome: "INCONCLUSIVE", message: "缺少参数: pattern" };
  try {
    const content = readFileSync(join(cwd, path), "utf8");
    const found = content.includes(pattern);
    return {
      outcome: found ? "COMPLETED" : "DEVIATED",
      message: found ? `文件 ${path} 包含 "${pattern}"` : `文件 ${path} 不包含 "${pattern}"`,
      actual: found ? "found" : "not-found",
    };
  } catch (e) {
    return { outcome: "INCONCLUSIVE", message: `无法读取 ${path}: ${e instanceof Error ? e.message : String(e)}` };
  }
}
```

### `src/verify/fs-exists.ts`

```typescript
// src/verify/fs-exists.ts — 验证文件存在
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ProbeOutcome } from "../schema.js";

export async function fsExists(cwd: string, params: Record<string, string>): Promise<ProbeOutcome> {
  const path = params.path;
  if (!path) return { outcome: "INCONCLUSIVE", message: "缺少参数: path" };
  const exists = existsSync(join(cwd, path));
  return {
    outcome: exists ? "COMPLETED" : "DEVIATED",
    message: exists ? `存在: ${path}` : `不存在: ${path}`,
  };
}
```

### `src/verify/fs-not-exists.ts`

```typescript
// src/verify/fs-not-exists.ts — 验证文件不存在
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ProbeOutcome } from "../schema.js";

export async function fsNotExists(cwd: string, params: Record<string, string>): Promise<ProbeOutcome> {
  const path = params.path;
  if (!path) return { outcome: "INCONCLUSIVE", message: "缺少参数: path" };
  const exists = existsSync(join(cwd, path));
  return {
    outcome: !exists ? "COMPLETED" : "DEVIATED",
    message: !exists ? `已删除: ${path}` : `仍存在: ${path}`,
  };
}
```

### `src/verify/lint-check.ts`

```typescript
// src/verify/lint-check.ts — 验证 lint 通过
import { execSync } from "node:child_process";
import type { ProbeOutcome } from "../schema.js";

export async function lintCheck(cwd: string, params: Record<string, string>): Promise<ProbeOutcome> {
  const cmd = params.cmd ?? "npx biome check";
  try {
    execSync(cmd, { cwd, stdio: "pipe", timeout: 30000 });
    return { outcome: "COMPLETED", message: `lint 通过: ${cmd}` };
  } catch (e) {
    const stderr = e instanceof Error && "stderr" in e
      ? Buffer.from((e as { stderr?: Uint8Array }).stderr ?? "").toString()
      : "";
    return {
      outcome: "DEVIATED",
      message: `lint 失败: ${cmd}`,
      actual: stderr.slice(0, 500),
    };
  }
}
```

### `src/verify/ts-compiles.ts`

```typescript
// src/verify/ts-compiles.ts — 验证 TS 编译通过
import { execSync } from "node:child_process";
import type { ProbeOutcome } from "../schema.js";

export async function tsCompiles(cwd: string, params: Record<string, string>): Promise<ProbeOutcome> {
  const cmd = params.cmd ?? "npx tsc --noEmit";
  try {
    execSync(cmd, { cwd, stdio: "pipe", timeout: 60000 });
    return { outcome: "COMPLETED", message: `TS 编译通过: ${cmd}` };
  } catch (e) {
    const stderr = e instanceof Error && "stderr" in e
      ? Buffer.from((e as { stderr?: Uint8Array }).stderr ?? "").toString()
      : "";
    return {
      outcome: "DEVIATED",
      message: `TS 编译失败: ${cmd}`,
      actual: stderr.slice(0, 500),
    };
  }
}
```

### `src/verify/test-pass.ts`

```typescript
// src/verify/test-pass.ts — 验证测试通过
import { execSync } from "node:child_process";
import type { ProbeOutcome } from "../schema.js";

export async function testPass(cwd: string, params: Record<string, string>): Promise<ProbeOutcome> {
  const cmd = params.cmd ?? "npx vitest run tests/verify/";
  try {
    execSync(cmd, { cwd, stdio: "pipe", timeout: 120000 });
    return { outcome: "COMPLETED", message: `测试通过: ${cmd}` };
  } catch (e) {
    const stderr = e instanceof Error && "stderr" in e
      ? Buffer.from((e as { stderr?: Uint8Array }).stderr ?? "").toString()
      : "";
    return {
      outcome: "DEVIATED",
      message: `测试失败: ${cmd}`,
      actual: stderr.slice(0, 500),
    };
  }
}
```

### `src/verify/git-status-clean.ts`

```typescript
// src/verify/git-status-clean.ts — 验证 git 工作树干净
import { execSync } from "node:child_process";
import type { ProbeOutcome } from "../schema.js";

export async function gitStatusClean(cwd: string, _params: Record<string, string>): Promise<ProbeOutcome> {
  try {
    const out = execSync("git status --porcelain", { cwd, encoding: "utf8", timeout: 10000 });
    const clean = out.trim() === "";
    return {
      outcome: clean ? "COMPLETED" : "DEVIATED",
      message: clean ? "git 工作树干净" : `git 工作树有变更:\n${out.trim()}`,
      actual: clean ? "clean" : "dirty",
    };
  } catch (e) {
    return { outcome: "INCONCLUSIVE", message: `git 执行失败: ${e instanceof Error ? e.message : String(e)}` };
  }
}
```

### `src/verify/file-hash.ts`

```typescript
// src/verify/file-hash.ts — 验证文件 sha256 hash 匹配
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProbeOutcome } from "../schema.js";

export async function fileHash(cwd: string, params: Record<string, string>): Promise<ProbeOutcome> {
  const path = params.path;
  if (!path) return { outcome: "INCONCLUSIVE", message: "缺少参数: path" };
  const expected = params.expected;
  if (!expected) return { outcome: "INCONCLUSIVE", message: "缺少参数: expected (sha256)" };
  try {
    const content = readFileSync(join(cwd, path));
    const hash = createHash("sha256").update(content).digest("hex");
    const match = hash === expected;
    return {
      outcome: match ? "COMPLETED" : "DEVIATED",
      message: match
        ? `hash 匹配: ${path}`
        : `hash 不匹配: ${path}（期望 ${expected.slice(0, 8)}...，实际 ${hash.slice(0, 8)}...）`,
      actual: hash,
    };
  } catch (e) {
    return { outcome: "INCONCLUSIVE", message: `无法读取 ${path}: ${e instanceof Error ? e.message : String(e)}` };
  }
}
```

---

## 改动 10：`src/index.ts` 注册 `pt_verify` tool

在 `pt_manual` tool 注册块之后（`pi.registerTool` 的 `}` 之后，`}` 闭合 `registerPtTools` 函数之前），加：

```typescript
  pi.registerTool({
    name: "pt_verify",
    label: "Pt Verify",
    description: "Run a verification probe to check if a Manual step was executed correctly. Returns COMPLETED/DEVIATED/INCONCLUSIVE. Use after completing a step that has an observe field.",
    promptSnippet: "Verify a Manual step execution result",
    promptGuidelines: ["Use pt_verify after completing a Manual step that has an observe field, to verify the execution result."],
    parameters: Type.Object({
      probe: Type.String({ description: "Probe name from observe field (e.g. fs-content-match, ts-compiles, test-pass, git-status-clean)" }),
      params: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Probe parameters, e.g. { path: 'src/foo.ts', pattern: 'export' }" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { runVerify } = await import("./verify/index.js");
      const result = await runVerify(ctx.cwd, params.probe, params.params ?? {});
      const text = result.outcome === "COMPLETED"
        ? `✓ ${result.message}`
        : result.outcome === "DEVIATED"
          ? `✗ ${result.message}${result.actual ? `\n${result.actual}` : ""}`
          : `? ${result.message}`;
      return {
        content: [{ type: "text", text }],
        details: result,
      };
    },
  });
```

> **注意**：用动态 `import("./verify/index.js")` 避免顶层导入影响 pt 启动（verify 模块用 child_process，懒加载更安全）。也可改顶层导入——若 pt 启动无性能问题。

> **Typebox 注意**：`Type.Record(Type.String(), Type.String())` 需要 typebox 的 `Type.Record` 支持。若该 API 不可用，改用 `Type.Any({ description: "..." })` 并在 execute 内手动校验。

---

## Probe 参数速查表

| Probe 名 | 必需参数 | 可选参数 | 默认命令/行为 |
|---|---|---|---|
| `fs-content-match` | `path`, `pattern` | — | 读文件检查包含文本 |
| `fs-exists` | `path` | — | 检查文件存在 |
| `fs-not-exists` | `path` | — | 检查文件不存在 |
| `lint-check` | — | `cmd` | `npx biome check` |
| `ts-compiles` | — | `cmd` | `npx tsc --noEmit` |
| `test-pass` | — | `cmd` | `npx vitest run tests/verify/` |
| `git-status-clean` | — | — | `git status --porcelain` |
| `file-hash` | `path`, `expected` | — | sha256 对比 |

---

## 测试用例

新建 `tests/verify/probes.test.ts`：

```typescript
// tests/verify/probes.test.ts — P1：verify 模块测试
import { describe, it, expect } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runVerify, listProbes } from "../../src/verify/index.js";

describe("P1: verify 模块", () => {
  it("listProbes 返回 8 个 probe", () => {
    const probes = listProbes();
    expect(probes).toContain("fs-content-match");
    expect(probes).toContain("ts-compiles");
    expect(probes).toContain("test-pass");
    expect(probes.length).toBe(8);
  });

  it("未知 probe 返回 INCONCLUSIVE", async () => {
    const r = await runVerify(process.cwd(), "unknown-probe", {});
    expect(r.outcome).toBe("INCONCLUSIVE");
    expect(r.message).toContain("未知 probe");
  });

  it("fs-content-match: 文件含文本 → COMPLETED", async () => {
    const tmp = join(process.cwd(), ".pt/cache/test-verify-tmp");
    mkdirSync(tmp, { recursive: true });
    writeFileSync(join(tmp, "foo.ts"), "export const x = 1;\n");
    const r = await runVerify(tmp, "fs-content-match", { path: "foo.ts", pattern: "export" });
    expect(r.outcome).toBe("COMPLETED");
    rmSync(tmp, { recursive: true });
  });

  it("fs-content-match: 文件不含文本 → DEVIATED", async () => {
    const tmp = join(process.cwd(), ".pt/cache/test-verify-tmp");
    mkdirSync(tmp, { recursive: true });
    writeFileSync(join(tmp, "foo.ts"), "export const x = 1;\n");
    const r = await runVerify(tmp, "fs-content-match", { path: "foo.ts", pattern: "nonexistent" });
    expect(r.outcome).toBe("DEVIATED");
    rmSync(tmp, { recursive: true });
  });

  it("fs-content-match: 缺参数 → INCONCLUSIVE", async () => {
    const r = await runVerify(process.cwd(), "fs-content-match", {});
    expect(r.outcome).toBe("INCONCLUSIVE");
  });

  it("fs-exists: 文件存在 → COMPLETED", async () => {
    const r = await runVerify(process.cwd(), "fs-exists", { path: "package.json" });
    expect(r.outcome).toBe("COMPLETED");
  });

  it("fs-exists: 文件不存在 → DEVIATED", async () => {
    const r = await runVerify(process.cwd(), "fs-exists", { path: "nonexistent-xyz.md" });
    expect(r.outcome).toBe("DEVIATED");
  });

  it("fs-not-exists: 文件不存在 → COMPLETED", async () => {
    const r = await runVerify(process.cwd(), "fs-not-exists", { path: "nonexistent-xyz.md" });
    expect(r.outcome).toBe("COMPLETED");
  });

  it("ts-compiles: 项目自身编译 → COMPLETED", async () => {
    const r = await runVerify(process.cwd(), "ts-compiles", {});
    expect(r.outcome).toBe("COMPLETED");
  });

  it("git-status-clean: 返回 COMPLETED 或 DEVIATED（不 INCONCLUSIVE）", async () => {
    const r = await runVerify(process.cwd(), "git-status-clean", {});
    expect(["COMPLETED", "DEVIATED"]).toContain(r.outcome);
  });
});
```

> **注意**：`lint-check` / `test-pass` 不在测试里跑实际命令（避免测试递归——test-pass 跑 vitest 会触发自身）。只测 `ts-compiles`（项目自身编译）和 `git-status-clean`（快速）。

---

## 验收标准（DoD）

- [ ] `src/verify/index.ts` 注册表 + `runVerify` + `listProbes`
- [ ] 8 个 verify 函数文件存在，每个返回 `ProbeOutcome`
- [ ] `pt_verify` tool 在 `src/index.ts` 注册
- [ ] `listProbes()` 返回 8 个 probe 名
- [ ] 未知 probe 名返回 INCONCLUSIVE
- [ ] 缺参数的 probe 返回 INCONCLUSIVE（不抛异常）
- [ ] fs-content-match / fs-exists / ts-compiles 在项目自身上跑通
- [ ] `tsc --noEmit` 通过
- [ ] `npm run verify` 通过（含新测试 `tests/verify/probes.test.ts`）

---

## 向后兼容

- verify/ 是全新模块——不影响现有 pt 功能
- pt_verify tool 是新增——不影响现有 pt_status / pt_flows / pt_manual tool
- verify 函数用 `node:fs` + `node:child_process`——不依赖 OXN 任何模块

---

## 执行步骤（顺序）

1. 跑 `tsc --noEmit && npm run verify` 确认 baseline 绿
2. 新建 `src/verify/` 目录
3. 写 8 个 verify 函数文件（改动 2-9）
4. 写 `src/verify/index.ts`（改动 1）
5. 跑 `tsc --noEmit`——应通过
6. 改 `src/index.ts` 注册 pt_verify tool（改动 10）
7. 跑 `tsc --noEmit`——应通过
8. 新建 `tests/verify/probes.test.ts`
9. 跑 `tsc --noEmit && npm run verify`
10. 全绿后 git commit `feat: P1 verify module + pt_verify tool`
