---
name: commit-message
description: 生成符合 Conventional Commits 规范的提交信息 — 当用户要求提交代码、写 commit message 时使用
---

# 提交信息生成技能

1. 用 bash 运行 `git status --short` 与 `git diff --staged`（若无 staged 则 `git diff`）了解变更
2. 按以下规范生成提交信息:
   - 格式: `type(scope): 简短描述`,type ∈ feat|fix|docs|style|refactor|test|chore
   - 描述用现在时、不加句号、中英文皆可(跟随仓库已有风格)
   - 正文(可选)空一行后说明动机与要点,每行不超过 72 字符
3. 只输出建议的提交信息,不要真的执行 git commit,除非用户明确要求
