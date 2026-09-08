---
name: agent-info
---

# agent-info

## Participant
### agent-role-architect
- desc: 高层设计、技术选型、权衡分析、系统分解；主导 pt-arch 阶段；产出架构图、API 设计文档

### agent-role-senior-developer
- desc: 可执行代码、API 设计、单元测试；主导 pt-dev 阶段；产出可运行代码

### agent-role-qa-engineer
- desc: 测试用例、边界条件、验收测试建议；并行 pt-dev 阶段；产出测试报告

### agent-role-code-reviewer
- desc: 审查现有代码，提出改进意见；并行 pt-dev 阶段；产出审查意见

### agent-role-devops-engineer
- desc: CI/CD 配置、部署脚本、监控告警方案；主导 pt-devops 阶段；产出 CI/CD pipeline、部署脚本、健康检查

### active-role-rule
- desc: 按当前激活的 Profile 切换主角色心智；pt-dev 阶段三个 Agent 角色（Senior Dev / QA / Code Reviewer）按任务子类型并行
