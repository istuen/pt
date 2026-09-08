---
name: pt-arch
blueprint: dev-knowledge
domains: [user-info, agent-info, product-design, pt-collab]
---

# pt-arch (profile)

<!--
Profile 范本说明：
- YAML 全局 domains 自动分发到 Blueprint 所有聚合组
- ## <聚合组名> 段用于追加本聚合组独有的 Domain（与全局合并去重）
- 即使无追加，保留段让配置入口可见（与 Blueprint 的 groups 对齐）
-->

## 会话背景
<!-- 此 Profile 用 Blueprint session 聚合组的 modules=Scene/Participant，
     靠 YAML 全局 domains 兜底分发；无追加 -->

## 触发索引
<!-- 此 Profile 用 Blueprint session 聚合组的 modules=Trigger，
     靠 YAML 全局 domains 兜底分发；无追加 -->

## 参考手册
<!-- 此 Profile 用 Blueprint turn 聚合组的 modules=Rules/Flows/Checklists，
     靠 YAML 全局 domains 兜底分发；无追加 -->
