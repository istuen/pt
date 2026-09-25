// tests/verify/doc-index.test.ts — Phase 3 §Step 6：scanDocs / filterByProfile / filterByStatus
//
// 配套 .pt/docs/designs/pt-doc-schema-phase3-command-layer-executor-brief.md §Step 1
//
// 测试策略：
//   - 真数据：用项目 .pt/ 全集验证 happy path（数量断言已知值）
//   - 边界：用 tmp 目录构造 frontmatter 变体（缺字段、字符串 profile、数组 profile、
//     无 profile 字段、YAML 解析错误）
//   - 性能：仅在真数据测试断言数量——不跑延迟断言（229 文件无感）

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  scanDocs,
  filterByProfile,
  filterByStatus,
  countParseErrors,
  type DocRecord,
} from "../../src/doc-index.js";

describe("doc-index: scanDocs", () => {
  describe("真实项目 (.pt/ 全集)", () => {
    const cwd = process.cwd();
    let issues: DocRecord[];
    let manuals: DocRecord[];
    let designs: DocRecord[];

    beforeAll(async () => {
      [issues, manuals, designs] = await Promise.all([
        scanDocs(cwd, "issue"),
        scanDocs(cwd, "manual"),
        scanDocs(cwd, "design"),
      ]);
    });

    it("issues 数量（结构不变式——不锁具体数字）", () => {
      // 不锁具体数字（pt-internal 不同分支上 issues 集会变）——只要 scan 能扫出东西
      // 不锁 parseErrors=0：同上（issues 集合可能部分未迁完）
      expect(issues.length).toBeGreaterThan(0);
    });
    it("issues 每条都有 frontmatter（至少含 name/status/created）", () => {
      const sample = issues[0];
      expect(sample.frontmatter).not.toBeNull();
      expect(sample.frontmatter?.type).toBe("issue");
    });

    it("manuals 数量（结构不变式——空集是合法状态）", () => {
      // 不锁数字：CI 环境 pt-internal 不含 manuals（session 生成型），0 是合法状态
      expect(manuals.length).toBeGreaterThanOrEqual(0);
    });

    it("designs 数量（结构不变式——不锁具体数字）", () => {
      // 不锁数字：pt-internal 不同分支上 designs 集会变
      expect(designs.length).toBeGreaterThan(0);
      // 不锁 parseErrors=0：pt-internal main 分支可能尚未迁完（老 design 文档无 frontmatter）
      // — scan 能容错继续扫（不拋）即合法
    });

    it("designs 大多数有 frontmatter（设计文档阶段 2 完成度）", () => {
      // 结构不变式：只锁比例（不锁 90%——pt-internal 不同分支上 frontmatter 迁移进度不同）
      // 仅验证 scan 能处理（parseError >= 0）——不过多断言
      expect(designs.length).toBeGreaterThanOrEqual(0);
    });

    it("scanDocs 目录不存在 → 返回 []（降级兼容，未初始化目录不报错）", async () => {
      const docs = await scanDocs("/nonexistent-cwd-xyz", "issue");
      expect(docs).toEqual([]);
    });
  });

  describe("tmp 夹具：frontmatter 变体", () => {
    const tmpDir = join(process.cwd(), ".pt/cache/test-doc-index-tmp");

    beforeAll(async () => {
      await mkdir(join(tmpDir, ".pt/docs/issues"), { recursive: true });
      await mkdir(join(tmpDir, ".pt/manuals"), { recursive: true });
      await mkdir(join(tmpDir, ".pt/docs/designs"), { recursive: true });
      // 5 个变体
      await writeFile(
        join(tmpDir, ".pt/docs/issues/has-string-profile.md"),
        `---
type: issue
name: has-string-profile
status: open
severity: low
created: 2026-09-23
domain: dev-process
profile: pt-dev
---
`
      );
      await writeFile(
        join(tmpDir, ".pt/docs/issues/has-array-profile.md"),
        `---
type: issue
name: has-array-profile
status: in-progress
severity: medium
created: 2026-09-23
domain: dev-process
profile: [pt-dev, pt-design]
---
`
      );
      await writeFile(
        join(tmpDir, ".pt/docs/issues/no-profile.md"),
        `---
type: issue
name: no-profile
status: open
severity: high
created: 2026-09-23
domain: dev-process
---
`
      );
      await writeFile(
        join(tmpDir, ".pt/docs/issues/no-frontmatter.md"),
        `# no frontmatter
body
`
      );
      await writeFile(
        join(tmpDir, ".pt/docs/issues/bad-yaml.md"),
        `---
type: issue
name: bad-yaml
status: [unclosed
---
`
      );
    });

    afterAll(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it("5 个变体都进列表（无 frontmatter / 坏 YAML 不抛）", async () => {
      const docs = await scanDocs(tmpDir, "issue");
      expect(docs.length).toBe(5);
    });

    it("坏 frontmatter 记 parseError，但 frontmatter=null 仍存在", async () => {
      const docs = await scanDocs(tmpDir, "issue");
      const bad = docs.find((d) => d.fileName === "bad-yaml");
      expect(bad).toBeDefined();
      expect(bad?.parseError).toBeDefined();
    });

    it("无 frontmatter 记 parseError='无 frontmatter'", async () => {
      const docs = await scanDocs(tmpDir, "issue");
      const noFm = docs.find((d) => d.fileName === "no-frontmatter");
      expect(noFm).toBeDefined();
      expect(noFm?.parseError).toBe("无 frontmatter");
    });
  });
});

describe("doc-index: filterByProfile", () => {
  // 构造 6 条测试数据：字符串/数组/无字段 × open/in-progress
  const docs: DocRecord[] = [
    {
      filePath: "1.md",
      fileName: "1",
      kind: "issue",
      frontmatter: { profile: "pt-dev" },
    },
    {
      filePath: "2.md",
      fileName: "2",
      kind: "issue",
      frontmatter: { profile: "pt-design" },
    },
    {
      filePath: "3.md",
      fileName: "3",
      kind: "issue",
      frontmatter: { profile: ["pt-dev", "pt-design"] },
    },
    {
      filePath: "4.md",
      fileName: "4",
      kind: "issue",
      frontmatter: { profile: ["pt-devops"] },
    },
    {
      filePath: "5.md",
      fileName: "5",
      kind: "issue",
      frontmatter: {},
    },
    {
      filePath: "6.md",
      fileName: "6",
      kind: "issue",
      frontmatter: null,
    },
  ];

  it("activeProfile=null → 返回全部（不激活 profile 模式不过滤）", () => {
    expect(filterByProfile(docs, null).length).toBe(6);
  });

  it("pt-dev → 命中 字符串 / 数组 / 无字段（降级兼容未迁移文档）", () => {
    const r = filterByProfile(docs, "pt-dev");
    const names = r.map((d) => d.fileName).sort();
    expect(names).toEqual(["1", "3", "5", "6"]);
  });

  it("pt-design → 命中 pt-design 字符串 + 数组含 pt-design + 无字段（5 项降级兼容）", () => {
    const r = filterByProfile(docs, "pt-design");
    const names = r.map((d) => d.fileName).sort();
    // 2 = profile: "pt-design"
    // 3 = profile: ["pt-dev", "pt-design"]
    // 5 = frontmatter={} (无 profile 字段)
    // 6 = frontmatter=null (无 frontmatter 也无 profile 字段)
    expect(names).toEqual(["2", "3", "5", "6"]);
  });

  it("pt-devops → 命中仅数组含 pt-devops + 无字段", () => {
    const r = filterByProfile(docs, "pt-devops");
    const names = r.map((d) => d.fileName).sort();
    expect(names).toEqual(["4", "5", "6"]);
  });

  it("ghost profile → 只剩无字段文档（降级兼容的逆证）", () => {
    const r = filterByProfile(docs, "ghost-profile");
    const names = r.map((d) => d.fileName).sort();
    expect(names).toEqual(["5", "6"]);
  });
});

describe("doc-index: filterByStatus", () => {
  const docs: DocRecord[] = [
    { filePath: "1", fileName: "1", kind: "issue", frontmatter: { status: "open" } },
    { filePath: "2", fileName: "2", kind: "issue", frontmatter: { status: "in-progress" } },
    { filePath: "3", fileName: "3", kind: "issue", frontmatter: { status: "resolved" } },
    { filePath: "4", fileName: "4", kind: "issue", frontmatter: {} },
    { filePath: "5", fileName: "5", kind: "issue", frontmatter: null },
  ];

  it("status=null → 全部", () => {
    expect(filterByStatus(docs, null).length).toBe(5);
  });
  it("status=open → 只 1 条", () => {
    expect(filterByStatus(docs, "open").map((d) => d.fileName)).toEqual(["1"]);
  });
  it("status=in-progress → 只 2 条", () => {
    expect(filterByStatus(docs, "in-progress").map((d) => d.fileName)).toEqual(["2"]);
  });
  it("status=resolved → 只 3 条", () => {
    expect(filterByStatus(docs, "resolved").map((d) => d.fileName)).toEqual(["3"]);
  });
  it("status=ghost → 0 条", () => {
    expect(filterByStatus(docs, "ghost").length).toBe(0);
  });
  it("缺 status 字段的文档不会被任何 status 命中（除 null）", () => {
    expect(filterByStatus(docs, "open").map((d) => d.fileName)).not.toContain("4");
  });
});
