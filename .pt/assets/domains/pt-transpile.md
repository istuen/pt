---
type: workflow
name: pt-transpile
---

# pt-transpile

## Trigger
### pt-transpile-trigger
- desc: 查看 Pt 转译流程时参考；含三段式编译（parse → compile → render）的详细说明
- hint: /manual:pt-transpile 查看完整手册

## Scene

### domains-dir
- path: .pt/assets/domains/
- desc: Domain md 目录（type=term/workflow/stack/扩展，由 frontmatter.type 区分）

### channels-dir
- path: .pt/assets/channels/
- desc: v8 Channel md 目录（v9 已删除——Channel 留作未来 Connector，预留层）

### blueprint-dir
- path: .pt/assets/blueprints/
- desc: Blueprint md 目录（v9 结构层——H2=注入点人类自定义名 + agent + injectionPoints + Compilation，跨项目复用）

### profile-dir
- path: .pt/assets/profiles/
- desc: Profile md 目录（v9 配置层——引用 Blueprint + YAML 全局 domains + 各注入点 ### Domains 追加，项目级）

## Manual

### transpile
- argument-hint: <profile-name>
- intent: 把 Profile {{profile-name}} 转译成 System Prompt + Context Message
- vars: [profile-name]
- step: 读 .pt/assets/domains/ 下所有 .md → parse/domain.ts 每个解析为 Domain IR（{ name, type, modules: Record<H2段名, 内容> }）
- step: 读 .pt/assets/blueprints/ 下所有 .md → parse/blueprint.ts 每个解析为 Blueprint IR（{ name, agent, injectionPoints: InjectionPointConfig[], compilation: CompilationConfig }），H2=注入点
- step: 读 .pt/assets/profiles/ 下所有 .md → parse/profile.ts 每个解析为 Profile IR（{ name, blueprint, domains: string[], injectionPoints: InjectionPointInstance[] }）
- step: 在 Profile 列表里找 name={{profile-name}} 作为 activeProfile → 找到 Profile.blueprint 引用的 Blueprint
- step: 调 compile/context.ts 的 compileContext(profile, blueprint, domains) → Context IR（{ name, sourceHash, modules: Record<注入点名, 聚合 markdown> }），按 Blueprint.injectionPoints 遍历，按 modName 驱动聚合
- step: render/cache.ts loadContext(cwd, name, hash, compilation) 命中 → 用缓存；未命中 → saveContext(Context, compilation) 落盘 `<cacheDir>/<name>.context.md`
- step: render/system-prompt.ts 遍历 Blueprint.injectionPoints，聚合所有 target=system_prompt 的注入点内容 → System Prompt 字符串，PiAdapter 封装 before_agent_start 注入
- step: 用户输入 /<template-name> 时 PiAdapter 触发 render/context-message.ts 的 bindFlowTemplate(FlowTemplate, args) 展开为 Context Message；/manual:<domain-name> 触发注入该 Domain 的 Manual 段内容

### list-available-profiles
- argument-hint: (无)
- intent: 列出当前项目所有可用 Profile 名
- vars: []
- step: 读 .pt/assets/profiles/ 下所有 .profile.md 的 frontmatter.name
- step: 去重排序后输出
