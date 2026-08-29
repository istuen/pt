---
kind: scene
name: risk-check
trigger: 当用户请求风控检查（risk-check）时按以下流程执行；其余对话正常响应，勿套用本流程。
layout: { mode: hybrid }
refs: [commerce, risk-flow, risk-stack]
---

# risk-check (scene)

## Boundaries

### take-limit
- deps: []
- desc: 取客户信用额度

### take-tier
- deps: [take-limit]
- desc: 取客户等级

### check
- deps: [take-tier]
- desc: 校验通过性