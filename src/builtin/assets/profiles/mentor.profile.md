---
name: mentor
blueprint: pt-default
domains: [mentor, user-info, agent-info]
---

# mentor (profile)

<!--
分步教学 profile——比 guide 更细，按 7 步引导用户从零到第一个可用 Pt 配置。

定位对比：
  guide  = 全量参考（按概念组织，引 6 domain 完整展示 Scene/User/Agent/Trigger/Rules/Flows/Checklists）
  mentor = 分步教学（按步骤组织，mentor domain 7 步主线 + 按需深度参考）

设计要点：
  - session-context 只引 mentor + user-info + agent-info（不引 authoring/usage/project-analysis）
    → Scene 只聚合 mentor 的 7 步（user-info/agent-info 无 Scene 段不干扰）
    → 保持 session 精简，深度参考通过 /pt_turn_inject 按需触发
  - trigger-index 的 mentor-trigger 带深度参考指引（authoring/usage/project-analysis）
  - reference-manual 的 Rules/Flows/Checklists 只聚合 mentor 的（教学专用，不与 authoring 重复）

复用 pt-default blueprint（3 聚合组：session-context/trigger-index/reference-manual）。
-->

## session-context
### Modules
- Scene
- User
- Agent

## trigger-index
### Modules
- Trigger

## reference-manual
### Modules
- Rules
- Flows
- Checklists
