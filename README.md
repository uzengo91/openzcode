# OpenZCode

**单二进制、双形态的编码 Agent MVP** —— 一个 Electron 可执行文件：启动 GUI 就是桌面 App，以 `ELECTRON_RUN_AS_NODE=1` 加载 `openzcode.cjs` 就是终端 CLI。桌面 App 本质上是 CLI 的一个 GUI 前端，通过 stdio 上的 JSON-RPC（`app-server --stdio`）驱动引擎。

[English](README.en.md) | 简体中文

[![CI](https://github.com/uzengo91/openzcode/actions/workflows/ci.yml/badge.svg)](https://github.com/uzengo91/openzcode/actions/workflows/ci.yml)
[![Release](https://github.com/uzengo91/openzcode/actions/workflows/release.yml/badge.svg)](https://github.com/uzengo91/openzcode/actions/workflows/release.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

> 架构复刻自对 ZCode 桌面版/CLI 的逆向解析，聚焦其三个最值得借鉴的设计：
> ① App↔CLI 用 stdio JSON-RPC 解耦（GUI 与引擎各自可独立使用）；
> ② 会话连续性双写（SQLite 结构化 + rollout jsonl 原始报文，可重放可审计）；
> ③ 权限双轨（引擎权限管理 + App 审批事件上行）。

## 快速开始

```bash
git clone https://github.com/uzengo91/openzcode.git
cd openzcode
npm install                 # 安装依赖 (electron + esbuild)
npm run build:cli           # 打包单文件 CLI: packages/cli/dist/openzcode.cjs
npm start                   # 启动桌面 App

# 配置模型服务 (CLI 方式，或在 App ⚙ 设置里配置)
node packages/cli/dist/openzcode.cjs provider add \
  --name my-llm --base-url https://your.host/v1 \
  --api-key <KEY> --model <MODEL> --protocol openai --set-default
node packages/cli/dist/openzcode.cjs provider test
```

也可以直接下载 [Releases](https://github.com/uzengo91/openzcode/releases) 中的 `openzcode-v*-bundle.zip`：

```bash
unzip openzcode-v*-bundle.zip && cd openzcode
./bin/openzcode --version          # CLI (node 或 electron-as-node)
cd app && npm install && npx electron .   # 桌面 App
```

## 三种运行形态（同一个 bundle）

| 形态 | 命令 | 说明 |
|---|---|---|
| 交互 TUI | `openzcode` | readline 终端会话，`/help` 查看命令 |
| 单发 | `openzcode -p "任务" --yolo [-C dir]` | 非交互执行并打印结果 |
| App-Server | `openzcode app-server --stdio` | JSON-RPC 2.0 over stdio，供 App 驱动 |
| 桌面 App | `npm start` | GUI 前端，每个 workspace 一个引擎进程 |

## 进程拓扑（与 ZCode 同构）

```
用户 ── GUI ── Electron main (openzcode-app)
                └── spawn: Electron binary + ELECTRON_RUN_AS_NODE=1
                      └── openzcode.cjs app-server --stdio  (进程名 openzcode-app-server)
                            ├── Agent 循环 (系统提示 + 工具 + 流式)
                            ├── 模型 API (OpenAI / Anthropic 兼容, HTTPS SSE)
                            └── 存储: SQLite(node:sqlite, WAL) + rollout/*.jsonl
```

## 功能清单（MVP）

- **Agent 循环**：系统提示注入（含 AGENTS.md/CLAUDE.md 自动加载）→ 流式请求 → 工具调用 → 结果回填 → 多轮迭代（上限可配）
- **内置工具 9 个**：`bash`、`read_file`、`write_file`、`edit_file`(str_replace 语义)、`list_dir`、`glob`、`grep`(优先 ripgrep)、`todo_write`、`web_fetch`
- **权限模型**：ask 模式下危险操作（bash/写/编辑）产生 `permission_request` 事件 → GUI 审批卡（允许/本会话总是允许/拒绝）或 TUI y/n/a；`yolo` 全放行；非交互且无 `--yolo` 时拒绝危险操作
- **存储双写**：`~/.openzcode/db.sqlite`（session/message/todo/model_usage/tool_usage/permission，WAL）+ `rollout/<sessId>.jsonl`；`node:sqlite` 不可用时自动回退 JSON 存储
- **模型接入**：Provider 注册表（openai/anthropic 双协议、多 provider、默认切换、连接测试、密钥 0600 落盘 + 脱敏回显）
- **桌面 App**：会话侧栏（持久化恢复）、流式渲染、工具卡片、权限审批、token 用量、任务清单、设置面板、工作目录切换（引擎随迁重启）、引擎崩溃自动重启
- **CLI TUI**：流式输出、工具行、权限确认、slash 命令（/new /sessions /resume /provider /yolo /todos /test /quit）

## 数据布局（`~/.openzcode/`）

```
config.json             providers + permissionMode (0600)
db.sqlite (| db.json)   会话/消息/用量/权限 结构化存储
rollout/<sessId>.jsonl  模型 IO 原始记录
workspace/default       默认工作目录
```

## 测试

```bash
npm run test:ci          # 无 LLM 冒烟: RPC/配置/会话/存储/健壮性 (CI 默认跑这个)
npm run test:e2e         # 真实 LLM E2E: 需要 env OPENZCODE_TEST_API_KEY
npm run test:artifact    # 产物集成测试: 用构建产物对【本仓库代码】做真实读写并断言
npm run package          # 打 release zip
```

- `test:e2e` 与 `test:artifact` 需要真实模型服务：设置 `OPENZCODE_TEST_API_KEY`（可选 `OPENZCODE_TEST_BASE_URL`、`OPENZCODE_TEST_MODEL`），或已在 `~/.openzcode/config.json` 配置默认 provider。密钥不进仓库。
- `test:artifact` 是最终验收门：用**构建产物**（`OPENZCODE_BUNDLE` 可指向 release 解压出的 openzcode.cjs）驱动 agent，把**本仓库**作为工作区 —— 模型要读取真实源码（`packages/cli/src/version.js`、`README.md`、`packages/app/package.json`）并将提取的事实写入 `.oz-itest/`（gitignored），断言逐字节与仓库真值一致。

## RPC 方法面（app-server）

`initialize`、`server/info`、`config/get|setProvider|removeProvider|setDefaultProvider|setOptions|testProvider`、
`session/create|list|get|messages|todos|send|stop|approve|delete`；事件通知 `session/event`（`turn_started` / `text_delta` / `message` / `tool_start` / `tool_end` / `permission_request` / `permission_resolved` / `todo_updated` / `usage` / `session_updated` / `turn_done`）。

## CI / Release

- **CI**（`.github/workflows/ci.yml`）：push/PR → 安装（跳过 Electron 二进制）→ 构建 bundle → 无 LLM 冒烟测试 →（可选，配置了 `OPENZCODE_TEST_API_KEY` secret 时）真实 LLM E2E → 上传产物。
- **Release**（`.github/workflows/release.yml`）：推送 `v*` tag → 构建 + 冒烟 → 打包 `openzcode-v*-bundle.zip` → 自动创建 GitHub Release 并附产物。

## 与完整版 ZCode 的差距（有意裁剪）

MVP 聚焦"单二进制双形态 + app-server + agent loop + 权限 + 双写存储"这条主干。以下能力未包含，但预留了扩展点：
MCP 客户端与插件市场、子代理（Agent 工具）、computer-use / browser-use broker（UDS+token）、
调度器（cron automations）、遥测（OpenTelemetry）、本地 CA 中间代理、会话 compact/fork、checkpoints。

## License

[Apache-2.0](LICENSE)
