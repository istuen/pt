---
name: dev-knowledge
agent: pi
---

# dev-knowledge (blueprint)

## 会话知识
target: system_prompt
mode: hybrid
### Modules
- Scene
- Trigger

## 参考手册
target: context_message
### Modules
- Manual

## Compilation
cache-dir: .pt/cache/contexts/
split: single-file