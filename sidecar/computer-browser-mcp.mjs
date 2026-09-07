#!/usr/bin/env node
// OpenZCode sidecar — MCP server exposing ZCode's computer-use + browser tools
// to the Rust kernel (MCP stdio transport). Reuses packages/cli JS modules.
// Tools mirror the ZCode JS tool table 1:1 so the alignment matrix passes.
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { screenshot, click, key, type, scroll, appState, clickElement, setElementValue, listWindows, clipboardGet, clipboardSet } = require(path.join(ROOT, "packages/cli/src/computer/index.js"));
const { BrowserManager } = require(path.join(ROOT, "packages/cli/src/browser/index.js"));

let browser = new BrowserManager();

const TOOLS = [
  { name: "computer_screenshot", description: "截取当前屏幕并作为图像返回", inputSchema: { type: "object", properties: {} } },
  { name: "computer_click", description: "屏幕坐标点击 (left/right/double)", inputSchema: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, button: { type: "string", enum: ["left", "right", "double"] } }, required: ["x", "y"] } },
  { name: "computer_type", description: "向焦点窗口键入文本", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "computer_key", description: "组合键 (cmd+c / Return / ...)", inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] } },
  { name: "computer_scroll", description: "滚动 (正上负下, 1-20)", inputSchema: { type: "object", properties: { amount: { type: "number" } }, required: ["amount"] } },
  { name: "computer_app_state", description: "语义元素树 ([eN] 引用, AX 或窗口级降级)", inputSchema: { type: "object", properties: { appHint: { type: "string" } } } },
  { name: "computer_click_ref", description: "按元素引用点击", inputSchema: { type: "object", properties: { ref: { type: "string" }, appHint: { type: "string" }, button: { type: "string", enum: ["left", "right"] }, double: { type: "boolean" } }, required: ["ref"] } },
  { name: "computer_set_value", description: "向元素引用填文本", inputSchema: { type: "object", properties: { ref: { type: "string" }, text: { type: "string" }, appHint: { type: "string" } }, required: ["ref", "text"] } },
  { name: "computer_windows", description: "列出可见窗口", inputSchema: { type: "object", properties: {} } },
  { name: "clipboard_read", description: "读剪贴板", inputSchema: { type: "object", properties: {} } },
  { name: "clipboard_write", description: "写剪贴板", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "browser_open", description: "打开浏览器并导航", inputSchema: { type: "object", properties: { url: { type: "string" } } } },
  { name: "browser_navigate", description: "跳转 URL", inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
  { name: "browser_snapshot", description: "页面 ARIA 快照 ([ref=eN])", inputSchema: { type: "object", properties: {} } },
  { name: "browser_click", description: "点击 [ref=eN]", inputSchema: { type: "object", properties: { ref: { type: "string" }, button: { type: "string", enum: ["left", "right"] }, double: { type: "boolean" } }, required: ["ref"] } },
  { name: "browser_type", description: "向 [ref=eN] 填文本", inputSchema: { type: "object", properties: { ref: { type: "string" }, text: { type: "string" }, submit: { type: "boolean" } }, required: ["ref", "text"] } },
  { name: "browser_evaluate", description: "页面内执行 JS", inputSchema: { type: "object", properties: { js: { type: "string" } }, required: ["js"] } },
  { name: "browser_screenshot", description: "页面截图返回", inputSchema: { type: "object", properties: { fullPage: { type: "boolean" } } } },
  { name: "browser_close", description: "关闭浏览器", inputSchema: { type: "object", properties: {} } },
];

const contentOf = (r) => [{ type: "text", text: r.output ?? String(r) ?? "" }];
const withImage = (r, image) => {
  const c = contentOf(r);
  if (image) c.push({ type: "image", data: image.data, mimeType: image.mime || "image/png" });
  return c;
};

const IMPL = {
  computer_screenshot: async () => { const r = await screenshot(); return { c: [{ type: "text", text: `屏幕截图 ${r.width || "?"}x${r.height || "?"}` }, { type: "image", data: r.image.data, mimeType: r.image.mime }] }; },
  computer_click: async (a) => ({ c: contentOf(await click(a.x, a.y, a.button || "left")) }),
  computer_type: async (a) => ({ c: contentOf(await type(String(a.text))) }),
  computer_key: async (a) => ({ c: contentOf(await key(String(a.key))) }),
  computer_scroll: async (a) => ({ c: contentOf(await scroll(a.amount)) }),
  computer_app_state: async (a) => ({ c: contentOf(await appState({ appHint: a.appHint })) }),
  computer_click_ref: async (a) => ({ c: contentOf(await clickElement(a.ref, { appHint: a.appHint, button: a.button, double: a.double })) }),
  computer_set_value: async (a) => ({ c: contentOf(await setElementValue(a.ref, String(a.text), { appHint: a.appHint })) }),
  computer_windows: async () => ({ c: contentOf(await listWindows()) }),
  clipboard_read: async () => ({ c: contentOf(await clipboardGet()) }),
  clipboard_write: async (a) => ({ c: contentOf(await clipboardSet(String(a.text ?? ""))) }),
  browser_open: async (a) => { if (a.url && a.url !== "about:blank") return { c: contentOf(await browser.navigate(String(a.url))) }; const pg = await browser.page(); return { c: contentOf(await browser.describe(pg)) }; },
  browser_navigate: async (a) => ({ c: contentOf(await browser.navigate(String(a.url))) }),
  browser_snapshot: async () => ({ c: contentOf(await browser.snapshot().then((s) => ({ output: s.text }))) }),
  browser_click: async (a) => ({ c: contentOf(await browser.clickRef(String(a.ref), { button: a.button, double: a.double }).then((m) => ({ output: `已点击 [${a.ref}] → ${m.title}` }))) }),
  browser_type: async (a) => ({ c: contentOf(await browser.fillRef(String(a.ref), String(a.text), { submit: !!a.submit }).then((m) => ({ output: `已输入 [${a.ref}]` }))) }),
  browser_evaluate: async (a) => ({ c: contentOf(await browser.evaluate(String(a.js)).then((r) => ({ output: String(r).slice(0, 30000) }))) }),
  browser_screenshot: async (a) => { const r = await browser.screenshotPage({ fullPage: !!a.fullPage }); return { c: [{ type: "text", text: "页面截图" }, { type: "image", data: r.image.data, mimeType: r.image.mime }] }; },
  browser_close: async () => { browser.close(); return { c: [{ type: "text", text: "浏览器已关闭" }] }; },
};

// MCP stdio loop (JSON-RPC, newline-delimited not required by spec but ok; use LSP-style framing? codex rmcp uses newline JSON for stdio)
const rl = createInterface({ input: process.stdin });
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

rl.on("line", async (line) => {
  if (!line.trim()) return;
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.id == null) return; // notification
  const reply = (result) => send({ jsonrpc: "2.0", id: msg.id, result });
  try {
    if (msg.method === "initialize") {
      reply({ protocolVersion: msg.params?.protocolVersion || "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "openzcode-computer-browser", version: "0.1.0" } });
    } else if (msg.method === "tools/list") {
      reply({ tools: TOOLS });
    } else if (msg.method === "tools/call") {
      const fn = IMPL[msg.params?.name];
      if (!fn) return reply({ content: [{ type: "text", text: `未知工具 ${msg.params.name}` }], isError: true });
      const { c } = await fn(msg.params.arguments || {});
      reply({ content: c });
    } else {
      reply({});
    }
  } catch (e) {
    reply({ content: [{ type: "text", text: `错误: ${e.message}` }], isError: true });
  }
});
process.title = "openzcode-sidecar-computer";
