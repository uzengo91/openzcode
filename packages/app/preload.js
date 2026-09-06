// Preload: minimal, explicit bridge between the sandboxed renderer and main.
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("openzcode", {
  // JSON-RPC style request to the host/CLI: invoke(method, params) → Promise
  invoke: (method, params) => ipcRenderer.invoke("rpc", { method, params: params ?? {} }),
  // Live agent-loop events: {sessionId, event}
  onEvent: (cb) => {
    const listener = (_ev, payload) => cb(payload);
    ipcRenderer.on("session/event", listener);
    return () => ipcRenderer.removeListener("session/event", listener);
  },
  // Engine lifecycle status from the host layer
  onStatus: (cb) => {
    const listener = (_ev, payload) => cb(payload);
    ipcRenderer.on("engine/status", listener);
    return () => ipcRenderer.removeListener("engine/status", listener);
  },
  // MCP server state changes from the engine
  onMcpStatus: (cb) => {
    const listener = (_ev, payload) => cb(payload);
    ipcRenderer.on("mcp/status", listener);
    return () => ipcRenderer.removeListener("mcp/status", listener);
  },
});
