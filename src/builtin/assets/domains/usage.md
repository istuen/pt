---
name: usage
---

# usage

## Trigger
### usage-trigger
- desc: 操作 Pt 时参考；含 /pt 命令族（含 /pt manual 实例化手册）+ --pt-profile flag（--pt-context 为旧 flag，backward-compat 保留）+ /pt-profile 切换
- hint: /manual:usage 查看完整命令列表

## Scene

### pt-commands
- desc: /pt（查看当前状态）+ /pt status（profile + segment 长度 + cache hit）+ /pt flows（列出可触发手册，即 Turn Context 内容索引）+ /pt raw（dump segment 到 .pt/cache/raws/）+ /pt full（dump 完整 Session Inject 到 .pt/cache/fulls/）

### pt-profile-command
- desc: /pt-profile（列出所有可用 Profile）+ /pt-profile <name>（切换到指定 Profile，下一轮生效）。旧命令 /pt-context 保留为 backward-compat fallback。

### manual-trigger
- desc: /manual:<domain-name>（注入该 Domain 的 Rules/Flows/Checklists 段到 Turn Inject）+ /<flow-name> <args>（触发 Domain 的 FlowTemplate）

### pt-profile-flag
- desc: --pt-profile <name>（Pi 启动时激活指定 Profile，CLI 优先级高于 session_start 默认逻辑）。旧 flag --pt-context 保留为 backward-compat fallback。

### pt-manual-command
- desc: /pt manual <procedure-name> [args...]（创建手册实例文档到 .pt/manuals/，含 checklist + 产物区，用于跟踪执行）。与 /manual:<domain>（ephemeral 参考）互补——前者持久化，后者即时注入。

### pt-tools-llm
- desc: pt_status / pt_flows / pt_manual 三个 LLM tool（pi.registerTool）。与 /pt 命令族共享纯函数内核——人类打 /pt status，LLM 调 pt_status，结果一致。/pt-profile 不做 tool（切换 Profile 改 Session Context 不该让 LLM 触发，见 .pt/docs/designs/pt-command-tool-dual-registration.md §2.4）。

## Flows

### list-profiles
- argument-hint: (无)
- intent: 列出当前项目所有可用 Profile 名（含内建 fallback）
- vars: []
- step: 读 .pt/assets/profiles/ 下所有 .profile.md 的 frontmatter.name
- step: 合并内建 src/builtin/assets/profiles/（同名时项目优先）
- step: 去重排序后输出

### switch_profile
- argument-hint: <profile-name>
- intent: 切换到指定 Profile 并重编译
- vars: [profile-name]
- step: /pt-profile {{profile-name}}
- step: Pt 删该 profile 的 cache（强制重编译）
- step: 下一轮 Pi 事件自动加载新 profile 的 segment

### dump_segment
- argument-hint: (无)
- intent: 把当前 session 的 segment（Pt 注入的 Session Context）dump 到文件
- vars: []
- step: /pt raw → 写入 .pt/cache/raws/segment-<timestamp>.md
- step: 用于检查 Pt 编译产物是否正确

## Rules

### cache-invalidation-rule
- check: 改资产后必删 .pt/cache/agent-contexts/*.agent-context.md 强制重编译；sourceHash 会自动失效，但手动删 cache 是最直接的验证方式

### profile-switch-next-turn
- check: /pt-profile <name> 切换后下一轮才生效（before_agent_start 事件重注入）；当前轮不受影响

### module-fallback-warning
- check: Domain Module 名拼错（如 ## Scenr）会走 generic fallback 静默聚合，不报错；用 /pt raw 检查 segment 确认 Module 是否正确贡献

### builtin-override
- check: 项目 .pt/assets/ 下同名资产覆盖内建（dedupByName 项目优先）；内建 guide 被项目 guide 覆盖时 /pt status 仍显示 guide 名但内容是项目版
