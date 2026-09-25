// tests/verify/doc-structure-match.test.ts — Phase 3 §Step 6：schema 校验 probe
//
// 配套 .pt/docs/designs/pt-doc-schema-phase3-command-layer-executor-brief.md §Step 4
//
// 测试覆盖：
//   - 缺参数 → INCONCLUSIVE
//   - 缺 schema 文件 → INCONCLUSIVE（含中文错误信息）
//   - 缺 frontmatter → DEVIATED
//   - 缺 required 字段 → DEVIATED
//   - enum 越界 → DEVIATED
//   - type 不匹配 → DEVIATED
//   - 完整合规 → COMPLETED
//   - allOf.if/then（status=resolved → required resolved）→ DEVIATED
//   - oneOf 多分支（字符串 / 数组）→ 命中分支校验
//
// Fixture 共享：outer describe("tmp 夹具共享") 创建 + 销毁 tmpDir，
//   validateDoc / docStructureMatch 两组 describe 内共享同一组文件。

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdir, writeFile, rm, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runVerify, listProbes } from "../../src/verify/index.js";
import {
  validateDoc,
  docStructureMatch,
  resolveSchemaPath,
} from "../../src/verify/doc-structure-match.js";
import { BUILTIN_SCHEMAS_DIR } from "../../src/constants.js";

describe("verify registry", () => {
  it("doc-structure-match 已注册", () => {
    expect(listProbes()).toContain("doc-structure-match");
  });
});

describe("docStructureMatch probe：参数缺失三态", () => {
  it("缺 path → INCONCLUSIVE", async () => {
    const r = await docStructureMatch(process.cwd(), { schema: "issue.frontmatter.schema.json" });
    expect(r.outcome).toBe("INCONCLUSIVE");
    expect(r.message).toContain("缺少参数: path");
  });

  it("缺 schema → INCONCLUSIVE", async () => {
    const r = await docStructureMatch(process.cwd(), { path: ".pt/docs/issues/foo.md" });
    expect(r.outcome).toBe("INCONCLUSIVE");
    expect(r.message).toContain("缺少参数: schema");
  });
});

describe("docStructureMatch：真数据 .pt/docs/issues 校验", () => {
  it("issue 文档走 builtin schema → COMPLETED（domain 是 optional）", async () => {
    // builtin issue schema required: type/name/status/severity/created；domain 是 optional。
    // 文档不带 domain 仍属合规。
    // 不锁具体文件名（pt-internal 不同分支上 issues 不同）——动态找第一个 issue 文件作 fixture
    const { readdirSync } = await import("node:fs");
    const issuesDir = ".pt/docs/issues";
    let sampleFile: string | null = null;
    try {
      const files = readdirSync(issuesDir).filter((f) => f.endsWith(".md"));
      sampleFile = files[0] ?? null;
    } catch {
      // issues dir 不存在
    }
    if (!sampleFile) {
      // 跳过——空 issue dir 是合法降级状态
      return;
    }
    const r = await docStructureMatch(process.cwd(), {
      path: `${issuesDir}/${sampleFile}`,
      schema: "issue.frontmatter.schema.json",
    });
    expect(r.outcome).toBe("COMPLETED");
  });

  it("runVerify shell 调用：doc-structure-match 仍可走", async () => {
    const { readdirSync } = await import("node:fs");
    const issuesDir = ".pt/docs/issues";
    let sampleFile: string | null = null;
    try {
      const files = readdirSync(issuesDir).filter((f) => f.endsWith(".md"));
      sampleFile = files[0] ?? null;
    } catch {
      return;
    }
    if (!sampleFile) return;
    const r = await runVerify(process.cwd(), "doc-structure-match", {
      path: `${issuesDir}/${sampleFile}`,
      schema: "issue.frontmatter.schema.json",
    });
    expect(["DEVIATED", "COMPLETED", "INCONCLUSIVE"]).toContain(r.outcome);
  });
});

// =====================================================================
// tmp 夹具共享：validateDoc 与 docStructureMatch 两组 describe 共用同一组 fixture
// =====================================================================
describe("tmp 夹具共享 (validateDoc + docStructureMatch)", () => {
  const tmpDir = join(process.cwd(), ".pt/cache/test-validate-doc-tmp");

  beforeAll(async () => {
    await mkdir(join(tmpDir, ".pt/schemas"), { recursive: true });
    await mkdir(join(tmpDir, "docs"), { recursive: true });
    // schema: 简单 issue schema，含 conditional if/then
    await writeFile(
      join(tmpDir, ".pt/schemas/test.schema.json"),
      JSON.stringify({
        type: "object",
        additionalProperties: false,
        required: ["name", "status"],
        properties: {
          name: { type: "string", pattern: "^[a-z][a-z0-9-]*$" },
          status: {
            type: "string",
            enum: ["open", "in-progress", "resolved", "wontfix"],
          },
          severity: {
            type: "string",
            enum: ["low", "medium", "high"],
          },
          profile: {
            oneOf: [
              { type: "string" },
              {
                type: "array",
                items: { type: "string" },
                minItems: 1,
                uniqueItems: true,
              },
            ],
          },
        },
        allOf: [
          {
            if: { properties: { status: { const: "resolved" } } },
            // biome-ignore lint/suspicious/noThenProperty: JSON Schema's if/then/else
            then: { required: ["resolved-date"] },
          },
        ],
      })
    );

    // OK 文件
    await writeFile(
      join(tmpDir, "docs/ok.md"),
      `---
name: ok
status: open
---
`
    );

    // missing required 'name'
    await writeFile(
      join(tmpDir, "docs/missing-name.md"),
      `---
status: open
---
`
    );

    // enum 越界
    await writeFile(
      join(tmpDir, "docs/bad-enum.md"),
      `---
name: bad-enum
status: WRONG
---
`
    );

    // type 不匹配（status 是数字）
    await writeFile(
      join(tmpDir, "docs/bad-type.md"),
      `---
name: bad-type
status: 42
---
`
    );

    // 条件必填违反：status=resolved 但无 resolved-date
    await writeFile(
      join(tmpDir, "docs/resolved-no-date.md"),
      `---
name: resolved-no-date
status: resolved
---
`
    );

    // oneOf 字符串分支
    await writeFile(
      join(tmpDir, "docs/oneof-string.md"),
      `---
name: oneof-string
status: open
profile: pt-dev
---
`
    );

    // oneOf 数组分支
    await writeFile(
      join(tmpDir, "docs/oneof-array.md"),
      `---
name: oneof-array
status: open
profile: [pt-dev, pt-design]
---
`
    );

    // oneOf 数组缺 minItems
    await writeFile(
      join(tmpDir, "docs/oneof-array-empty.md"),
      `---
name: oneof-array-empty
status: open
profile: []
---
`
    );

    // 无 frontmatter
    await writeFile(join(tmpDir, "docs/no-frontmatter.md"), `# body\n`);

    // 完整合法（resolved + 有 resolved-date）
    await writeFile(
      join(tmpDir, "docs/resolved-with-date.md"),
      `---
name: resolved-with-date
status: resolved
resolved-date: 2026-09-23
---
`
    );
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("validateDoc 内核", () => {
    it("合规文档 → ok=true, errors=[]", async () => {
      const r = await validateDoc(tmpDir, "docs/ok.md", "test.schema.json");
      expect(r.ok).toBe(true);
      expect(r.errors).toEqual([]);
    });

    it("missing required 'name' → ok=false, errors 含 'missing required: name'", async () => {
      const r = await validateDoc(tmpDir, "docs/missing-name.md", "test.schema.json");
      expect(r.ok).toBe(false);
      expect(r.errors.some((e) => e.includes("missing required: name"))).toBe(true);
    });

    it("enum 越界 → errors 含 'not in enum'", async () => {
      const r = await validateDoc(tmpDir, "docs/bad-enum.md", "test.schema.json");
      expect(r.ok).toBe(false);
      expect(r.errors.some((e) => e.includes("not in enum"))).toBe(true);
    });

    it("type 不匹配（数字字符串字段期望） → errors 含 'expected'", async () => {
      const r = await validateDoc(tmpDir, "docs/bad-type.md", "test.schema.json");
      expect(r.ok).toBe(false);
      expect(r.errors.some((e) => e.includes("expected"))).toBe(true);
    });

    it("conditional if/then violation → errors 含 'missing required (conditional)'", async () => {
      const r = await validateDoc(tmpDir, "docs/resolved-no-date.md", "test.schema.json");
      expect(r.ok).toBe(false);
      expect(r.errors.some((e) => e.includes("conditional"))).toBe(true);
    });

    it("conditional if/then satisfied → ok=true", async () => {
      const r = await validateDoc(tmpDir, "docs/resolved-with-date.md", "test.schema.json");
      expect(r.ok).toBe(true);
    });

    it("oneOf 字符串分支 → ok=true", async () => {
      const r = await validateDoc(tmpDir, "docs/oneof-string.md", "test.schema.json");
      expect(r.ok).toBe(true);
    });

    it("oneOf 数组分支 → ok=true", async () => {
      const r = await validateDoc(tmpDir, "docs/oneof-array.md", "test.schema.json");
      expect(r.ok).toBe(true);
    });

    it("oneOf 数组 minItems 违反 → ok=false", async () => {
      const r = await validateDoc(tmpDir, "docs/oneof-array-empty.md", "test.schema.json");
      expect(r.ok).toBe(false);
    });

    it("无 frontmatter → ok=false, reason='无 frontmatter'", async () => {
      const r = await validateDoc(tmpDir, "docs/no-frontmatter.md", "test.schema.json");
      expect(r.ok).toBe(false);
      expect(r.reason).toContain("无 frontmatter");
    });
  });

  describe("docStructureMatch probe wrapper", () => {
    it("合规 → COMPLETED", async () => {
      const r = await docStructureMatch(tmpDir, {
        path: "docs/ok.md",
        schema: "test.schema.json",
      });
      expect(r.outcome).toBe("COMPLETED");
    });

    it("缺 required → DEVIATED", async () => {
      const r = await docStructureMatch(tmpDir, {
        path: "docs/missing-name.md",
        schema: "test.schema.json",
      });
      expect(r.outcome).toBe("DEVIATED");
      expect(r.message).toContain("missing required");
    });

    it("无 frontmatter → DEVIATED（含 reason）", async () => {
      const r = await docStructureMatch(tmpDir, {
        path: "docs/no-frontmatter.md",
        schema: "test.schema.json",
      });
      expect(r.outcome).toBe("DEVIATED");
      expect(r.message).toContain("无 frontmatter");
    });

    it("conditional if/then violation → DEVIATED", async () => {
      const r = await docStructureMatch(tmpDir, {
        path: "docs/resolved-no-date.md",
        schema: "test.schema.json",
      });
      expect(r.outcome).toBe("DEVIATED");
    });
  });
});

// =====================================================================
// 两级查找测试（issue pt-builtin-schema-packaging §Step 6）
//   - 项目级覆盖存在 → 用项目版
//   - 项目级覆盖不存在 → fallback builtin
//   - 两级都不存在 → resolveSchemaPath 返回 null
//   - 通过 probe 验证 INCONCLUSIVE / DEVIATED / COMPLETED 三态
//
// 隔离原则：每个子 describe 用独立 tmpDir，避免 resolveSchemaPath 单测
// 写入项目级 schema 后影响 probe 走 builtin fallback 的下一个测试。
// =====================================================================
describe("schema 两级查找（项目级覆盖 > builtin fallback）", () => {
  describe("resolveSchemaPath 单测", () => {
    it("builtin schema 存在 → 返回 builtin 路径", () => {
      const emptyDir = "/var/folders/pt-resolve-empty";
      const p = resolveSchemaPath(emptyDir, "issue.frontmatter.schema.json");
      expect(p).not.toBeNull();
      expect(p).toBe(join(BUILTIN_SCHEMAS_DIR, "issue.frontmatter.schema.json"));
    });

    it("项目级覆盖存在 → 返回项目级路径", async () => {
      const projectDir = await mkdtemp(join(tmpdir(), "pt-resolve-override-"));
      await mkdir(join(projectDir, ".pt/schemas"), { recursive: true });
      await writeFile(
        join(projectDir, ".pt/schemas/issue.frontmatter.schema.json"),
        JSON.stringify({ type: "object" })
      );
      const p = resolveSchemaPath(projectDir, "issue.frontmatter.schema.json");
      expect(p).toBe(join(projectDir, ".pt/schemas/issue.frontmatter.schema.json"));
      await rm(projectDir, { recursive: true, force: true });
    });

    it("项目级 + builtin 都不存在 → 返回 null", async () => {
      const emptyDir = await mkdtemp(join(tmpdir(), "pt-resolve-none-"));
      const p = resolveSchemaPath(emptyDir, "non-existent.schema.json");
      expect(p).toBeNull();
      await rm(emptyDir, { recursive: true, force: true });
    });
  });

  describe("probe 走 builtin fallback（项目无 .pt/schemas/）", () => {
    let tmpRoot: string;

    beforeAll(async () => {
      // 干净 tmpDir（不预先建 .pt/schemas/）
      tmpRoot = await mkdtemp(join(tmpdir(), "pt-builtin-fallback-"));
      await writeFile(
        join(tmpRoot, "issue-ok.md"),
        `---
type: issue
name: builtin-issue-ok
status: open
severity: low
created: 2026-09-23
---
`
      );
      await writeFile(
        join(tmpRoot, "issue-violation.md"),
        `---
type: issue
name: builtin-issue-bad
status: NOT-IN-ENUM
severity: low
created: 2026-09-23
---
`
      );
    });

    afterAll(async () => {
      await rm(tmpRoot, { recursive: true, force: true });
    });

    it("builtin schema 校验合规文档 → COMPLETED", async () => {
      const r = await docStructureMatch(tmpRoot, {
        path: "issue-ok.md",
        schema: "issue.frontmatter.schema.json",
      });
      expect(r.outcome).toBe("COMPLETED");
    });

    it("builtin schema 校验违规文档 → DEVIATED", async () => {
      const r = await docStructureMatch(tmpRoot, {
        path: "issue-violation.md",
        schema: "issue.frontmatter.schema.json",
      });
      expect(r.outcome).toBe("DEVIATED");
      expect(r.message).toContain("not in enum");
    });

    it("不存在 schema 名 → INCONCLUSIVE", async () => {
      const r = await docStructureMatch(tmpRoot, {
        path: "issue-ok.md",
        schema: "no-such-schema.json",
      });
      expect(r.outcome).toBe("INCONCLUSIVE");
      expect(r.message).toContain("schema 未找到");
    });
  });

  describe("probe 走项目级覆盖（粒度 = 单文件名）", () => {
    let overrideTmpRoot: string;

    beforeAll(async () => {
      overrideTmpRoot = await mkdtemp(join(tmpdir(), "pt-project-override-"));
      // 自定义极简 schema（只 required type/name/status，无 severity/created）
      await mkdir(join(overrideTmpRoot, ".pt/schemas"), { recursive: true });
      await writeFile(
        join(overrideTmpRoot, ".pt/schemas/issue.frontmatter.schema.json"),
        JSON.stringify({
          type: "object",
          additionalProperties: false,
          required: ["type", "name", "status"],
          properties: {
            type: { const: "issue" },
            name: { type: "string" },
            status: { type: "string", enum: ["open", "in-progress", "resolved"] },
          },
        })
      );
      // 用宽松 schema 验证合规文档
      await writeFile(
        join(overrideTmpRoot, "loose-ok.md"),
        `---
type: issue
name: loose-ok
status: open
---
`
      );
      // 同样宽松 schema 验证违规（status 越界）
      await writeFile(
        join(overrideTmpRoot, "loose-bad.md"),
        `---
type: issue
name: loose-bad
status: WRONG
---
`
      );
    });

    afterAll(async () => {
      await rm(overrideTmpRoot, { recursive: true, force: true });
    });

    it("项目级覆盖生效（不强制 severity/created） → COMPLETED", async () => {
      const r = await docStructureMatch(overrideTmpRoot, {
        path: "loose-ok.md",
        schema: "issue.frontmatter.schema.json",
      });
      expect(r.outcome).toBe("COMPLETED");
    });

    it("项目级覆盖仍按自家约束校验（enum）→ DEVIATED", async () => {
      const r = await docStructureMatch(overrideTmpRoot, {
        path: "loose-bad.md",
        schema: "issue.frontmatter.schema.json",
      });
      expect(r.outcome).toBe("DEVIATED");
      expect(r.message).toContain("not in enum");
    });

    it("覆盖内容确实是用户写的版本（内容核验）", async () => {
      const p = resolveSchemaPath(overrideTmpRoot, "issue.frontmatter.schema.json");
      expect(p).not.toBeNull();
      const content = await readFile(p!, "utf8");
      const parsed = JSON.parse(content);
      // 项目版 required 不含 severity/created（builtin 版要求）
      expect(parsed.required).toEqual(["type", "name", "status"]);
    });
  });
});
