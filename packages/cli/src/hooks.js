// Hooks engine — user/project/plugin hook scripts executed at lifecycle points.
// File format: an executable file whose first-line comment is
//   `# openzcode-hook: <Event> [toolName]`
// Event ∈ PreToolUse|PostToolUse|SessionStart|SessionStop|PermissionRequest.
// Also hooks.json: { "PreToolUse": [ { command, tool? } ] }
// Protocol: hook receives one JSON line on stdin; PreToolUse may answer
//   {"deny":true,"reason":"..."} or {"input":{...}}; PermissionRequest may
//   answer {"allow":bool}. 10s timeout per hook; failures never propagate.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");

const EVENTS = ["PreToolUse", "PostToolUse", "SessionStart", "SessionStop", "PermissionRequest"];
const HOOK_TIMEOUT_MS = Number(process.env.OPENZCODE_HOOK_TIMEOUT_MS) || 10000;

function hookDirs({ workspace, plugins }) {
  const base = process.env.OPENZCODE_CONFIG_DIR || path.join(os.homedir(), ".openzcode");
  const dirs = [{ dir: path.join(base, "hooks"), scope: "user" }];
  if (workspace) dirs.push({ dir: path.join(workspace, ".openzcode", "hooks"), scope: "project" });
  for (const p of plugins || []) dirs.push({ dir: path.join(p.dir, "hooks"), scope: `plugin:${p.name}` });
  return dirs;
}

function parseBinding(file, content) {
  const lines = (content || "").split(/\r?\n/).slice(0, 5);
  for (const line of lines) {
    if (!line || line.startsWith("#!")) continue; // shebang
    const m = /^#\s*openzcode-hook:\s*(\w+)(?:\s+(\S+))?/.exec(line.trim());
    if (m) {
      if (!EVENTS.includes(m[1])) return null;
      return { event: m[1], tool: m[2] || null };
    }
    if (line.trim() && !line.trim().startsWith("#")) break; // code before binding → not a hook
  }
  return null;
}

function isExecutable(st) {
  return !!(st.mode & 0o111) || process.platform === "win32";
}

function collectDir(dir, scope, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isDirectory()) continue;
    const full = path.join(dir, e.name);
    if (e.name === "hooks.json") continue;
    let content = "";
    try { content = fs.readFileSync(full, "utf8"); } catch { continue; }
    const binding = parseBinding(full, content);
    if (!binding) continue;
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    out.push({ event: binding.event, tool: binding.tool, name: e.name, file: full, scope, executable: isExecutable(st) });
  }
  // hooks.json command entries
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, "hooks.json"), "utf8"));
    for (const [event, list] of Object.entries(cfg)) {
      if (!EVENTS.includes(event) || !Array.isArray(list)) continue;
      for (const entry of list) {
        if (!entry || !entry.command) continue;
        out.push({ event, tool: entry.tool || null, name: entry.name || entry.command.slice(0, 40), command: entry.command, scope });
      }
    }
  } catch {}
}

function loadHooks({ workspace, plugins }) {
  const all = [];
  for (const { dir, scope } of hookDirs({ workspace, plugins })) collectDir(dir, scope, all);
  // priority: project > user > plugin — later scopes override same (event+tool+name)
  const rank = { project: 3, user: 2 };
  const byKey = new Map();
  for (const h of all) {
    const key = `${h.event}|${h.tool || "*"}|${h.name}`;
    const prev = byKey.get(key);
    if (!prev || (rank[h.scope] || 1) >= (rank[prev.scope] || 1)) byKey.set(key, h);
  }
  const hooks = [...byKey.values()];

  function match(event, toolName) {
    return hooks.filter((h) => h.event === event && (!h.tool || h.tool === toolName));
  }

  function runHook(hook, payload) {
    return new Promise((resolve) => {
      const input = JSON.stringify(payload);
      const done = (r) => resolve(r);
      const timer = setTimeout(() => done({ timedOut: true, output: null }), HOOK_TIMEOUT_MS);
      try {
        const isCmd = !!hook.command;
        let child;
        const hookEnv = { ...process.env, OPENZCODE_HOOK_EVENT: payload.event, OPENZCODE_HOOK_TOOL: payload.tool || "", OPENZCODE_SESSION_ID: payload.sessionId || "", OPENZCODE_WORKSPACE: payload.workspace || "" };
        if (isCmd) {
          // command snippets may contain shell syntax — run through the shell
          child = execFile(process.platform === "win32" ? "cmd.exe" : "/bin/sh", process.platform === "win32" ? ["/d", "/s", "/c", hook.command] : ["-c", hook.command], {
            timeout: HOOK_TIMEOUT_MS,
            maxBuffer: 1024 * 1024,
            windowsHide: true,
            env: hookEnv,
          }, (err, stdout) => {
            clearTimeout(timer);
            if (err && !stdout) return done({ error: err.message, output: null });
            done({ output: stdout || "" });
          });
        } else {
          child = execFile(hook.file, [], {
            timeout: HOOK_TIMEOUT_MS,
            maxBuffer: 1024 * 1024,
            windowsHide: true,
            env: hookEnv,
          }, (err, stdout) => {
            clearTimeout(timer);
            if (err && !stdout) return done({ error: err.message, output: null });
            done({ output: stdout || "" });
          });
        }
        child.stdin.end(input + "\n");
      } catch (e) {
        clearTimeout(timer);
        done({ error: e.message, output: null });
      }
    });
  }

  function firstJsonLine(stdout) {
    if (!stdout) return null;
    for (const line of String(stdout).split(/\r?\n/)) {
      const t = line.trim();
      if (!t.startsWith("{")) continue;
      try { return JSON.parse(t); } catch {}
    }
    return null;
  }

  async function preToolUse(toolName, input) {
    const matches = match("PreToolUse", toolName);
    let current = input;
    for (const hook of matches) {
      const r = await runHook(hook, { event: "PreToolUse", tool: toolName, input: current });
      const answer = firstJsonLine(r.output);
      if (answer && answer.deny) return { input: current, deny: true, reason: answer.reason || "被 hook 拦截" };
      if (answer && answer.input && typeof answer.input === "object") {
        current = { ...current, ...answer.input };
      }
    }
    return { input: current, deny: false };
  }

  async function postToolUse(toolName, input, result) {
    for (const hook of match("PostToolUse", toolName)) {
      await runHook(hook, { event: "PostToolUse", tool: toolName, input, result });
    }
  }

  async function sessionStart(ctx) {
    for (const hook of match("SessionStart")) await runHook(hook, { event: "SessionStart", ...ctx });
  }
  async function sessionStop(ctx) {
    for (const hook of match("SessionStop")) await runHook(hook, { event: "SessionStop", ...ctx });
  }
  async function permissionRequest(payload) {
    for (const hook of match("PermissionRequest", payload.tool)) {
      const r = await runHook(hook, { event: "PermissionRequest", ...payload });
      const answer = firstJsonLine(r.output);
      if (answer && typeof answer.allow === "boolean") return { allow: answer.allow };
    }
    return null;
  }

  return {
    list: () => hooks.map(({ event, tool, name, file, command, scope }) => ({ event, tool, name, file, command, scope })),
    preToolUse,
    postToolUse,
    sessionStart,
    sessionStop,
    permissionRequest,
  };
}

module.exports = { loadHooks, EVENTS, HOOK_TIMEOUT_MS };
