---
kind: scene
name: article
trigger: 当用户请求"写文章"时按以下流程执行；其余对话正常响应，勿套用本流程。
layout: { mode: hybrid }
refs: [writing, article-flow, md-stack]
---

# article (scene)

## Boundaries

### select-topic
- deps: []
- desc: 查关键词热度数据，确定选题和目标读者。

### outline
- deps: [select-topic]
- desc: 写大纲，每节一句话概括。

### draft
- deps: [outline]
- desc: 按大纲写初稿，markdown 格式。

### revise
- deps: [draft]
- desc: 检查字数≥800、无标题党词，修订成稿。