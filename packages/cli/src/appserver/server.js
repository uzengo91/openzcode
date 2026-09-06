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

  rpc.on("session/send", guard(async (p) => {
    const session = storage.getSession(p.sessionId);
    if (!session) throw new Error(`会话不存在: ${p.sessionId}`);
    const text = String(p.text ?? "").trim();
    if (!text) throw new Error("消息不能为空");

    const t = turnState(p.sessionId);
    if (t.running) throw new Error("该会话正在处理上一条消息，请等待或点击停止");

    const provider = p.providerIdOrName ? configStore.getProvider(p.providerIdOrName) : configStore.getDefaultProvider();
    const config = configStore.load();

    t.running = true;
    t.abort = new AbortController();
    const abort = t.abort;

    // Fire the turn asynchronously; progress flows out as session/event.
    runAgentTurn({
      session,
      userText: text,
      provider,
      config,
      storage,
      emit: (event) => emitEvent(p.sessionId, event),
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
    })
      .catch(() => {})
      .finally(() => {
        t.running = false;
        t.abort = null;
        t.pendingPerms.clear();
      });

    return { started: true, provider: provider ? { id: provider.id, name: provider.name, model: provider.model } : null };
  }));

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

  /* ------------- shutdown ------------- */

  function shutdown() {
    for (const [, t] of turns) { try { t.abort?.abort(new Error("app-server 关闭")); } catch {} }
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
