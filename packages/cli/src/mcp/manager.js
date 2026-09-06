// MCP manager — multi-scope server registry + tool aggregation.
// Scopes (later wins on name conflict):
//   user     ~/.openzcode/mcp.json
//   project  <workspace>/.mcp.json
//   plugins  <pluginDir>/mcp.json (from plugins registry)
// Tools are exposed to the agent as  mcp__<server>__<tool>.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { McpConnection } = require("./client");
const configStore = require("../config");

function userMcpPath() {
  return path.join(process.env.OPENZCODE_CONFIG_DIR || path.join(os.homedir(), ".openzcode"), "mcp.json");
}

function readMcpFile(p) {
  try {
    const data = JSON.parse(fs.readFileSync(p, "utf8"));
    const servers = data.mcpServers || data.servers || {};
    if (servers && typeof servers === "object" && !Array.isArray(servers)) return servers;
    return {};
  } catch {
    return {};
  }
}

function writeUserMcp(servers) {
  const p = userMcpPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ mcpServers: servers }, null, 2) + "\n");
  return p;
}

class McpManager {
  constructor({ workspace, plugins, emit }) {
    this.workspace = workspace;
    this.plugins = plugins || [];          // plugin descriptors with mcpPath
    this.emit = emit || (() => {});
    this.conns = new Map();                // name -> {conn, cfg, source, enabled}
    this.loaded = false;
  }

  _setWorkspace(workspace) { this.workspace = workspace; }

  _configs() {
    const out = [];
    const disabled = configStore.load().disabledMcpServers || [];
    const add = (name, cfg, source) => {
      if (!name || typeof cfg !== "object") return;
      out.push({ name, cfg, source, enabled: !disabled.includes(name) });
    };

    const user = readMcpFile(userMcpPath());
    for (const [name, cfg] of Object.entries(user)) add(name, cfg, `user:${path.basename(userMcpPath())}`);

    if (this.workspace) {
      const proj = readMcpFile(path.join(this.workspace, ".mcp.json"));
      for (const [name, cfg] of Object.entries(proj)) add(name, cfg, "project:.mcp.json");
    }
    for (const plug of this.plugins) {
      if (!plug.mcpPath) continue;
      const servers = readMcpFile(plug.mcpPath);
      for (const [name, cfg] of Object.entries(servers)) add(`${name}`, cfg, `plugin:${plug.name}`);
    }
    return out;
  }

  async load() {
    // dispose removed/changed
    const wanted = new Map(this._configs().map((c) => [c.name, c]));
    for (const [name, entry] of this.conns) {
      const w = wanted.get(name);
      const changed = !w || JSON.stringify(w.cfg) !== JSON.stringify(entry.cfg) || w.source !== entry.source || w.enabled !== entry.enabled;
      if (changed) {
        entry.conn && entry.conn.close();
        this.conns.delete(name);
      }
    }
    for (const [name, c] of wanted) {
      if (this.conns.has(name)) continue;
      const conn = c.enabled
        ? new McpConnection(name, c.cfg, {
            workspace: this.workspace,
            log: (msg) => this.emit({ type: "log", message: msg }),
          })
        : null;
      const entry = { conn, cfg: c.cfg, source: c.source, enabled: c.enabled };
      this.conns.set(name, entry);
      if (conn) {
        // eager connect, tolerate failures
        conn.start().catch(() => {});
        this.emit({ type: "mcp_status", name, status: conn.status });
      }
    }
    this.loaded = true;
    return this.list();
  }

  async reload() {
    for (const [, entry] of this.conns) entry.conn.close();
    this.conns.clear();
    return this.load();
  }

  list() {
    return [...this.conns.entries()].map(([name, e]) => ({
      name,
      type: e.conn ? e.conn.type : (e.cfg.url ? "http" : "stdio"),
      source: e.source,
      enabled: e.enabled,
      status: e.enabled ? (e.conn ? e.conn.status : "stopped") : "disabled",
      error: e.conn ? e.conn.error : null,
      toolCount: e.conn ? e.conn.tools.length : 0,
      tools: e.conn ? e.conn.tools.map((t) => t.name) : [],
      serverInfo: e.conn ? e.conn.serverInfo : null,
      command: e.cfg.command || e.cfg.url || "",
    }));
  }

  /** aggregated tool defs for the agent, namespaced mcp__<server>__<tool> */
  async toolDefinitions({ maxTools = 60 } = {}) {
    const defs = [];
    for (const [name, e] of this.conns) {
      if (!e.enabled || !e.conn) continue;
      let tools = [];
      try { tools = await e.conn.listTools(); } catch { continue; }
      for (const t of tools) {
        if (defs.length >= maxTools) return defs;
        defs.push({
          name: `mcp__${name}__${t.name}`,
          description: (t.description || t.name) + ` (MCP server: ${name})`,
          parameters: t.parameters,
          danger: !!e.cfg.danger,
          mcp: { server: name, tool: t.name },
        });
      }
    }
    return defs;
  }

  async call(namespaced, args) {
    if (!namespaced.startsWith("mcp__")) return { ok: false, output: `非 MCP 工具: ${namespaced}` };
    const rest = namespaced.slice(5);
    const last = rest.lastIndexOf("__");
    if (last < 0) return { ok: false, output: `无效的 MCP 工具名: ${namespaced} (应为 mcp__<server>__<tool>)` };
    const server = rest.slice(0, last);
    const tool = rest.slice(last + 2);
    const entry = this.conns.get(server);
    if (!entry || !entry.enabled || !entry.conn) return { ok: false, output: `未找到或已禁用 MCP server: ${server} (可用: ${[...this.conns.entries()].filter(([,e])=>e.enabled&&e.conn).map(([n])=>n).join(", ") || "无"})` };
    try {
      return await entry.conn.callTool(tool, args);
    } catch (e) {
      // one retry after restart (server may have crashed earlier)
      try {
        entry.conn.close();
        await entry.conn.start();
        return await entry.conn.callTool(tool, args);
      } catch (e2) {
        return { ok: false, output: `MCP ${server}.${tool} 调用失败: ${e2.message}` };
      }
    }
  }

  async callDirect(server, tool, args) {
    const entry = this.conns.get(server);
    if (!entry || !entry.conn) return { ok: false, output: `未找到或已禁用 MCP server: ${server}` };
    try { return await entry.conn.callTool(tool, args); }
    catch (e) { return { ok: false, output: `MCP ${server}.${tool} 调用失败: ${e.message}` }; }
  }

  async ensureAll() {
    await Promise.allSettled([...this.conns.values()].filter((e) => e.enabled && e.conn).map((e) => e.conn.ensureRunning()));
  }

  setEmit(emit) { this.emit = emit || (() => {}); }

  close() {
    for (const [, entry] of this.conns) entry.conn && entry.conn.close();
    this.conns.clear();
  }

  setContext({ workspace, plugins }) {
    this._setWorkspace(workspace);
    this.plugins = plugins || [];
  }
}

module.exports = { McpManager, userMcpPath, readMcpFile, writeUserMcp };
