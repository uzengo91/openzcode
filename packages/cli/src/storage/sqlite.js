// SQLite storage via node:sqlite (built-in, no third-party driver), WAL mode —
// same approach as the reference architecture.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { dirs } = require("../paths");

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS session (
     id TEXT PRIMARY KEY, title TEXT, workspace TEXT, model TEXT, parent_id TEXT,
     created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS message (
     id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, parts TEXT NOT NULL,
     created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_message_session ON message(session_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS todo (
     session_id TEXT PRIMARY KEY, items TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS model_usage (
     id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, model TEXT,
     prompt_tokens INTEGER, completion_tokens INTEGER, duration_ms INTEGER, created_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS tool_usage (
     id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, tool TEXT,
     ok INTEGER, duration_ms INTEGER, created_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS permission (
     id TEXT PRIMARY KEY, session_id TEXT, tool TEXT, input TEXT, allowed INTEGER, created_at TEXT)`,
];

function now() { return new Date().toISOString(); }
function id(prefix) { return `${prefix}_${crypto.randomUUID()}`; }

class SqliteStorage {
  constructor(dbPath) {
    const { DatabaseSync } = require("node:sqlite");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    for (const ddl of MIGRATIONS) this.db.exec(ddl);
  }

  createSession({ title = "新会话", workspace, model = null, parentId = null }) {
    const s = { id: id("sess"), title, workspace, model, parent_id: parentId, created_at: now(), updated_at: now() };
    this.db.prepare(
      "INSERT INTO session (id, title, workspace, model, parent_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?)"
    ).run(s.id, s.title, s.workspace, s.model, s.parent_id, s.created_at, s.updated_at);
    return s;
  }

  touchSession(sessionId, { title, model } = {}) {
    const sets = ["updated_at = ?"]; const args = [now()];
    if (title !== undefined) { sets.push("title = ?"); args.push(title); }
    if (model !== undefined) { sets.push("model = ?"); args.push(model); }
    args.push(sessionId);
    this.db.prepare(`UPDATE session SET ${sets.join(", ")} WHERE id = ?`).run(...args);
  }

  listSessions({ workspace } = {}) {
    const rows = workspace
      ? this.db.prepare("SELECT * FROM session WHERE workspace = ? ORDER BY updated_at DESC LIMIT 200").all(workspace)
      : this.db.prepare("SELECT * FROM session ORDER BY updated_at DESC LIMIT 200").all();
    return rows;
  }

  getSession(sessionId) {
    return this.db.prepare("SELECT * FROM session WHERE id = ?").get(sessionId) || null;
  }

  deleteSession(sessionId) {
    this.db.prepare("DELETE FROM message WHERE session_id = ?").run(sessionId);
    this.db.prepare("DELETE FROM todo WHERE session_id = ?").run(sessionId);
    this.db.prepare("DELETE FROM session WHERE id = ?").run(sessionId);
  }

  appendMessage(sessionId, role, parts, { msgId } = {}) {
    const m = { id: msgId || id("msg"), session_id: sessionId, role, parts: JSON.stringify(parts), created_at: now() };
    this.db.prepare(
      "INSERT INTO message (id, session_id, role, parts, created_at) VALUES (?,?,?,?,?)"
    ).run(m.id, m.session_id, m.role, m.parts, m.created_at);
    this.touchSession(sessionId);
    return { ...m, parts: JSON.parse(m.parts) };
  }

  getMessages(sessionId) {
    return this.db.prepare("SELECT * FROM message WHERE session_id = ? ORDER BY created_at, rowid").all(sessionId)
      .map((r) => ({ ...r, parts: safeParse(r.parts, []) }));
  }

  setTodos(sessionId, items) {
    this.db.prepare(
      "INSERT INTO todo (session_id, items, updated_at) VALUES (?,?,?) " +
      "ON CONFLICT(session_id) DO UPDATE SET items = excluded.items, updated_at = excluded.updated_at"
    ).run(sessionId, JSON.stringify(items || []), now());
  }

  getTodos(sessionId) {
    const row = this.db.prepare("SELECT items FROM todo WHERE session_id = ?").get(sessionId);
    return row ? safeParse(row.items, []) : [];
  }

  recordModelUsage({ sessionId, model, promptTokens, completionTokens, durationMs }) {
    this.db.prepare(
      "INSERT INTO model_usage (session_id, model, prompt_tokens, completion_tokens, duration_ms, created_at) VALUES (?,?,?,?,?,?)"
    ).run(sessionId, model, promptTokens | 0, completionTokens | 0, durationMs | 0, now());
  }

  recordToolUse({ sessionId, tool, ok, durationMs }) {
    this.db.prepare(
      "INSERT INTO tool_usage (session_id, tool, ok, duration_ms, created_at) VALUES (?,?,?,?,?)"
    ).run(sessionId, tool, ok ? 1 : 0, durationMs | 0, now());
  }

  recordPermission({ permId, sessionId, tool, input, allowed }) {
    this.db.prepare(
      "INSERT OR REPLACE INTO permission (id, session_id, tool, input, allowed, created_at) VALUES (?,?,?,?,?,?)"
    ).run(permId, sessionId, tool, JSON.stringify(input), allowed ? 1 : 0, now());
  }

  close() { try { this.db.close(); } catch {} }
}

function safeParse(s, dflt) { try { return JSON.parse(s); } catch { return dflt; } }

module.exports = { SqliteStorage };
