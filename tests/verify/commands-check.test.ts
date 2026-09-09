// tests/verify/commands-check.test.ts — checkText 内核单测
//
// 配套 .pt/docs/issues/pt-asset-migration-visibility.md §Layer 3：
//   - biome/tsc 风格输出格式化
//   - --profile X 过滤
//   - 0 issue / null assetHealthIssues / 单 issue / 多 profile 多 issue

import { describe, it, expect } from "vitest";
import { checkText } from "../../src/commands.js";
import type { AssetHealthIssue } from "../../src/asset-health.js";
import { createSessionState, type SessionState } from "../../src/session.js";

function makeSession(issues: AssetHealthIssue[] | null): SessionState {
  const s = createSessionState();
  s.assetHealthIssues = issues;
  return s;
}

const ISSUE_PROFILE_A: AssetHealthIssue = {
  severity: "error",
  scope: "profile",
  name: "profile-a",
  field: "groups.会话背景.modules",
  msg: "Profile「profile-a」聚合组「会话背景」缺 ### Modules",
  hint: "在 H2 段下加 `### Modules: [Scene, ...]`",
  fix: "/pt check --fix profile-a",
};

const ISSUE_PROFILE_A_WARN: AssetHealthIssue = {
  severity: "warning",
  scope: "profile",
  name: "profile-a",
  field: "groups.*.modules",
  msg: "Profile「profile-a」的 modName「Foo」段名不在已知集合",
};

const ISSUE_PROFILE_B: AssetHealthIssue = {
  severity: "error",
  scope: "profile",
  name: "profile-b",
  msg: "Profile「profile-b」引用 Blueprint「ghost」不存在",
  hint: "检查拼写 / 项目 .pt/assets/blueprints/ 是否漏文件",
};

describe("checkText", () => {
  describe("assetHealthIssues = null（未扫描）", () => {
    it("返回提示串 + 0 issue", () => {
      const r = checkText(makeSession(null));
      expect(r.issueCount).toBe(0);
      expect(r.errors).toBe(0);
      expect(r.warnings).toBe(0);
      expect(r.output).toContain("未扫描");
    });
  });

  describe("assetHealthIssues = []（已扫无 issue）", () => {
    it("全集无 issue → '✓ 项目所有 Profile 配置正常'", () => {
      const r = checkText(makeSession([]));
      expect(r.output).toContain("✓");
      expect(r.output).toContain("项目所有 Profile 配置正常");
      expect(r.issueCount).toBe(0);
    });

    it("--profile X 无 issue → '✓ Profile「X」配置正常'", () => {
      const r = checkText(makeSession([]), { profileName: "profile-a" });
      expect(r.output).toContain("✓ Profile「profile-a」配置正常");
    });
  });

  describe("单 issue 渲染", () => {
    it("error issue 输出 biome 风格 × [error] + msg + hint + fix", () => {
      const r = checkText(makeSession([ISSUE_PROFILE_A]));
      expect(r.output).toContain("profile-a.profile.md");
      expect(r.output).toContain(
        "× [error] groups.会话背景.modules Profile「profile-a」聚合组「会话背景」缺 ### Modules"
      );
      expect(r.output).toContain("hint: 在 H2 段下加");
      expect(r.output).toContain("fix:  /pt check --fix profile-a");
      expect(r.errors).toBe(1);
      expect(r.warnings).toBe(0);
    });

    it("warning issue 输出 ⚠ [warning] + msg", () => {
      const r = checkText(makeSession([ISSUE_PROFILE_A_WARN]));
      expect(r.output).toContain("⚠ [warning]");
      expect(r.output).toContain("modName「Foo」");
      expect(r.errors).toBe(0);
      expect(r.warnings).toBe(1);
    });

    it("summary 行：'× N errors, M warnings'", () => {
      const r = checkText(makeSession([ISSUE_PROFILE_A, ISSUE_PROFILE_A_WARN, ISSUE_PROFILE_B]));
      expect(r.output).toMatch(/×\s+\d+\s+errors?,\s+\d+\s+warnings?/);
    });

    it("fix option=true → 'fix:' 行不显示（避免误导用户）", () => {
      const r = checkText(makeSession([ISSUE_PROFILE_A]), { fix: true });
      expect(r.output).not.toContain("fix:  /pt check");
    });
  });

  describe("--profile 过滤", () => {
    it("只列指定 profile 的 issue，其它 profile 的忽略", () => {
      const r = checkText(makeSession([ISSUE_PROFILE_A, ISSUE_PROFILE_B]), {
        profileName: "profile-a",
      });
      expect(r.output).toContain("profile-a.profile.md");
      expect(r.output).not.toContain("profile-b.profile.md");
      expect(r.issueCount).toBe(1);
    });

    it("--profile 指定无 issue 的 profile → '✓ Profile「X」配置正常'", () => {
      const r = checkText(makeSession([ISSUE_PROFILE_B]), { profileName: "profile-c" });
      expect(r.output).toContain("✓ Profile「profile-c」配置正常");
      expect(r.issueCount).toBe(0);
    });
  });

  describe("多 issue 分组", () => {
    it("同一 profile 多 issue → 单 file 头 + 多 issue 行", () => {
      const r = checkText(makeSession([ISSUE_PROFILE_A, ISSUE_PROFILE_A_WARN]));
      // file header 只出现一次
      const headerCount = (r.output.match(/profile-a\.profile\.md/g) ?? []).length;
      expect(headerCount).toBe(1);
      // 两条 issue 都列出
      expect(r.output).toContain("缺 ### Modules");
      expect(r.output).toContain("modName「Foo」");
    });

    it("多 profile → 多 file header 分组", () => {
      const r = checkText(makeSession([ISSUE_PROFILE_A, ISSUE_PROFILE_B]));
      expect(r.output).toContain("profile-a.profile.md");
      expect(r.output).toContain("profile-b.profile.md");
    });
  });

  describe("summary + hint 行", () => {
    it("issues>0 时 summary 后追加 'hint: 查看 .pt/docs/migrations/...'", () => {
      const r = checkText(makeSession([ISSUE_PROFILE_A]));
      expect(r.output).toContain(".pt/docs/migrations/v9.0-to-v9.1-modules.md");
    });

    it("errors>0 且 fix=false → 提示运行 /pt check --fix", () => {
      const r = checkText(makeSession([ISSUE_PROFILE_A]));
      expect(r.output).toContain("/pt check --fix");
    });

    it("errors=0 → 不提示 --fix", () => {
      const r = checkText(makeSession([ISSUE_PROFILE_A_WARN]));
      expect(r.output).not.toContain("/pt check --fix");
    });
  });
});
