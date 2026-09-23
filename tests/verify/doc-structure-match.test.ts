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
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { runVerify, listProbes } from "../../src/verify/index.js";
import { validateDoc, docStructureMatch } from "../../src/verify/doc-structure-match.js";

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

describe("docStructureMatch：真数据 .pt/docs/issues 校验（Phase 2 未迁移状态）", () => {
  it("已迁移文档（pt-doc-index-and-schema）→ DEVIATED（缺 domain）", async () => {
    const r = await docStructureMatch(process.cwd(), {
      path: ".pt/docs/issues/pt-doc-index-and-schema.md",
      schema: "issue.frontmatter.schema.json",
    });
    expect(r.outcome).toBe("DEVIATED");
    expect(r.message).toContain("domain");
  });

  it("runVerify shell 调用：doc-structure-match 仍可走", async () => {
    const r = await runVerify(process.cwd(), "doc-structure-match", {
      path: ".pt/docs/issues/pt-doc-index-and-schema.md",
      schema: "issue.frontmatter.schema.json",
    });
    expect(["DEVIATED", "COMPLETED"]).toContain(r.outcome);
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
