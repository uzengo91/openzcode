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
  `CREATE TABLE IF NOT EXISTS automations (
     id TEXT PRIMARY KEY, name TEXT NOT NULL, prompt TEXT NOT NULL, workspace TEXT,
     schedule TEXT NOT NULL, recurring INTEGER NOT NULL DEFAULT 1, max_runs INTEGER,
     mode TEXT NOT NULL DEFAULT 'yolo', enabled INTEGER NOT NULL DEFAULT 1,
     status TEXT NOT NULL DEFAULT 'active',
     run_count INTEGER NOT NULL DEFAULT 0, next_run_at TEXT, last_run_at TEXT,
     created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS automation_runs (
     id TEXT PRIMARY KEY, automation_id TEXT NOT NULL, session_id TEXT,
     started_at TEXT NOT NULL, finished_at TEXT, ok INTEGER, error TEXT, created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_runs_automation ON automation_runs(automation_id, started_at)`,
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

  /** full history rewrite (compact): wipes messages, inserts the new list */
  replaceMessages(sessionId, messages) {
    const run = this.db.transaction((sid, list) => {
      this.db.prepare("DELETE FROM message WHERE session_id = ?").run(sid);
      const ins = this.db.prepare("INSERT INTO message (id, session_id, role, parts, created_at) VALUES (?,?,?,?,?)");
      for (const m of list) {
        ins.run(id("msg"), sid, m.role, JSON.stringify(m.parts || []), m.createdAt || m.created_at || now());
      }
      this.touchSession(sid);
    });
    run(sessionId, messages);
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

  /* ---------------- automations ---------------- */

  _automationRow(r) {
    if (!r) return null;
    return {
      id: r.id, name: r.name, prompt: r.prompt, workspace: r.workspace,
      schedule: safeParse(r.schedule, {}), recurring: !!r.recurring,
      maxRuns: r.max_runs ?? null, mode: r.mode, enabled: !!r.enabled,
      status: r.status, runCount: r.run_count || 0,
      nextRunAt: r.next_run_at || null, lastRunAt: r.last_run_at || null,
      createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }

  automationCreate(a) {
    const row = {
      id: a.id, name: a.name, prompt: a.prompt, workspace: a.workspace || null,
      schedule: JSON.stringify(a.schedule), recurring: a.recurring ? 1 : 0,
      max_runs: a.maxRuns ?? null, mode: a.mode || "yolo", enabled: a.enabled === false ? 0 : 1,
      status: a.status || "active", run_count: a.runCount || 0, next_run_at: a.nextRunAt || null,
      last_run_at: a.lastRunAt || null, created_at: a.createdAt || now(), updated_at: now(),
    };
    this.db.prepare(
      "INSERT INTO automations (id, name, prompt, workspace, schedule, recurring, max_runs, mode, enabled, status, run_count, next_run_at, last_run_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
    ).run(row.id, row.name, row.prompt, row.workspace, row.schedule, row.recurring, row.max_runs, row.mode, row.enabled, row.status, row.run_count, row.next_run_at, row.last_run_at, row.created_at, row.updated_at);
    return this._automationRow(this.db.prepare("SELECT * FROM automations WHERE id = ?").get(a.id));
  }

  automationGet(id) { return this._automationRow(this.db.prepare("SELECT * FROM automations WHERE id = ?").get(id)); }

  automationList({ workspace } = {}) {
    const rows = workspace
      ? this.db.prepare("SELECT * FROM automations WHERE workspace = ? OR workspace IS NULL ORDER BY created_at DESC").all(workspace)
      : this.db.prepare("SELECT * FROM automations ORDER BY created_at DESC").all();
    return rows.map((r) => this._automationRow(r));
  }

  automationUpdate(id, fields) {
    const sets = ["updated_at = ?"]; const args = [now()];
    for (const [k, v] of Object.entries(fields)) {
      const col = { schedule: "schedule", enabled: "enabled", status: "status", nextRunAt: "next_run_at", lastRunAt: "last_run_at", runCount: "run_count", prompt: "prompt", name: "name", mode: "mode", maxRuns: "max_runs", recurring: "recurring" }[k];
      if (!col) continue;
      sets.push(`${col} = ?`);
      args.push(typeof v === "object" && v !== null ? JSON.stringify(v) : (typeof v === "boolean" ? (v ? 1 : 0) : v));
    }
    args.push(id);
    this.db.prepare(`UPDATE automations SET ${sets.join(", ")} WHERE id = ?`).run(...args);
    return this.automationGet(id);
  }

  automationDelete(id) {
    this.db.prepare("DELETE FROM automation_runs WHERE automation_id = ?").run(id);
    this.db.prepare("DELETE FROM automations WHERE id = ?").run(id);
  }

  /** atomic claim: only fires if next_run_at still equals expected (prevents double-fire) */
  automationClaim(id, expectedNextRunAt, newNextRunAt) {
    const r = this.db.prepare(
      "UPDATE automations SET next_run_at = ?, updated_at = ? WHERE id = ? AND next_run_at = ?"
    ).run(newNextRunAt, now(), id, expectedNextRunAt);
    return r.changes === 1;
  }

  dueAutomations(nowIso) {
    return this.db.prepare("SELECT * FROM automations WHERE enabled = 1 AND status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at")
      .all(nowIso).map((r) => this._automationRow(r));
  }

  automationRunStart({ id, automationId, sessionId }) {
    this.db.prepare(
      "INSERT INTO automation_runs (id, automation_id, session_id, started_at, created_at) VALUES (?,?,?,?,?)"
    ).run(id, automationId, sessionId || null, now(), now());
  }

  automationRunFinish(runId, { sessionId, ok, error }) {
    this.db.prepare(
      "UPDATE automation_runs SET finished_at = ?, session_id = ?, ok = ?, error = ? WHERE id = ?"
    ).run(now(), sessionId || null, ok ? 1 : 0, error || null, runId);
  }

  automationRuns(automationId, { limit = 20 } = {}) {
    return this.db.prepare("SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY started_at DESC LIMIT ?")
      .all(automationId, limit)
      .map((r) => ({
        id: r.id, automationId: r.automation_id, sessionId: r.session_id,
        startedAt: r.started_at, finishedAt: r.finished_at, ok: r.ok == null ? null : !!r.ok,
        error: r.error || null,
      }));
  }

  close() { try { this.db.close(); } catch {} }
}

function safeParse(s, dflt) { try { return JSON.parse(s); } catch { return dflt; } }

module.exports = { SqliteStorage };
