# kernel/ — vendored Codex CLI 上游快照

本目录是 [openai/codex](https://github.com/openai/codex) 的 **vendored 快照**（Apache-2.0）。
OpenZCode 的内核改造（`oz-*` patch/crate）叠加在此之上；**尽量不直接修改上游文件**，以便定期同步。

## 上游同步（rebase 流程）

```bash
# 1. 一次性配置 upstream（本目录内）
cd kernel && git init 2>/dev/null; git remote add upstream https://github.com/openai/codex.git 2>/dev/null || true

# 2. 拉取上游最新 main（完整历史需要 unshallow）
git fetch --depth 1 upstream main

# 3. 对比差异并将我们的 oz-* 改造重放
#    我们的改造以 kernel/oz-patch/*.patch 形式保存（git diff 生成的补丁文件）
#    同步 = 用新快照替换本目录 + 依序重放 patch：
git apply --check oz-patch/*.patch   # 冲突检查
git apply oz-patch/*.patch
```

## 我们的叠加物（不在上游）

| 文件/目录 | 用途 |
|---|---|
| `oz-patch/*.patch` | 全部 OpenZCode 改造（branding、中文文案、GLM 预置 provider 等），补丁形式可重放 |
| `config.examples/glm.toml` | 阿里云 MaaS GLM 端点的 config.toml 模板（wire_api=chat） |
| `config.examples/anthropic.toml` | Anthropic 兼容端点模板（M1 起） |

## 上游版本

- 快照日期：2026-09-07
- 来源：https://github.com/openai/codex main（浅快照）
