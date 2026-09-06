// JSON-file storage fallback, same interface as SqliteStorage, for runtimes
// where node:sqlite is unavailable. Whole store kept in ~/.openzcode/db.json.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { dirs } = require("../paths");

function now() { return new Date().toISOString(); }
function id(prefix) { return `${prefix}_${crypto.randomUUID()}`; }
function safeParse(s, dflt) { try { return JSON.parse(s); } catch { return dflt; } }

class JsonStorage {
  constructor(dbPath) {
    this.path = dbPath;
    try {
      this.data = JSON.parse(fs.readFileSync(dbPath, "utf8"));
    } catch {
      this.data = { sessions: [], messages: [], todos: {}, model_usage: [], tool_usage: [], permission: [] };
    }
    for (const k of ["sessions", "messages", "model_usage", "tool_usage", "permission"]) {
      if (!Array.isArray(this.data[k])) this.data[k] = [];
    }
    if (!this.data.todos || typeof this.data.todos !== "object") this.data.todos = {};
  }

  _flush() {
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    fs.writeFileSync(this.path, JSON.stringify(this.data));
  }

  createSession({ title = "新会话", workspace, model = null, parentId = null }) {
    const s = { id: id("sess"), title, workspace, model, parent_id: parentId, created_at: now(), updated_at: now() };
    this.data.sessions.push(s);
    this._flush();
    return s;
  }

  touchSession(sessionId, { title, model } = {}) {
    const s = this.data.sessions.find((x) => x.id === sessionId);
    if (!s) return;
    s.updated_at = now();
    if (title !== undefined) s.title = title;
    if (model !== undefined) s.model = model;
    this._flush();
  }

  listSessions({ workspace } = {}) {
    const rows = this.data.sessions
      .filter((s) => !workspace || s.workspace === workspace)
      .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
      .slice(0, 200);
    return JSON.parse(JSON.stringify(rows));
  }

  getSession(sessionId) {
    return this.data.sessions.find((x) => x.id === sessionId) || null;
  }

  deleteSession(sessionId) {
    this.data.sessions = this.data.sessions.filter((x) => x.id !== sessionId);
    this.data.messages = this.data.messages.filter((x) => x.session_id !== sessionId);
    delete this.data.todos[sessionId];
    this._flush();
  }

  appendMessage(sessionId, role, parts, { msgId } = {}) {
    const m = { id: msgId || id("msg"), session_id: sessionId, role, parts, created_at: now() };
    this.data.messages.push(m);
    this.touchSession(sessionId);
    this._flush();
    return JSON.parse(JSON.stringify(m));
  }

  getMessages(sessionId) {
    return JSON.parse(JSON.stringify(this.data.messages.filter((x) => x.session_id === sessionId)));
  }

  setTodos(sessionId, items) {
    this.data.todos[sessionId] = { items: items || [], updated_at: now() };
    this._flush();
  }

  getTodos(sessionId) {
    const t = this.data.todos[sessionId];
    return t ? JSON.parse(JSON.stringify(t.items || [])) : [];
  }

  recordModelUsage({ sessionId, model, promptTokens, completionTokens, durationMs }) {
    this.data.model_usage.push({ sessionId, model, promptTokens: promptTokens | 0, completionTokens: completionTokens | 0, durationMs: durationMs | 0, created_at: now() });
    this._flush();
  }

  recordToolUse({ sessionId, tool, ok, durationMs }) {
    this.data.tool_usage.push({ sessionId, tool, ok: !!ok, durationMs: durationMs | 0, created_at: now() });
    this._flush();
  }

  recordPermission({ permId, sessionId, tool, input, allowed }) {
    this.data.permission.push({ id: permId, sessionId, tool, input, allowed: !!allowed, created_at: now() });
    this._flush();
  }

  close() { this._flush(); }
}

module.exports = { JsonStorage };
