// Test fixture: a minimal but real MCP server over stdio (newline-delimited
// JSON-RPC). Tools: echo / add / now — used by CI and E2E to prove the MCP
// pipeline end-to-end. No dependencies.
"use strict";

const readline = require("node:readline");

const TOOLS = [
  {
    name: "echo",
    description: "原样返回输入的 text 字段",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
  {
    name: "add",
    description: "计算 a+b 并返回结果",
    inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
  },
  {
    name: "now",
    description: "返回服务器当前 ISO 时间",
    inputSchema: { type: "object", properties: {} },
  },
];

function toolCall(name, args) {
  if (name === "echo") {
    return { content: [{ type: "text", text: `echo: ${args.text}` }] };
  }
  if (name === "add") {
    const sum = Number(args.a) + Number(args.b);
    if (!Number.isFinite(sum)) return { content: [{ type: "text", text: "参数 a/b 必须是数字" }], isError: true };
    return { content: [{ type: "text", text: String(sum) }] };
  }
  if (name === "now") {
    return { content: [{ type: "text", text: new Date().toISOString() }] };
  }
  return { content: [{ type: "text", text: `未知工具: ${name}` }], isError: true };
}

const rl = readline.createInterface({ input: process.stdin });
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\n"); }

rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id == null) return; // notification
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: msg.params?.protocolVersion || "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "openzcode-test-server", version: "0.1.0" } } });
  } else if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } });
  } else if (msg.method === "tools/call") {
    send({ jsonrpc: "2.0", id: msg.id, result: toolCall(msg.params?.name, msg.params?.arguments || {}) });
  } else if (msg.method === "ping") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
  } else {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
  }
});

process.title = "openzcode-test-mcp-server";
