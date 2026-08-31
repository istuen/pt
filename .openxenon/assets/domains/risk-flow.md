---
type: workflow
name: risk-flow
---

# risk-flow

## Scene

### credit-limits
- path: ./data/credit-limits.xlsx
- desc: 客户信用额度表

### customer-tier
- path: ./data/customer-tier.xlsx
- desc: 客户等级表

## Manual

### risk-check
- argument-hint: <客户ID> <金额>
- intent: 客户 {{客户ID}} 申请下单，订单金额 {{金额}}
- vars: [客户ID, 金额]
- step: 取额度 — 读 `./data/credit-limits.xlsx` 查 {{客户ID}} 的信用额度
- step: 取等级 — 读 `./data/customer-tier.xlsx` 查 {{客户ID}} 的客户等级
- step: 校验 R1（额度）— 条件: 信用额度 >= {{金额}}；否则: 拒绝（额度不足）
- step: 校验 R2（黑名单）— 条件: 客户等级 = 黑名单；则: 拒绝（触发 ban:放款）
- step: 产出最终结论 — 通过/拒绝 + 理由的业务描述