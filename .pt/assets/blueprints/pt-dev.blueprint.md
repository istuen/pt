---
name: pt-dev
---

# pt-dev (blueprint)

## Channel

pt-dev

## 会话知识

### Domains
- pt-architecture
- pt-stack
- pt-concepts

### Trigger
当用户要开发/修改 Pt 自身（改 IR、改资产、扩展 Domain Type、加 Channel/Blueprint）时按以下流程回答；其余对话正常响应，勿套用本流程。

### Boundaries
### identify-task
- deps: []
- desc: 识别开发任务类型（改 schema / 改 asset / 扩 type / 加 channel / 加 blueprint）

### cite-stack
- deps: [identify-task]
- desc: 按任务类型从 pt-stack 引用相关技术栈（typescript / pi-extension-api / tsx / md-asset-format）

### cite-flow
- deps: [cite-stack]
- desc: 从 pt-dev-flow 引用对应流程（modify-schema / modify-asset / add-domain-type）

### execute
- deps: [cite-flow]
- desc: 按 cite-flow 步骤执行（tsc --noEmit → verify-phase77.ts → git commit）

## 对话记忆

### Domains
- pt-dev-flow
- pt-collab

## Compilation

cache-dir: .pt/contexts/cache/
split: single-file
