#!/usr/bin/env node
// OpenZCode memory sidecar — MCP server bridging ZCode's memory system
// (MEMORY.md + [[links]], workspaceKey directories) onto the Rust kernel.
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const memory = require(path.join(ROOT, "packages/cli/src/memory.js"));

const workspace = process.env.OPENZCODE_WORKSPACE || process.cwd();

const TOOLS = [
  { name: "memory_write", description: "写入长期记忆(跨会话持久)。name 为短横线标识; body 可用 [[其他记忆名]] 引用", inputSchema: { type: "object", properties: { name: { type: "string" }, body: { type: "string" }, description: { type: "string" } }, required: ["name", "body"] } },
  { name: "memory_read", description: "读取一条记忆(name=list 列出全部)", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "memory_index", description: "读取记忆索引(MEMORY.md)", inputSchema: { type: "object", properties: {} } },
];

const IMPL = {
  memory_write: (a) => ({ c: [{ type: "text", text: memory.write(workspace, String(a.name || ""), String(a.body ?? ""), String(a.description ?? "")).output }] }),
  memory_read: (a) => {
    const name = String(a.name || "").trim();
    if (!name || name === "list") {
      const items = memory.listIndex(workspace);
      return { c: [{ type: "text", text: items.map((i) => `- ${i.name}: ${i.description}`).join("\n") || "(记忆库为空)" }] };
    }
    return { c: [{ type: "text", text: memory.read(workspace, name).output }] };
  },
  memory_index: () => {
    const items = memory.listIndex(workspace);
    return { c: [{ type: "text", text: items.map((i) => `- [${i.name}](${i.file}) — ${i.description}`).join("\n") || "(空)" }] };
  },
};

const rl = createInterface({ input: process.stdin });
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
rl.on("line", async (line) => {
  if (!line.trim()) return;
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.id == null) return;
  try {
    if (msg.method === "initialize") {
      send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: msg.params?.protocolVersion || "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "openzcode-memory", version: "0.1.0" } } });
    } else if (msg.method === "tools/list") {
      send({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } });
    } else if (msg.method === "tools/call") {
      const fn = IMPL[msg.params?.name];
      if (!fn) return send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: `未知工具` }], isError: true } });
      send({ jsonrpc: "2.0", id: msg.id, result: fn(msg.params.arguments || {}) });
    } else send({ jsonrpc: "2.0", id: msg.id, result: {} });
  } catch (e) {
    send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: `错误: ${e.message}` }], isError: true } });
  }
});
process.title = "openzcode-sidecar-memory";
