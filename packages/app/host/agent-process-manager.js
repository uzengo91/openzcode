// Agent process manager (the "host" layer): spawns the CLI bundle in
// app-server mode using the Electron binary itself as Node
// (ELECTRON_RUN_AS_NODE=1), one process per workspace — the same topology as
// the reference architecture. Owns the JSON-RPC client over stdio and
// reconnects with backoff if the engine crashes.
"use strict";

const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

// monorepo layout requires ../../cli/src/rpc/jsonrpc; the release zip ships a
// copy of that module at ./jsonrpc.js (see scripts/package-release.mjs)
let createRpc;
try { createRpc = require("./jsonrpc").createRpc; }
catch { createRpc = require("../../cli/src/rpc/jsonrpc").createRpc; }

const CLI_BUNDLE = path.join(__dirname, "..", "..", "cli", "dist", "openzcode.cjs");

class AgentProcessManager {
  constructor({ onEvent, onStatus }) {
    this.onEvent = onEvent;     // (method, params) => void
    this.onStatus = onStatus;   // (status) => void
    this.proc = null;
    this.rpc = null;
    this.workspace = null;
    this.restartAttempts = 0;
    this.stopping = false;
    this.ready = false;
  }

  cliPath() {
    // 1) repo layout:  packages/app/host → packages/cli/dist/openzcode.cjs
    // 2) release zip:  openzcode/app/host → openzcode/openzcode.cjs
    // 3) packaged app: Resources/openzcode.cjs
    const candidates = [
      CLI_BUNDLE,
      path.join(__dirname, "..", "..", "openzcode.cjs"),
      path.join(process.resourcesPath || "", "openzcode.cjs"),
    ];
    for (const p of candidates) {
      try { if (p && fs.existsSync(p)) return p; } catch {}
    }
    return CLI_BUNDLE;
  }

  async start(workspace) {
    this.workspace = workspace;
    this.stopping = false;
    await this.spawnEngine();
    return this.rpc.request("initialize", { workspace }, { timeoutMs: 15000 });
  }

  async spawnEngine() {
    this.killChild();
    try { fs.mkdirSync(this.workspace, { recursive: true }); } catch {}
    const bin = process.execPath; // Electron binary itself
    const args = [this.cliPath(), "app-server", "--stdio"];
    const env = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      OPENZCODE_WORKSPACE: this.workspace,
    };
    this.proc = spawn(bin, args, { cwd: this.workspace, env, stdio: ["pipe", "pipe", "pipe"] });
    this.ready = false;
    this.onStatus({ state: "starting", pid: this.proc.pid });

    this.proc.stderr.on("data", (d) => console.error(`[openzcode-cli] ${d}`.trimEnd()));
    this.proc.on("error", (err) => {
      console.error("engine spawn error:", err.message);
      this.ready = false;
      this.onStatus({ state: "error", message: `引擎启动失败: ${err.message}` });
    });

    this.proc.on("exit", (code, signal) => {
      this.ready = false;
      this.onStatus({ state: this.stopping ? "stopped" : "crashed", code, signal });
      if (!this.stopping && this.restartAttempts < 5) {
        const delay = Math.min(1000 * 2 ** this.restartAttempts, 10000);
        this.restartAttempts++;
        this.onStatus({ state: "restarting", attempt: this.restartAttempts, delay });
        setTimeout(() => {
          if (!this.stopping) this.spawnEngine().catch(() => {});
        }, delay);
      }
    });

    this.rpc = createRpc({ input: this.proc.stdout, output: this.proc.stdin });
    // Forward CLI notifications (session/event, mcp/status …) to the UI layer.
    this.rpc.on("session/event", (params) => this.onEvent("session/event", params));
    this.rpc.on("mcp/status", (params) => this.onEvent("mcp/status", params));

    await this.rpc.request("initialize", { workspace: this.workspace }, { timeoutMs: 15000 });
    this.ready = true;
    this.restartAttempts = 0;
    this.onStatus({ state: "ready", pid: this.proc.pid });
  }

  killChild() {
    if (this.proc) {
      try { this.proc.removeAllListeners("exit"); } catch {}
      try { this.proc.kill("SIGTERM"); } catch {}
      setTimeout(() => { try { this.proc && this.proc.kill("SIGKILL"); } catch {} }, 1500);
      this.proc = null;
    }
  }

  async setWorkspace(workspace) {
    if (workspace === this.workspace && this.ready) return;
    this.workspace = workspace;
    await this.spawnEngine();
  }

  rpcCall(method, params) {
    if (!this.rpc || !this.ready) return Promise.reject(new Error("CLI 引擎尚未就绪，请稍候"));
    return this.rpc.request(method, params, { timeoutMs: 120000 });
  }

  shutdown() {
    this.stopping = true;
    this.killChild();
  }
}

module.exports = { AgentProcessManager };
