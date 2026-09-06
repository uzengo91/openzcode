// Newline-delimited JSON-RPC 2.0 over any duplex stream (stdio for app-server).
// Server side: handlers per method + notify(). Client side: request() with
// pending-promise map. Both sides share the same framing.
"use strict";

const readline = require("node:readline");

function createRpc({ input, output, onEnd, onError }) {
  const handlers = new Map();      // method -> async (params, ctx) => result
  const pending = new Map();       // outgoing request id -> {resolve, reject, timer}
  let nextId = 1;
  let closed = false;

  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  function write(obj) {
    if (closed) return;
    try {
      output.write(JSON.stringify(obj) + "\n");
    } catch (e) {
      onError && onError(e);
    }
  }

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try { msg = JSON.parse(trimmed); } catch { return; /* ignore malformed */ }
    if (typeof msg !== "object" || msg === null) return;

    if (Array.isArray(msg)) { msg.forEach(handleOne); return; }
    handleOne(msg);
  });

  function handleOne(msg) {
    const isRequest = typeof msg.method === "string" && msg.id !== undefined && msg.id !== null;
    const isResponse = msg.method === undefined && (msg.result !== undefined || msg.error !== undefined);

    if (isResponse) {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(Object.assign(new Error(msg.error.message || "RPC error"), { code: msg.error.code, data: msg.error.data }));
      else p.resolve(msg.result);
      return;
    }

    if (isRequest) {
      const handler = handlers.get(msg.method);
      if (!handler) {
        write({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
        return;
      }
      Promise.resolve()
        .then(() => handler(msg.params ?? {}))
        .then(
          (result) => write({ jsonrpc: "2.0", id: msg.id, result: result !== undefined ? result : {} }),
          (err) => write({
            jsonrpc: "2.0", id: msg.id,
            error: { code: err.code && typeof err.code === "number" ? err.code : -32000, message: err.message || String(err) },
          })
        );
      return;
    }

    // notification
    if (typeof msg.method === "string") {
      const handler = handlers.get(msg.method);
      if (handler) {
        Promise.resolve().then(() => handler(msg.params ?? {})).catch((err) => onError && onError(err));
      }
    }
  }

  rl.on("close", () => {
    closed = true;
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error("RPC connection closed"));
    }
    pending.clear();
    onEnd && onEnd();
  });

  return {
    on(method, handler) { handlers.set(method, handler); },
    notify(method, params) { write({ jsonrpc: "2.0", method, params: params ?? {} }); },
    request(method, params, { timeoutMs = 60000 } = {}) {
      const rid = nextId++;
      return new Promise((resolve, reject) => {
        const timer = timeoutMs
          ? setTimeout(() => { pending.delete(rid); reject(new Error(`RPC timeout: ${method}`)); }, timeoutMs)
          : null;
        pending.set(rid, { resolve, reject, timer });
        write({ jsonrpc: "2.0", id: rid, method, params: params ?? {} });
      });
    },
    close() {
      closed = true;
      try { rl.close(); } catch {}
    },
    isClosed() { return closed; },
  };
}

module.exports = { createRpc };
