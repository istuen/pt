// tests/verify/issue-pt-trigger-desc-quality.test.ts — Trigger desc 写法体检
//
// 配套 issue pt-trigger-relevance-signal §八.3（新增审查项）+ §七之二 / §七之三 的实测依据
//
// 纯函数测试——不依赖 scanProjectHealth 的副作用（不碰文件/缓存）。
//
// 3 条规则：
//   1. desc-domain-boundary  —— desc 是领域边界式（灰区任务实测 16.4% vs 98.4%）
//   2. desc-task-signal-weak —— desc 是任务类别式但没点名本 Domain 的项（信号对不上灰区任务）
//   3. desc-rule-name-drift  —— desc 点名的规则名不存在（写进 desc 的信号是死的）

import { describe, it, expect } from "vitest";
import { checkTriggerDescQuality } from "../../src/verify/trigger-desc-quality.js";
import type { Domain } from "../../src/schema.js";

/** 造一个最小 Domain（Trigger + 可选 Scene/Rules 项）。 */
function mkDomain(
  opts: { name?: string; desc?: string; itemNames?: string[]; withTrigger?: boolean } = {}
): Domain {
  const {
    name = "test-domain",
    desc = "改 schema 契约 / 增删字段或类型 前，先查规范（rule-a、rule-b）",
    itemNames = ["rule-a", "rule-b"],
    withTrigger = true,
  } = opts;
  const modules: Record<string, unknown> = {};
  if (withTrigger) {
    modules.Trigger = [{ name: "test-trigger", desc }];
  }
  if (itemNames.length > 0) {
    modules.Rules = itemNames.map((n) => ({ name: n, check: "x" }));
  }
  return {
    name,
    modules: modules as Domain["modules"],
  } as Domain;
}

describe("checkTriggerDescQuality · 规则 1 desc-domain-boundary", () => {
  it("领域边界式 desc（'X 参考'形态）→ 报 warning", () => {
    const issues = checkTriggerDescQuality(
      mkDomain({ desc: "改 Pt 代码时参考；含 9 条技术规范（modules-type-safety 等）" })
    );
    const d = issues.find((i) => i.rule === "desc-domain-boundary");
    expect(d).toBeDefined();
    expect(d?.domainName).toBe("test-domain");
    expect(d?.itemName).toBe("test-trigger");
    expect(d?.msg).toContain("领域边界式");
  });

  it("任务类别式 desc → 不报该规则", () => {
    const issues = checkTriggerDescQuality(mkDomain());
    expect(issues.find((i) => i.rule === "desc-domain-boundary")).toBeUndefined();
  });

  it("「改 Pt 代码时参考」也是领域边界式（首分句 = X 参考形态）", () => {
    // 注：'改 Pt 代码时参考' 的首分句匹配领域介绍形态 → 归 rule 1（不叠加 rule 2）
    const issues = checkTriggerDescQuality(
      mkDomain({ desc: "改 Pt 代码时参考；含类型安全 / 命名一致等工程规范" })
    );
    expect(issues.find((i) => i.rule === "desc-domain-boundary")).toBeDefined();
  });

  it("领域边界式 + 任务信号在后半（'X 参考；…时参考'）→ 仍算领域边界式（信号被埋）", () => {
    const issues = checkTriggerDescQuality(
      mkDomain({ desc: "问题生命周期管理参考；含 issue 文档结构 / status 流转（排查问题时参考）" })
    );
    expect(issues.find((i) => i.rule === "desc-domain-boundary")).toBeDefined();
  });

  it("领域边界式命中时不再叠加规则 2（避免双报）", () => {
    const issues = checkTriggerDescQuality(
      mkDomain({ desc: "技术架构理念参考；以 Rams 底座映射到技术架构" })
    );
    expect(issues.some((i) => i.rule === "desc-domain-boundary")).toBe(true);
    expect(issues.some((i) => i.rule === "desc-task-signal-weak")).toBe(false);
  });
});

describe("checkTriggerDescQuality · 规则 2 desc-task-signal-weak", () => {
  it("任务类别式但没点名任何本 Domain 的项 → 报 warning", () => {
    const issues = checkTriggerDescQuality(
      mkDomain({
        desc: "想配置流水线时查规范；含工程化基建要求",
        itemNames: ["rule-a", "rule-b"],
      })
    );
    const d = issues.find((i) => i.rule === "desc-task-signal-weak");
    expect(d).toBeDefined();
    expect(d?.msg).toContain("泛化任务词");
  });

  it("任务类别式且点名了本 Domain 的项 → 不报", () => {
    const issues = checkTriggerDescQuality(
      mkDomain({ desc: "改 schema 契约 / 增删字段或类型 前，先查规范（rule-a、rule-b）" })
    );
    expect(issues.find((i) => i.rule === "desc-task-signal-weak")).toBeUndefined();
  });

  it("hint 里给出可用的项名（让作者能直接抄）", () => {
    const issues = checkTriggerDescQuality(
      mkDomain({ desc: "想配置流水线时查规范；含工程化基建要求", itemNames: ["rule-a", "rule-b"] })
    );
    const d = issues.find((i) => i.rule === "desc-task-signal-weak");
    expect(d?.hint).toContain("rule-a");
  });
});

describe("checkTriggerDescQuality · 规则 3 desc-rule-name-drift", () => {
  it("desc 点名的规则名不存在 → 报 warning（信号是死的）", () => {
    const issues = checkTriggerDescQuality(
      mkDomain({
        desc: "改 schema 契约 前，先查规范（rule-a、ghost-rule）",
        itemNames: ["rule-a", "rule-b"],
      })
    );
    const d = issues.find((i) => i.rule === "desc-rule-name-drift");
    expect(d).toBeDefined();
    expect(d?.msg).toContain("ghost-rule");
  });

  it("全部点名都存在 → 不报", () => {
    const issues = checkTriggerDescQuality(
      mkDomain({
        desc: "改 schema 契约 前，先查规范（rule-a、rule-b）",
        itemNames: ["rule-a", "rule-b"],
      })
    );
    expect(issues.find((i) => i.rule === "desc-rule-name-drift")).toBeUndefined();
  });

  it("括号里是中文散文 → 不当作规则名（不误报）", () => {
    const issues = checkTriggerDescQuality(
      mkDomain({ desc: "改 schema 契约 前，先查规范（类型安全、命名一致）", itemNames: ["rule-a"] })
    );
    expect(issues.find((i) => i.rule === "desc-rule-name-drift")).toBeUndefined();
  });

  it("括号里是 CamelCase 概念名（Domain / Blueprint）→ 不当作规则名（不误报）", () => {
    const issues = checkTriggerDescQuality(
      mkDomain({
        desc: "写或改 Pt 资产 md（Domain / Blueprint / Profile）时，先查创作手册",
        itemNames: ["rule-a"],
      })
    );
    expect(issues.find((i) => i.rule === "desc-rule-name-drift")).toBeUndefined();
  });
});

describe("checkTriggerDescQuality · 边界", () => {
  it("没有 Trigger 段 → 返回空（不崩）", () => {
    const issues = checkTriggerDescQuality(mkDomain({ withTrigger: false }));
    expect(issues).toEqual([]);
  });

  it("Trigger 项没有 desc → 跳过（不报）", () => {
    const d = mkDomain({ desc: "" });
    expect(checkTriggerDescQuality(d)).toEqual([]);
  });

  it("Domain 没有 Rules / Scene 段 → 规则 2 仍能报（不依赖别的段存在）", () => {
    const issues = checkTriggerDescQuality(
      mkDomain({ desc: "想配置流水线时查规范；含工程化基建要求", itemNames: [] })
    );
    expect(issues.some((i) => i.rule === "desc-task-signal-weak")).toBe(true);
  });

  it("多个 Trigger 项 → 逐项检查", () => {
    const d: Domain = {
      name: "multi",
      modules: {
        Trigger: [
          { name: "t1", desc: "改 Pt 代码时参考；含 9 条技术规范" },
          { name: "t2", desc: "改 schema 契约 前，先查规范（rule-a）" },
        ],
        Rules: [{ name: "rule-a", check: "x" }],
      },
    } as Domain;
    const issues = checkTriggerDescQuality(d);
    expect(issues).toHaveLength(1);
    expect(issues[0].itemName).toBe("t1");
  });
});
