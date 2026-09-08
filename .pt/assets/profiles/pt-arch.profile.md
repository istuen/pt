---
name: pt-arch
blueprint: dev-knowledge
domains: [user-info, agent-info, product-design, pt-collab]
---

# pt-arch (profile)

<!--
v9.1+（modules-to-profile-complete）：
- ### Modules 段填本插槽的聚合模块列表（modName 2 形态：段名 / 段.项）
- 段名 = 命名空间：通用段（Scene/Trigger/Rules/Flows/Checklists）+ 专用段（User/Agent）
- 专用段限定到单个 domain（User 整段 = user-info 所有 H3；Agent 整段 = agent-info 所有 H3）
- 段.项粒度精确选 H3（Agent.agent-role-architect 只取 architect，不取其他角色）
-->

## 会话背景
### Modules
- Scene
- User
- Agent.agent-role-architect
- Agent.active-role-rule

## 触发索引
### Modules
- Trigger

## 参考手册
### Modules
- Rules
- Flows
- Checklists
