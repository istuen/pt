---
name: pt
---

# pt (blueprint)

## Channel

project-dev

## Domains

- pt-concepts
- pt-transpile
- pt-capabilities

## Trigger

当用户询问 Pt 自身相关知识（架构、转译流程、能力边界）时按以下流程回答；其余对话正常响应，勿套用本流程。

## Boundaries

### identify-topic
- deps: []
- desc: 识别用户问题属于哪一类（概念 / 转译流程 / 能力边界）

### cite-domain
- deps: [identify-topic]
- desc: 按类别引用对应 Domain 的 Scene 段（axioms）

### compose-answer
- deps: [cite-domain]
- desc: 把 axioms 与 Manual 模块组合成可执行回答