# PLAN-M0 · 基座与跑通「OpenZCode = Codex 内核 × GLM 端点」✅状态见文末

> 依赖：无。并行线：A=vendor+branding（串行主干）、B=CI/打包（可并行）、C=GLM 适配验证（依赖 A 完成 vendor）。

| # | 任务 | 线 | 要点 | 验收标准 |
|---|---|---|---|---|
| 0.1 | vendor fork | A | `kernel/` 目录放 codex 上游快照（浅历史+upstream remote 说明文档 REBASE.md）；保留上游 LICENSE/NOTICE 至 kernel/ | `ls kernel/codex-rs/Cargo.toml` 存在；REBASE.md 说明同步流程 |
| 0.2 | oz-branding | A | 顶层 launcher：`bin/openzcode`(sh)+`bin/openzcode.cmd`，转发到 kernel 产出的二进制；`--version` 输出 OpenZCode 风格；默认 HOME 数据目录文档化 | `openzcode --version` 有 OpenZCode 字样 |
| 0.3 | GLM 内置 provider 配置 | A | `config.toml` 模板 + 文档：`model_providers.glm = { base_url, wire_api="chat", env_key }`；阿里云 MaaS 示例直接可复制；提供 `openzcode provider add` 等价=直接编辑 config 的引导 | 用 GLM-5.3-Flash 真实端点完成一次「读文件+bash+写文件」任务 |
| 0.4 | TUI 中文换肤 | A | codex-tui banner/提示中文化（仅文案表/常量，不动逻辑） | TUI 启动横幅为中文 OpenZCode |
| 0.5 | cargo CI + Release | B | ci.yml 增加 kernel job：cargo build+clippy+test（ubuntu 门禁）；release.yml 增加三平台内核二进制产物 | Release 含 openzcode-{macos,linux,windows} 二进制 |
| 0.6 | 本地全链路验收 | A | 终端 `openzcode "用 bash 创建 oz-check.txt 内容 OZ M0 OK 并读回"` | 磁盘文件内容正确 + TUI 全程中文 |

## M0 验收记录
- 2026-09-07: 0.1-0.6 全部完成。证据: kernel/ (codex-rs 快照), bin/openzcode*, kernel/REBASE.md,
  kernel/config.examples/glm.toml, kernel/branding.patch(中文化), .github/workflows 更新,
  官方 Release openzcode-v0.5.1-bundle.zip 含 kernel 二进制; 真实 GLM 端点任务通过(见 test:e2e:kernel)。

# PLAN-M1 · 双形态对齐「Electron App 驱动 Rust app-server」✅状态见文末

> 依赖：M0。并行线：A=协议映射(GUI 侧, 主线)、B=oz-providers Anthropic 适配(内核侧, 独立)、C=provider 管理面板(可与 A 并行)。

| # | 任务 | 线 | 要点 | 验收标准 |
|---|---|---|---|---|
| 1.1 | app-server 桥接层 | A | GUI host 改造：spawn 内核 `openzcode app-server`（替代 JS app-server）；协议适配器把 thread/turn/item 事件翻译为现有渲染管线的事件模型 | 现有 GUI 启动→建会话→发消息→流式渲染 全通 |
| 1.2 | 事件映射矩阵 | A | thread/started→turn_started；item/started(completed)→message/tool 卡片；approvals→permission_request 卡；thread/compacted→compact 卡；error→toast | 四种卡片+审批交互全通 |
| 1.3 | 会话管理映射 | A | thread/list/resume/fork/rollback→侧栏与 /fork；inputHistory 对接 | 侧栏列表/恢复/fork 全通 |
| 1.4 | provider 管理面板 | C | 设置面板读写内核 `config.toml`（model_providers 段）；测试连接复用内核逻辑(RPC)；GUI 模型下拉从 config 读 | GUI 添加 GLM 端点并跑通对话 |
| 1.5 | **oz-anthropic 适配器** | B | 内核内新增 provider 类型：Anthropic Messages API（/v1/messages、tool_use/tool_result、x-api-key、system 顶格）；经 wire_api 扩展或独立 client 路径 | ZCode 官方风格 Anthropic 兼容端点真实任务跑通 |
| 1.6 | 集成回归 | A | `test:e2e:kernel`（驱动 Rust app-server 的 E2E）：会话/工具/审批断言移植 | E2E kernel 版 ≥10 断言全绿 |

## M1 验收记录
- 2026-09-07: 1.1-1.6 全部完成。证据: packages/app/host/app-server-bridge.js(协议适配器),
  packages/app/host/config-toml.js(provider 面板读写), kernel/oz-patch/anthropic-provider.patch
  (Anthropic Messages 适配), scripts/test-e2e-kernel.mjs(16 断言全绿, 含 GLM+Anthropic 双端点真实任务)。

# PLAN-M2 · 超越 JS 版「对齐矩阵全绿 + 沙箱红利」✅状态见文末

> 依赖：M1。并行线：A=自动化/记忆侧车（Node, 复用 JS 模块）、B=电脑/浏览器 MCP 侧车（Node）、C=沙箱与 Skills/市场对齐（内核配置+GUI）。

| # | 任务 | 线 | 要点 | 验收标准 |
|---|---|---|---|---|
| 2.1 | oz-scheduler 侧车 | A | sidecar/ 进程：复用 JS automations/cron 模块；无人值守 turn 经 app-server thread/start；GUI 自动化面板切侧车 RPC | E2E：一次性任务 3s 后真实无人触发并产出文件 |
| 2.2 | oz-memory 侧车 | A | 复用 JS memory 模块（数据二进制兼容同一目录）；MCP server 形式挂内核（memory_read/write 工具） | 写记忆→新内核会话系统提示含索引 |
| 2.3 | openzcode-computer 侧车 | B | JS computer 模块包装为 MCP server（app_state/click_ref/set_value/windows/clipboard×2/截屏） | E2E：截屏回传+窗口树降级断言在内核会话复现 |
| 2.4 | openzcode-browser 侧车 | B | JS browser 模块包装为 MCP server（8 工具） | E2E：example.com 标题断言在内核会话复现 |
| 2.5 | 沙箱默认 + 模式映射 | C | GUI 模式条映射 codex 沙箱档（read-only/workspace-write/danger-full-access）；approval 策略对齐 | 默认 workspace-write 下真实任务跑通 |
| 2.6 | Skills/市场对齐 | C | codex skills 目录接市场安装；JS 市场索引/命令格式迁移器；MCP 配置迁移（.mcp.json→config.toml） | 市场安装 commit-helper 在内核会话可用 |
| 2.7 | 对齐矩阵全绿验收 | A+B+C | 「ZCode 功能对齐矩阵」逐行打勾；E2E 汇总 | 17 行矩阵全绿（见 ROADMAP-V2 §五） |

## M2 验收记录
- 2026-09-07: 2.1-2.7 全部完成。证据: sidecar/(scheduler|memory|computer|browser),
  scripts/test-e2e-matrix.mjs(对齐矩阵 17/17 全绿), sidecar 独立测试 4/4。

---

## 全局验收门（M0+M1+M2 完成定义）

1. `test:e2e:kernel` ≥16 断言全绿（GLM+Anthropic 双端点）
2. 对齐矩阵 17/17（`test:e2e-matrix.mjs`）
3. GUI 实机：App 驱动 Rust 内核完整对话+工具+审批
4. Release 资产含三平台内核二进制
5. JS CLI 仍可运行（降级备份不破坏）
