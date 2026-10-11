// tests/verify/issue-pt-virtual-raw-injection.test.ts — pt-virtual-raw-injection 集成测试
//
// issue: .pt/docs/issues/pt-virtual-raw-injection.md
// 覆盖硬指标：
//   1  virtual Domain modules 存 section.raw（string）—— parse 层
//   2  normal Domain 未注册 H2 段仍走 fallbackTerms（Term[]）—— 零回归
//   3  dispatchGroup string 拦截 + H2→H3 降级（含 ## Scene 段名撞注册表场景）
//   4  renderGenericModule string 分支（防御层）
//   5  mergeSectionContent string concat（\n\n 连接）
//   6  整篇原文注入（含散文）—— loadAndTranspile 全链路
//
// 架构纪律：
//   - render 层零改动（本测试不 import src/render/*）
//   - 不加新 modName / renderer（renderGenericModule 加 export 仅供测试直接调）
//   - mode 走提取函数 parseDomainModules，不升级策略模式
//
// 段名选择：单元测试用英文段名（点号访问，无 lint 噪音）；集成测试夹具用中文段名
// （贴近厂商提示词真实场景，模板字符串不触发 lint）——两者都验证"散文保留"核心。

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDomain } from "../../src/parse/domain.js";
import {
  dispatchGroup,
  mergeSectionContent,
  renderGenericModule,
} from "../../src/compile/agent-context.js";
import { isTermArray } from "../../src/compile/type-guards.js";
import { loadAndTranspile } from "../../src/transpile.js";
import type { BlueprintGroup, Domain, ModName, ProfileGroup } from "../../src/schema.js";

// ==================== parse 层（硬指标 1 + 2） ====================

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function parseFromString(content: string, suffix = "v"): Promise<Domain> {
  const dir = await mkdtemp(join(tmpdir(), `pt-vraw-${suffix}-`));
  await writeFile(join(dir, "d.md"), content);
  tempDirs.push(dir);
  return parseDomain(dir, "d.md");
}

/** virtual Domain 含散文 + H3 + 列表混合内容（issue §四.2 散文丢失实证夹具升级版）。
 *  段名用英文（单元测试点号访问无 lint 噪音），散文内容用中文（验证散文保留核心）。 */
const VIRTUAL_RAW_DOMAIN_MD = `---
name: test-virtual-raw
mode: virtual
tagline: 整篇原文注入测试
---

## Prompt

你是一个编码助手。这是一段散文，含多行内容。
第二行散文。应该被完整保留。

### SubRule
- desc: 列表项也会保留
- desc: 第二个列表项

## Notes

更多散文内容。H2 段名是任意标题。
`;

describe("pt-virtual-raw-injection：parse 层（硬指标 1 + 2）", () => {
  it("硬指标 1：virtual Domain modules 存 section.raw（string）—— 散文原文保留", async () => {
    const d = await parseFromString(VIRTUAL_RAW_DOMAIN_MD, "raw");
    expect(d.mode).toBe("virtual");
    expect(typeof d.modules.Prompt).toBe("string");
    expect(d.modules.Prompt).toContain("你是一个编码助手");
    expect(d.modules.Prompt).toContain("第二行散文");
    expect(d.modules.Notes).toContain("更多散文内容");
  });

  it("硬指标 1 补充：virtual Domain 的 H3 + 列表也保留在原文里（不拆成 Term[]）", async () => {
    const d = await parseFromString(VIRTUAL_RAW_DOMAIN_MD, "raw-h3");
    const seg = d.modules.Prompt as string;
    expect(seg).toContain("### SubRule");
    expect(seg).toContain("列表项也会保留");
    // 不是数组（Term[]）——证明 mode 分支先于段级注册表
    expect(Array.isArray(d.modules.Prompt)).toBe(false);
  });

  it("硬指标 1 关键：virtual Domain 含 ## Scene 段名时 modules.Scene 是 string（不是 Term[]）", async () => {
    // virtual Domain 的 H2 段名是任意标题，即使叫 Scene 也不走段级注册表
    const d = await parseFromString(
      `---\nname: v-scene\nmode: virtual\n---\n## Scene\n这是一段散文，段名叫 Scene 但 mode=virtual。\n`,
      "scene"
    );
    expect(typeof d.modules.Scene).toBe("string");
    expect(d.modules.Scene).toContain("这是一段散文");
    expect(Array.isArray(d.modules.Scene)).toBe(false);
  });

  it("硬指标 2：normal Domain 未注册 H2 段仍走 fallbackTerms（Term[]）—— 零回归", async () => {
    const d = await parseFromString(
      `---\nname: n\n---\n## Glossary\n### term-a\n- desc: 术语描述\n`,
      "normal"
    );
    expect(d.mode).toBe("normal");
    expect(Array.isArray(d.modules.Glossary)).toBe(true);
    expect(isTermArray(d.modules.Glossary)).toBe(true);
  });

  it("硬指标 2 补充：normal Domain 的 ## Scene 段仍走段级注册表（Term[]）—— 零回归", async () => {
    const d = await parseFromString(
      `---\nname: n-scene\n---\n## Scene\n### user-profile\n- desc: 用户档案\n`,
      "normal-scene"
    );
    expect(Array.isArray(d.modules.Scene)).toBe(true);
    expect(isTermArray(d.modules.Scene)).toBe(true);
  });
});

// ==================== compile 层：dispatchGroup（硬指标 3） ====================

/** 构造最小 ProfileGroup（单 mod，段粒度）。 */
function mkProfileGroup(mods: ModName[]): ProfileGroup {
  return { name: "session-context", domains: [], modules: mods };
}

/** 构造最小 BlueprintGroup（byDomain mode，与 pt-virtual 一致）。 */
function mkBpGroup(): BlueprintGroup {
  return { name: "session-context", inject: "session", mode: "byDomain" };
}

describe("pt-virtual-raw-injection：dispatchGroup string 拦截 + H2→H3 降级（硬指标 3）", () => {
  it("virtual Domain 散文内容 → 输出 ### <H2名>\\n<原文>（H2 降级 H3）", () => {
    const domain: Domain = {
      name: "v",
      mode: "virtual",
      modules: {
        Prompt: "你是一个编码助手。散文内容保留。",
      },
    };
    const out = dispatchGroup(mkProfileGroup([{ section: "Prompt" }]), mkBpGroup(), [domain]);
    expect(out).toContain("### Prompt");
    expect(out).toContain("你是一个编码助手。散文内容保留。");
  });

  it("关键：virtual Domain 含 ## Scene 段名 → 不走 renderSceneModule，输出原文（跳过注册表）", () => {
    // Scene 段名在 moduleRenderers 注册表里（renderSceneModule）。
    // virtual 的 modules.Scene 是 string，dispatchGroup string 拦截必须先于注册表查找。
    const domain: Domain = {
      name: "v-scene",
      mode: "virtual",
      modules: {
        Scene: "这是 Scene 段的散文原文，不是 Term[]。",
      },
    };
    const out = dispatchGroup(mkProfileGroup([{ section: "Scene" }]), mkBpGroup(), [domain]);
    // 输出含 H2 降级 H3 标题 + 原文
    expect(out).toContain("### Scene");
    expect(out).toContain("这是 Scene 段的散文原文");
    // 不含 renderSceneModule 的 Term[] 渲染产物（- name: desc 形态）
    expect(out).not.toMatch(/^- /m);
  });

  it("多 H2 段 virtual Domain → 每段都降级 H3，段间 \\n\\n 分隔", () => {
    const domain: Domain = {
      name: "v-multi",
      mode: "virtual",
      modules: {
        First: "散文一。",
        Second: "散文二。",
      },
    };
    const out = dispatchGroup(
      mkProfileGroup([{ section: "First" }, { section: "Second" }]),
      mkBpGroup(),
      [domain]
    );
    expect(out).toContain("### First\n散文一。");
    expect(out).toContain("### Second\n散文二。");
    // 两段之间 \n\n 分隔（dispatchGroup parts.join("\n\n")）
    expect(out).toMatch(/散文一。\n\n### Second/);
  });

  it("零回归：normal Domain 的 Term[] 内容仍走 renderer（string 拦截不触发）", () => {
    const domain: Domain = {
      name: "n",
      mode: "normal",
      modules: {
        Scene: [{ name: "user-profile", desc: "用户档案" }],
      },
    };
    const out = dispatchGroup(mkProfileGroup([{ section: "Scene" }]), mkBpGroup(), [domain]);
    // renderSceneModule 输出 ### <domain.name> + - name: desc
    expect(out).toContain("### n");
    expect(out).toContain("- user-profile: 用户档案");
  });
});

// ==================== compile 层：renderGenericModule（硬指标 4） ====================

describe("pt-virtual-raw-injection：renderGenericModule string 防御分支（硬指标 4）", () => {
  it("string 内容原样返回（不返空）", () => {
    const d: Domain = { name: "v", modules: {} };
    expect(renderGenericModule(d, "字符串内容")).toBe("字符串内容");
  });

  it("多行 string 原样返回（含换行）", () => {
    const d: Domain = { name: "v", modules: {} };
    const raw = "第一行散文。\n第二行散文。\n### SubRule\n- desc: 列表项";
    expect(renderGenericModule(d, raw)).toBe(raw);
  });

  it("零回归：NamedItem[] 仍走原逻辑（- name: desc）", () => {
    const d: Domain = { name: "n", modules: {} };
    const out = renderGenericModule(d, [{ name: "item-a", desc: "描述" }]);
    expect(out).toBe("- item-a: 描述");
  });

  it("零回归：非 string 非 NamedItem[] 返空（原行为）", () => {
    const d: Domain = { name: "n", modules: {} };
    expect(renderGenericModule(d, 123)).toBe("");
    expect(renderGenericModule(d, null)).toBe("");
    expect(renderGenericModule(d, undefined)).toBe("");
  });
});

// ==================== compile 层：mergeSectionContent（硬指标 5） ====================

describe("pt-virtual-raw-injection：mergeSectionContent string concat（硬指标 5）", () => {
  it("两份 string content 合并用 \\n\\n 连接", () => {
    const d1: Domain = { name: "a", modules: { S: "原文A" } };
    const d2: Domain = { name: "b", modules: { S: "原文B" } };
    const merged = mergeSectionContent([d1, d2], "S");
    expect(merged).toBe("原文A\n\n原文B");
  });

  it("单份 string 原样返回（parts.length === 1 back-compat）", () => {
    const d: Domain = { name: "a", modules: { S: "单份原文" } };
    expect(mergeSectionContent([d], "S")).toBe("单份原文");
  });

  it("无该 section → undefined", () => {
    const d: Domain = { name: "a", modules: { Other: "x" } };
    expect(mergeSectionContent([d], "S")).toBeUndefined();
  });

  it("零回归：多份 Term[] 仍按 name union（string 分支不触发）", () => {
    const d1: Domain = { name: "a", modules: { Scene: [{ name: "t1", desc: "d1" }] } };
    const d2: Domain = { name: "b", modules: { Scene: [{ name: "t2", desc: "d2" }] } };
    const merged = mergeSectionContent([d1, d2], "Scene");
    expect(Array.isArray(merged)).toBe(true);
    expect(isTermArray(merged)).toBe(true);
  });
});

// ==================== 集成测试：整篇原文注入（硬指标 6） ====================

async function mkAssetRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `pt-vraw-e2e-${prefix}-`));
  const assets = join(root, ".pt", "assets");
  await mkdir(join(assets, "domains"), { recursive: true });
  await mkdir(join(assets, "blueprints"), { recursive: true });
  await mkdir(join(assets, "profiles"), { recursive: true });
  return root;
}

function assetsDir(root: string): string {
  return join(root, ".pt", "assets");
}

/** 集成测试夹具用中文段名——贴近厂商提示词真实场景（issue 步骤 5 原样）。
 *  模板字符串内容不触发 biome lint/formatter，只验证端到端 segment 含散文。 */
const VIRTUAL_RAW_DOMAIN_CN_MD = `---
name: test-virtual-raw
mode: virtual
tagline: 整篇原文注入测试
---

## 系统提示词

你是一个编码助手。这是一段散文，含多行内容。
第二行散文。应该被完整保留。

### 子规则
- desc: 列表项也会保留
- desc: 第二个列表项

## 另一段

更多散文内容。H2 段名是任意标题。
`;

describe("pt-virtual-raw-injection：整篇原文注入全链路（硬指标 6）", () => {
  it("virtual Domain 含散文 → segment 含散文原文 + H2 降级 H3 格式", async () => {
    const root = await mkAssetRoot("raw");
    await writeFile(join(assetsDir(root), "domains/test-virtual-raw.md"), VIRTUAL_RAW_DOMAIN_CN_MD);
    tempDirs.push(root);
    const result = await loadAndTranspile(root, "test-virtual-raw");
    expect(result.activeProfile).toBe("test-virtual-raw");
    expect(result.blueprint.name).toBe("pt-virtual");
    // segment 含散文原文（核心——修复前散文丢失）
    expect(result.segment).toContain("你是一个编码助手");
    expect(result.segment).toContain("第二行散文");
    expect(result.segment).toContain("更多散文内容");
    // H2 降级 H3 格式
    expect(result.segment).toContain("### 系统提示词");
    expect(result.segment).toContain("### 另一段");
    // H3 + 列表也保留在原文里
    expect(result.segment).toContain("### 子规则");
    expect(result.segment).toContain("列表项也会保留");
  });

  it("多 H2 段 virtual Domain → segment 含全部段（每段 H3 降级标题 + 原文）", async () => {
    const root = await mkAssetRoot("multi");
    await writeFile(
      join(assetsDir(root), "domains/multi.md"),
      `---\nname: multi-virtual\nmode: virtual\ntagline: 多段测试\n---\n## 段一\n散文一。\n## 段二\n散文二。\n`
    );
    tempDirs.push(root);
    const result = await loadAndTranspile(root, "multi-virtual");
    expect(result.segment).toContain("### 段一");
    expect(result.segment).toContain("散文一。");
    expect(result.segment).toContain("### 段二");
    expect(result.segment).toContain("散文二。");
  });
});
