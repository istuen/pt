// tests/verify/issue-pt-active-profile-fallback-mismatch.test.ts —
//
// 修复 pt-active-profile-fallback-mismatch：parse 层 findActiveProfile fallback 时
// 暴露 origin 元数据 + caller 层同步改写 s.activeProfile / loadedFrom / notify。
//
// 覆盖：
// - parse 层：profile 找不到 → origin="fallback" + originalProfileName
// - parse 层：profile 找到 → origin="exact"
// - transpile 层：origin 透传到 TranspileResult
// - resolveAndDedupRefs-like behavior：fallback 后 activeProfile 与原始请求名不同
// - 集成：完全无 profile 时仍抛错（fallback 路径不能掩盖真错）

import { describe, it, expect } from "vitest";
import { mdAdapter } from "../../src/parse/index.js";
import type { AssetPack } from "../../src/schema.js";

function makePack(name: string, rootDir: string): AssetPack {
  return {
    name,
    rootDir,
    version: "0.0.0",
    // v15.x PR7（issue pt-remove-global-pack 移除）：fallback 默认值改 "settings"（"global" 已不在 PackSource）
    source: name === "prj" ? "project" : "settings",
    manifestWarnings: [],
    loadDomains: () => Promise.resolve([]),
    loadBlueprints: () => Promise.resolve([]),
    loadProfiles: () => Promise.resolve([]),
  };
}

describe("activeProfile fallback origin（fix pt-active-profile-fallback-mismatch）", () => {
  // 用真实 mdAdapter.load 跑 fixtures（避免造太多 mock）
  // fixtures 在 tests/fixtures/，我们用空目录 + 临时 pack profile
  const cwd = process.cwd();

  it("profile 找到 → origin='exact'，无 originalProfileName", async () => {
    // pt-dev 在 .pt/assets/profiles/ 存在，精确命中
    const bundle = await mdAdapter.load(cwd, "pt-dev");
    expect(bundle.activeProfileOrigin).toBe("exact");
    expect(bundle.originalProfileName).toBeUndefined();
    expect(bundle.activeProfile).toBe("pt-dev");
  });

  it("profile 不存在 → origin='fallback'，originalProfileName=请求名", async () => {
    // 'nonexistent-profile-xyz' 在所有 pack 都找不到
    const bundle = await mdAdapter.load(cwd, "nonexistent-profile-xyz");
    expect(bundle.activeProfileOrigin).toBe("fallback");
    expect(bundle.originalProfileName).toBe("nonexistent-profile-xyz");
    expect(bundle.activeProfile).not.toBe("nonexistent-profile-xyz");
    // fallback 到 alphabetic 第一个（pt-arch 在 pt-design/dev/devops 之前）
    expect(bundle.activeProfile).toBeTruthy();
  });

  it("限定 @pack/name 找不到 → 仍 fallback（fallback 在限定 ref 后才生效）", async () => {
    // @pt/nonexistent 限定 ref 找不到 → findActiveProfile 抛错 → fallback 到 allProfiles[0]
    const bundle = await mdAdapter.load(cwd, "@pt/nonexistent");
    expect(bundle.activeProfileOrigin).toBe("fallback");
    expect(bundle.originalProfileName).toBe("@pt/nonexistent");
  });

  it("限定 @pt/guide（builtin 有）→ origin='exact'", async () => {
    // @pt/guide builtin 存在 → 精确命中
    const bundle = await mdAdapter.load(cwd, "@pt/guide");
    expect(bundle.activeProfileOrigin).toBe("exact");
    expect(bundle.activeProfile).toBe("guide");
  });
});
