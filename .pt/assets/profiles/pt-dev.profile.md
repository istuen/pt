---
name: pt-dev
blueprint: dev-knowledge
domains: [me, product-design, dev-workflow, issue-workflow, testing-workflow, release-workflow, asset-workflow, deployment, pt-quality, pt-collab]
---

# pt-dev (profile)

<!--
Profile 范本说明：
- YAML 全局 domains 自动分发到 Blueprint 所有注入点
- ## <注入点名> 段用于追加本注入点独有的 Domain（与全局合并去重）
- 即使无追加，保留段让配置入口可见（与 Blueprint 的 injectionPoints 对齐）
-->

## 会话知识
<!-- 此 Profile 用 Blueprint 全局 session 注入点的 modules=Scene/Trigger/Participant，
     靠 YAML 全局 domains 兜底分发；无追加 -->

## 参考手册
<!-- 此 Profile 用 Blueprint 全局 turn 注入点的 modules=Rules/Flows/Checklists，
     靠 YAML 全局 domains 兜底分发；无追加 -->