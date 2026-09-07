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

## 功能清单（MVP+）

- **Agent 循环**：系统提示注入（含 AGENTS.md/CLAUDE.md 自动加载）→ 流式请求 → 工具调用 → 结果回填 → 多轮迭代（上限可配）
- **内置工具 10 个**：`bash`、`read_file`、`write_file`、`edit_file`(str_replace 语义)、`list_dir`、`glob`、`grep`(优先 ripgrep)、`todo_write`、`web_fetch`、`skill`
- **权限模型**：ask 模式下危险操作（bash/写/编辑）产生 `permission_request` 事件 → GUI 审批卡（允许/本会话总是允许/拒绝）或 TUI y/n/a；`yolo` 全放行；非交互且无 `--yolo` 时拒绝危险操作
- **存储双写**：`~/.openzcode/db.sqlite`（session/message/todo/model_usage/tool_usage/permission，WAL）+ `rollout/<sessId>.jsonl`；`node:sqlite` 不可用时自动回退 JSON 存储
- **模型接入**：Provider 注册表（openai/anthropic 双协议、多 provider、默认切换、连接测试、密钥 0600 落盘 + 脱敏回显）
- **桌面 App**：会话侧栏（持久化恢复）、流式渲染、工具卡片、权限审批、token 用量、任务清单、设置面板（Provider/MCP/Skills）、工作目录切换（引擎随迁重启）、引擎崩溃自动重启
- **CLI TUI**：流式输出、工具行、权限确认、slash 命令（/new /sessions /resume /provider /skills /mcp /plugins /commands /reload /quit）

## MCP 服务器（stdio + Streamable HTTP）

工具以 `mcp__<server>__<tool>` 命名空间暴露给模型，自动出现在工具表中；崩溃自动重启后重试一次。

配置三处作用域（同名时 project > user > plugin）：

```jsonc
// ~/.openzcode/mcp.json (用户级) 或 <工作区>/.mcp.json (项目级)
{
  "mcpServers": {
    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] },
    "deepwiki":   { "url": "https://mcp.deepwiki.com/mcp", "headers": { "authorization": "Bearer xxx" } },
    "careful":    { "command": "./run.sh", "danger": true }   // danger: true → ask 模式下需审批
  }
}
```

- GUI：⚙ 设置 → MCP 服务器 → 添加/禁用/重载；CLI：`openzcode mcp list|tools|call <server> <tool> [json]`
- 传输：stdio（子进程，JSON-RPC over newline）与 Streamable HTTP（POST + `Mcp-Session-Id`，SSE/JSON 响应均可）

## 技能 Skills

`SKILL.md`（YAML frontmatter: `name` + `description`）放在三处任一：`~/.openzcode/skills/<名称>/`、`<工作区>/.openzcode/skills/<名称>/`、插件 `skills/`。名称与描述注入系统提示，模型判断匹配后调用 `skill` 工具加载完整说明再执行。示例见 [`examples/skills/repo-conventions`](examples/skills/repo-conventions/SKILL.md)。

## 插件与自定义命令

一个插件 = `~/.openzcode/plugins/<名称>/`（或项目 `.openzcode/plugins/`）下的目录，可同时贡献 `skills/` + `commands/` + `mcp.json`。完整示例见 [`examples/plugins/demo-plugin`](examples/plugins/demo-plugin)。

```bash
openzcode plugin install ./my-plugin    # 安装(复制到用户级)
openzcode plugin list | remove <name>
```

自定义 slash 命令：`~/.openzcode/commands/<名称>.md`（或项目/插件 `commands/`），frontmatter `description`，正文为提示词模板，`$ARGUMENTS`/`$1` 会被实际参数替换。示例见 [`examples/commands/translate.md`](examples/commands/translate.md)。TUI 与 GUI 输入 `/名称 参数` 即生效。

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
- `test:artifact` 是最终验收门：用**构建产物**（`OPENZCODE_BUNDLE` 可指向 release 解压出的 openzcode.cjs）驱动 agent，把**本仓库**作为工作区 —— 模型要读取真实源码并写入 `.oz-itest/`（gitignored），断言逐字节与仓库真值一致；同时验证 **MCP 工具调用**（引擎加载配置的 MCP server，LLM 决策调用 `mcp__calc__add` 并核验结果）。
- `test:ci` 覆盖 MCP 双 transport（stdio + Streamable HTTP 的握手/tools list/tools call）、技能发现与 frontmatter、命令展开（$ARGUMENTS/$1）、插件安装/移除/启停 —— 全程无 LLM、无外网。

- [Roadmap · 对标 ZCode 的差距分析与路线图](ROADMAP.md)
- [Roadmap V2 · 基于 Codex CLI 内核 × ZCode 体验的改造方案（当前方向）](ROADMAP-V2.md)

## 电脑操作 与 浏览器控制

**电脑操作**（零原生依赖，按平台自动选择后端，危险操作需审批）：
`computer_screenshot`（截图作为图像回传给模型）、`computer_click`（left/right/double）、`computer_type`、`computer_key`（`cmd+c`/`ctrl+shift+t`/`Return`…）、`computer_scroll`。

| 平台 | 截屏 | 鼠标/键盘 |
|---|---|---|
| macOS | `screencapture` | osascript（键盘/左键），装 [cliclick](https://github.com/BlueM/cliclick) 后支持右键/双击 |
| Windows | PowerShell + GDI+ | PowerShell SendInput/SendKeys（完整支持） |
| Linux | gnome-screenshot / scrot / import | xdotool（X11） |

**浏览器控制**（playwright-core，可选依赖；优先复用本机 Chrome/Edge，无需下载浏览器）：
`browser_open` / `browser_navigate` / `browser_snapshot`（ARIA 快照，`[ref=eN]` 引用）/ `browser_click` / `browser_type` / `browser_evaluate` / `browser_screenshot` / `browser_close`。
快照引用是点击与输入的唯一事实来源。截图同样作为图像回传模型。设置环境变量 `OPENZCODE_BROWSER_HEADLESS=0` 可有头运行。
浏览器缺失时给出明确安装提示（`npm i playwright-core` + Chrome/Edge 或 `npx playwright install chromium`）。

## 自动化（定时任务）

引擎内建调度器（默认 30s tick），自动化持久化在 SQLite，触发时自动开新会话、以设定权限模式无人值守执行，并记录每次运行历史。

```bash
# CLI
openzcode automation create --name "每日简报" --prompt "生成工作区简报" --cron "0 9 * * 1-5"
openzcode automation create --name "巡检" --prompt "检查构建" --every 30 --unit minute --max-runs 10
openzcode automation create --name "提醒" --prompt "喝水" --delay-minutes 60   # 一次性
openzcode automation list|runs|run|enable|disable|delete
# TUI: /automations (run|del|on|off <id>)
```

- 对话中可直接让模型创建：它有 `CronCreate / CronList / CronUpdate / CronDelete` 四个工具
- 调度三型：`cron`（5 字段本地时区）、`every`（间隔循环，1-200 minute/hour/day）、`once`（延迟分钟一次性）；`maxRuns` 有限次数后自动完成
- 防双触发：`nextRunAt` 乐观锁 claim（多进程共享同一 SQLite 只会触发一次）
- GUI：侧栏「⏰ 自动化」— 列表/创建/暂停/立即运行/删除/运行历史

## 插件市场

市场 = 一个 `marketplace.json` 索引 + 插件包。官方源为本仓库 `marketplace/marketplace.json`（raw.githubusercontent），可添加任意 URL 或本地目录源。安装 = 下载 zip → sha256 校验（如索引提供）→ 解包到用户插件目录 → 热加载。

```bash
openzcode marketplace list                # 浏览全部源的插件
openzcode marketplace install commit-helper
openzcode marketplace add my-src /path/to/dir   # 或 https URL
# TUI: /plugins ; GUI: 侧栏「▦ 插件市场」— 卡片浏览/一键安装/添加源
```

插件包优先使用索引里的 `localPath`（仓库内/离线可用），否则下载 `url` 归档。Release CI 会自动把 `marketplace/plugins/*` 打成 zip 附到 Release。

## RPC 方法面（app-server）

`initialize`、`server/info`、`config/get|setProvider|removeProvider|setDefaultProvider|setOptions|testProvider`、
`session/create|list|get|messages|todos|send|stop|approve|delete`、
`mcp/list|reload|toggle|call|userConfig|saveUserConfig`、`skills/list`、`commands/list|expand`、`plugin/list|install|remove`、
`automation/create|list|get|update|delete|toggle|runs|runNow`、`marketplace/list|install|addSource|removeSource`；
事件通知 `session/event`（`turn_started` / `text_delta` / `message` / `tool_start` / `tool_end` / `permission_request` / `permission_resolved` / `todo_updated` / `skill_loaded` / `usage` / `session_updated` / `turn_done`）、`mcp/status`、`automation/status`。

## CI / Release

- **CI**（`.github/workflows/ci.yml`）：push/PR → 安装（跳过 Electron 二进制）→ 构建 bundle → 无 LLM 冒烟测试 →（可选，配置了 `OPENZCODE_TEST_API_KEY` secret 时）真实 LLM E2E → 上传产物。
- **Release**（`.github/workflows/release.yml`）：推送 `v*` tag → 构建 + 冒烟 → 打包 `openzcode-v*-bundle.zip` → 自动创建 GitHub Release 并附产物。

## 与完整版 ZCode 的差距（有意裁剪）

主干之外，本仓库已实现 MCP 客户端、Skills、插件与自定义命令。仍未包含（扩展点预留）：
子代理（Agent 工具）、computer-use / browser-use broker（UDS+token）、调度器（cron automations）、
遥测（OpenTelemetry）、本地 CA 中间代理、会话 compact/fork、checkpoints、插件市场（远程安装）。

## License

[Apache-2.0](LICENSE)
