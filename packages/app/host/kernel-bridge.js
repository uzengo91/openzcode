#!/usr/bin/env node
// OpenZCode app-server bridge (M1) — protocol adapter between the ZCode GUI
// renderer and the vendored Codex kernel's `codex-app-server` (JSON-RPC over
// stdio, v2 protocol: thread/*, turn/*, item/*).
//
// This module is GUI-side (Node, Electron host). It exposes the SAME async
// surface the GUI already uses (invoke-style methods + event emitter), so the
// renderer keeps working while the engine underneath switches from the legacy
// JS app-server to the Rust kernel.
"use strict";

const { spawn } = require("node:child_process");
const { createInterface } = require("node:readline");
const path = require("node:path");
const fs = require("node:fs");

const DEFAULT_KERNEL = path.join(__dirname, "..", "..", "kernel", "codex-rs", "target", "release", "codex-app-server");

function resolveKernelBinary(explicit) {
  const candidates = [
    explicit,
    process.env.OPENZCODE_KERNEL_APP_SERVER,
    DEFAULT_KERNEL,
    // release bundle layout
    path.join(process.resourcesPath || "", "kernel", "codex-app-server"),
  ].filter(Boolean);
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return candidates[0];
}

class KernelAppServerBridge {
  /**
   * @param options { kernelPath?, cwd?, onEvent } onEvent(zcodeEvent) receives
   *        events in the LEGACY GUI event model (turn_started/text_delta/
   *        message/tool_*/permission_*/compact_*/turn_done) so the renderer
   *        needs zero changes.
   */
  constructor(options = {}) {
    this.kernelPath = resolveKernelBinary(options.kernelPath);
    this.cwd = options.cwd || process.cwd();
    this.onEvent = options.onEvent || (() => {});
    this.proc = null;
    this.rpc = null; // { request, notify }
    this.pending = new Map();
    this.nextId = 1;
    this.ready = false;
    this.threadId = null; // current conversation (kernel threads map 1:1 to ZCode sessions)
    this.itemCache = new Map(); // item_id → accumulating tool state
  }

  /* ------------- wire plumbing ------------- */

  async start() {
    if (!fs.existsSync(this.kernelPath)) {
      throw new Error(`内核 app-server 不存在: ${this.kernelPath} (先构建: cargo build --release -p codex-app-server)`);
    }
    this.proc = spawn(this.kernelPath, ["app-server"], {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, RUST_LOG: process.env.RUST_LOG || "error" },
    });
    this.proc.stderr.on("data", (d) => console.error(`[kernel] ${String(d).trimEnd().slice(0, 300)}`));

    const rl = createInterface({ input: this.proc.stdout });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      this._handleMessage(msg);
    });
    this.proc.on("exit", (code) => {
      this.ready = false;
      this.onEvent({ type: "engine_status", state: "stopped", code });
    });

    // initialize handshake (v2)
    await this.request("initialize", {
      clientInfo: { name: "openzcode-gui", title: "OpenZCode", version: require("../../package.json").version },
    }, { timeoutMs: 20000 });
    this.notify("initialized");
    this.ready = true;
    this.onEvent({ type: "engine_status", state: "ready" });
    return { kernel: this.kernelPath };
  }

  _handleMessage(msg) {
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) entry.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else entry.resolve(msg.result);
      return;
    }
    // server→client request (approvals/elicitation) or notification
    if (msg.method && msg.id !== undefined) {
      this._handleServerRequest(msg);
      return;
    }
    if (msg.method) this._handleNotification(msg.method, msg.params || {});
  }

  _handleServerRequest(msg) {
    // codex approvals arrive as server→client requests; auto-answer per mode,
    // and surface to GUI as permission cards.
    const method = msg.method;
    // Ask GUI (permission card) unless auto-approved
    this.onEvent({
      type: "permission_request",
      id: String(msg.id),
      tool: method.includes("exec") ? "bash" : method,
      input: msg.params,
    });
    // store resolver so GUI approval can reply
    this.pendingApprovals = this.pendingApprovals || new Map();
    this.pendingApprovals.set(String(msg.id), {
      reply: (result) => this._send({ jsonrpc: "2.0", id: msg.id, result }),
      method,
      params: msg.params,
    });
  }

  /** GUI approval → kernel reply */
  approve(id, allow) {
    const entry = this.pendingApprovals && this.pendingApprovals.get(String(id));
    if (!entry) return false;
    this.pendingApprovals.delete(String(id));
    this.onEvent({ type: "permission_resolved", id: String(id), allow: !!allow });
    // generic positive/negative reply shape for exec/review approvals
    entry.reply(allow
      ? { decision: "approved" }
      : { decision: "denied" });
    return true;
  }

  _handleNotification(method, params) {
    const map = {
      "thread/started": () => this.onEvent({ type: "turn_started" }),
      "turn/started": () => this.onEvent({ type: "turn_started" }),
      "turn/completed": () => {
        this.onEvent({ type: "turn_done", ok: true });
      },
      "error": () => this.onEvent({ type: "turn_done", ok: false, error: params?.message || "内核错误" }),
      "item/started": () => this._onItem(params, "started"),
      "item/completed": () => this._onItem(params, "completed"),
      "thread/compacted": () => this.onEvent({ type: "compact_done", compacted: true }),
    };
    const handler = map[method];
    if (handler) handler();
    else this.onEvent({ type: "kernel_notification", method, params });
  }

  /** kernel thread items → ZCode message/tool cards */
  _onItem(params, phase) {
    const threadId = params.threadId || this.threadId;
    const item = params.item || {};
    const kind = item.type || item.itemType;
    if (kind === "agentMessage") {
      if (phase === "completed") {
        this.onEvent({
          type: "message",
          message: { role: "assistant", parts: [{ type: "text", text: item.text || "" }] },
        });
      }
      return;
    }
    if (kind === "reasoning") return; // hidden in ZCode UI for now
    if (kind === "commandExecution" || kind === "commandExecutionOutput") {
      const itemId = item.id || params.itemId || "cmd";
      let st = this.itemCache.get(itemId);
      if (!st) {
        st = { kind: "tool", id: itemId, name: "bash", input: { command: item.command || "" }, status: "running", output: "" };
        this.itemCache.set(itemId, st);
        this.onEvent({ type: "tool_start", id: itemId, name: "bash", input: st.input });
        return;
      }
      if (phase === "completed") {
        st.status = item.exitCode === 0 || item.status === "completed" ? "ok" : "error";
        st.output = item.aggregatedOutput || item.output || "";
        this.onEvent({ type: "tool_end", id: itemId, name: "bash", ok: st.status === "ok", ms: item.durationMs, output: String(st.output).slice(0, 2500) });
        this.itemCache.delete(itemId);
      }
      return;
    }
    if (kind === "fileChange" || kind === "mcpToolCall" || kind === "webSearch") {
      const itemId = item.id || params.itemId || kind;
      const name = kind === "fileChange" ? "edit_file" : kind === "webSearch" ? "web_search" : (item.tool || "mcp_tool");
      if (phase === "started") {
        this.itemCache.set(itemId, { kind: "tool", id: itemId, name });
        this.onEvent({ type: "tool_start", id: itemId, name, input: item });
      } else {
        this.onEvent({ type: "tool_end", id: itemId, name, ok: true, output: JSON.stringify(item).slice(0, 2000) });
        this.itemCache.delete(itemId);
      }
      return;
    }
    if (kind === "error") {
      this.onEvent({ type: "turn_done", ok: false, error: item.message || "item error" });
    }
  }

  _send(obj) {
    if (!this.proc || this.proc.killed) throw new Error("内核未运行");
    this.proc.stdin.write(JSON.stringify(obj) + "\n");
  }

  request(method, params, { timeoutMs = 120000 } = {}) {
    if (!this.proc) return Promise.reject(new Error("内核未启动"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`内核 RPC 超时: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this._send({ jsonrpc: "2.0", id, method, params: params ?? {} });
    });
  }

  notify(method, params) {
    try { this._send({ jsonrpc: "2.0", method, params: params ?? {} }); } catch {}
  }

  /* ------------- ZCode-facing surface ------------- */

  /** create a new conversation (ZCode session) */
  async newThread(options = {}) {
    const r = await this.request("thread/start", {
      model: options.model,
      cwd: options.workspace || this.cwd,
      approvalPolicy: "on-request",
      sandbox: options.sandbox || "workspace-write",
    });
    this.threadId = r?.thread?.id || r?.threadId || r?.id || null;
    return { sessionId: this.threadId };
  }

  /** send a user message; streams events via onEvent; resolves at turn end */
  async send(text) {
    if (!this.threadId) await this.newThread({});
    let settled;
    const done = new Promise((r) => { settled = r; });
    const origTurnDone = this.onEvent;
    // wrap once to detect completion
    this.onEvent = (ev) => { origTurnDone(ev); if (ev.type === "turn_done") { this.onEvent = origTurnDone; settled(); } };
    await this.request("turn/start", { threadId: this.threadId, input: [{ type: "text", text }] });
    await done;
    return { ok: true };
  }

  async stop() {
    try { await this.request("turn/interrupt", { threadId: this.threadId }); } catch {}
  }

  async listThreads() {
    const r = await this.request("thread/list", {});
    return r;
  }

  shutdown() {
    try { this.proc && this.proc.kill("SIGTERM"); } catch {}
    setTimeout(() => { try { this.proc && this.proc.kill("SIGKILL"); } catch {} }, 1500);
  }
}

module.exports = { KernelAppServerBridge, resolveKernelBinary };
