---
type: workflow
name: pt-transpile
---

# pt-transpile

## Scene

### domains-dir
- path: .pt/assets/domains/
- desc: Domain md 目录（type=term/workflow/stack/扩展，由 frontmatter.type 区分）

### channels-dir
- path: .pt/assets/channels/
- desc: Channel md 目录（H2=注入点，定义每个注入点的 target + modules + mode，跨项目复用）

### blueprint-dir
- path: .pt/assets/blueprints/
- desc: Blueprint md 目录（按注入点选 Domain + Trigger/Boundaries + Compilation，每场景一份）

## Manual

### transpile
- argument-hint: <blueprint-name>
- intent: 把 Blueprint {{blueprint-name}} 转译成 System Prompt + Context Message
- vars: [blueprint-name]
- step: 读 .pt/assets/domains/ 下所有 .md → parse/domain.ts 每个解析为 Domain IR（{ name, type, modules: Record<H2段名, 内容> }）
- step: 读 .pt/assets/channels/ 下所有 .md → parse/channel.ts 每个解析为 Channel IR（{ name, injectionPoints: InjectionPointConfig[] }），H2=注入点
- step: 读 .pt/assets/blueprints/ 下所有 .md → parse/blueprint.ts 每个解析为 Blueprint IR（{ name, channel, injectionPoints: InjectionPointInstance[], compilation: CompilationConfig }）
- step: 在 Blueprint 列表里找 name={{blueprint-name}} 作为 activeBlueprint
- step: 调 compile/context.ts 的 compileContext(activeBlueprint, channel, domains) → Context IR（{ name, sourceHash, modules: Record<注入点名, 聚合 markdown> }），按 Channel.injectionPoints 遍历编译
- step: render/cache.ts loadContext(cwd, name, hash, compilation) 命中 → 用缓存；未命中 → saveContext(Context, compilation) 落盘 `<cacheDir>/<name>.context.md`
- step: render/system-prompt.ts 遍历 Channel.injectionPoints，聚合所有 target=system_prompt 的注入点内容 → System Prompt 字符串，拼到 pi Agent systemPrompt 末尾，before_agent_start 注入
- step: 用户输入 /<template-name> 时 render/context-message.ts 的 bindFlowTemplate(FlowTemplate, args) 展开为 Context Message，input 事件 transform 替换；FlowTemplate 从 blueprint.injectionPoints[target=context_message].domains 引用的 workflow-Domain 取

### list-available-blueprints
- argument-hint: (无)
- intent: 列出当前项目所有可用 Blueprint 名
- vars: []
- step: 读 .pt/assets/blueprints/ 下所有 .blueprint.md 的 frontmatter.name
- step: 去重排序后输出
