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

  /* ---------------- automations ---------------- */

  constructorInitAutomations() {
    if (!Array.isArray(this.data.automations)) this.data.automations = [];
    if (!Array.isArray(this.data.automation_runs)) this.data.automation_runs = [];
  }

  automationCreate(a) {
    this.constructorInitAutomations.call(this);
    const row = { ...a, enabled: a.enabled !== false, recurring: !!a.recurring, runCount: a.runCount || 0, createdAt: a.createdAt || now(), updatedAt: now() };
    this.data.automations.push(row);
    this._flush();
    return JSON.parse(JSON.stringify(row));
  }

  automationGet(id) { this.constructorInitAutomations.call(this); return this.data.automations.find((x) => x.id === id) || null; }

  automationList({ workspace } = {}) {
    this.constructorInitAutomations.call(this);
    return JSON.parse(JSON.stringify(
      this.data.automations.filter((a) => !workspace || !a.workspace || a.workspace === workspace)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    ));
  }

  automationUpdate(id, fields) {
    const a = this.automationGet(id);
    if (!a) return null;
    Object.assign(a, fields, { updatedAt: now() });
    this._flush();
    return JSON.parse(JSON.stringify(a));
  }

  automationDelete(id) {
    this.constructorInitAutomations.call(this);
    this.data.automations = this.data.automations.filter((x) => x.id !== id);
    this.data.automation_runs = this.data.automation_runs.filter((r) => r.automationId !== id);
    this._flush();
  }

  automationClaim(id, expectedNextRunAt, newNextRunAt) {
    const a = this.automationGet(id);
    if (!a || a.nextRunAt !== expectedNextRunAt) return false;
    a.nextRunAt = newNextRunAt;
    a.updatedAt = now();
    this._flush();
    return true;
  }

  dueAutomations(nowIso) {
    this.constructorInitAutomations.call(this);
    return JSON.parse(JSON.stringify(
      this.data.automations.filter((a) => a.enabled && a.status === "active" && a.nextRunAt && a.nextRunAt <= nowIso)
        .sort((a, b) => (a.nextRunAt < b.nextRunAt ? -1 : 1))
    ));
  }

  automationRunStart({ id, automationId, sessionId }) {
    this.constructorInitAutomations.call(this);
    this.data.automation_runs.push({ id, automationId, sessionId: sessionId || null, started_at: now(), finished_at: null, ok: null, error: null, created_at: now() });
    this._flush();
  }

  automationRunFinish(runId, { sessionId, ok, error }) {
    this.constructorInitAutomations.call(this);
    const r = this.data.automation_runs.find((x) => x.id === runId);
    if (r) { r.finished_at = now(); r.sessionId = sessionId || null; r.ok = !!ok; r.error = error || null; this._flush(); }
  }

  automationRuns(automationId, { limit = 20 } = {}) {
    this.constructorInitAutomations.call(this);
    return JSON.parse(JSON.stringify(
      this.data.automation_runs.filter((r) => r.automationId === automationId)
        .sort((a, b) => (a.started_at < b.started_at ? 1 : -1)).slice(0, limit)
    ));
  }

  close() { this._flush(); }
}

module.exports = { JsonStorage };
