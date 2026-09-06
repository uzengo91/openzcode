// MCP client — one connection to one MCP server.
// Transports:
//   stdio  — spawn subprocess, newline-delimited JSON-RPC (MCP stdio spec);
//            reuses the same createRpc framing as app-server.
//   http   — "Streamable HTTP": POST JSON-RPC to the endpoint, response may be
//            JSON or an SSE stream; honours Mcp-Session-Id.
// Lifecycle: initialize → notifications/initialized → tools/list / tools/call.
"use strict";

const { spawn } = require("node:child_process");
const { createRpc } = require("../rpc/jsonrpc");
const { VERSION } = require("../version");

const PROTOCOL_VERSION = "2025-03-26";
const CLIENT_INFO = { name: "openzcode", version: VERSION };

class McpConnection {
  /**
   * @param name    server key (used for namespacing + logs)
   * @param cfg     {command,args,env,cwd} | {url,headers}
   * @param ctx     {workspace, log}
   */
  constructor(name, cfg, ctx = {}) {
    this.name = name;
    this.cfg = cfg || {};
    this.ctx = ctx;
    this.status = "stopped"; // stopped|starting|running|error|crashed
    this.error = null;
    this.tools = [];
    this.serverInfo = null;
    this.sessionId = null;
    this.proc = null;
    this.rpc = null;
    this.startPromise = null;
    this.restartCount = 0;
  }

  get type() { return this.cfg.url ? "http" : "stdio"; }

  /* ---------------- lifecycle ---------------- */

  async start() {
    if (this.status === "running") return;
    if (this.startPromise) return this.startPromise;
    this.status = "starting";
    this.error = null;
    this.startPromise = this._start()
      .then(() => { this.status = "running"; this.startPromise = null; })
      .catch((e) => {
        this.status = "error";
        this.error = e.message || String(e);
        this.startPromise = null;
        this.ctx.log && this.ctx.log(`MCP ${this.name} 启动失败: ${this.error}`);
        throw e;
      });
    return this.startPromise;
  }

  async _start() {
    if (this.type === "stdio") await this._startStdio();
    else await this._startHttp();

    const res = await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { roots: {} },
      clientInfo: CLIENT_INFO,
    }, { timeoutMs: 15000 });
    this.serverInfo = res?.serverInfo || null;
    this.notify("notifications/initialized");
    await this.refreshTools();
  }

  async _startStdio() {
    const { command, args = [] } = this.cfg;
    if (!command) throw new Error("stdio server 缺少 command");
    const env = { ...process.env, ...this.cfg.env };
    this.proc = spawn(command, args, {
      cwd: this.cfg.cwd || this.ctx.workspace,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.on("error", (e) => { this.status = "error"; this.error = e.message; });
    this.proc.stderr.on("data", (d) => this.ctx.log && this.ctx.log(`[mcp:${this.name}] ${String(d).trimEnd().slice(0, 500)}`));
    this.proc.on("exit", (code, signal) => {
      const wasRunning = this.status === "running" || this.status === "starting";
      this.status = wasRunning ? "crashed" : "stopped";
      this.rpc = null;
      this.tools = [];
      if (wasRunning) this.ctx.log && this.ctx.log(`MCP ${this.name} 进程退出 (code=${code} signal=${signal})`);
    });
    this.rpc = createRpc({
      input: this.proc.stdout,
      output: this.proc.stdin,
      onEnd: () => {},
    });
  }

  async _startHttp() {
    // nothing persistent; each request is a POST. Validate reachability via initialize.
  }

  async refreshTools() {
    const res = await this.request("tools/list", {}, { timeoutMs: 15000 });
    this.tools = (res?.tools || []).map((t) => ({
      name: t.name,
      description: t.description || "",
      parameters: t.inputSchema || { type: "object", properties: {} },
    }));
    return this.tools;
  }

  /* ---------------- request plumbing ---------------- */

  request(method, params, { timeoutMs = 30000 } = {}) {
    if (this.type === "stdio") {
      if (!this.rpc || this.proc?.exitCode != null) throw new Error(`MCP ${this.name} 未连接`);
      return this.rpc.request(method, params, { timeoutMs });
    }
    return this._httpRequest(method, params, timeoutMs);
  }

  notify(method, params) {
    if (this.type === "stdio") {
      try { this.rpc && this.rpc.notify(method, params); } catch {}
    } else {
      // JSON-RPC notifications carry no id; server replies 202
      this._httpRequest(method, params, 10000, { notification: true }).catch(() => {});
    }
  }

  async _httpRequest(method, params, timeoutMs, { notification = false } = {}) {
    const url = this.cfg.url;
    const headers = {
      "content-type": "application/json",
      accept: notification ? "application/json" : "application/json, text/event-stream",
      ...(this.cfg.headers || {}),
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error(`MCP HTTP 超时 (${method})`)), timeoutMs);
    const body = notification
      ? { jsonrpc: "2.0", method, params: params ?? {} }
      : { jsonrpc: "2.0", id: Math.floor(Math.random() * 1e9), method, params: params ?? {} };
    let res;
    try {
      res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;

    if (!res.ok) {
      const b = await res.text().catch(() => "");
      throw new Error(`MCP HTTP ${res.status}: ${b.slice(0, 300)}`);
    }
    if (notification || res.status === 202) return {};

    const ctype = res.headers.get("content-type") || "";
    let msg = null;
    if (ctype.includes("text/event-stream")) {
      msg = await this._readSseResponse(res);
    } else {
      msg = await res.json().catch(() => null);
    }
    if (!msg) throw new Error(`MCP HTTP 无效响应 (${method})`);
    if (msg.error) throw new Error(`MCP ${method}: ${msg.error.message || JSON.stringify(msg.error)}`);
    return msg.result ?? {};
  }

  async _readSseResponse(res) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const messages = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, "");
        buf = buf.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        try { messages.push(JSON.parse(line.slice(5).trim())); } catch {}
      }
    }
    return messages.find((m) => m.result !== undefined || m.error !== undefined) || messages[0] || null;
  }

  /* ---------------- high-level API ---------------- */

  async listTools() {
    if (this.status !== "running") {
      // lazy (re)start, e.g. after crash
      try { await this.start(); } catch { return []; }
    }
    return this.tools;
  }

  async callTool(toolName, args, { timeoutMs = 120000 } = {}) {
    if (this.status !== "running") await this.start(); // throws on failure
    const res = await this.request("tools/call", { name: toolName, arguments: args ?? {} }, { timeoutMs });
    const text = (res?.content || [])
      .filter((c) => c.type === "text" && c.text != null)
      .map((c) => c.text).join("\n");
    if (res?.isError) return { ok: false, output: text || "MCP 工具返回错误" };
    return { ok: true, output: text || JSON.stringify(res ?? {}) };
  }

  async ensureRunning() {
    if (this.status === "running") return;
    await this.start();
  }

  close() {
    if (this.proc) {
      try { this.proc.removeAllListeners("exit"); } catch {}
      try { this.proc.kill("SIGTERM"); } catch {}
      setTimeout(() => { try { this.proc && this.proc.kill("SIGKILL"); } catch {} }, 1500);
      this.proc = null;
    }
    if (this.rpc) { try { this.rpc.close(); } catch {} this.rpc = null; }
    this.status = "stopped";
    this.tools = [];
  }
}

module.exports = { McpConnection, PROTOCOL_VERSION };
