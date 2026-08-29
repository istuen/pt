---
type: term
name: commerce
---

# commerce

## Scene

### 客户
- desc: 有唯一客户ID的注册主体，有信用额度和客户等级。

### 订单
- desc: 客户的下单请求，含金额字段。

### 信用额度
- desc: 客户可透支的上限金额，决定放款是否通过。

### 客户等级
- desc: 客户的风险分类（如普通/白银/黑名单）。

## Blueprint

### ban-blacklist-lending
- items: [黑名单, 黑号]
- desc: 黑名单客户禁止放款

### inv-amount-positive
- desc: 订单金额必须大于 0。