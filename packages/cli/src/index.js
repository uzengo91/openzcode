// OpenZCode CLI entry — one bundle, multiple forms:
//   openzcode                       interactive TUI
//   openzcode -p "task" [--yolo]    one-shot print mode
//   openzcode app-server --stdio    JSON-RPC server driven by the desktop App
//   openzcode provider add|list|use|remove|test
//   openzcode config get|set
//   openzcode --version
"use strict";

const configStore = require("./config");
const { testProvider } = require("./llm/client");
const { ensureDirs, dirs } = require("./paths");
const { runTui, runPrint } = require("./tui");
const { runAppServer } = require("./appserver/server");
const { SkillRegistry } = require("./skills");
const pluginRegistry = require("./plugins");
const commands = require("./commands");
const { McpManager } = require("./mcp/manager");
const automations = require("./automations");
const marketplace = require("./marketplace");
const { runAgentTurn } = require("./agent/loop");
const { VERSION, APP_NAME } = require("./version");

function usage() {
  console.log(`${APP_NAME} v${VERSION} — 单二进制双形态编码 Agent (CLI + Electron App)

用法:
  openzcode                       交互式终端模式
  openzcode -p "<任务>" [--yolo]  单次执行并打印结果
  openzcode app-server --stdio    以 JSON-RPC(stdio) 服务模式运行(供桌面 App 驱动)
  openzcode --version             版本

模型服务配置 (provider):
  openzcode provider add --name free --base-url https://host/v1 \\
        --api-key KEY --model MODEL [--protocol openai|anthropic] [--set-default]
  openzcode provider list
  openzcode provider use <name|id>
  openzcode provider remove <name|id>
  openzcode provider test [name|id]

其他配置:
  openzcode config get
  openzcode config set permissionMode=ask|yolo maxIterations=40

环境变量:
  OPENZCODE_CONFIG_DIR   数据目录 (默认 ~/.openzcode)
  OPENZCODE_WORKSPACE    工作目录 (默认 ~/.openzcode/workspace/default)`);
}

function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) flags[key] = true;
      else { flags[key] = next; i++; }
    }
  }
  return flags;
}

async function cmdProvider(args) {
  const sub = args[0];
  const flags = parseFlags(args.slice(1));
  try {
    switch (sub) {
      case "add": {
        if (!flags["base-url"] || !flags.model) {
          console.error("用法: openzcode provider add --name NAME --base-url URL --api-key KEY --model MODEL [--protocol openai|anthropic] [--set-default]");
          process.exit(2);
        }
        configStore.addProvider({
          name: flags.name, baseUrl: flags["base-url"], apiKey: flags["api-key"] || "",
          model: flags.model, protocol: flags.protocol || "openai", setDefault: !!flags["set-default"],
        });
        const cfg = configStore.load();
        const p = cfg.providers.find((x) => x.name === flags.name);
        console.log(`✓ 已保存 provider: ${p.name} (${p.model} @ ${p.baseUrl})${cfg.defaultProviderId === p.id ? " [默认]" : ""}`);
        break;
      }
      case "list": {
        const cfg = configStore.load();
        if (!cfg.providers.length) { console.log("(无 provider，用 provider add 添加)"); break; }
        for (const p of cfg.providers) {
          console.log(`${p.id === cfg.defaultProviderId ? "→" : " "} ${p.name.padEnd(16)} ${p.model.padEnd(24)} ${p.baseUrl} [${p.protocol}] key=${configStore.maskApiKey(p.apiKey)}`);
        }
        break;
      }
      case "use": {
        if (!args[1]) { console.error("用法: openzcode provider use <name|id>"); process.exit(2); }
        configStore.setDefaultProvider(args[1]);
        const p = configStore.getDefaultProvider();
        console.log(`✓ 默认 provider: ${p.name} (${p.model})`);
        break;
      }
      case "remove": {
        if (!args[1]) { console.error("用法: openzcode provider remove <name|id>"); process.exit(2); }
        configStore.removeProvider(args[1]);
        console.log(`✓ 已移除: ${args[1]}`);
        break;
      }
      case "test": {
        const p = args[1] ? configStore.getProvider(args[1]) : configStore.getDefaultProvider();
        if (!p) { console.error("未找到 provider"); process.exit(2); }
        console.log(`测试 ${p.name} (${p.model} @ ${p.baseUrl}) …`);
        const r = await testProvider(p);
        console.log(`✓ 连接成功${r.models?.length ? `: ${r.models.slice(0, 10).join(", ")}${r.models.length > 10 ? ` …共${r.models.length}个` : ""}` : ""}`);
        break;
      }
      default:
        usage();
        process.exit(sub ? 2 : 0);
    }
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }
}

function cmdConfig(args) {
  const sub = args[0];
  if (sub === "get") {
    const cfg = configStore.publicConfig();
    console.log(JSON.stringify(cfg, null, 2));
    return;
  }
  if (sub === "set") {
    const opts = {};
    for (const kv of args.slice(1)) {
      const [k, v] = kv.split("=");
      if (!k || v === undefined) { console.error(`无效参数: ${kv} (应为 key=value)`); process.exit(2); }
      if (k === "maxIterations") opts.maxIterations = Number(v);
      else opts[k] = v;
    }
    configStore.setOptions(opts);
    console.log("✓ 已保存");
    return;
  }
  usage();
  process.exit(sub ? 2 : 0);
}

/* ---------------- extension subcommands (mcp/skill/plugin/command) ---------------- */

function makeExtensions() {
  const workspace = dirs().workspace;
  const plugins = pluginRegistry.discover({ workspace });
  const skills = new SkillRegistry({ workspace, plugins });
  const mcp = new McpManager({ workspace, plugins, emit: (e) => { if (e.type === "log") console.error(`[mcp] ${e.message}`); } });
  return { workspace, plugins, skills, mcp };
}

async function cmdMcp(args) {
  const sub = args[0] || "list";
  const ext = makeExtensions();
  try {
    if (sub === "list") {
      const list = await ext.mcp.load();
      if (!list.length) { console.log("(无 MCP server — 在 ~/.openzcode/mcp.json 或项目 .mcp.json 配置)"); return; }
      for (const s of list) {
        console.log(`${s.enabled ? "→" : " "} ${s.name.padEnd(16)} [${s.type}] ${s.status.padEnd(8)} tools=${s.toolCount}  (${s.source}) ${s.error ? "⚠ " + s.error : ""}`);
      }
    } else if (sub === "tools") {
      await ext.mcp.load();
      const defs = await ext.mcp.toolDefinitions();
      if (!defs.length) { console.log("(无可用 MCP 工具)"); return; }
      for (const d of defs) console.log(`${d.name}  —  ${String(d.description).slice(0, 100)}`);
    } else if (sub === "call") {
      // openzcode mcp call <server> <tool> [json-args]
      const [, server, tool, jsonArgs] = args;
      if (!server || !tool) { console.error("用法: openzcode mcp call <server> <tool> '{\"a\":1}'"); process.exit(2); }
      await ext.mcp.load();
      const r = await ext.mcp.callDirect(server, tool, jsonArgs ? JSON.parse(jsonArgs) : {});
      console.log(r.ok ? r.output : `✗ ${r.output}`);
      if (!r.ok) process.exit(1);
    } else {
      console.error("用法: openzcode mcp list|tools|call <server> <tool> [args]");
      process.exit(sub ? 2 : 0);
    }
  } catch (e) { console.error(`✗ ${e.message}`); process.exit(1); } finally { ext.mcp.close(); }
}

function cmdSkill(args) {
  const ext = makeExtensions();
  const sub = args[0] || "list";
  if (sub === "list") {
    const list = ext.skills.list();
    if (!list.length) { console.log("(无技能 — 在 ~/.openzcode/skills/<name>/SKILL.md 或项目 .openzcode/skills/ 创建)"); return; }
    for (const s of list) console.log(`→ ${s.name.padEnd(20)} [${s.scope}] ${s.description}`);
  } else if (sub === "show") {
    const s = ext.skills.get(args[1]);
    if (!s) { console.error(`未找到技能: ${args[1]}`); process.exit(1); }
    console.log(`# ${s.name}  (${s.scope})\n${s.description}\n\n---\n${s.body}`);
  } else { console.error("用法: openzcode skill list|show <name>"); process.exit(sub ? 2 : 0); }
}

function cmdPlugin(args) {
  const ext = makeExtensions();
  const sub = args[0] || "list";
  try {
    if (sub === "list") {
      if (!ext.plugins.length) { console.log("(无插件 — 目录: ~/.openzcode/plugins/<name>/ 或项目 .openzcode/plugins/<name>/)"); return; }
      for (const p of ext.plugins) {
        const c = [p.skillsDir && "skills", p.commandsDir && "commands", p.mcpPath && "mcp"].filter(Boolean).join("+") || "—";
        console.log(`→ ${p.name.padEnd(18)} v${p.version} [${p.scope}] 贡献: ${c}  ${p.description}`);
      }
    } else if (sub === "install") {
      const r = pluginRegistry.install(args[1], { workspace: ext.workspace });
      console.log(`✓ 已安装插件 ${r.name} → ${r.dest}`);
    } else if (sub === "remove") {
      const r = pluginRegistry.remove(args[1], { workspace: ext.workspace });
      console.log(`✓ 已移除 ${r.name} (${r.removed})`);
    } else { console.error("用法: openzcode plugin list|install <path>|remove <name>"); process.exit(sub ? 2 : 0); }
  } catch (e) { console.error(`✗ ${e.message}`); process.exit(1); }
}

function cmdCommand(args) {
  const ext = makeExtensions();
  if ((args[0] || "list") === "list") {
    const list = commands.list({ workspace: ext.workspace, plugins: ext.plugins });
    if (!list.length) { console.log("(无自定义命令 — 在 ~/.openzcode/commands/<name>.md 或插件 commands/ 创建)"); return; }
    for (const c of list) console.log(`/${c.name.padEnd(16)} [${c.scope}] ${c.description}`);
  } else { console.error("用法: openzcode command list"); process.exit(2); }
}

async function cmdAutomation(args) {
  const sub = args[0] || "list";
  const flags = parseFlags(args.slice(1));
  const ws = dirs().workspace;
  // service with a quiet in-process launcher so `automation run` works standalone
  const storage = require("./storage").getStorage();
  const service = automations.createService({
    storage,
    workspace: ws,
    launchTurn: async (sid, text, { yolo } = {}) => {
      const s = storage.getSession(sid);
      let cfg = configStore.load();
      if (yolo) cfg = { ...cfg, permissionMode: "yolo" };
      const plugins = pluginRegistry.discover({ workspace: ws });
      const skills = new SkillRegistry({ workspace: ws, plugins });
      const mcp = new McpManager({ workspace: ws, plugins, emit: () => {} });
      await mcp.load().catch(() => {});
      const r = await runAgentTurn({
        session: s, userText: text, provider: configStore.getDefaultProvider(), config: cfg, storage,
        emit: (e) => {
          if (e.type === "tool_start") console.error(`${DIM}⚙ ${e.name}${RESET}`);
          else if (e.type === "turn_done") console.error(`${e.ok ? GREEN + "✓ 回合完成" : RED + "✗ 回合失败"}${RESET}`);
        },
        permissionHandler: null,
        signal: undefined,
        extensions: { mcpManager: mcp, skills },
      });
      mcp.close();
      return r;
    },
    emit: () => {},
  });
  const DIM = "\x1b[2m", RESET = "\x1b[0m", GREEN = "\x1b[32m", RED = "\x1b[31m";
  const fmt = (a) => `${a.enabled ? "→" : " "} [${a.id}] ${a.name} — ${automations.describeSchedule(a)} · ${a.status} · 已运行 ${a.runCount} 次${a.nextRunAt ? ` · 下次 ${a.nextRunAt.slice(0, 16).replace("T", " ")}` : ""}`;
  try {
    switch (sub) {
      case "list": {
        const list = service.list();
        if (!list.length) { console.log("(暂无自动化 — openzcode automation create 或让模型用 CronCreate)"); return; }
        list.forEach((a) => console.log(fmt(a)));
        break;
      }
      case "create": {
        if (!flags.name || !flags.prompt) {
          console.error('用法: openzcode automation create --name "标题" --prompt "任务" (--cron "0 9 * * 1-5" | --every 20 --unit minute | --delay-minutes 5) [--max-runs N] [--mode yolo|ask]');
          process.exit(2);
        }
        const row = service.create({
          title: flags.name, prompt: flags.prompt,
          schedule: { cron: flags.cron, interval: flags.every ? Number(flags.every) : undefined, intervalUnit: flags.unit, delayMinutes: flags["delay-minutes"] !== undefined ? Number(flags["delay-minutes"]) : undefined },
          recurring: flags.recurring !== undefined ? flags.recurring === "true" : undefined,
          maxRuns: flags["max-runs"] !== undefined ? Number(flags["max-runs"]) : undefined,
          mode: flags.mode,
        });
        console.log(`✓ 已创建: [${row.id}] ${row.name} · 下次 ${row.nextRunAt.slice(0, 16).replace("T", " ")}`);
        break;
      }
      case "delete": service.remove(args[1]); console.log(`✓ 已删除 ${args[1]}`); break;
      case "enable": case "disable": {
        const a = service.get(args[1]);
        if (!a) { console.error(`不存在: ${args[1]}`); process.exit(1); }
        service.update(args[1], { enabled: sub === "enable" });
        console.log(`✓ 已${sub === "enable" ? "启用" : "禁用"}: ${a.name}`);
        break;
      }
      case "runs": {
        const runs = service.runs(args[1]);
        if (!runs.length) { console.log("(无运行记录)"); return; }
        for (const r of runs) console.log(`${r.ok ? "✓" : "✗"} ${r.started_at.slice(0, 19).replace("T", " ")} session=${(r.sessionId || r.session_id || "-").toString().slice(0, 13)} ${r.error ? "⚠ " + r.error : ""}`);
        break;
      }
      case "run": {
        console.log(`${DIM}触发运行 ${args[1]} …${RESET}`);
        await service.runNow(args[1]);
        console.log(`${GREEN}✓ 运行完成${RESET}`);
        break;
      }
      default:
        console.error("用法: openzcode automation list|create|delete|enable|disable|run|runs");
        process.exit(sub ? 2 : 0);
    }
  } catch (e) { console.error(`✗ ${e.message}`); process.exit(1); }
}

async function cmdMarketplace(args) {
  const sub = args[0] || "list";
  try {
    switch (sub) {
      case "list": {
        const all = await marketplace.listMarketplaces();
        for (const m of all) {
          console.log(`\n市场 ${m.name} (${m.source})${m.error ? ` ⚠ ${m.error}` : ""}`);
          for (const p of m.plugins) {
            console.log(`  ${p._installed ? "[已安装]" : "        "} ${p.name.padEnd(20)} v${p.version}  ${p.description}`);
          }
        }
        break;
      }
      case "install": {
        if (!args[1]) { console.error("用法: openzcode marketplace install <name>"); process.exit(2); }
        console.log(`${DIM}安装 ${args[1]} …${RESET}`);
        const all = await marketplace.listMarketplaces();
        let entry = null;
        for (const m of all) { entry = m.plugins.find((x) => x.name === args[1]); if (entry) break; }
        if (!entry) { console.error(`市场中未找到: ${args[1]}`); process.exit(1); }
        const r = await marketplace.installEntry(entry);
        console.log(`✓ 已安装 ${r.name} v${r.version} → ${r.dest}`);
        break;
      }
      case "add": {
        const [name, target] = [args[1], args[2]];
        if (!name || !target) { console.error("用法: openzcode marketplace add <name> <url-or-dir>"); process.exit(2); }
        const s = marketplace.addSource({ name, url: /^https?:/i.test(target) ? target : undefined, path: /^https?:/i.test(target) ? undefined : target });
        console.log(`✓ 已添加市场源: ${s.name} → ${s.url || s.path}`);
        break;
      }
      case "remove": marketplace.removeSource(args[1]); console.log(`✓ 已移除市场源: ${args[1]}`); break;
      default:
        console.error("用法: openzcode marketplace list|install <name>|add <name> <src>|remove <name>");
        process.exit(sub ? 2 : 0);
    }
  } catch (e) { console.error(`✗ ${e.message}`); process.exit(1); }
}

async function main() {
  const argv = process.argv.slice(2);

  if (argv[0] === "--version" || argv[0] === "-v") {
    console.log(`${APP_NAME} ${VERSION}`);
    return;
  }

  if (argv[0] === "app-server") {
    ensureDirs();
    runAppServer();
    return;
  }

  if (argv[0] === "provider") { await cmdProvider(argv.slice(1)); return; }
  if (argv[0] === "config") { cmdConfig(argv.slice(1)); return; }
  if (argv[0] === "mcp") { await cmdMcp(argv.slice(1)); return; }
  if (argv[0] === "skill" || argv[0] === "skills") { cmdSkill(argv.slice(1)); return; }
  if (argv[0] === "plugin" || argv[0] === "plugins") { cmdPlugin(argv.slice(1)); return; }
  if (argv[0] === "command" || argv[0] === "commands") { cmdCommand(argv.slice(1)); return; }
  if (argv[0] === "automation" || argv[0] === "automations" || argv[0] === "cron") { await cmdAutomation(argv.slice(1)); return; }
  if (argv[0] === "marketplace" || argv[0] === "market") { await cmdMarketplace(argv.slice(1)); return; }
  if (argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") { usage(); return; }

  if (argv[0] === "-p" || argv[0] === "--print") {
    const rest = argv.slice(1);
    let yolo = false, workspace = null;
    const words = [];
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === "--yolo") yolo = true;
      else if (a === "-C" || a === "--workspace" || a === "--cwd") workspace = rest[++i];
      else if (a.startsWith("--")) { i++; } // skip unknown flag (+value)
      else words.push(a);
    }
    const text = words.join(" ").trim();
    if (!text) { console.error('用法: openzcode -p "<任务>" [--yolo] [-C 工作目录]'); process.exit(2); }
    await runPrint(text, { yolo, workspace });
    return;
  }

  await runTui();
}

main().catch((e) => {
  console.error(e?.stack || e?.message || e);
  process.exit(1);
});
