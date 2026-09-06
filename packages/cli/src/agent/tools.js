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

  return new Promise((resolve) => {
    execFile(
      "/bin/bash",
      ["-c", cmd],
      {
        cwd,
        timeout: timeoutSec * 1000,
        maxBuffer: 10 * 1024 * 1024,
        killSignal: "SIGTERM",
        env: {
          ...process.env,
          OPENZCODE_SESSION_ID: ctx.sessionId || "",
          OPENZCODE_WORKSPACE: cwd,
          TERM: "dumb",
          NO_COLOR: "1",
        },
      },
      (err, stdout, stderr) => {
        let out = "";
        if (stdout) out += stdout;
        if (stderr) out += (out ? "\n--- stderr ---\n" : "") + stderr;
        if (!out && err && err.code !== 0) out = `(无输出, 退出码 ${err.code ?? "?"})`;
        if (err && err.killed) out += `\n[命令超时被终止: ${timeoutSec}s]`;
        resolve(err && err.code !== 0 && err.killed !== true && !out.trim()
          ? errResult(`${err.message}\n退出码 ${err.code ?? "?"}`)
          : { ok: !(err && err.code !== 0), output: truncate(out || "(无输出)", "命令输出") });
      }
    );
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
];

const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

function getTool(name) { return TOOL_MAP.get(name) || null; }
function toolDefinitions() {
  return TOOLS.map(({ name, description, parameters, danger }) => ({ name, description, parameters, danger: !!danger }));
}

module.exports = { toolDefinitions, getTool, resolveInWorkspace, truncate, okResult, errResult, crypto };
