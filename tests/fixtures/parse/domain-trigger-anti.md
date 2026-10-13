---
name: test-trigger-anti-domain
---

## Trigger

### trigger-with-anti
- desc: 测试 anti 字段保留
- anti: 纯代码改动无任务派发/验收时（不触发手册注入）

### trigger-without-anti
- desc: 测试无 anti 时不输出 anti 字段

### trigger-with-hint-and-anti
- desc: 测试 hint 与 anti 同时保留
- hint: 调 pt_inject tool domain=test 查看完整规范
- anti: 纯查询无执行任务时（不触发手册注入）
