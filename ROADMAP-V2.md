# ROADMAP v2 · OpenZCode = Codex CLI 内核 × ZCode 外观与体验

> **方案转变（2026-09-07）**：放弃自研 JS 内核继续追赶，改为 **基于 OpenAI Codex CLI（Apache-2.0，Rust）做改造**：
> **内核 = Codex CLI**（沙箱/agent 循环/协议栈/多端架构直接继承），**外观与体验 = ZCode**（单二进制双形态、Electron App 驱动 CLI 的 app-server 模式、GLM/国产模型生态、中文体验）。
> **同时支持 OpenAI / Anthropic 兼容端点**（含 GLM、DeepSeek、Qwen 等国产兼容端点为一等公民）。
> **对齐基准 = ZCode 现有功能**（v0.5.0 JS 版已落地的全部能力：MCP/Skills/插件/命令/Hooks/记忆/自动化调度/插件市场/电脑操作/浏览器控制/权限双轨/会话管理/ZCode 风格 GUI）——这些功能清单直接作为 Codex 内核改造的**需求规格**，逐项在 Rust 内核 + 侧车上对齐实现。
> JS CLI（`packages/cli`）**保留不删**、不再投入开发：仅作为可运行的降级备份与 GUI 联调夹具；其功能以"已验收行为"的形式成为 V2 的验收基准。

---

## 一、为什么这个方案成立（可行性结论）

| 前提 | 事实依据（源码核实） |
|---|---|
| 许可允许 | Codex **Apache-2.0**（NOTICE 仅要求保留声明），可 fork 改造、可改名分发 |
| 模型多端点 | 内核已有 `wire_api` 抽象（**Responses / Chat 双协议**）+ `model_providers` 自定义配置；加 **Anthropic Messages 协议适配器**即覆盖我们全部端点（阿里云 MaaS/freeshare/bigmodel 均为 OpenAI 兼容，ZCode 官方走 Anthropic 兼容） |
| 双形态同构 | Codex 已有 `app-server` + `app-server-protocol`（**110+ JSON-RPC 方法**，stdio/uds 传输）——与 ZCode「App 经 stdio JSON-RPC 驱动 CLI」拓扑**完全同构**，Electron App 直接对接 |
| 外观可套 | Electron GUI 是协议客户端，替换数据源即可；ZCode 风格 UI（侧栏/工具条/卡片）已在我们仓库成型，只换 RPC 对接层 |
| 品牌边界 | codex 商标/名称不使用；产品名 OpenZCode，溯源声明保留 Apache-2.0 + NOTICE |

**风险与对策**
- **上游漂移**：Codex 迭代极快 → 用 **vendored fork + 定期 rebase**（ monthly），改造全部以**独立 crate / feature flag** 形式叠加（`openzcode-*` 前缀），不改核心文件，降低合并冲突。
- **Rust 工程能力**：团队 JS 背景 → 改造集中在「协议适配器 + 配置 + 打包」三条线，核心 agent 循环不动 Rust 代码；CI 全自动构建。
- **功能回退**：JS CLI 已有的自动化调度/记忆/电脑操作语义层，Codex 原生缺失 → 作为 `openzcode` 侧车 crate 或 GUI 层能力补齐（见 P2）。

---

## 二、目标架构

```
用户 ── OpenZCode.app (Electron, ZCode 风格 GUI)           ← 我们现有 renderer 改造
        │  stdio/uds JSON-RPC (app-server-protocol, 110+ 方法)
        ▼
openzcode (Rust 单二进制 = Codex CLI 内核改造)
        ├── codex-core (agent 循环/工具/沙箱 Seatbelt·Landlock·WinACL)  ← 上游, 不动
        ├── oz-providers: OpenAI 兼容 + Anthropic 兼容适配器            ← 新增 crate
        ├── oz-branding: 名称/图标/默认配置/中文提示                     ← 新增
        ├── oz-sidecar: 自动化调度 · 记忆 · 电脑操作语义层(后期)        ← 新增(可选能力)
        └── tui (codex-tui, 换肤 + 中文)                                ← 少量改
        ▼
   模型端点: OpenAI 兼容(阿里云MaaS/GLM/DeepSeek/…) · Anthropic 兼容(ZCode官方/…) · Responses
```

---

## 三、阶段规划

### M0 · 基座与跑通（第 1-2 周）——「让 codex 内核以 OpenZCode 之名跑起来」

| # | 事项 | 要点 | 验收 |
|---|---|---|---|
| 0.1 | Vendor fork 搭建 | 仓库 `openzcode` 内建 `kernel/`（codex 上游快照 + upstream.remote 指向 openai/codex）；保留 Apache-2.0 LICENSE/NOTICE；README 溯源声明 | `cargo build` 通过；`git remote` 与 rebase 文档化 |
| 0.2 | oz-branding | 二进制名 `openzcode`、banner/版本串、默认 `~/.openzcode/` 数据目录、config 兼容读取 JS 版 `providers`（迁移器） | `openzcode --version` = OpenZCode 风格输出 |
| 0.3 | **oz-providers: OpenAI 兼容适配** | 用既有 `wire_api=chat`：把阿里云 MaaS（GLM-5.3-Flash）端点以内置 provider 预置（`oz` 系列预设 + `model_providers` 自定义文档中文化）；处理国产端点特性（`stream_options`、SSE 心跳、空闲超时=复用我们 90s 经验） | GLM-5.3-Flash 真实端到端任务（读写文件+bash）跑通 |
| 0.4 | TUI 中文化+换肤 | codex-tui 文案表抽取 → 中文；主题色对齐 ZCode 深蓝黑 | TUI 全中文界面 |
| 0.5 | 三平台 CI | 复用现有 CI 骨架：cargo build + clippy + test 矩阵（ubuntu 门禁，mac/win advisory→逐步转正） | Release 产物三平台二进制 |

**M0 退出标准**：`openzcode "修复 xxx"` 在终端完整跑通 GLM 端点；双平台安装包可分发。

### M1 · 双形态对齐（第 3-5 周）——「Electron App 驱动 Rust 内核」

| # | 事项 | 要点 | 验收 |
|---|---|---|---|
| 1.1 | app-server 对接层 | GUI 的 `rpc()` 从 JS app-server 切到 codex app-server（thread/start、turn/start、item/* 事件映射到现有渲染管线） | 现有 GUI 全功能接 Rust 内核 |
| 1.2 | 事件/卡片映射 | thread/turn/item 事件 → 我们的 user/assistant/tool/permission 卡片；approvals → 审批卡；thread/compacted → 压缩卡 | 四类卡片 + 审批/计划/提问交互全通 |
| 1.3 | provider 管理移植 | GUI 设置面板读写 codex `config.toml` 的 `model_providers`；连接测试复用内核；密钥走 codex auth 存储 | GUI 添加 GLM/Anthropic 端点并跑通 |
| 1.4 | 单二进制双形态 | Electron 以 `ELECTRON_RUN_AS_NODE` 方式不再适用(Rust) → 改为 **app 内嵌内核二进制**（资源文件）+ PATH `openzcode` CLI；保留下述双入口体验 | App 内嵌内核 + 独立 CLI 双入口 |
| 1.5 | **Anthropic 兼容适配器** | 新增 `wire_api=anthropic`（messages API、`tool_use/tool_result`、`x-api-key`、interleaved thinking 可选）；对齐我们 JS 版语义 | ZCode 官方端点(bigmodel anthropic 兼容)跑通 |
| 1.6 | 会话管理映射 | thread/list/resume/fork/**rollback**/compacted 全接 GUI；`turn/steer` 接「运行中插话」 | 会话列表/fork/回退/压缩/运行中转向 全可用 |

**M1 退出标准**：Electron App + Rust 内核替代 JS 方案的全部日常功能；JS CLI 降级为备份入口。

### M2 · 超越 JS 版（第 6-8 周）——「吃到 codex 红利」

| # | 事项 | 要点 | 验收 |
|---|---|---|---|
| 2.1 | **OS 沙箱默认启用** | macOS Seatbelt / Linux Landlock / Windows ACL（codex 原生）；GUI 模式条映射 read-only/workspace-write/danger；hooks(oz) 在沙箱外做策略层 | 默认 workspace-write 沙箱下完成真实任务 |
| 2.2 | MCP 对齐 | codex rmcp-client 配置对接 GUI 的 MCP 管理面板（mcpServers 迁移器） | 现有 calc fixture 经 GUI 配置跑通 |
| 2.3 | Skills/插件市场 | codex skills + plugin marketplace 接 GUI 市场页；JS 版市场索引格式迁移器 | 市场安装 commit-helper 到 codex skills 体系 |
| 2.4 | **对齐 ZCode：自动化调度** | `oz-scheduler`（Node 侧车进程，复用 JS 版 automations 模块）：cron/every/once + maxRuns + 乐观锁防双触发 + 无人值守 turn（调 thread/start）；GUI 自动化面板数据源切换到侧车 RPC | JS 版自动化全部行为在 V2 等价可用；每日任务真实无人触发 |
| 2.5 | **对齐 ZCode：记忆系统** | `oz-memory`（侧车）：workspaceKey 目录 + MEMORY.md + [[链接]] 格式与 JS 版**二进制兼容**（同一数据目录直接沿用）；经 AGENTS.md 注入 + `memory_read/write` 工具桥接内核 | JS 版记忆数据零迁移可用；跨会话生效 |
| 2.6 | **对齐 ZCode：电脑操作 + 浏览器控制** | JS 版 computer(语义元素树+窗口降级)/browser(Playwright 8 工具) 以 **MCP server 形式**打包为 `openzcode-computer` / `openzcode-browser` 侧车，内核经 MCP 挂载——工具行为与 JS 版逐一对齐 | E2E：截屏回传模型、窗口树降级、example.com 标题读取 三断言在内核会话复现 |
| 2.7 | **对齐 ZCode：Hooks** | codex 原生 plugin hooks 为主；`hooks/` 三级目录(用户/项目/插件) + `openzcode-hook:` 注释绑定格式作为**兼容层**迁移到 codex 插件清单 | JS 版 shield.sh deny 场景在 V2 复现 |
| 2.8 | **对齐 ZCode：自定义命令 + Skills** | codex skills/prompts 原生承载；JS 版 commands($ARGUMENTS) 与 SKILL.md 格式写迁移器（数据零丢失） | JS 版 translate.md / repo-conventions 在 V2 可用 |

**M2 退出标准**：JS 版全部能力在 Rust 内核上可用 + 沙箱/steer/rollback 三个 JS 版没有的能力。

### M3 · 产品化（第 9-12 周）

安装包（dmg/NSIS/AppImage + 签名公证计划）、自动更新、内置 ripgrep、文档站、性能基线（TUI 渲染/首 token 延迟）、JS CLI 归档（`legacy/` 分支保留）。

---

## 四、并行分工建议（单人可串行，两人可并行）

| 线 | 内容 | 技能 |
|---|---|---|
| **内核线** | M0.1/0.3/1.5/2.1（Rust：providers 适配器、沙箱配置） | Rust 中级即可（改造面窄） |
| **GUI 线** | M1.1-1.3/1.6 + G 全部（现有 renderer 的 RPC 对接改造） | 现有 JS 栈 |
| **侧车线** | M2.4/2.5/2.6（Node 侧车 + MCP 桥） | 现有 JS 资产复用 |

## 五、测试与验收基线 = 「ZCode 功能对齐矩阵」

**验收的唯一基准是 ZCode（JS v0.5.0）现有功能行为**，逐项建矩阵（功能 → V2 实现方式 → 验收断言）：

| ZCode 现有功能 | V2 承载方式 | 验收断言（复用现有测试改造） |
|---|---|---|
| 权限双轨 ask/yolo + 审批卡 | codex approvals 原生 | 审批卡交互 + deny 路径 |
| MCP（stdio+HTTP, mcp__x__y） | codex rmcp-client | calc fixture 双 transport |
| Skills（SKILL.md 三作用域） | codex skills + 迁移器 | repo-conventions 自动触发 |
| 插件（skills/commands/mcp 三贡献） | codex plugin + 迁移器 | demo-plugin 三贡献可见 |
| 市场（索引+zip+sha256+localPath） | codex marketplace + 索引兼容层 | 安装 commit-helper |
| 自定义命令（$ARGUMENTS） | codex prompts + 迁移器 | /translate 展开 |
| Hooks（三级+5 事件+deny） | codex plugin hooks + 兼容层 | shield.sh deny 场景 |
| 记忆（[[链接]]+MEMORY.md） | oz-memory 侧车（数据兼容） | 写→读→新会话注入 |
| 自动化（cron/every/once+实火） | oz-scheduler 侧车 | 一次性任务无人值守触发 |
| 电脑操作（元素树/窗口/剪贴板/截屏） | openzcode-computer MCP 侧车 | 截屏回传+窗口树降级断言 |
| 浏览器控制（Playwright 8 工具） | openzcode-browser MCP 侧车 | example.com 标题断言 |
| 会话（fork/compact/历史） | codex thread 原生 | fork 独立性+压缩断言 |
| Plan 模式/提问 | codex plan/approvals 原生（缺则侧车） | 写拦截+选项回传 |
| web_search/web_fetch | codex web search 工具（或侧车） | 时效问答断言 |
| ZCode 风格 GUI 全部 | 现 renderer 切 app-server 协议 | 数据源 RPC 矩阵 12 项 |
| 双端点 GLM+Anthropic | oz-providers | 双端点 E2E 各跑通 |

- **内核**：cargo test + 上游套件；`test-e2e.mjs` 改造为 app-server 协议版（断言原样保留）
- **GUI**：renderer 沿用；`test:artifact` 语义平移
- **JS 版 test-ci 60 断言** → 逐项映射进上表；矩阵全绿 = V2 达到替换标准

## 六、明确不做（记录取舍）

- 不改 codex-core 内部（agent 循环/沙箱实现）——只加 crate、不加冲突
- 不引入 codex 的云端(Codex Web)/语音/企业鉴权——与 ZCode 定位无关
- 不使用 "codex/OpenAI" 商标与名称——产品名 OpenZCode，LICENSE/NOTICE 合规保留
- JS 内核冻结为"行为基准 + 降级备份"：不再加功能、不再修非致命 bug；其全部已验收功能 = V2 的需求规格与验收基准
