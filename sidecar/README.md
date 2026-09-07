# OpenZCode Sidecar 服务（M2）

把 ZCode（JS 版）的既有能力桥接进 Rust 内核（codex）的侧车进程集合。

| 服务 | 命令 | 说明 |
|---|---|---|
| 电脑+浏览器 | `node sidecar/computer-browser-mcp.mjs` | MCP server（stdio）：19 个工具 = JS 版 computer 11 + browser 8，行为逐一对齐 |
| 记忆 | `node sidecar/memory-mcp.mjs` | MCP server：memory_write/read/index；数据与 JS 版**同一目录格式**（~/.openzcode/memories/<workspaceKey>/），零迁移 |
| 调度器 | `node sidecar/scheduler.mjs`（serve 常驻 / create / list / tick） | cron/every/once + maxRuns + completed 状态机；无人值守 turn 经内核 `exec` 模式执行 |

## 内核侧挂载（config.toml 示例）

```toml
[mcp_servers.oz-computer]
command = "node"
args = ["/path/to/openzcode/sidecar/computer-browser-mcp.mjs"]

[mcp_servers.oz-memory]
command = "node"
args = ["/path/to/openzcode/sidecar/memory-mcp.mjs"]
```

环境变量：`OPENZCODE_WORKSPACE`（记忆/执行工作区）、`OPENZCODE_CONFIG_DIR`、`OPENZCODE_KERNEL`（内核二进制路径，默认 kernel/codex-rs/target/release/codex-tui）、`OPENZCODE_AUTOMATION_TICK_MS`。

## 已验证
- computer-browser: initialize/tools/list(19)/computer_windows/computer_app_state（真机返回窗口树）
- memory: 同一数据目录读写（JS 版兼容）
- scheduler: create→tick→内核执行→completed 状态（fake kernel 实火）
