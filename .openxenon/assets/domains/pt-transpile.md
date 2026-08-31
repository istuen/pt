---
type: workflow
name: pt-transpile
---

# pt-transpile

## Scene

### domains-dir
- path: .openxenon/assets/domains/
- desc: Domain md 目录（type=term/workflow/stack，由 frontmatter.type 区分）

### blueprints-dir
- path: .openxenon/assets/blueprints/
- desc: Struct md 目录（kind=scene/blueprint，由 frontmatter.kind 区分，scene + manual 同名成对）

## Manual

### transpile
- argument-hint: <scene-name>
- intent: 把 Scene {{scene-name}} 转译成 System Prompt + Manual
- vars: [scene-name]
- step: 读 .openxenon/assets/domains/ 下所有 .md → 每个解析为 Domain { name, type, scene, blueprint }
- step: 读 .openxenon/assets/blueprints/ 下所有 .md → 每个解析为 Struct { name, kind, refs, trigger?, boundaries?, layout? }
- step: 在 Struct 里找 kind=scene 且 name={{scene-name}} 作为 activeScene
- step: 调用 generateV6Prompt(bundle) 按 activeScene.refs 渲染 System Prompt（scene renderer 按 type 分发）
- step: 把 System Prompt 拼到 Pi Agent systemPrompt 末尾，before_agent_start 注入
- step: 用户输入 /<template-name> 时调 generateManual(bundle, manualStruct, args) 展开 Manual，input 事件 transform 替换

### list-available-scenes
- argument-hint: (无)
- intent: 列出当前项目所有可用 Scene 名
- vars: []
- step: 读 .openxenon/assets/blueprints/ 下所有 .scene.md 的 frontmatter.name
- step: 去重排序后输出