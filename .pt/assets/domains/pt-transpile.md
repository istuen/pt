---
type: workflow
name: pt-transpile
---

# pt-transpile

## Scene

### domains-dir
- path: .openxenon/assets/domains/
- desc: Domain md 目录（type=term/workflow/stack/扩展，由 frontmatter.type 区分）

### channels-dir
- path: .openxenon/assets/channels/
- desc: Channel md 目录（声明含哪些上下文模块 + 编排策略，跨项目复用）

### blueprints-dir
- path: .openxenon/assets/blueprints/
- desc: Blueprint md 目录（引用 Channel + 具体 Domains + trigger + boundaries，每场景一份）

## Manual

### transpile
- argument-hint: <blueprint-name>
- intent: 把 Blueprint {{blueprint-name}} 转译成 System Prompt + Context Message
- vars: [blueprint-name]
- step: 读 .openxenon/assets/domains/ 下所有 .md → parse/domain.ts 每个解析为 Domain IR（{ name, type, modules: Record<H2段名, 内容> }）
- step: 读 .openxenon/assets/channels/ 下所有 .md → parse/channel.ts 每个解析为 Channel IR（{ name, modules, layout }）
- step: 读 .openxenon/assets/blueprints/ 下所有 .md → parse/blueprint.ts 每个解析为 Blueprint IR（{ name, channel, domains, trigger, boundaries }）
- step: 在 Blueprint 列表里找 name={{blueprint-name}} 作为 activeBlueprint
- step: 调 compile/context.ts 的 compileContext(activeBlueprint, channel, domains) → Context IR（{ name, sourceHash, modules: Record<H2段名, 聚合 markdown> }）
- step: render/cache.ts loadContext 命中 → 用缓存；未命中 → saveContext(Context) 落盘 .pt/cache/*.context.md
- step: render/system-prompt.ts 读 Context.modules.Scene → System Prompt 字符串，拼到 Pi Agent systemPrompt 末尾，before_agent_start 注入
- step: 用户输入 /<template-name> 时 render/context-message.ts 的 bindFlowTemplate(FlowTemplate, args) 展开为 Context Message，input 事件 transform 替换

### list-available-blueprints
- argument-hint: (无)
- intent: 列出当前项目所有可用 Blueprint 名
- vars: []
- step: 读 .openxenon/assets/blueprints/ 下所有 .blueprint.md 的 frontmatter.name
- step: 去重排序后输出