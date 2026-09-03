// tsup.config.ts — pt 发布形态构建配置（P4）
//
// 设计：tsc + tsup 分工
//  - tsc 负责 typecheck（`tsc --noEmit`，npm scripts 的 prebuild 守门）
//  - tsup 负责 emit（基于 esbuild，快速 + 配置集中）
//
// 产出：dist/index.js + dist/index.d.ts + dist/<子目录>/*.js + dist/builtin/assets/*.md
//
// 配置要点：
//  - splitting: true 保留 dist/compile/、dist/agent/ 等子目录结构
//  - dts: true 用 tsc 生成 .d.ts
//  - external: pi 包不打包
//  - onSuccess: 跨平台 builtin 资产复制（替代 cp -r）

import { defineConfig } from "tsup";
import { cp, mkdir } from "node:fs/promises";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: false,  // P4.3 修正：tsup 内置 rollup-plugin-dts 在 TypeScript 7.x 不兼容，单独用 tsc 生成 d.ts
  target: "node18",
  platform: "node",
  bundle: false,  // 1:1 模块结构（src/compile/foo.ts → dist/compile/foo.js）
  clean: true,
  sourcemap: false,
  minify: false,
  external: [
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-ai",
    "typebox",
    "node:*",
  ],
  // 独立 d.ts 生成（用 tsc，因为 rollup-plugin-dts 与 TypeScript 7.x 不兼容）
  async onSuccess() {
    const { execSync } = await import("node:child_process");
    execSync("tsc --project tsconfig.build.json", { stdio: "inherit" });
    // 跨平台 builtin 资产复制（Windows 不支持 cp -r）
    await mkdir("dist/builtin/assets", { recursive: true });
    await cp("src/builtin/assets", "dist/builtin/assets", { recursive: true });
    console.log("✓ d.ts generated + builtin assets copied");
  },
});
