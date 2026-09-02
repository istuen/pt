# P2 执行文档：引用完整性校验

> **基线**：pt `@issac/pi-pt@0.1.0` Phase 9.9 v9
> **关联**：`pt-oxn-heritage.md`（遗产清单）、`pt-oxn-heritage-impl-overview.md`（总览）
> **用途**：执行者按本文档逐项落地 P2。含改动清单、代码片段、验收标准、测试用例。

---

## 目标

检测 Profile→Blueprint→Domain 三层引用的悬空引用：
- Profile 引用的 Blueprint 不存在
- Profile 直接选的 Domain 不存在（`profile.domains` + `profile.injectionPoints[].domains`）
- Profile 的注入点名在 Blueprint 里无对应

> **注意**：pt 的引用图是三层星型（Profile→Blueprint, Profile→Domain, Blueprint→Module名），非 OXN 的 Domain→Domain 网状。无环风险——校验重点是**完整性**（悬空引用检测），非**无环**。

## 前置条件

- 无（独立于 P0/P1，可并行执行）

## pt 引用图结构（执行前必读）

```
Profile (.pt/assets/profiles/*.profile.md)
  ├─ blueprint: "dev-knowledge"     → 引用 Blueprint
  ├─ domains: [me, requirements]    → 引用 Domain（全局）
  └─ injectionPoints:
       ├─ 会话知识: { domains: [] }  → 引用 Domain（注入点级追加）
       └─ 参考手册: { domains: [] }

Blueprint (.pt/assets/blueprints/*.blueprint.md)
  ├─ injectionPoints:
       ├─ 会话知识: { modules: [Scene, Trigger] }  → Module 名（H2 段名，非 Domain 名）
       └─ 参考手册: { modules: [Manual] }
  └─ compilation: { cacheDir, split }
```

**校验点**：
1. `profile.blueprint` → 在 `blueprints[]` 里有对应 name
2. `profile.domains[]` 每项 → 在 `domains[]` 里有对应 name
3. `profile.injectionPoints[].domains[]` 每项 → 在 `domains[]` 里有对应 name
4. `profile.injectionPoints[].name` → 在 `blueprint.injectionPoints[]` 里有对应 name（注入点名匹配）

> Blueprint.injectionPoints[].modules 是 H2 段名（如 "Scene"），不是 Domain 名——**不校验 modules**（它是模块类型声明，不是引用）。

---

## 改动清单

| # | 文件 | 改动 | 行数 |
|---|---|---|---|
| 1 | `src/verify/ref-check.ts` | 新建：引用完整性校验函数 | ~80 |
| 2 | `src/index.ts` | 注册 `pt_check_refs` tool | ~25 |

---

## 改动 1：`src/verify/ref-check.ts`（新建）

```typescript
// src/verify/ref-check.ts — Profile→Blueprint→Domain 引用完整性校验
//
// pt 引用图是三层星型（非 OXN Domain→Domain 网状），无环风险。
// 校验重点是完整性：悬空引用检测。
// 不校验 Blueprint.injectionPoints[].modules（H2 段名是模块类型声明，非 Domain 引用）。

import type { Blueprint, Domain, Profile } from "../schema.js";

export interface RefCheckResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/** 校验单个 Profile 的引用完整性。
 *  传入该 Profile 引用的 Blueprint（若存在）+ 全集 Domains。 */
export function checkProfileRefs(
  profile: Profile,
  blueprints: Blueprint[],
  domains: Domain[],
): RefCheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const domainNames = new Set(domains.map((d) => d.name));
  const blueprintNames = new Set(blueprints.map((b) => b.name));

  // 1. Profile → Blueprint 存在性
  const bp = blueprints.find((b) => b.name === profile.blueprint);
  if (!bp) {
    errors.push(`Profile "${profile.name}" 引用的 Blueprint "${profile.blueprint}" 不存在`);
  }

  // 2. Profile → Domain（全局 domains）
  for (const dn of profile.domains) {
    if (!domainNames.has(dn)) {
      errors.push(`Profile "${profile.name}" 的 domains 引用悬空 Domain "${dn}"`);
    }
  }

  // 3. Profile.injectionPoints → Domain + 注入点名匹配
  for (const ip of profile.injectionPoints) {
    // 3a. 注入点名应在 Blueprint 里有对应
    if (bp) {
      const bpIp = bp.injectionPoints.find((bip) => bip.name === ip.name);
      if (!bpIp) {
        errors.push(`Profile "${profile.name}" 的注入点 "${ip.name}" 在 Blueprint "${bp.name}" 里无对应`);
      }
    }

    // 3b. 注入点引用的 Domain 存在
    for (const dn of ip.domains) {
      if (!domainNames.has(dn)) {
        errors.push(`Profile "${profile.name}" 注入点 "${ip.name}" 引用悬空 Domain "${dn}"`);
      }
    }
  }

  // 4. 警告：Blueprint 声明了注入点但 Profile 未实例化（非错误——Profile 可只实例化部分注入点）
  if (bp) {
    for (const bpIp of bp.injectionPoints) {
      const hasProfileIp = profile.injectionPoints.some((pip) => pip.name === bpIp.name);
      if (!hasProfileIp) {
        warnings.push(`Blueprint "${bp.name}" 的注入点 "${bpIp.name}" 在 Profile "${profile.name}" 里未实例化`);
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** 校验所有 Profile 的引用完整性（批量入口）。 */
export function checkAllRefs(
  profiles: Profile[],
  blueprints: Blueprint[],
  domains: Domain[],
): RefCheckResult {
  const allErrors: string[] = [];
  const allWarnings: string[] = [];

  for (const profile of profiles) {
    const r = checkProfileRefs(profile, blueprints, domains);
    allErrors.push(...r.errors);
    allWarnings.push(...r.warnings);
  }

  return { ok: allErrors.length === 0, errors: allErrors, warnings: allWarnings };
}

/** 把 RefCheckResult 格式化为人类可读文本（pt_check_refs tool 输出用）。 */
export function formatRefCheckResult(r: RefCheckResult): string {
  const lines: string[] = [];
  if (r.ok && r.warnings.length === 0) {
    lines.push("✓ 引用完整性检查通过，无悬空引用");
    return lines.join("\n");
  }
  if (r.errors.length > 0) {
    lines.push(`✗ ${r.errors.length} 个悬空引用：`);
    for (const e of r.errors) lines.push(`  - ${e}`);
  }
  if (r.warnings.length > 0) {
    lines.push(`⚠ ${r.warnings.length} 个警告：`);
    for (const w of r.warnings) lines.push(`  - ${w}`);
  }
  if (r.ok && r.warnings.length > 0) {
    lines.unshift("✓ 引用完整性检查通过（有警告）");
  }
  return lines.join("\n");
}
```

---

## 改动 2：`src/index.ts` 注册 `pt_check_refs` tool

在 `pt_verify` tool 注册块之后（或 `pt_manual` 之后，若 P1 未实现），加：

```typescript
  pi.registerTool({
    name: "pt_check_refs",
    label: "Pt Check Refs",
    description: "Check Profile→Blueprint→Domain reference integrity. Detects dangling references (Profile references non-existent Blueprint or Domain). Read-only.",
    promptSnippet: "Check Pt reference integrity",
    promptGuidelines: ["Use pt_check_refs to detect dangling references in Profile/Blueprint/Domain before committing asset changes."],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const { checkAllRefs, formatRefCheckResult } = await import("./verify/ref-check.js");
      const r = await loadAndTranspile(ctx.cwd, session.activeProfile ?? "");
      const b = r.bundles[0];
      const result = checkAllRefs(b.profiles, b.blueprints, b.domains);
      return {
        content: [{ type: "text", text: formatRefCheckResult(result) }],
        details: result,
      };
    },
  });
```

> **依赖**：`loadAndTranspile` 和 `session` 已在 `src/index.ts` 顶部导入（现有代码）。若 P1 的 `pt_verify` 未实现，此 tool 独立可用（不依赖 verify/index.ts）。

> **注意**：`loadAndTranspile` 会重新解析资产——对大项目有延迟。可改为复用 `session.cachedBundles`（若已激活 Profile）。简单实现先用 `loadAndTranspile`，后续优化。

---

## 测试用例

新建 `tests/verify/ref-check.test.ts`：

```typescript
// tests/verify/ref-check.test.ts — P2：引用完整性校验
import { describe, it, expect } from "vitest";
import { loadAndTranspile } from "../../src/transpile.js";
import { checkAllRefs, checkProfileRefs, formatRefCheckResult } from "../../src/verify/ref-check.js";
import type { Profile, Blueprint, Domain } from "../../src/schema.js";

describe("P2: 引用完整性校验", () => {
  it("项目自身资产无悬空引用", async () => {
    const r = await loadAndTranspile(process.cwd(), "pt-dev");
    const b = r.bundles[0];
    const result = checkAllRefs(b.profiles, b.blueprints, b.domains);
    expect(result.errors).toEqual([]);
  });

  it("悬空 Blueprint 被检测", () => {
    const profile: Profile = {
      name: "test",
      blueprint: "nonexistent-blueprint",
      domains: [],
      injectionPoints: [],
    };
    const result = checkProfileRefs(profile, [], []);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("nonexistent-blueprint");
  });

  it("悬空 Domain 被检测", () => {
    const profile: Profile = {
      name: "test",
      blueprint: "bp1",
      domains: ["nonexistent-domain"],
      injectionPoints: [],
    };
    const blueprint: Blueprint = {
      name: "bp1",
      agent: "pi",
      injectionPoints: [],
      compilation: { cacheDir: ".pt/cache", split: "single-file" },
    };
    const result = checkProfileRefs(profile, [blueprint], []);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("nonexistent-domain");
  });

  it("注入点名不匹配被检测", () => {
    const profile: Profile = {
      name: "test",
      blueprint: "bp1",
      domains: [],
      injectionPoints: [{ name: "unknown-ip", domains: [] }],
    };
    const blueprint: Blueprint = {
      name: "bp1",
      agent: "pi",
      injectionPoints: [{ name: "会话知识", target: "system_prompt", modules: ["Scene"] }],
      compilation: { cacheDir: ".pt/cache", split: "single-file" },
    };
    const result = checkProfileRefs(profile, [blueprint], []);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("unknown-ip"))).toBe(true);
  });

  it("Blueprint 声明注入点但 Profile 未实例化 → 警告（非错误）", () => {
    const profile: Profile = {
      name: "test",
      blueprint: "bp1",
      domains: [],
      injectionPoints: [],  // 未实例化任何注入点
    };
    const blueprint: Blueprint = {
      name: "bp1",
      agent: "pi",
      injectionPoints: [{ name: "会话知识", target: "system_prompt", modules: ["Scene"] }],
      compilation: { cacheDir: ".pt/cache", split: "single-file" },
    };
    const result = checkProfileRefs(profile, [blueprint], []);
    expect(result.ok).toBe(true);  // 无错误
    expect(result.warnings.length).toBeGreaterThan(0);  // 有警告
  });

  it("formatRefCheckResult 输出可读文本", () => {
    const text = formatRefCheckResult({
      ok: true,
      errors: [],
      warnings: [],
    });
    expect(text).toContain("通过");
  });
});
```

---

## 验收标准（DoD）

- [ ] `src/verify/ref-check.ts` 存在，导出 `checkProfileRefs` + `checkAllRefs` + `formatRefCheckResult`
- [ ] `pt_check_refs` tool 在 `src/index.ts` 注册
- [ ] 项目自身资产校验通过（无悬空引用）
- [ ] 悬空 Blueprint 被检测为 error
- [ ] 悬空 Domain 被检测为 error
- [ ] 注入点名不匹配被检测为 error
- [ ] Blueprint 注入点未实例化被检测为 warning（非 error）
- [ ] `tsc --noEmit` 通过
- [ ] `npm run verify` 通过（含新测试 `tests/verify/ref-check.test.ts`）

---

## 向后兼容

- `ref-check.ts` 是全新模块——不影响现有 pt 功能
- `pt_check_refs` tool 是新增——不影响现有 tool
- 校验函数是纯函数（读 IR，无副作用）——不修改资产

---

## 执行步骤（顺序）

1. 跑 `tsc --noEmit && npm run verify` 确认 baseline 绿
2. 新建 `src/verify/ref-check.ts`（改动 1）
3. 跑 `tsc --noEmit`——应通过
4. 改 `src/index.ts` 注册 pt_check_refs tool（改动 2）
5. 跑 `tsc --noEmit`——应通过
6. 新建 `tests/verify/ref-check.test.ts`
7. 跑 `tsc --noEmit && npm run verify`
8. 全绿后 git commit `feat: P2 reference integrity check + pt_check_refs tool`
