---
name: workflow/p2-io-demo
---

# P2 I/O 渲染示范

> P2 端到端验证夹具：parse → bindFlowTemplate → buildManualDoc 完整链路。
> 不入 `.pt/assets/`，仅供 tests/verify/bind-flow-template.test.ts 的端到端测试使用。
> 这里用块式 dataSource + 行内 output + 既有 observe 三字段齐全，验证渲染顺序为
> dataSource → output → observe（输入→产出→验证语义流）。

## Flows

### demo-io-rendering
- argument-hint: <topic>
- intent: P2 I/O 渲染机制示范 — parse 数据源 + 期望产出都进 IR + 进 manual 实例文件
- vars: [topic]
- step: 读取需求
  - dataSource:
      name: requirement-doc
      path: .pt/docs/designs/
      desc: 已有需求文档目录
  - output: 需求摘要（写给 {{topic}} 的开场陈述）
- step: 实施改动
- step: 收尾
- observe: [git-status-clean]