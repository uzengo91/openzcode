# OpenZCode 对标 ZCode · 差距分析与路线图

> 基准：`zcode-architecture-deep-dive.md`（ZCode App 3.11.2 / CLI 0.16.5 逆向解析）。
> 现状：OpenZCode v0.4.2（单 bundle 双形态 / app-server / MCP / Skills / 插件 / 自动化 / 市场 / 电脑操作 / 浏览器控制 / 三平台 CI）。
> 工作量：S < 1 天 · M = 1-3 天 · L = 3-7 天 · XL = 1-2 周+（单人）。

---

## 一、对标总览

| 模块 | ZCode | OpenZCode v0.4.2 | 状态 |
|---|---|---|---|
| 单二进制双形态 | Electron binary + ELECTRON_RUN_AS_NODE 加载 cjs | 同款实现 | ✅ 对齐 |
| App↔CLI 通信 | stdio JSON-RPC（44 个方法） | stdio JSON-RPC（50+ 方法） | ✅ 对齐 |
| Agent 循环 + 流式 | SSE 流式 + 工具循环 | 同款 + 空闲超时/重试 | ✅ 对齐 |
| 权限双轨 | permission 表 + App 审批事件 | 同款（ask/yolo + 审批卡） | ✅ 对齐 |
| 存储双写 | SQLite(WAL, 19 表) + rollout jsonl | SQLite(WAL, 9 表) + rollout | 🟡 部分 |
| 内置工具 | bash/read/edit/todo/web_fetch… | 10 个超集（+ls/glob/grep） | ✅ 对齐 |
| MCP 客户端 | stdio + SSE + StreamableHTTP | stdio + StreamableHTTP | 🟡 缺 SSE |
| Skills | SKILL.md 多来源 | 同款实现 | ✅ 对齐 |
| slash 命令 | 内置 + 文件定义 | 同款 + 插件贡献 | ✅ 对齐 |
| AGENTS.md/CLAUDE.md | 自动注入 | 自动注入 | ✅ 对齐 |
| Hooks | hooks/ 生命周期钩子 | ❌ 无 | ❌ 缺失 |
| 子代理（Agent 工具） | 独立会话 + agents/ 产物 | ❌ 无 | ❌ 缺失 |
| Plan 模式 | EnterPlanMode/ExitPlanMode | ❌ 无 | ❌ 缺失 |
| AskUserQuestion | 结构化选项提问 | ❌ 无 | ❌ 缺失 |
| WebSearch | 搜索工具 | 仅 web_fetch | ❌ 缺失 |
| 会话 compact/fork/rewind | 压缩 / fork / checkpoint 回滚 | ❌ 无 | ❌ 缺失 |
| 记忆系统 | memories/ + MEMORY.md + [[链接]] | ❌ 无 | ❌ 缺失 |
| 自动化调度 | 独立调度进程 + cron/off-peak/trigger | 引擎内 tick + cron/every/once | 🟡 部分 |
| 插件市场 | 官方 CDN(24) + 第三方(291) + zip/sha256 | 索引 + zip/sha256/localPath | 🟡 部分 |
| 插件配置/更新 | configure/update/validate/operationProgress | 安装/移除/启停 | 🟡 部分 |
| 电脑操作 | 29 工具，AX 语义操作 + 签名 Helper | 5 工具坐标级 + 三平台驱动 | 🟡 部分 |
| 浏览器控制 | 无状态 VM 内核 + 3 工具 + 多后端 | 8 工具直接 Playwright | 🟡 等价不同构 |
| OAuth 登录 | zcode:// 深链 + coding-plan OAuth | 手动填 API key | ❌ 缺失 |
| 打包分发 | .app + 签名公证 + Squirrel 自动更新 | dev 模式 + zip（无安装包） | ❌ 缺失 |
| 遥测 | OpenTelemetry + deviceMid | 无（opt-in 待定） | ⏸ 暂缓 |
| 本地 CA 中间代理 | NODE_EXTRA_CA_CERTS + 流量审计 | 无 | ⏸ 暂缓 |
| 远程 SSH agent 部署 | zcode-agent-deploy | 无 | ⏸ 暂缓 |

**结论**：架构主干（双形态、app-server、权限、双写、MCP/Skills/插件/自动化/市场）已对齐；**核心体验差距集中在 5 件事——语义化电脑操作、Hooks、子代理、会话管理（compact/rewind/fork）、记忆系统**；分发链（打包/签名/自动更新）是从"能用"到"产品"的分水岭。

---

## 二、逐模块差距分析

### 2.1 电脑操作 —— 最大能力差距 🟡

ZCode 的 29 工具核心优势是 **AX 语义操作**（`get_app_state` 返回带 `state_id/index` 的元素树，点击/设值/执行动作都走 accessibility，不抢焦点、不依赖坐标猜测），加上签名 Helper 持有 TCC 权限、UDS+双 token 通道、controller lease。

OpenZCode 现状：坐标级 5 工具（截图/点击/输入/按键/滚动），三平台驱动。**坐标方案在 UI 变化时脆弱**，且无法读取元素文本（只能靠截图 OCR——靠模型视觉）。

**差距清单**：`get_app_state`（AX 树/UIA/AT-SPI 元素树）、元素级 click/type/set_value/perform_action/select_text、`list_apps/list_windows`、剪贴板读写、`open_application`、`zoom` 局部放大、权限探测 `request_access`、鼠标按下/拖拽。

### 2.2 会话管理 🟡

ZCode：`session/fork`（分支）、`compact`（历史压缩防上下文爆）、`checkpoint/rewind`（文件清单哈希快照回滚）、`/goal`（目标注入每个系统提示）、会话级 setModel、`parent_id` 子会话血缘、input_history（↑键历史）。

OpenZCode：基本 CRUD + 发送/停止/审批。**长会话无 compact 会撞上下文上限；误改文件无回滚**。

### 2.3 扩展点 ❌ 三块缺失

- **Hooks**：`hooks/` 下 PreToolUse/PostToolUse/SessionStart/Stop 脚本，可拦截/改写工具调用——插件自动化与团队治理的基石。
- **子代理**：`Agent` 工具 spawn 独立会话（general-purpose/Explore 类型），agents/ 目录落产物，主会话只收结论——长任务的上下文隔离手段。
- **记忆**：`~/.openzcode/memories/<workspace>/` + MEMORY.md 索引 + `[[链接]]`，会话开始注入——跨会话个性化。

### 2.4 Agent 循环高级参数 🟡

ZCode 有 `thinking.budget_tokens`、`output_config.effort`、Anthropic `cache_control` 断点（省 90% 重复前缀费用）。OpenZCode 全裸奔：无推理档位、无缓存优化。

### 2.5 浏览器/电脑的架构差异（有意为之，记录在案）

- 浏览器：ZCode 用"无状态 VM 内核 + 运行时桥"（3 工具，模型写 JS）；OpenZCode 用 8 个声明式工具。**能力等价**，声明式对弱模型更稳，VM 内核对强模型更灵活 → roadmap 里作为可选模式。
- 电脑操作的安全架构（签名 Helper + UDS + 双 token + lease）：MVP 用宿主权限直跑。**对外分发前必须补**（否则每个用户都要手动授两处权限，且无进程隔离）。

### 2.6 分发链 ❌ 完全缺失

无 .app/.exe 安装包、无代码签名/公证、无自动更新（Squirrel）、无内置 ripgrep、无应用图标/URL scheme。当前只有源码 + release zip（需自装依赖）。

---

## 三、Roadmap

### P0 · 核心体验对齐（目标：日常主力可用，覆盖 90% 日常场景）

| # | 事项 | 方案要点 | 验收标准 | 量 |
|---|---|---|---|---|
| 1 | **computer-use 语义化** | 新增 `get_app_state`（macOS AXTree via osascript/私有 API，Windows UIA via PowerShell/COM，Linux AT-SPI via python3-atspi 探测）返回元素树（role/name/value/坐标/action）；`computer_click` 支持 element target；`set_value`/`perform_action`/`list_windows`/`clipboard_read/write` | 在 App 会话中：对 Finder/浏览器仅凭元素树完成"找到输入框→填入→提交"，零坐标猜测 | L |
| 2 | **Hooks 系统** | `hooks/`（用户/项目/插件三级）+ `hook 事件: PreToolUse/PostToolUse/SessionStart/SessionStop/PermissionRequest`；stdin/stdout JSON 协议；PreToolUse 可 deny/改参；GUI 设置页显示已注册 hooks | 示例 hook：写文件后自动 prettier；bash 命令含 `rm -rf /` 时 deny | M |
| 3 | **子代理 Agent 工具** | spawn 独立引擎会话（共享 provider/config，独立上下文与 todo），类型 `general-purpose`/`Explore`（只读工具白名单），结论回填主会话；agents/ 目录落 metadata+output | 主会话派发"全仓搜索某 API 用法"，子代理返回结论且主会话上下文不膨胀 | L |
| 4 | **会话 compact** | 上下文 token 超阈值（可配，默认 ~70%）自动触发：旧消息摘要替换（LLM 总结），保留最近 N 轮原文 + 摘要标记；`/compact` 手动触发 | 50 轮会话不撞上下文上限；compact 后任务连续性保持 | M |
| 5 | **记忆系统** | `~/.openzcode/memories/<workspaceKey>/` + MEMORY.md 索引；工具 `memory_write/memory_read`；会话系统提示注入索引（按 [[链接]] 递归读相关条目）；GUI 侧栏"记忆"入口 | 告知偏好后，新会话自动沿用 | M |
| 6 | **WebSearch 工具** | 无 API 依赖实现：搜索引擎结果页抓取（Bing/百度可配置）→ 标题+摘要列表返回；与 web_fetch 组合成完整检索链 | "搜一下 playwright 最新版本号"返回准确结果 | S |
| 7 | **Plan 模式** | `EnterPlanMode/ExitPlanMode` 工具 + GUI 计划展示卡；plan 模式下写类工具被 deny，只能读和产出计划；退出需用户批准 | 复杂任务先出计划，批准后执行 | M |
| 8 | **AskUserQuestion** | 工具发起 2-4 选项提问 → GUI 选项卡/TUI 序号选择 → 选中项回填模型 | 模型遇到歧义时走结构化提问 | S |
| 9 | **会话 fork + input_history** | fork = 复制消息历史到新会话；输入框 ↑ 键回溯历史（input_history 表） | fork 后旧会话不受影响 | S |

### P1 · 生产力与生态（目标：插件生态与长任务生产力对齐）

| # | 事项 | 方案要点 | 验收标准 | 量 |
|---|---|---|---|---|
| 10 | **checkpoint / rewind** | 会话级文件快照（清单+内容哈希，存 `.openzcode/checkpoints/`），写类工具前自动快照；GUI"回滚到此检查点"；与 hook 联动可跳过 | 误改文件一键回滚 | L |
| 11 | **插件生态增强** | 插件 `config.schema.json` → GUI 配置表单（configure）；`update`（版本比对+覆盖安装）；`.mcp.json` `${ENV}` 变量插值；兼容 Claude marketplace 索引格式（只读导入）；`plugin validate` | 从 claude-plugins-official 索引安装一个插件并跑通其 MCP | M |
| 12 | **内置插件** | document-skills（docx/xlsx/pdf 技能包）、skill-creator、restore-sessions 移植为官方市场插件 | 市场一键安装即用 | M |
| 13 | **调度器增强** | off-peak 闲时窗口（仅 XX:00-XX:00 执行）、trigger 型（文件变化/git push 触发）、`keepAwake`（执行期防休眠，caffeinate/SetThreadExecutionState）、调度器独立进程选项 | off-peak 任务白天不跑；长任务不休眠 | M |
| 14 | **推理档位与缓存** | 会话/GUI 切换 thinking budget 与 effort 档位（anthropic thinking + openai reasoning_effort 透传）；Anthropic `cache_control` 系统提示断点 | 同任务成本下降（缓存命中可见于 rollout） | M |
| 15 | **OAuth 登录 + 模型目录** | provider 支持 OAuth 流（本地回调端口 + deep link `openzcode://`）；模型目录 JSON（内置+远端更新），GUI 新建 provider 可从目录选择 | bigmodel/智谱套餐 OAuth 登录可用 | L |
| 16 | **`/goal` 目标注入** | 会话级 goal 写入每次系统提示；GUI 标题栏显示 goal 徽章 | 设 goal 后每轮系统提示含目标 | S |

### P2 · 分发与架构（目标：从源码项目到可分发产品）

| # | 事项 | 方案要点 | 验收标准 | 量 |
|---|---|---|---|---|
| 17 | **安装包 + 自动更新** | electron-builder：macOS dmg（签名+公证）/ NSIS / AppImage；内置 release zip 全部产物；Squirrel/electron-updater 对接 GitHub Releases | 三平台双击安装即用；应用内一键升级 | XL |
| 18 | **内置工具链** | 随包分发 ripgrep（三平台二进制），grep 工具优先用内置；下载校验 sha256 | 无系统 rg 的机器上 grep 提速且行为一致 | S |
| 19 | **CUA 安全架构**（对齐 ZCode §5/§9） | 可选签名 helper App 持有 TCC 权限，引擎经 UDS+token 通信，controller lease 防抢占；无 helper 时回退宿主权限模式 | 新机器安装后无需手动授两处系统权限 | XL |
| 20 | **本地 CA 中间代理**（可选功能） | node-forge 自签 CA + NODE_EXTRA_CA_CERTS 注入引擎，GUI 可查看模型流量审计日志 | 设置开启后 rollout 旁可见完整请求审计 | L |
| 21 | **stdio tap 调试** | `openzcode tap` 包裹 app-server 落盘双向流量；`OPENZCODE_AGENT_SERVER_COMMAND` 替换引擎（开发热连） | 开发者可回放任意会话的 RPC 流 | S |

### P3 · 远期 / 有意暂缓

| # | 事项 | 说明 | 量 |
|---|---|---|---|
| 22 | 遥测 OpenTelemetry | 仅 opt-in，匿名 deviceMid + 计数上报 | M |
| 23 | 浏览器 VM 内核模式 | 对齐 ZCode browser-use 设计（模型写 JS 的无状态内核），作为 8 工具之外的高级模式 | L |
| 24 | 浏览器多后端 | iab（App 内嵌浏览器视图）/ extension（接管用户浏览器） | XL |
| 25 | 远程 SSH agent | 引擎部署到远程主机执行（对齐 zcode-agent-deploy） | XL |
| 26 | 自身暴露为 MCP server | `openzcode mcp-serve`：把会话/自动化能力暴露给其他 AI 客户端 | M |
| 27 | workflow 引擎 | DB 已预留 workflow_* 表设计空间；DAG 任务编排 | XL |
| 28 | rollout 回放 UI | GUI 内查看/回放任意会话的模型 IO 与工具轨迹 | M |
| 29 | MCP SSE legacy transport | 仅当遇到只支持旧 SSE 的 server | S |
| 30 | iOS/Android 模拟器插件 | 对齐 zcode 内置 android-emulator / ios-simulator | L |

---

## 四、有意不对标项（记录设计取舍）

| ZCode 设计 | OpenZCode 取舍 | 理由 |
|---|---|---|
| 独立调度器进程 | 引擎内 tick（App 关闭则暂停） | 单机 MVP 简化；独立进程列 P1-13 |
| browser-use 无状态 VM 内核 | 8 个声明式工具 | 对弱模型更稳；VM 模式列 P3-23 |
| 剪贴板/截图走 CUA Helper | 宿主权限直跑 | 无分发签名前的务实解；P2-19 补齐 |
| 企业级遥测 | 无 | 开源项目 opt-in 优先级低 |
| GLM 通道绑定（bigmodel/zai 套餐） | 通用 OpenAI/Anthropic 双协议 + OAuth 列 P1-15 | 保持开放性 |

---

## 五、里程碑建议

- **v0.5 · 日常主力**（P0 全部）：语义化电脑操作 + Hooks + 子代理 + compact + 记忆 + WebSearch + Plan 模式 + AskUserQuestion。预估 3-4 周。
- **v0.6 · 生产力**（P1 重点 10-15）：checkpoint 回滚、插件生态增强、内置插件、调度增强、缓存与档位。预估 2-3 周。
- **v0.7 · 产品化**（P2 重点 17-19）：安装包 + 自动更新 + CUA 安全架构。预估 3-4 周。
- **v1.0**：P1/P2 收尾 + 实战反馈修复。
