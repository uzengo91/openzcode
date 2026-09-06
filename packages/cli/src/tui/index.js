// Interactive terminal UI: readline REPL over the same agent core.
"use strict";

const readline = require("node:readline");
const os = require("node:os");
const path = require("node:path");
const configStore = require("../config");
const { getStorage } = require("../storage");
const { dirs } = require("../paths");
const { runAgentTurn } = require("../agent/loop");
const { testProvider } = require("../llm/client");
const { SkillRegistry } = require("../skills");
const pluginRegistry = require("../plugins");
const commands = require("../commands");
const { McpManager } = require("../mcp/manager");
const automations = require("../automations");
const { VERSION, APP_NAME } = require("../version");

const DIM = "\x1b[2m", RESET = "\x1b[0m", GREEN = "\x1b[32m", RED = "\x1b[31m", CYAN = "\x1b[36m", YELLOW = "\x1b[33m";

function fmtToolInput(name, input) {
  const s = typeof input === "object" && input ? Object.entries(input).map(([k, v]) => `${k}=${JSON.stringify(v).slice(0, 80)}`).join(" ") : String(input ?? "");
  return `${name} ${s.slice(0, 120)}`;
}

async function runTui() {
  process.title = "openzcode-cli";
  const storage = getStorage();
  const workspace = dirs().workspace;
  let config = configStore.load();
  let session = storage.createSession({ workspace });
  let activeProvider = configStore.getDefaultProvider();

  // extensions: plugins → skills / commands / mcp
  let currentPlugins = pluginRegistry.discover({ workspace });
  const skills = new SkillRegistry({ workspace, plugins: currentPlugins });
  const mcp = new McpManager({ workspace, plugins: currentPlugins, emit: (e) => { if (e.type === "log") console.error(`${DIM}[mcp] ${e.message}${RESET}`); } });
  let mcpLoaded = false;
  function rediscoverExtensions() {
    currentPlugins = pluginRegistry.discover({ workspace });
    skills.setContext({ workspace, plugins: currentPlugins });
    mcp.setContext({ workspace, plugins: currentPlugins });
  }
  async function ensureMcp() {
    if (!mcpLoaded) { rediscoverExtensions(); await mcp.load().catch(() => {}); mcpLoaded = true; }
  }

  // automations: agent Cron* tools + unattended scheduler (quiet output)
  let tuiAutoRef = { v: null };
  const tuiAuto = automations.createService({
    storage,
    workspace,
    launchTurn: async (sid, text, { yolo } = {}) => {
      const s = storage.getSession(sid);
      if (!s) throw new Error("会话不存在");
      let cfg = configStore.load();
      if (yolo) cfg = { ...cfg, permissionMode: "yolo" };
      await ensureMcp();
      return runAgentTurn({
        session: s, userText: text, provider: configStore.getDefaultProvider(), config: cfg, storage,
        emit: (event) => {
          if (event.type === "tool_start") console.log(`${DIM}⏰ [${s.title}] ⚙ ${fmtToolInput(event.name, event.input)}${RESET}`);
          else if (event.type === "turn_done") console.log(`${DIM}⏰ [${s.title}] ${event.ok ? "完成" : "失败: " + (event.error || "")}${RESET}`);
        },
        permissionHandler: null,
        signal: undefined,
        extensions: { mcpManager: mcp, skills, automations: tuiAutoRef.v },
      });
    },
    emit: (e) => {
      if (e.type === "automation_started") console.log(`${DIM}⏰ 自动化触发: ${e.name} (会话 ${e.sessionId.slice(0, 13)}…)${RESET}`);
      else if (e.type === "automation_finished") console.log(`${DIM}⏰ 自动化${e.ok ? "完成" : "失败"}: ${e.name}${RESET}`);
    },
  });
  tuiAutoRef.v = tuiAuto;
  const AUTO_TICK = Math.max(1000, Number(process.env.OPENZCODE_AUTOMATION_TICK_MS) || 30000);
  const autoTimer = setInterval(() => tuiAuto.tickNow().catch(() => {}), AUTO_TICK);
  if (autoTimer.unref) autoTimer.unref();

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let running = false;
  let stopFn = null;

  function banner() {
    console.log(`${CYAN}${APP_NAME} v${VERSION}${RESET}  CLI 终端模式`);
    console.log(`${DIM}工作目录: ${workspace}`);
    console.log(`模型: ${activeProvider ? `${activeProvider.name} (${activeProvider.model} @ ${activeProvider.baseUrl})` : "(未配置 — 用 /provider 或 openzcode provider add 配置)"}`);
    console.log(`权限模式: ${config.permissionMode === "yolo" ? "yolo(自动放行)" : "ask(危险操作需确认)"}   输入 /help 查看命令${RESET}`);
    console.log("");
  }

  function prompt() {
    if (running || rl.closed) return;
    try {
      rl.question(`${GREEN}›${RESET} `, (line) => handleInput(line).catch((e) => console.error(RED + (e.message || e) + RESET)).finally(() => prompt()));
    } catch {
      // readline already closed (stdin EOF) — exit quietly
      process.exit(0);
    }
  }

  async function handleInput(raw) {
    const text = raw.trim();
    if (!text) return;

    if (text.startsWith("/")) {
      const r = await handleSlash(text);
      if (r && r.sendText) await runTurn(r.sendText); // custom command expansion
      return;
    }
    await runTurn(text);
  }

  async function runTurn(text) {
    if (!activeProvider) {
      console.log(RED + "尚未配置模型 provider。先运行: openzcode provider add --name free --base-url https://host/v1 --api-key KEY --model MODEL" + RESET);
      return;
    }

    running = true;
    const abortCtrl = new AbortController();
    stopFn = () => { try { abortCtrl.abort(new Error("用户停止")); } catch {} };

    const emit = (event) => {
      switch (event.type) {
        case "text_delta": process.stdout.write(event.text); break;
        case "message":
          if (event.message.role === "assistant") process.stdout.write("\n");
          break;
        case "tool_start": process.stdout.write(`${DIM}⚙ ${fmtToolInput(event.name, event.input)}${RESET}\n`); break;
        case "tool_end": {
          const mark = event.ok ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
          process.stdout.write(`  ${mark} ${event.ms}ms ${event.ok ? "" : String(event.output).slice(0, 200)}\n`);
          break;
        }
        case "skill_loaded": process.stdout.write(`${DIM}◆ 已加载技能 ${event.name}${RESET}\n`); break;
        case "permission_request": break; // handled via permissionHandler
        case "usage": process.stdout.write(`${DIM}(tokens: ${event.promptTokens} in / ${event.completionTokens} out, ${event.durationMs}ms)${RESET}\n`); break;
        case "turn_done":
          if (!event.ok && !event.aborted) console.error(`${RED}出错: ${event.error}${RESET}`);
          break;
        default: break;
      }
    };

    const permissionHandler = ({ tool }) =>
      new Promise((resolve) => {
        rl.question(`${YELLOW}允许执行 ${tool}? [y]允许 / [a]本次会话总是允许 / [n]拒绝 ${RESET}`, (ans) => {
          const a = String(ans).trim().toLowerCase();
          resolve({ allow: a === "y" || a === "yes" || a === "a", always: a === "a" });
        });
      });

    try {
      await ensureMcp();
      await runAgentTurn({
        session,
        userText: text,
        provider: activeProvider,
        config,
        storage,
        emit,
        permissionHandler,
        signal: abortCtrl.signal,
        extensions: { mcpManager: mcp, skills, automations: tuiAuto },
      });
    } finally {
      running = false;
      stopFn = null;
      config = configStore.load();
      session = storage.getSession(session.id) || session;
      console.log("");
      if (rl.closed) process.exit(0); // stdin EOF while turn was running
    }
  }

  async function handleSlash(text) {
    const [cmd, ...rest] = text.slice(1).split(/\s+/);
    const arg = rest.join(" ").trim();
    switch (cmd) {
      case "help":
        console.log(`命令:
  /new              新建会话
  /sessions [n]     列出最近会话 (默认 10)
  /resume <序号>    切换到列出的某个会话
  /provider [名称]  查看/切换模型 provider
  /providers        列出全部 provider
  /yolo | /ask      切换权限模式 (yolo=自动放行危险操作)
  /todos            查看当前会话任务清单
  /test             测试当前 provider 连接
  /skills           列出可用技能 (skill 工具自动触发)
  /skill <名称>     查看技能内容
  /mcp              列出 MCP 服务器与工具
  /plugins          列出已安装插件
  /commands         列出自定义 slash 命令
  /reload           重载插件/技能/MCP 配置
  /automations      自动化任务列表 (run|del|on|off <id>)
  /quit             退出`);
        break;
      case "new":
        session = storage.createSession({ workspace });
        console.log(`${DIM}已新建会话 ${session.id}${RESET}`);
        break;
      case "sessions": {
        const list = storage.listSessions({ workspace });
        const n = Number(arg) || 10;
        list.slice(0, n).forEach((s, i) => {
          const mark = s.id === session.id ? "→" : " ";
          console.log(`${mark} [${i + 1}] ${s.id.slice(0, 13)}…  ${s.title}  ${DIM}${(s.updated_at || "").slice(0, 16)}${RESET}`);
        });
        break;
      }
      case "resume": {
        const idx = Number(arg);
        const list = storage.listSessions({ workspace });
        if (!idx || !list[idx - 1]) { console.log("用法: /resume <sessions 列表中的序号>"); break; }
        session = list[idx - 1];
        console.log(`${DIM}已切换到会话: ${session.title}${RESET}`);
        break;
      }
      case "providers": {
        const ps = configStore.getProviders();
        if (!ps.length) console.log("(无 provider)");
        ps.forEach((p) => console.log(`${p.id === configStore.load().defaultProviderId ? "→" : " "} ${p.name}  ${p.model} @ ${p.baseUrl} [${p.protocol}]`));
        break;
      }
      case "provider": {
        if (!arg) {
          console.log(activeProvider ? `当前: ${activeProvider.name} (${activeProvider.model})` : "未设置。用 /provider <名称> 切换");
          break;
        }
        const p = configStore.getProvider(arg);
        if (!p) { console.log(`未找到 provider: ${arg}`); break; }
        configStore.setDefaultProvider(p.id);
        activeProvider = p;
        console.log(`已切换默认 provider: ${p.name} (${p.model})`);
        break;
      }
      case "yolo": case "ask": {
        configStore.setOptions({ permissionMode: cmd });
        config = configStore.load();
        console.log(`权限模式: ${cmd}`);
        break;
      }
      case "todos": {
        const items = storage.getTodos(session.id);
        if (!items.length) { console.log("(空)"); break; }
        for (const t of items) console.log(`[${t.status === "completed" ? "x" : t.status === "in_progress" ? ">" : " "}] ${t.content}`);
        break;
      }
      case "test": {
        if (!activeProvider) { console.log("未配置 provider"); break; }
        console.log(`${DIM}测试连接 ${activeProvider.baseUrl} …${RESET}`);
        try {
          const r = await testProvider(activeProvider);
          console.log(`${GREEN}✓ 连接成功${RESET}${r.models?.length ? `，可用模型: ${r.models.slice(0, 10).join(", ")}${r.models.length > 10 ? " …" : ""}` : ""}`);
        } catch (e) {
          console.log(`${RED}✗ 失败: ${e.message}${RESET}`);
        }
        break;
      }
      case "skills": {
        rediscoverExtensions();
        const list = skills.list();
        if (!list.length) { console.log("(无技能 — ~/.openzcode/skills/<name>/SKILL.md 或项目 .openzcode/skills/)"); break; }
        for (const s of list) console.log(`→ ${s.name.padEnd(20)} [${s.scope}] ${s.description}`);
        break;
      }
      case "skill": {
        const s = skills.get(arg);
        if (!s) { console.log(`未找到技能: ${arg} (/skills 查看列表)`); break; }
        console.log(`${DIM}#${s.name} (${s.scope}) — ${s.description}${RESET}\n${s.body.slice(0, 2000)}`);
        break;
      }
      case "mcp": {
        rediscoverExtensions();
        const l = await mcp.load();
        if (!l.length) { console.log("(无 MCP server — ~/.openzcode/mcp.json 或项目 .mcp.json)"); break; }
        for (const s of l) console.log(`${s.enabled ? "→" : " "} ${s.name.padEnd(16)} [${s.type}] ${s.status} tools=${s.toolCount} (${s.source})${s.error ? " ⚠ " + s.error : ""}`);
        break;
      }
      case "plugins": {
        rediscoverExtensions();
        if (!currentPlugins.length) { console.log("(无插件 — ~/.openzcode/plugins/<name>/)"); break; }
        for (const p of currentPlugins) {
          const c = [p.skillsDir && "skills", p.commandsDir && "commands", p.mcpPath && "mcp"].filter(Boolean).join("+") || "—";
          console.log(`→ ${p.name.padEnd(18)} v${p.version} [${p.scope}] ${c}`);
        }
        break;
      }
      case "commands": {
        rediscoverExtensions();
        const l = commands.list({ workspace, plugins: currentPlugins });
        if (!l.length) { console.log("(无自定义命令 — ~/.openzcode/commands/<name>.md)"); break; }
        for (const c of l) console.log(`/${c.name.padEnd(16)} [${c.scope}] ${c.description}`);
        break;
      }
      case "reload": {
        rediscoverExtensions();
        await mcp.reload().catch(() => {});
        const l = mcp.list();
        console.log(`已重载: 插件 ${currentPlugins.length} 个, MCP server ${l.length} 个, 技能 ${skills.list().length} 个`);
        break;
      }
      case "automations": case "auto": {
        const sub = (rest[0] || "").toLowerCase();
        const target = rest[1];
        if (sub === "run" && target) {
          try { await tuiAuto.runNow(target); console.log(`${GREEN}✓ 已触发运行${RESET}`); }
          catch (e) { console.log(`${RED}✗ ${e.message}${RESET}`); }
          break;
        }
        if (sub === "del" && target) { try { tuiAuto.remove(target); console.log("✓ 已删除"); } catch (e) { console.log(`✗ ${e.message}`); } break; }
        if ((sub === "on" || sub === "off") && target) {
          try { const a = tuiAuto.toggle(target); console.log(`✓ ${a.enabled ? "已启用" : "已禁用"}: ${a.name}`); } catch (e) { console.log(`✗ ${e.message}`); }
          break;
        }
        const list = tuiAuto.list();
        if (!list.length) { console.log("(暂无自动化 — 让模型用 CronCreate 创建, 或 openzcode automation create)"); break; }
        for (const a of list) console.log(`${a.enabled ? "→" : " "} [${a.id}] ${a.name} — ${automations.describeSchedule(a)} · ${a.status} · 已运行 ${a.runCount} 次${a.nextRunAt ? ` · 下次 ${a.nextRunAt.slice(0, 16).replace("T", " ")}` : ""}`);
        console.log(`${DIM}  (/automations run|del|on|off <id>)${RESET}`);
        break;
      }
      case "quit": case "exit": case "q":
        rl.close();
        process.exit(0);
        break;
      default: {
        // custom slash command (plugins / user / project) → expand & send
        const expanded = commands.expand(text, { workspace, plugins: currentPlugins });
        if (expanded) {
          console.log(`${DIM}(命令 /${expanded.name} → 已展开${expanded.description ? ": " + expanded.description : ""})${RESET}`);
          return { sendText: expanded.prompt };
        }
        console.log(`未知命令 /${cmd}，/help 查看帮助`);
      }
    }
  }

  banner();
  prompt();

  rl.on("close", () => { if (!running) process.exit(0); });
  rl.on("SIGINT", () => {
    if (running && stopFn) { stopFn(); console.log(`${DIM}(停止当前任务… 再按一次 Ctrl-C 退出)${RESET}`); return; }
    rl.close();
    process.exit(0);
  });
}

/* ---------------- one-shot print mode ---------------- */

async function runPrint(userText, { yolo, workspace }) {
  const storage = getStorage();
  const ws = workspace ? path.resolve(workspace) : dirs().workspace;
  const config = configStore.load();
  if (yolo) config.permissionMode = "yolo";
  const provider = configStore.getDefaultProvider();
  if (!provider) {
    console.error("未配置模型 provider。先运行: openzcode provider add ...");
    process.exit(2);
  }
  const session = storage.createSession({ workspace: ws, title: (userText || "print").slice(0, 30) });

  // extensions (skills + mcp) work in print mode too
  const plugins = pluginRegistry.discover({ workspace: ws });
  const skills = new SkillRegistry({ workspace: ws, plugins });
  const mcp = new McpManager({ workspace: ws, plugins, emit: () => {} });

  const emit = (event) => {
    switch (event.type) {
      case "tool_start": console.error(`${DIM}⚙ ${fmtToolInput(event.name, event.input)}${RESET}`); break;
      case "tool_end": console.error(`  ${event.ok ? "✓" : "✗"} ${event.ms}ms`); break;
      case "permission_request": console.error(`${YELLOW}(yolo 未开启时此操作将被拒绝: ${event.tool})${RESET}`); break;
      default: break;
    }
  };

  const result = await runAgentTurn({
    session,
    userText,
    provider,
    config,
    storage,
    emit,
    permissionHandler: null, // no interactive approval; dangerous ops denied in ask mode unless yolo
    signal: undefined,
    extensions: { mcpManager: mcp, skills },
  });
  mcp.close();

  // print final assistant text
  const msgs = storage.getMessages(session.id);
  const finalText = [];
  for (const m of msgs) {
    if (m.role !== "assistant") continue;
    for (const p of m.parts || []) if (p.type === "text" && p.text.trim()) finalText.push(p.text);
  }
  console.log(finalText.join("\n\n").trim());
  process.exit(result.ok ? 0 : 1);
}

module.exports = { runTui, runPrint };
