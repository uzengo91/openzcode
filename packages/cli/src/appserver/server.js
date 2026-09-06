// App-server mode: `openzcode.cjs app-server --stdio`
// JSON-RPC 2.0 over stdio. The desktop App spawns this process (one per
// workspace) and drives sessions through it; agent-loop events stream back
// as `session/event` notifications.
//
// Methods:
//   initialize, server/info
//   config/get | config/setProvider | config/removeProvider |
//   config/setDefaultProvider | config/setOptions | config/testProvider
//   session/create | session/list | session/messages | session/todos |
//   session/send | session/stop | session/approve | session/delete
"use strict";

const path = require("node:path");
const os = require("node:os");
const { createRpc } = require("../rpc/jsonrpc");
const configStore = require("../config");
const { getStorage } = require("../storage");
const { dirs, ensureDirs } = require("../paths");
const { runAgentTurn } = require("../agent/loop");
const { testProvider } = require("../llm/client");
const { SkillRegistry } = require("../skills");
const pluginRegistry = require("../plugins");
const commands = require("../commands");
const { McpManager, writeUserMcp, readMcpFile, userMcpPath } = require("../mcp/manager");
const automations = require("../automations");
const marketplace = require("../marketplace");
const { VERSION, PROTOCOL_VERSION } = require("../version");

function resolveWorkspace(p) {
  const ws = p ? path.resolve(p) : dirs().workspace;
  return ws.replace(/^~(?=$|\/)/, os.homedir());
}

function runAppServer() {
  ensureDirs();
  process.title = "openzcode-app-server";
  const storage = getStorage();
  const defaultWorkspace = resolveWorkspace(process.env.OPENZCODE_WORKSPACE);

  const rpc = createRpc({ input: process.stdin, output: process.stdout });

  // sessionId -> { abort: AbortController|null, running: bool, pendingPerms: Map }
  const turns = new Map();

  /* ------------- extensions: plugins / skills / commands / mcp ------------- */

  let currentPlugins = [];
  const skills = new SkillRegistry({ workspace: defaultWorkspace, plugins: [] });
  const mcp = new McpManager({ workspace: defaultWorkspace, plugins: [], emit: () => {} });

  mcp.setEmit((e) => {
    if (e.type === "mcp_status") { if (!rpc.isClosed()) rpc.notify("mcp/status", { name: e.name, status: e.status }); }
    else if (e.type === "log") { if (!rpc.isClosed()) rpc.notify("engine/log", { message: e.message }); }
  });

  function refreshExtensions() {
    currentPlugins = pluginRegistry.discover({ workspace: defaultWorkspace });
    skills.setContext({ workspace: defaultWorkspace, plugins: currentPlugins });
    mcp.setContext({ workspace: defaultWorkspace, plugins: currentPlugins });
    return mcp.load();
  }
  const extensionsReady = refreshExtensions().catch(() => {});

  /* ------------- turn launcher (shared by RPC + scheduler) ------------- */

  async function launchTurn(sessionId, text, { yolo = false } = {}) {
    const session = storage.getSession(sessionId);
    if (!session) throw new Error(`会话不存在: ${sessionId}`);
    const trimmed = String(text ?? "").trim();
    if (!trimmed) throw new Error("消息不能为空");

    let cfg = configStore.load();
    if (yolo) cfg = { ...cfg, permissionMode: "yolo" };
    const provider = configStore.getDefaultProvider();

    const t = turnState(sessionId);
    if (t.running) throw new Error("该会话正在处理上一条消息，请等待或点击停止");

    await extensionsReady;
    t.running = true;
    t.abort = new AbortController();
    const abort = t.abort;

    // runAgentTurn resolves (never rejects) with {ok,...}; progress flows as session/event
    const done = runAgentTurn({
      session,
      userText: trimmed,
      provider,
      config: cfg,
      storage,
      emit: (event) => emitEvent(sessionId, event),
      permissionHandler: ({ id, signal }) =>
        new Promise((resolve, reject) => {
          t.pendingPerms.set(id, { resolve, reject });
          const onAbort = () => {
            t.pendingPerms.delete(id);
            reject(new Error("已停止"));
          };
          signal?.addEventListener("abort", onAbort, { once: true });
        }),
      signal: abort.signal,
      extensions: { mcpManager: mcp, skills, automations: automationService },
    });
    done.finally(() => {
      t.running = false;
      t.abort = null;
      t.pendingPerms.clear();
    });
    return done;
  }

  /* ------------- automations service + scheduler ------------- */

  const automationService = automations.createService({
    storage,
    workspace: defaultWorkspace,
    launchTurn,
    emit: (e) => { if (!rpc.isClosed() && (e.type === "automation_started" || e.type === "automation_finished" || e.type === "automation_changed")) rpc.notify("automation/status", e); },
  });

  const SCHEDULER_TICK_MS = Math.max(1000, Number(process.env.OPENZCODE_AUTOMATION_TICK_MS) || 30000);
  const schedulerTimer = setInterval(() => {
    automationService.tickNow().catch((e) => console.error(`[automation] tick: ${e.message}`));
  }, SCHEDULER_TICK_MS);
  if (schedulerTimer.unref) schedulerTimer.unref();

  function turnState(sessionId) {
    let t = turns.get(sessionId);
    if (!t) { t = { abort: null, running: false, pendingPerms: new Map() }; turns.set(sessionId, t); }
    return t;
  }

  function emitEvent(sessionId, event) {
    if (!rpc.isClosed()) rpc.notify("session/event", { sessionId, event });
  }

  function publicSession(s) {
    return { id: s.id, title: s.title, workspace: s.workspace, model: s.model, createdAt: s.created_at, updatedAt: s.updated_at };
  }

  const guard = (fn) => async (params) => fn(params || {});

  /* ------------- lifecycle ------------- */

  rpc.on("initialize", guard(() => ({
    protocolVersion: PROTOCOL_VERSION,
    name: "openzcode-app-server",
    version: VERSION,
    workspace: defaultWorkspace,
    storage: storage.constructor.name,
  })));

  rpc.on("server/info", guard(() => ({
    name: "openzcode-app-server", version: VERSION, workspace: defaultWorkspace,
    providers: configStore.getProviders().length,
  })));

  /* ------------- config ------------- */

  rpc.on("config/get", guard(() => configStore.publicConfig()));

  rpc.on("config/setProvider", guard((p) => {
    // If client sends back a masked key on edit, keep the stored one.
    if (p.id && (p.apiKey || "").includes("****")) {
      const existing = configStore.getProvider(p.id);
      if (existing) p.apiKey = existing.apiKey;
    }
    configStore.addProvider(p);
    return configStore.publicConfig();
  }));

  rpc.on("config/removeProvider", guard((p) => { configStore.removeProvider(p.idOrName); return configStore.publicConfig(); }));
  rpc.on("config/setDefaultProvider", guard((p) => { configStore.setDefaultProvider(p.idOrName); return configStore.publicConfig(); }));
  rpc.on("config/setOptions", guard((p) => { configStore.setOptions(p); return configStore.publicConfig(); }));

  rpc.on("config/testProvider", guard(async (p) => {
    try {
      let prov = null;
      if (p.idOrName) prov = configStore.getProvider(p.idOrName);
      if (!prov && p.provider) prov = configStore.normalizeProvider(p.provider);
      if (!prov) throw new Error("未指定要测试的 provider");
      const r = await testProvider(prov);
      return { ok: true, models: r.models || [], message: `连接成功${r.models?.length ? `，可用模型 ${r.models.length} 个` : ""}` };
    } catch (e) {
      return { ok: false, message: e.message || String(e) };
    }
  }));

  /* ------------- sessions ------------- */

  rpc.on("session/create", guard((p) => {
    const s = storage.createSession({
      title: p.title || "新会话",
      workspace: resolveWorkspace(p.workspace),
    });
    return publicSession(s);
  }));

  rpc.on("session/list", guard((p) =>
    storage.listSessions({ workspace: p.workspace ? resolveWorkspace(p.workspace) : undefined }).map(publicSession)
  ));

  rpc.on("session/get", guard((p) => {
    const s = storage.getSession(p.sessionId);
    if (!s) throw new Error(`会话不存在: ${p.sessionId}`);
    return publicSession(s);
  }));

  rpc.on("session/messages", guard((p) => storage.getMessages(p.sessionId)));

  rpc.on("session/todos", guard((p) => storage.getTodos(p.sessionId)));

  rpc.on("session/delete", guard((p) => {
    const t = turns.get(p.sessionId);
    if (t?.running) throw new Error("会话正在运行，请先停止");
    storage.deleteSession(p.sessionId);
    return { deleted: true };
  }));

  rpc.on("session/send", guard((p) => {
    const provider = p.providerIdOrName ? configStore.getProvider(p.providerIdOrName) : configStore.getDefaultProvider();
    // fire-and-forget: the turn streams out as session/event; automation fire() awaits its own copy
    launchTurn(p.sessionId, p.text, { yolo: !!p.yolo }).catch((e) => console.error(`[session/send] ${e?.stack || e}`));
    return { started: true, provider: provider ? { id: provider.id, name: provider.name, model: provider.model } : null };
  }));

  /* ------------- automations RPC ------------- */

  rpc.on("automation/create", guard((p) => automationService.create(p)));
  rpc.on("automation/list", guard((p) => automationService.list(p)));
  rpc.on("automation/get", guard((p) => {
    const a = automationService.get(p.id);
    if (!a) throw new Error(`自动化不存在: ${p.id}`);
    return a;
  }));
  rpc.on("automation/update", guard((p) => {
    const { id, ...fields } = p;
    return automationService.update(id, fields);
  }));
  rpc.on("automation/delete", guard((p) => automationService.remove(p.id)));
  rpc.on("automation/toggle", guard((p) => automationService.toggle(p.id)));
  rpc.on("automation/runs", guard((p) => automationService.runs(p.id)));
  rpc.on("automation/runNow", guard((p) => automationService.runNow(p.id)));

  rpc.on("session/stop", guard((p) => {
    const t = turns.get(p.sessionId);
    if (t?.abort) t.abort.abort(new Error("用户停止"));
    return { stopped: true };
  }));

  rpc.on("session/approve", guard((p) => {
    const t = turnState(p.sessionId);
    const entry = t.pendingPerms.get(p.id);
    if (!entry) return { resolved: false };
    t.pendingPerms.delete(p.id);
    entry.resolve({ allow: !!p.allow, always: !!p.always });
    return { resolved: true };
  }));

  /* ------------- extensions RPC: mcp / skills / commands / plugins ------------- */

  rpc.on("mcp/list", guard(() => mcp.list()));

  rpc.on("mcp/reload", guard(async () => { await refreshExtensions(); return mcp.list(); }));

  rpc.on("mcp/toggle", guard(async (p) => {
    const cfg = configStore.load();
    const disabled = new Set(cfg.disabledMcpServers || []);
    if (disabled.has(p.name)) disabled.delete(p.name);
    else disabled.add(p.name);
    cfg.disabledMcpServers = [...disabled];
    configStore.save(cfg);
    await refreshExtensions();
    return mcp.list();
  }));

  rpc.on("mcp/saveUserConfig", guard(async (p) => {
    const servers = p.servers && typeof p.servers === "object" ? p.servers : {};
    writeUserMcp(servers);
    await refreshExtensions();
    return { saved: userMcpPath(), list: mcp.list() };
  }));

  rpc.on("mcp/userConfig", guard(() => ({ path: userMcpPath(), servers: readMcpFile(userMcpPath()) })));

  rpc.on("mcp/call", guard((p) => mcp.callDirect(String(p.server), String(p.tool), p.args || {})));

  rpc.on("skills/list", guard(() => skills.list()));

  rpc.on("commands/list", guard(() => commands.list({ workspace: defaultWorkspace, plugins: currentPlugins })));

  rpc.on("commands/expand", guard((p) => commands.expand(String(p.text || ""), { workspace: defaultWorkspace, plugins: currentPlugins })));

  rpc.on("plugin/list", guard(() => currentPlugins.map((p) => ({
    name: p.name, version: p.version, description: p.description, scope: p.scope, dir: p.dir,
    contributes: {
      skills: !!p.skillsDir, commands: !!p.commandsDir, mcp: !!p.mcpPath,
    },
  }))));

  rpc.on("plugin/install", guard(async (p) => {
    const r = pluginRegistry.install(String(p.path), { workspace: defaultWorkspace });
    await refreshExtensions();
    return { installed: r, list: mcp.list(), skills: skills.list() };
  }));

  rpc.on("plugin/remove", guard(async (p) => {
    const r = pluginRegistry.remove(String(p.name), { workspace: defaultWorkspace });
    await refreshExtensions();
    return { removed: r, list: mcp.list() };
  }));

  /* ------------- marketplace RPC ------------- */

  rpc.on("marketplace/list", guard(() => marketplace.listMarketplaces()));

  rpc.on("marketplace/install", guard(async (p) => {
    const all = await marketplace.listMarketplaces();
    let entry = null;
    for (const m of all) {
      entry = m.plugins.find((x) => x.name === p.name && (!p.marketplace || m.name === p.marketplace));
      if (entry) break;
    }
    if (!entry) throw new Error(`市场中未找到插件: ${p.name}`);
    const installed = await marketplace.installEntry(entry);
    await refreshExtensions();
    return { installed, plugins: currentPlugins.map((x) => ({ name: x.name, version: x.version, scope: x.scope })) };
  }));

  rpc.on("marketplace/addSource", guard((p) => { marketplace.addSource({ name: p.name, url: p.url, path: p.path }); return marketplace.sources(); }));
  rpc.on("marketplace/removeSource", guard((p) => marketplace.removeSource(p.name)));

  /* ------------- shutdown ------------- */

  function shutdown() {
    for (const [, t] of turns) { try { t.abort?.abort(new Error("app-server 关闭")); } catch {} }
    try { mcp.close(); } catch {}
    try { storage.close(); } catch {}
    try { process.exit(0); } catch {}
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // Keep the process alive on stdin EOF handled by rpc onEnd
  process.stdin.on("end", shutdown);
  process.stdin.resume();

  return rpc;
}

module.exports = { runAppServer };
