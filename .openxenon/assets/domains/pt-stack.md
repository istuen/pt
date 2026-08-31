---
type: stack
name: pt-stack
---

# pt-stack

## Scene

### typescript
- role: Pt 全部源码用 TypeScript（src/*.ts）；tsconfig.json include: ["src"]，target ES2022，module ESNext bundler。

### pi-extension-api
- role: Pi 提供的 ExtensionAPI（src/index.ts 入口）；用到的接口：registerFlag / registerCommand / on(session_start|before_agent_start|input|session_shutdown)。

### tsx
- role: 验证脚本运行器（.pt/verify-*.ts 用 `npx tsx` 直接执行，tsconfig.json allowImportingTsExtensions: true）。

### md-asset-format
- role: Domain / Channel / Blueprint 都是 markdown + YAML frontmatter；按目录位置分发解析（domains/ → Domain IR，channels/ → Channel IR，blueprints/ → Blueprint IR）。

### git
- role: 版本控制；每 Phase 一个 commit（Phase X.Y: ... 格式），baseline 可回退（ffa721e / 571b45d / 9fca537 / 0f6ce44 等已知节点）。

## Manual