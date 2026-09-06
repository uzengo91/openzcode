// Test fixture: minimal Streamable-HTTP MCP server (no dependencies).
// POST JSON-RPC to /mcp — tools: upper {text}, reverse {text}.
"use strict";

import http from "node:http";

const TOOLS = [
  { name: "upper", description: "把 text 转为大写", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "reverse", description: "把 text 反转", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
];

function call(name, args) {
  if (name === "upper") return { content: [{ type: "text", text: String(args.text).toUpperCase() }] };
  if (name === "reverse") return { content: [{ type: "text", text: [...String(args.text)].reverse().join("") }] };
  return { content: [{ type: "text", text: `未知工具 ${name}` }], isError: true };
}

const SESSION = "sess-" + Math.random().toString(36).slice(2, 10);

const server = http.createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/mcp") {
    res.writeHead(404).end();
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let msg;
    try { msg = JSON.parse(body); } catch { res.writeHead(400).end(); return; }

    // notifications (no response expected per JSON-RPC / MCP streamable HTTP)
    if (msg.id == null || (typeof msg.method === "string" && msg.method.startsWith("notifications/"))) {
      res.writeHead(202).end();
      return;
    }

    res.writeHead(200, { "content-type": "application/json", "mcp-session-id": SESSION });
    const reply = (result) => res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));

    if (msg.method === "initialize") {
      reply({ protocolVersion: msg.params?.protocolVersion || "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "openzcode-test-http", version: "0.1.0" } });
    } else if (msg.method === "tools/list") {
      reply({ tools: TOOLS });
    } else if (msg.method === "tools/call") {
      reply(call(msg.params?.name, msg.params?.arguments || {}));
    } else {
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `no method ${msg.method}` } }));
    }
  });
});

const port = Number(process.argv[2] || process.env.PORT || 8931);
server.listen(port, "127.0.0.1", () => console.log(`test-http-mcp listening on http://127.0.0.1:${port}/mcp`));
