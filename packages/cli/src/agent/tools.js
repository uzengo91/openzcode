// Built-in tool registry: bash / file ops / glob / grep / todo / web_fetch.
// Each tool: { name, description, parameters (JSON Schema), danger, run(input, ctx) }
// danger=true → requires user approval when permissionMode is "ask".
"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");
const crypto = require("node:crypto");
const computer = require("../computer");
const { BrowserManager } = require("../browser");

const MAX_OUTPUT_CHARS = 30000;

function truncate(text, label) {
  if (typeof text !== "string") text = String(text ?? "");
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return text.slice(0, MAX_OUTPUT_CHARS) + `\n[... ${label || "输出"} 已截断，原始长度 ${text.length} 字符]`;
}

function resolveInWorkspace(workspace, p) {
  const abs = path.isAbsolute(p) ? path.normalize(p) : path.resolve(workspace, p);
  const inside =
    abs === workspace ||
    abs.startsWith(workspace.endsWith(path.sep) ? workspace : workspace + path.sep);
  return { abs, inside };
}

function okResult(text) { return { ok: true, output: truncate(text, "工具结果") }; }
function errResult(text) { return { ok: false, output: truncate(String(text), "错误输出") }; }

/* ------------------------------ bash ------------------------------ */

function runBash(input, ctx) {
  const cmd = String(input.command ?? "");
  if (!cmd.trim()) return Promise.resolve(errResult("command 不能为空"));
  const timeoutSec = Math.min(Math.max(Number(input.timeout_sec) || 60, 1), 600);
  const cwd = ctx.workspace;
  const isWin = process.platform === "win32";
  const opts = {
    cwd,
    timeout: timeoutSec * 1000,
    maxBuffer: 10 * 1024 * 1024,
    killSignal: "SIGTERM",
    windowsHide: true,
    env: {
      ...process.env,
      OPENZCODE_SESSION_ID: ctx.sessionId || "",
      OPENZCODE_WORKSPACE: cwd,
      TERM: "dumb",
      NO_COLOR: "1",
    },
  };

  return new Promise((resolve) => {
    const child = isWin
      ? execFile("cmd.exe", ["/d", "/s", "/c", cmd], opts, onDone)
      : execFile("/bin/bash", ["-c", cmd], opts, onDone);
    void child;

    function onDone(err, stdout, stderr) {
      let out = "";
      if (stdout) out += stdout;
      if (stderr) out += (out ? "\n--- stderr ---\n" : "") + stderr;
      if (!out && err && err.code !== 0) out = `(无输出, 退出码 ${err.code ?? "?"})`;
      if (err && err.killed) out += `\n[命令超时被终止: ${timeoutSec}s]`;
      resolve(err && err.code !== 0 && err.killed !== true && !out.trim()
        ? errResult(`${err.message}\n退出码 ${err.code ?? "?"}`)
        : { ok: !(err && err.code !== 0), output: truncate(out || "(无输出)", "命令输出") });
    }
  });
}

/* ------------------------------ file tools ------------------------------ */

async function runReadFile(input, ctx) {
  const p = String(input.path ?? "");
  if (!p) return errResult("path 不能为空");
  const { abs } = resolveInWorkspace(ctx.workspace, p);
  let stat;
  try { stat = await fsp.stat(abs); } catch { return errResult(`文件不存在: ${p}`); }
  if (stat.isDirectory()) return errResult(`是目录不是文件: ${p} (可用 list_dir)`);
  if (stat.size > 2 * 1024 * 1024) return errResult(`文件过大 (${stat.size} 字节)，请用 bash 查看片段`);

  const raw = await fsp.readFile(abs, "utf8");
  const lines = raw.split("\n");
  const offset = Math.max(Number(input.offset) || 1, 1);
  const limit = Math.min(Number(input.limit) || 2000, 2000);
  const slice = lines.slice(offset - 1, offset - 1 + limit);
  const numbered = slice.map((l, i) => `${String(offset + i).padStart(6)}\t${l}`).join("\n");
  let out = numbered || "(空文件)";
  if (offset - 1 + limit < lines.length) out += `\n[... 还有 ${lines.length - (offset - 1 + limit)} 行, 用 offset/limit 继续]`;
  return okResult(out);
}

async function runWriteFile(input, ctx) {
  const p = String(input.path ?? "");
  if (!p) return errResult("path 不能为空");
  const { abs } = resolveInWorkspace(ctx.workspace, p);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, String(input.content ?? ""), "utf8");
  return okResult(`已写入 ${p} (${(input.content ?? "").length} 字符)`);
}

async function runEditFile(input, ctx) {
  const p = String(input.path ?? "");
  const oldStr = String(input.old_string ?? "");
  const newStr = String(input.new_string ?? "");
  if (!p || !oldStr) return errResult("path 与 old_string 不能为空");
  if (oldStr === newStr) return errResult("old_string 与 new_string 相同");
  const { abs } = resolveInWorkspace(ctx.workspace, p);
  let content;
  try { content = await fsp.readFile(abs, "utf8"); } catch { return errResult(`文件不存在: ${p}`); }

  const count = content.split(oldStr).length - 1;
  if (count === 0) return errResult(`old_string 在文件中未找到，请先用 read_file 确认精确内容(含缩进)`);
  if (count > 1 && !input.replace_all) {
    return errResult(`old_string 出现 ${count} 次，不唯一。请提供更长的上下文，或设置 replace_all=true`);
  }
  const updated = input.replace_all ? content.split(oldStr).join(newStr) : content.replace(oldStr, newStr);
  await fsp.writeFile(abs, updated, "utf8");
  return okResult(`已编辑 ${p} (替换 ${input.replace_all ? count : 1} 处)`);
}

async function runListDir(input, ctx) {
  const p = String(input.path ?? ".");
  const { abs } = resolveInWorkspace(ctx.workspace, p);
  let entries;
  try { entries = await fsp.readdir(abs, { withFileTypes: true }); }
  catch (e) { return errResult(`无法读取目录 ${p}: ${e.message}`); }
  const dirs = [], files = [];
  for (const e of entries) (e.isDirectory() ? dirs : files).push(e.name);
  const fmt = (names, mark) => names.sort().slice(0, 500).map((n) => mark + n);
  const out = [
    `${p}/`,
    ...fmt(dirs, ""),
    ...fmt(files, ""),
  ].join("\n");
  const total = dirs.length + files.length;
  return okResult(out + (total > 500 ? `\n[... 共 ${total} 项，已截断]` : ""));
}

/* ------------------------------ glob / grep ------------------------------ */

function globToRegExp(pattern) {
  // supports **, *, ? with path awareness
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") { re += "(?:.*)"; i++; if (pattern[i + 1] === "/") i++; }
      else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + re + "$");
}

async function walkFiles(root, maxFiles = 4000) {
  const out = [];
  const skip = new Set(["node_modules", ".git", "dist", ".DS_Store"]);
  async function walk(dir, depth) {
    if (depth > 8 || out.length >= maxFiles) return;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= maxFiles) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (skip.has(e.name)) continue;
        await walk(full, depth + 1);
      } else out.push(full);
    }
  }
  await walk(root, 0);
  return out;
}

async function runGlob(input, ctx) {
  const pattern = String(input.pattern ?? "");
  if (!pattern) return errResult("pattern 不能为空");
  const base = resolveInWorkspace(ctx.workspace, String(input.path ?? ".")).abs;
  if (typeof fs.globSync === "function") {
    try {
      const found = fs.globSync(pattern, { cwd: base });
      const rel = found.map((f) => path.relative(base, f)).sort().slice(0, 500);
      return okResult(rel.join("\n") || "(无匹配)");
    } catch {}
  }
  // fallback matcher
  const re = globToRegExp(pattern);
  const files = await walkFiles(base);
  const rel = files.map((f) => path.relative(base, f)).filter((f) => re.test(f)).sort().slice(0, 500);
  return okResult(rel.join("\n") || "(无匹配)");
}

function isBinaryBuf(buf) {
  const n = Math.min(buf.length, 1024);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

async function grepWithRipgrep(pattern, base, glob, maxResults) {
  const args = ["-n", "--no-heading", "-S", "--max-count", "5", pattern, base];
  if (glob) args.push("-g", glob);
  if (maxResults) args.push("-m", String(maxResults));
  return new Promise((resolve) => {
    execFile("rg", args, { maxBuffer: 8 * 1024 * 1024, timeout: 20000 }, (err, stdout) => {
      if (err && !stdout) return resolve(null);
      resolve(stdout || "");
    });
  });
}

async function runGrep(input, ctx) {
  const pattern = String(input.pattern ?? "");
  if (!pattern) return errResult("pattern 不能为空");
  const base = resolveInWorkspace(ctx.workspace, String(input.path ?? ".")).abs;
  const glob = input.glob ? String(input.glob) : null;
  const maxResults = Math.min(Number(input.max_results) || 200, 500);

  const rgOut = await grepWithRipgrep(pattern, base, glob, maxResults);
  if (rgOut !== null) {
    const lines = rgOut.split("\n").filter(Boolean).slice(0, maxResults);
    return okResult(lines.join("\n") || "(无匹配)");
  }

  // pure-JS fallback
  let re;
  try { re = new RegExp(pattern, "i"); } catch (e) { return errResult(`无效的正则: ${e.message}`); }
  const files = await walkFiles(base);
  const hits = [];
  for (const f of files) {
    if (glob && !globToRegExp(glob).test(path.relative(base, f)) && !globToRegExp(glob).test(path.basename(f))) continue;
    let buf;
    try { buf = await fsp.readFile(f); } catch { continue; }
    if (isBinaryBuf(buf)) continue;
    const text = buf.toString("utf8");
    const lines = text.split("\n");
    for (let i = 0; i < lines.length && hits.length < maxResults; i++) {
      if (re.test(lines[i])) hits.push(`${f}:${i + 1}: ${lines[i].trim().slice(0, 300)}`);
    }
    if (hits.length >= maxResults) break;
  }
  return okResult(hits.join("\n") || "(无匹配)");
}

/* ------------------------------ todo ------------------------------ */

function runTodoWrite(input, ctx) {
  const items = Array.isArray(input.items) ? input.items : [];
  const clean = items.slice(0, 100).map((t) => ({
    content: String(t.content ?? "").slice(0, 500),
    status: ["pending", "in_progress", "completed"].includes(t.status) ? t.status : "pending",
    priority: ["high", "medium", "low"].includes(t.priority) ? t.priority : "medium",
  }));
  ctx.storage.setTodos(ctx.sessionId, clean);
  ctx.emit({ type: "todo_updated", items: clean });
  return Promise.resolve(okResult(`已更新任务清单 (${clean.length} 项)`));
}

/* ------------------------------ web_fetch ------------------------------ */

async function runWebFetch(input, ctx) {
  const url = String(input.url ?? "");
  if (!/^https?:\/\//.test(url)) return errResult("url 必须以 http(s):// 开头");
  const maxChars = Math.min(Number(input.max_chars) || 20000, 100000);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error("fetch 超时(20s)")), 20000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "user-agent": "Mozilla/5.0 (OpenZCode MVP)", accept: "text/html,text/plain,*/*" },
      redirect: "follow",
    });
    const ctype = res.headers.get("content-type") || "";
    if (!res.ok) return errResult(`HTTP ${res.status} ${res.statusText}`);
    const raw = await res.text();
    let text = raw;
    if (ctype.includes("html")) {
      text = raw
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
        .replace(/[ \t]+/g, " ")
        .replace(/\n\s*\n+/g, "\n\n")
        .trim();
    }
    return okResult(`[${res.status} ${ctype}]\n` + truncate(text.slice(0, maxChars), "网页内容"));
  } catch (e) {
    return errResult(`抓取失败: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------ web search ------------------------------ */

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
}

function stripTags(s) {
  return decodeEntities(String(s).replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

async function runWebSearch(input) {
  const query = String(input.query ?? "").trim();
  if (!query) return errResult("query 不能为空");
  const engine = input.engine === "duckduckgo" ? "duckduckgo" : "bing";
  const count = Math.min(Math.max(Number(input.count) || 6, 1), 10);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error("搜索超时(20s)")), 20000);
  try {
    let html;
    if (engine === "bing") {
      const res = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${count + 4}&setmkt=en-US&setlang=en`, {
        signal: ctrl.signal,
        headers: {
          "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
          "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
        },
      });
      if (!res.ok) return errResult(`Bing HTTP ${res.status}`);
      html = await res.text();
    } else {
      const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
        signal: ctrl.signal,
        headers: { "user-agent": "Mozilla/5.0 (OpenZCode)" },
      });
      if (!res.ok) return errResult(`DuckDuckGo HTTP ${res.status}`);
      html = await res.text();
    }

    const results = [];
    if (engine === "bing") {
      const itemRe = /<li class="b_algo"[\s\S]*?<\/li>/g;
      let m;
      while ((m = itemRe.exec(html)) && results.length < count) {
        const item = m[0];
        const urlM = /<h2[^>]*><a[^>]+href="(https?:\/\/[^"]+)"/.exec(item);
        if (!urlM) continue;
        const title = stripTags(/<h2[^>]*>([\s\S]*?)<\/h2>/.exec(item)?.[1] || "");
        const snippet = stripTags(/<p[^>]*>([\s\S]*?)<\/p>/.exec(item)?.[1] || /<div class="b_caption"[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/.exec(item)?.[1] || "");
        results.push({ title, url: decodeEntities(urlM[1]), snippet: snippet.slice(0, 300) });
      }
    } else {
      const itemRe = /<a rel="nofollow" class="result__a" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
      const snipRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
      const snippets = [];
      let sm;
      while ((sm = snipRe.exec(html))) snippets.push(stripTags(sm[1]));
      let im, i = 0;
      while ((im = itemRe.exec(html)) && results.length < count) {
        let url = decodeEntities(im[1]);
        const uddg = /uddg=([^&]+)/.exec(url);
        if (uddg) url = decodeURIComponent(uddg[1]);
        results.push({ title: stripTags(im[2]), url, snippet: (snippets[i] || "").slice(0, 300) });
        i++;
      }
    }

    if (!results.length) return errResult(`搜索无结果 (${engine}) — 可尝试换 engine 或调整关键词`);
    const out = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join("\n");
    return okResult(`[${engine} 搜索: ${query}] 共 ${results.length} 条\n\n${out}`);
  } catch (e) {
    return errResult(`搜索失败: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------ computer use / browser ------------------------------ */

let sharedBrowser = null;
function browserMgr() {
  if (!sharedBrowser) sharedBrowser = new BrowserManager();
  return sharedBrowser;
}

const COMPUTER_TOOLS = [
  {
    name: "computer_screenshot",
    description: "截取当前屏幕并作为图像返回给模型。GUI 自动化前先观察屏幕。返回屏幕尺寸信息。",
    parameters: { type: "object", properties: {} },
    run: async () => {
      const r = await computer.screenshot();
      return { ok: true, output: `屏幕截图 ${r.width || "?"}x${r.height || "?"} 已返回 (${computer.platform})`, image: r.image };
    },
  },
  {
    name: "computer_click",
    description: "在屏幕坐标 (x, y) 点击。button: left(默认)/right/double。先 computer_screenshot 观察后再确定坐标。",
    parameters: {
      type: "object",
      properties: {
        x: { type: "number", description: "屏幕横坐标(像素)" },
        y: { type: "number", description: "屏幕纵坐标(像素)" },
        button: { type: "string", enum: ["left", "right", "double"] },
      },
      required: ["x", "y"],
    },
    danger: true,
    run: async (input) => {
      await computer.click(input.x, input.y, input.button || "left");
      return { ok: true, output: `已在 (${Math.round(input.x)}, ${Math.round(input.y)}) ${input.button || "left"} 点击` };
    },
  },
  {
    name: "computer_type",
    description: "向当前焦点窗口输入文本(相当于键盘输入)。",
    parameters: {
      type: "object",
      properties: { text: { type: "string", description: "要输入的文本" } },
      required: ["text"],
    },
    danger: true,
    run: async (input) => {
      await computer.type(String(input.text));
      return { ok: true, output: `已输入 ${String(input.text).length} 字符` };
    },
  },
  {
    name: "computer_key",
    description: "按组合键。格式 'cmd+c' / 'ctrl+shift+t' / 'Return' / 'Escape' / 'Tab' / 'Up' 等。macOS 的 cmd 即 ⌘。",
    parameters: {
      type: "object",
      properties: { key: { type: "string", description: "组合键描述" } },
      required: ["key"],
    },
    danger: true,
    run: async (input) => {
      await computer.key(String(input.key));
      return { ok: true, output: `已按下 ${input.key}` };
    },
  },
  {
    name: "computer_scroll",
    description: "滚动当前窗口。amount 正数向上、负数向下, 幅度 1-20。",
    parameters: {
      type: "object",
      properties: { amount: { type: "number", description: "滚动格数, 正上负下" } },
      required: ["amount"],
    },
    danger: true,
    run: async (input) => {
      await computer.scroll(input.amount);
      return { ok: true, output: `已滚动 ${input.amount}` };
    },
  },
];

const BROWSER_TOOLS = [
  {
    name: "browser_open",
    description: "打开浏览器(无头, 优先本机 Chrome/Edge)并导航到 URL。返回页面标题与地址。之后用 browser_snapshot 查看页面结构。",
    parameters: {
      type: "object",
      properties: { url: { type: "string", description: "完整 URL, 默认 about:blank" } },
    },
    run: async (input) => {
      const url = String(input.url || "about:blank");
      if (!/^https?:\/\//.test(url) && url !== "about:blank") return { ok: false, output: "url 必须以 http(s):// 开头" };
      if (url === "about:blank") {
        const page = await browserMgr().page();
        return { ok: true, output: JSON.stringify(await browserMgr().describe(page)) };
      }
      return { ok: true, output: JSON.stringify(await browserMgr().navigate(url)) };
    },
  },
  {
    name: "browser_navigate",
    description: "在已打开的浏览器中跳转到新 URL。",
    parameters: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    },
    run: async (input) => ({ ok: true, output: JSON.stringify(await browserMgr().navigate(String(input.url))) }),
  },
  {
    name: "browser_snapshot",
    description: "获取当前页面的可访问性快照(YAML 树), 元素带 [ref=eN] 引用 — 这是点击/输入的唯一事实来源, 禁止猜测选择器。",
    parameters: { type: "object", properties: {} },
    run: async () => ({ ok: true, output: (await browserMgr().snapshot()).text }),
  },
  {
    name: "browser_click",
    description: "点击 browser_snapshot 返回的 [ref=eN] 元素。button: left/right, double: 双击。",
    parameters: {
      type: "object",
      properties: {
        ref: { type: "string", description: "快照中的元素引用, 如 e12" },
        button: { type: "string", enum: ["left", "right"] },
        double: { type: "boolean" },
      },
      required: ["ref"],
    },
    danger: true,
    run: async (input) => {
      const meta = await browserMgr().clickRef(String(input.ref), { button: input.button, double: !!input.double });
      return { ok: true, output: `已点击 [${input.ref}] → ${meta.title} ${meta.url}` };
    },
  },
  {
    name: "browser_type",
    description: "向快照中 [ref=eN] 的输入框填入文本; submit=true 时回车提交。",
    parameters: {
      type: "object",
      properties: {
        ref: { type: "string" },
        text: { type: "string" },
        submit: { type: "boolean" },
      },
      required: ["ref", "text"],
    },
    danger: true,
    run: async (input) => {
      const meta = await browserMgr().fillRef(String(input.ref), String(input.text), { submit: !!input.submit });
      return { ok: true, output: `已在 [${input.ref}] 输入${input.submit ? " 并回车" : ""} → ${meta.title}` };
    },
  },
  {
    name: "browser_evaluate",
    description: "在页面上下文执行 JS 并返回结果(可 async)。用于读取页面数据。",
    parameters: {
      type: "object",
      properties: { js: { type: "string", description: "JS 代码, 如 return document.title" } },
      required: ["js"],
    },
    danger: true,
    run: async (input) => ({ ok: true, output: (await browserMgr().evaluate(String(input.js))).slice(0, MAX_OUTPUT_CHARS) }),
  },
  {
    name: "browser_screenshot",
    description: "对当前页面截图并作为图像返回给模型。",
    parameters: {
      type: "object",
      properties: { fullPage: { type: "boolean", description: "整页截图, 默认视口" } },
    },
    run: async (input) => {
      const r = await browserMgr().screenshotPage({ fullPage: !!input.fullPage });
      return { ok: true, output: "页面截图已返回", image: r.image };
    },
  },
  {
    name: "browser_close",
    description: "关闭浏览器并释放资源。",
    parameters: { type: "object", properties: {} },
    run: async () => {
      browserMgr().close();
      return { ok: true, output: "浏览器已关闭" };
    },
  },
];

/* ------------------------------ registry ------------------------------ */

const TOOLS = [
  {
    name: "bash",
    description: "在工作目录中执行一条 bash 命令并返回 stdout/stderr。适合 ls、git、npm、构建、测试等。长输出会被截断。",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "要执行的 bash 命令" },
        timeout_sec: { type: "number", description: "超时秒数, 默认 60, 最大 600" },
      },
      required: ["command"],
    },
    danger: true,
    run: runBash,
  },
  {
    name: "read_file",
    description: "读取文本文件内容(带行号)。大文件用 offset/limit 分段读取。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径(相对工作目录或绝对路径)" },
        offset: { type: "number", description: "起始行(1-based), 默认 1" },
        limit: { type: "number", description: "读取行数, 默认 2000" },
      },
      required: ["path"],
    },
    run: runReadFile,
  },
  {
    name: "write_file",
    description: "创建或覆盖文件。目录不存在会自动创建。覆盖已有文件前建议先 read_file。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "目标文件路径" },
        content: { type: "string", description: "完整文件内容" },
      },
      required: ["path", "content"],
    },
    danger: true,
    run: runWriteFile,
  },
  {
    name: "edit_file",
    description: "对文件做精确字符串替换(类似 str_replace)。old_string 必须与文件内容逐字符匹配且唯一, 否则会报错。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "目标文件路径" },
        old_string: { type: "string", description: "要被替换的精确原文(含缩进)" },
        new_string: { type: "string", description: "替换后的新文本" },
        replace_all: { type: "boolean", description: "替换全部出现, 默认 false" },
      },
      required: ["path", "old_string", "new_string"],
    },
    danger: true,
    run: runEditFile,
  },
  {
    name: "list_dir",
    description: "列出目录内容(子目录在前)。",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "目录路径, 默认工作目录" } },
    },
    run: runListDir,
  },
  {
    name: "glob",
    description: "按 glob 模式匹配文件路径, 支持 ** 和 *。",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "glob 模式, 如 src/**/*.js" },
        path: { type: "string", description: "搜索根目录, 默认工作目录" },
      },
      required: ["pattern"],
    },
    run: runGlob,
  },
  {
    name: "grep",
    description: "在文件内容中做正则搜索(优先用 ripgrep)。返回 文件:行号: 内容 列表。",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "正则表达式" },
        path: { type: "string", description: "搜索根目录, 默认工作目录" },
        glob: { type: "string", description: "文件名过滤, 如 *.ts" },
        max_results: { type: "number", description: "最多返回条数, 默认 200" },
      },
      required: ["pattern"],
    },
    run: runGrep,
  },
  {
    name: "todo_write",
    description: "维护当前任务清单(计划/进度)。多步骤任务应先写清单, 完成一步更新一步。",
    parameters: {
      type: "object",
      properties: {
        items: {
          type: "array",
          description: "任务列表(全量覆盖)",
          items: {
            type: "object",
            properties: {
              content: { type: "string", description: "任务描述" },
              status: { type: "string", enum: ["pending", "in_progress", "completed"] },
              priority: { type: "string", enum: ["high", "medium", "low"] },
            },
            required: ["content"],
          },
        },
      },
      required: ["items"],
    },
    run: runTodoWrite,
  },
  {
    name: "web_fetch",
    description: "抓取一个网页 URL, 返回正文文本(HTML 会去标签)。",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "完整 URL" },
        max_chars: { type: "number", description: "最多返回字符数, 默认 20000" },
      },
      required: ["url"],
    },
    run: runWebFetch,
  },
  {
    name: "web_search",
    description: "网页搜索: 返回搜索结果的标题/URL/摘要列表(默认 Bing 国际版, 可选 duckduckgo)。时效性问题优先用本工具, 再用 web_fetch 打开具体结果。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索关键词" },
        engine: { type: "string", enum: ["bing", "duckduckgo"], description: "搜索引擎, 默认 bing" },
        count: { type: "number", description: "结果数量上限, 默认 6, 最大 10" },
      },
      required: ["query"],
    },
    run: runWebSearch,
  },
  {
    name: "skill",
    description: "加载一个技能(Skill)的完整说明到上下文。当用户任务匹配系统提示中列出的技能描述时,先调用本工具,再按技能说明执行。可用 name 见系统提示的技能清单。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "技能名(见系统提示技能清单)" },
        args: { type: "string", description: "传给技能的附加参数(可选)" },
      },
      required: ["name"],
    },
    run: (input, ctx) => {
      if (!ctx.skills) return Promise.resolve(errResult("技能系统不可用"));
      const r = ctx.skills.loadForAgent(String(input.name || ""), input.args ? String(input.args) : null);
      if (r.ok) ctx.emit && ctx.emit({ type: "skill_loaded", name: r.skill.name, scope: r.skill.dir });
      return Promise.resolve(r);
    },
  },
  {
    name: "CronCreate",
    description: "创建一个定时自动化任务: 到点后引擎会以该提示词自动开起新会话并执行。三种调度方式二选一: cron 表达式 / interval+intervalUnit 循环 / delayMinutes 一次性延迟。",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "自动化标题(保留用户的自然语言时间表述,如 '每20分钟' '每天早上9点')" },
        prompt: { type: "string", description: "到点后要执行的完整任务提示词(必须自包含,不依赖当前对话上下文)" },
        cron: { type: "string", description: "5字段 cron 表达式(本地时区), 如 '0 9 * * 1-5'" },
        interval: { type: "number", description: "循环间隔数值(1-200), 与 intervalUnit 搭配" },
        intervalUnit: { type: "string", enum: ["minute", "hour", "day"], description: "循环间隔单位" },
        delayMinutes: { type: "number", description: "一次性延迟分钟数(与 cron/interval 互斥)" },
        recurring: { type: "boolean", description: "是否循环, 默认 cron/interval 为 true, delayMinutes 为 false" },
        maxRuns: { type: "number", description: "有限次数: 最多执行 N 次后自动完成(可选)" },
        mode: { type: "string", enum: ["yolo", "ask"], description: "无人值守执行权限模式, 默认 yolo" },
      },
      required: ["title", "prompt"],
    },
    run: (input, ctx) => {
      if (!ctx.automations) return Promise.resolve(errResult("自动化系统不可用"));
      return ctx.automations.createFromTool(input);
    },
  },
  {
    name: "CronList",
    description: "列出当前全部自动化任务(含状态与下次运行时间)。",
    parameters: { type: "object", properties: {} },
    run: (input, ctx) => {
      if (!ctx.automations) return Promise.resolve(errResult("自动化系统不可用"));
      return Promise.resolve(ctx.automations.listForTool());
    },
  },
  {
    name: "CronUpdate",
    description: "修改自动化任务: 更换调度/提示词/启停等。未提供的字段保持不变。",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "自动化 id (CronList 获得)" },
        title: { type: "string" },
        prompt: { type: "string" },
        cron: { type: "string" },
        interval: { type: "number" },
        intervalUnit: { type: "string", enum: ["minute", "hour", "day"] },
        delayMinutes: { type: "number" },
        enabled: { type: "boolean" },
        maxRuns: { type: "number" },
        mode: { type: "string", enum: ["yolo", "ask"] },
      },
      required: ["id"],
    },
    run: (input, ctx) => {
      if (!ctx.automations) return Promise.resolve(errResult("自动化系统不可用"));
      return Promise.resolve(ctx.automations.updateFromTool(input));
    },
  },
  {
    name: "CronDelete",
    description: "删除一个自动化任务。",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "自动化 id" } },
      required: ["id"],
    },
    run: (input, ctx) => {
      if (!ctx.automations) return Promise.resolve(errResult("自动化系统不可用"));
      return Promise.resolve(ctx.automations.deleteFromTool(String(input.id || "")));
    },
  },
  {
    name: "AskUserQuestion",
    description: "向用户提出一个结构化问题(2-4 个选项)。遇到需求歧义、方案选择时使用; 用户的选择会作为工具结果返回。",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "完整的问题" },
        header: { type: "string", description: "简短主题标签(≤12字符)" },
        options: {
          type: "array",
          description: "2-4 个选项",
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "选项标签(1-5 词)" },
              description: { type: "string", description: "该选项的含义/影响" },
            },
            required: ["label"],
          },
        },
        multiSelect: { type: "boolean", description: "是否允许多选" },
      },
      required: ["question", "options"],
    },
    run: (input, ctx) => {
      const options = (Array.isArray(input.options) ? input.options : []).map((o) => String(o.label ?? o)).filter(Boolean);
      if (options.length < 2 || options.length > 4) return Promise.resolve(errResult("options 需要 2-4 个"));
      if (!ctx.askUser) return Promise.resolve(errResult("当前环境不支持交互提问(非交互模式)"));
      return ctx.askUser({
        question: String(input.question ?? ""),
        header: String(input.header ?? "").slice(0, 12),
        options,
        multiSelect: !!input.multiSelect,
      });
    },
  },
  {
    name: "EnterPlanMode",
    description: "进入计划模式: 之后只能读取/搜索/产出计划, 写类工具(bash/写文件/编辑等)会被拒绝。先充分调研, 再用 ExitPlanMode 提交完整计划等待用户批准。",
    parameters: { type: "object", properties: {} },
    run: (input, ctx) => {
      if (!ctx.planMode) return Promise.resolve(errResult("计划模式不可用"));
      return ctx.planMode.enter();
    },
  },
  {
    name: "ExitPlanMode",
    description: "提交计划并请求用户批准。plan 参数为完整的实施计划(markdown)。批准后自动退出计划模式并开始执行; 拒绝则继续留在计划模式调整方案。",
    parameters: {
      type: "object",
      properties: {
        plan: { type: "string", description: "完整实施计划(markdown), 用户将逐条审阅" },
      },
      required: ["plan"],
    },
    run: (input, ctx) => {
      if (!ctx.planMode) return Promise.resolve(errResult("计划模式不可用"));
      return ctx.planMode.exit(String(input.plan ?? ""));
    },
  },
  {
    name: "Agent",
    description: "派发一个子代理在独立上下文中执行复杂多步任务, 只把最终结论带回主会话(不占用主上下文)。subagent_type: general-purpose(全部工具) / Explore(只读探索, 无写权限)。适合: 大范围搜索、独立调研、批量重复工作。",
    parameters: {
      type: "object",
      properties: {
        description: { type: "string", description: "任务简述(3-5词)" },
        prompt: { type: "string", description: "给子代理的完整任务描述(必须自包含)" },
        subagent_type: { type: "string", enum: ["general-purpose", "Explore"], description: "子代理类型, 默认 general-purpose" },
      },
      required: ["description", "prompt"],
    },
    danger: true,
    run: (input, ctx) => {
      if (!ctx.subagents) return Promise.resolve(errResult("子代理系统不可用"));
      return ctx.subagents.spawn({
        description: String(input.description ?? "子任务"),
        prompt: String(input.prompt ?? ""),
        type: input.subagent_type === "Explore" ? "Explore" : "general-purpose",
      });
    },
  },
  ...COMPUTER_TOOLS,
  ...BROWSER_TOOLS,
  {
    name: "memory_write",
    description: "把一条长期记忆写入当前工作区的记忆库(跨会话持久)。适合: 用户偏好、项目约定、重要结论。name 为短横线小写标识。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "记忆标识, 如 deploy-workflow" },
        body: { type: "string", description: "记忆正文(markdown), 可用 [[其他记忆名]] 链接" },
        description: { type: "string", description: "一句话摘要(索引用)" },
      },
      required: ["name", "body"],
    },
    run: (input, ctx) => {
      if (!ctx.memory) return Promise.resolve(errResult("记忆系统不可用"));
      return Promise.resolve(ctx.memory.write(ctx.workspace, String(input.name || ""), String(input.body ?? ""), String(input.description ?? "")));
    },
  },
  {
    name: "memory_read",
    description: "读取一条长期记忆(含 [[链接]] 的相关记忆列表)。name 不确定时可传 list 查看全部。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "记忆标识, 或 \"list\" 列出全部" },
      },
      required: ["name"],
    },
    run: (input, ctx) => {
      if (!ctx.memory) return Promise.resolve(errResult("记忆系统不可用"));
      const name = String(input.name || "").trim();
      if (name === "list" || name === "") {
        const items = ctx.memory.listIndex(ctx.workspace);
        return Promise.resolve({ ok: true, output: items.length ? items.map((i) => `- ${i.name}: ${i.description}`).join("\n") : "(记忆库为空 — 用 memory_write 写入)" });
      }
      return Promise.resolve(ctx.memory.read(ctx.workspace, name));
    },
  },
];

const ALL_TOOLS = TOOLS;
// Explore-type subagents temporarily swap the visible tool table
// (see src/subagent.js); null restores the full table.
let toolTableOverride = null;

function __setToolTableForSubagent(defs) {
  toolTableOverride = defs;
}
const TOOL_MAP = new Map(ALL_TOOLS.map((t) => [t.name, t]));

function getTool(name) {
  if (toolTableOverride) {
    const t = toolTableOverride.find((d) => d.name === name);
    return t || null;
  }
  return TOOL_MAP.get(name) || null;
}
function toolDefinitions() {
  const table = toolTableOverride || ALL_TOOLS;
  return table.map(({ name, description, parameters, danger }) => ({ name, description, parameters, danger: !!danger }));
}

function closeBrowser() { sharedBrowser && sharedBrowser.close(); }

module.exports = { toolDefinitions, getTool, __setToolTableForSubagent, closeBrowser, resolveInWorkspace, truncate, okResult, errResult, crypto };
