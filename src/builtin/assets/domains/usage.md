---
name: usage
---

# usage

## Trigger
### usage-trigger
- desc: 操作 Pt 时参考；含 /pt 命令族（含 /pt make-manual 实例化手册）+ --pt-profile flag（--pt-context 为旧 flag，backward-compat 保留）+ /pt-profile 切换
- hint: /pt_turn_inject usage 查看完整命令列表

## Scene

### pt-commands
- desc: /pt（查看当前状态）+ /pt status（profile + segment 长度 + cache hit）+ /pt flows（列出可触发手册，即 Turn Context 内容索引）+ /pt raw（dump segment 到 .pt/cache/raws/）+ /pt full（dump 完整 Session Inject 到 .pt/cache/fulls/）

### pt-profile-command
- desc: /pt-profile（列出所有可用 Profile）+ /pt-profile <name>（切换到指定 Profile，下一轮生效）。旧命令 /pt-context 保留为 backward-compat fallback。

### manual-trigger
- desc: /pt_turn_inject <domain>（注入该 Domain 的 Rules/Flows/Checklists 段到 Turn Inject）+ /pt_turn_inject <flow-name> <args>（触发 Domain 的 FlowTemplate）

### pt-profile-flag
- desc: --pt-profile <name>（Pi 启动时激活指定 Profile，CLI 优先级高于 session_start 默认逻辑）。旧 flag --pt-context 保留为 backward-compat fallback。

### pt-make-manual-command
- desc: pt_make_manual LLM tool（创建 Manual 实例文档，用于多步过程跟踪）

### pt-turn-inject-command
- desc: pt_turn_inject LLM tool（按需注入 Domain 的 TurnContext 手册详情，LLM 推理触发）

### manual-create-command
- desc: /pt make-manual <procedure-name> [args...]（创建手册实例文档到 .pt/manuals/，含 checklist + 产物区，用于跟踪执行）。与 /pt_turn_inject <domain>（ephemeral 参考）互补——前者持久化，后者即时注入。

### pt-tools-llm
- desc: pt_status / pt_flows / pt_make_manual / pt_turn_inject 四个 LLM tool（pi.registerTool）。与 /pt 命令族共享纯函数内核——人类打 /pt status，LLM 调 pt_status，结果一致。/pt-profile 不做 tool（切换 Profile 改 Session Context 不该让 LLM 触发，见 .pt/docs/designs/pt-command-tool-dual-registration.md §2.4）。

### settings-pack
- desc: v15.x settings 声明 Pack——在 .pi/settings.json 的 pt.asset-packs[] 声明第三方 / 团队 Pack（只 path 字段，name 从 manifest 读）。路径支持 ~（home dir）/ 绝对 / 相对 cwd。多个 settings pack 按声明顺序后者赢（npm 风格）。pt.project-pack-dir 可改 project pack 路径（默认 .pt/assets，支持项目外路径）

### use-profile
- desc: v15.x Profile use 单继承——use: @pack/name 引用另一 Profile 作为基础增量覆盖。blueprint 覆盖 / tagline 覆盖 / domains 追加去重 / groups 同名替换。循环检测报错含链；菱形不误报。不写 use = 独立 Profile。示例：use: @pt-internal/pt-dev + blueprint: @team-stdlib/minimal + domains: [my-domain]

### frontmatter-parser-limit
- desc: Profile / Domain 的 frontmatter 是简易 parser（src/parse/shared.ts:parseFrontmatter）——支持单行 key: value，不支持复杂 YAML 结构（多行字符串 / 嵌套 / 注释）。复杂结构走 Blueprint 的 .blueprint.yaml（用 yaml 库完整解析）。v15.x use 字段保持单行 string 形态以兼容（M7）——如 `use: @pt-internal/pt-dev`，不写多行

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
