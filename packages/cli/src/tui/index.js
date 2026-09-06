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
      await handleSlash(text);
      return;
    }

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
      await runAgentTurn({
        session,
        userText: text,
        provider: activeProvider,
        config,
        storage,
        emit,
        permissionHandler,
        signal: abortCtrl.signal,
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
      case "quit": case "exit": case "q":
        rl.close();
        process.exit(0);
        break;
      default:
        console.log(`未知命令 /${cmd}，/help 查看帮助`);
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
  });

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
