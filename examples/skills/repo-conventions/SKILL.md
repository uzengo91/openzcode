---
name: repo-conventions
description: 仓库约定速查 — 当用户询问代码规范、提交信息格式或目录结构时使用此技能
---

# 仓库约定 (示例技能)

当用户询问本仓库的规范时,按以下要点回答:

1. **提交信息**: 使用 conventional commits (`feat:`, `fix:`, `chore:`, `docs:`)。
2. **目录结构**: `packages/cli` 是引擎 (单文件打包为 openzcode.cjs), `packages/app` 是 Electron GUI。
3. **测试**: 改动后必须运行 `npm run test:ci`; 涉及 LLM 链路时运行 `npm run test:e2e`。
4. **协议**: Apache-2.0。

回答时保持简洁,使用中文。
