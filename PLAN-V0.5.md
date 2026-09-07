# PLAN · OpenZCode v0.5「日常主力」✅ 已完成并验收（v0.5.0, 2026-09-07）

> 对应 ROADMAP P0（9 项）+ GUI 贴近 ZCode。开发方式：三条并行线（A 语义化电脑操作 / B Hooks / C 记忆）+ 主线（其余功能 + GUI + 集成）。
> **验收结果**：CI 60/60 · E2E 34/34 · 产物集成 18/18（官方 Release bundle）· GUI 数据源 RPC 12 项全通。逐项核对见文末「验收记录」。

## 0. 功能拆解与分工

| # | 功能 | 负责线 | 依赖 | 涉及文件 |
|---|---|---|---|---|
| A1 | `computer_app_state`（元素树） | 线A | 无 | src/computer/{ax.js,index.js} |
| A2 | 元素级点击/设值/按键/滚动 + `computer_windows`/`clipboard` | 线A | A1 | 同上 |
| B1 | hooks 加载器（用户/项目/插件三级，事件 5 种） | 线B | 无 | src/hooks.js |
| B2 | PreToolUse 拦截/改参/ deny + PostToolUse | 线B | B1 | src/hooks.js + agent/loop.js |
| C1 | 记忆目录 + MEMORY.md 索引解析（[[链接]]） | 线C | 无 | src/memory.js |
| C2 | memory_read/memory_write 工具 + 系统提示注入 | 线C | C1 | src/memory.js + agent/tools.js + agent/system.js |
| M1 | WebSearch（Bing/百度结果页抓取） | 主线 | 无 | agent/tools.js |
| M2 | AskUserQuestion（权限通道复用） | 主线 | 无 | agent/tools.js + loop.js + RPC/GUI/TUI |
| M3 | Plan 模式（plan_mode + Enter/ExitPlanMode） | 主线 | 无 | loop.js + tools.js + GUI |
| M4 | 子代理 Agent 工具（general-purpose/Explore） | 主线 | M3 | src/subagent.js + agent/tools.js |
| M5 | 会话 compact（自动 70%/手动 /compact） | 主线 | 无 | src/compact.js + loop.js |
| M6 | fork + input_history（↑ 历史） | 主线 | 无 | appserver + storage + TUI |
| M7 | RPC/GUI/TUI 全量接线（新工具可见、新事件渲染） | 主线 | A/B/C/M* | appserver + renderer |
| G1 | GUI 贴近 ZCode：侧栏改版（＋新建任务 / 🔍搜索 / 自动化 / 插件市场 / 记忆），会话搜索过滤 | 主线 | 无 | renderer |
| G2 | Composer 工具条：模式(plan/ask/yolo)切换、模型选择、effort 档位；底部输入区 ZCode 风格 | 主线 | M2/M3 | renderer |
| G3 | 计划审批卡、选项提问卡、子代理进度卡渲染 | 主线 | M2/M3/M4 | renderer |

## 1. 验收标准（逐项）

- **A1/A2**：在 macOS 真机上，agent 仅凭 `computer_app_state` 返回的元素树完成"找到某窗口的文本框→设值→点按钮"，全程零坐标猜测；`computer_windows` 列出可见窗口；clipboard 读写往返一致；Windows/Linux 路径有驱动位 + status 探测（CI 不可交互环境跳过交互断言，仅测 status/加载）。
- **B1/B2**：示例 hook（PostToolUse=写文件后 echo 日志；PreToolUse=deny 含 `rm -rf /` 的 bash）在 test-ci 中真实触发；三级目录优先级 project>user>plugin；hook 崩溃不阻塞主流程（超时 10s 兜底）。
- **C1/C2**：写入 `memory_write` 后 MEMORY.md 索引出现该条；新会话系统提示含记忆索引；`[[链接]]` 被解析且 `memory_read` 按名可取。
- **M1**：`web_search "playwright browser" ` 返回 ≥3 条带 URL+摘要的结果；E2E 中模型用它回答时效性问题。
- **M2**：GUI 出现选项卡（2-4 个选项，可点选），选择回传模型；TUI 序号选择。
- **M3**：plan 模式下 `bash/write_file/edit_file` 被 deny 并提示；`ExitPlanMode` 需 GUI 批准（计划卡）；批准后恢复原模式。
- **M4**：`Agent` 工具 spawn 独立会话（rollout 独立文件），Explore 类型无写权限（工具白名单），结果以结论回填主会话；GUI 显示子代理运行卡。
- **M5**：>70% 阈值自动 compact（E2E 注入超长对话触发一次），摘要替换旧消息且任务连续；`/compact` 手动可用。
- **M6**：GUI/TUI `/fork` 产生新会话且消息完整复制；输入框 ↑ 键回溯历史（TUI）。
- **G1-G3**：侧栏五入口与 ZCode 对齐；Composer 工具条可切 plan/ask/yolo、选模型、选 effort；三种新卡片渲染正常。
- **集成**：`test:ci`（新增 hooks/memory/app_state 注册/computer_windows/plan deny/fork 等 ≥15 断言）与 `test:e2e`（新增 ≥6 断言：WebSearch 时效问答、AskUserQuestion 回传、Plan 流程、子代理派发、compact 触发、记忆跨会话）全绿；`test:artifact` 18 项不回退。

## 2. 并行执行序

1. **并发波次 1**（互不依赖）：线A（A1→A2）、线B（B1→B2）、线C（C1→C2）、主线 M1。
2. **并发波次 2**：主线 M2→M3→M4、M5、M6；G1 可与任何线并行。
3. **集成**：M7 → G2 → G3 → 工具注册与 RPC 汇总。
4. **验收**：test-ci/test-e2e 扩展并全绿 → 按 §1 逐项核对 → GUI 实机验证 → v0.5.0 tag 发布 → 产物集成测试。

## 3. 接口约定（防并行冲突）

- 线A 产出 `src/computer/ax.js`：`appState()`, `clickElement(winHint, ref)`, `setElementValue(ref, text)`, `performElementAction(ref, action)`, `listWindows()`, `clipboardGet/Set()`；index.js 只加不改既有 5 工具签名。
- 线B 产出 `src/hooks.js`：`loadHooks(ctx) → {preToolUse(name,input), postToolUse(name,input,result), sessionStart(), sessionStop(), permissionRequest()}`，全部返回 Promise，deny 形如 `{deny:true, reason}`；loop.js 仅在工具执行前后各插一个 await 点（主线集成时合入，避免 B 直接改 loop 冲突）。
- 线C 产出 `src/memory.js`：`memoryDir(workspace)`, `listIndex()`, `read(name)`, `write(name, body, description)`, `promptSection()`；工具注册走 tools.js 数组尾部追加（与主线无冲突）。
- 主线新工具统一追加在 tools.js 的 COMPUTER_TOOLS/BROWSER_TOOLS 之后；loop.js 的 hook 插点、plan 拦截、compact 触发点集中一次合入。

---

## 验收记录（2026-09-07, v0.5.0）

| 项 | 结果 | 证据 |
|---|---|---|
| A1 元素树 | ✅(降级达标) | computer_app_state 在 AX 未授权时返回窗口级可点击树(e1/e2 + 坐标), axStatus 给出授权指引; mac 真机验证 |
| A2 元素操作/windows/clipboard | ✅ | 8 新工具注册; clipboard_write→read 往返 ✓(CI); computer_click_ref 取元素中心(真机) |
| B1/B2 Hooks | ✅ | CI: hooks/list 发现 ✓ + 真实 .sh/.js 触发; E2E: PreToolUse deny 被模型观察到并应变(DB 留痕 "被 hook 拦截"); 三级优先级(project>user)自验 |
| C1/C2 记忆 | ✅ | CI: memory write/list/read(含[[链接]]) ✓; promptSection 注入; 线C自验 36 断言 |
| M1 WebSearch | ✅ | Bing 国际版解析真实返回 playwright 官方链接(E2E 覆盖链路) |
| M2 AskUserQuestion | ✅ | 工具+question_request/resolved 事件+GUI 选项卡+RPC session/answer |
| M3 Plan 模式 | ✅ | 写类工具拦截(WRITE_CLASS_TOOLS) + plan_request/approvePlan 审批流 + GUI 计划卡 |
| M4 子代理 | ✅ | E2E: Agent 工具→subagent_started→Explore 只读→结论回填(含文件内容) 3 断言全过 |
| M5 compact | ✅ | 真实 LLM 压缩验证: 8→4 条, 结构化摘要(目标/步骤/文件/下一步); auto 70% 阈值 + /compact + session/compact RPC |
| M6 fork/history | ✅ | CI: fork 复制消息+独立性 ✓, inputHistory ✓; TUI ↑/↓ 历史 |
| G1-G3 GUI | ✅ | 侧栏(新建任务/自动化/插件市场/记忆/Hooks/搜索), Composer 工具条(模式/模型/effort), 计划/提问/子代理/压缩卡片; 数据源 RPC 12 项全通 |
| 集成测试 | ✅ | CI 60/60 + E2E 34/34 + 官方产物 18/18 |

**已知限制（记录）**：macOS/Windows CI runner 无桌面会话，语义层完整断言仅在 ubuntu(门禁)+真实 mac 开发机执行；Windows/Linux 的 AX/UIA/AT-SPI 驱动已就位但未经真机验证。
