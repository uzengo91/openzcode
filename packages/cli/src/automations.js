// Automations engine — schedule normalization, next-run computation, and the
// fire pipeline (claim → new session → agent turn → run record).
// Schedules:
//   {kind:"cron",  cron:"0 9 * * 1-5"}          recurring by calendar
//   {kind:"every", interval:20, unit:"minute"|"hour"|"day"}
//   {kind:"once",  delayMinutes:5}              one-shot relative delay
// Finite runs via maxRuns; disable via enabled=false; status: active|completed.
"use strict";

const cron = require("./cron");
const crypto = require("node:crypto");

const UNIT_MS = { minute: 60000, hour: 3600000, day: 86400000 };

function id(prefix) { return `${prefix}_${crypto.randomUUID()}`; }

function normalizeSchedule(input = {}) {
  if (input.cron) {
    const v = cron.validate(String(input.cron));
    if (!v.ok) throw new Error(`cron 表达式无效: ${v.error}`);
    return { kind: "cron", cron: String(input.cron) };
  }
  if (input.delayMinutes !== undefined) {
    const n = Number(input.delayMinutes);
    if (!Number.isFinite(n) || n <= 0) throw new Error("delayMinutes 必须为正数");
    return { kind: "once", delayMinutes: Math.min(n, 525600) };
  }
  if (input.interval !== undefined || input.intervalUnit) {
    const n = Number(input.interval);
    const unit = input.intervalUnit || "minute";
    if (!Number.isInteger(n) || n < 1 || n > 200) throw new Error("interval 必须是 1-200 的整数");
    if (!UNIT_MS[unit]) throw new Error(`intervalUnit 只支持 minute|hour|day`);
    return { kind: "every", interval: n, unit };
  }
  throw new Error("需要 cron / delayMinutes / interval+intervalUnit 之一");
}

/** first fire time for a fresh automation */
function firstRunAt(schedule, from = new Date()) {
  if (schedule.kind === "cron") return cron.nextRun(schedule.cron, from);
  if (schedule.kind === "once") return new Date(from.getTime() + schedule.delayMinutes * UNIT_MS.minute);
  return new Date(from.getTime() + schedule.interval * UNIT_MS[schedule.unit]);
}

/** next fire time after a run (recurring only); null → automation completed */
function nextAfterRun(automation, from = new Date()) {
  const { schedule } = automation;
  if (schedule.kind === "once") return null;
  if (schedule.kind === "cron") return cron.nextRun(schedule.cron, from);
  return new Date(from.getTime() + schedule.interval * UNIT_MS[schedule.unit]);
}

function describeSchedule(automation) {
  const s = automation.schedule || {};
  if (s.kind === "cron") return cron.describe(s.cron);
  if (s.kind === "once") return `${s.delayMinutes} 分钟后 (一次性)`;
  const unitZh = { minute: "分钟", hour: "小时", day: "天" }[s.unit] || s.unit;
  return `每 ${s.interval} ${unitZh}`;
}

function validateInput({ name, prompt, schedule, recurring, maxRuns, mode }) {
  if (!name || !String(name).trim()) throw new Error("自动化名称必填");
  if (!prompt || !String(prompt).trim()) throw new Error("自动化提示词 (prompt) 必填");
  const norm = normalizeSchedule(schedule);
  if (norm.kind === "once") {
    if (recurring) throw new Error("一次性任务 (delayMinutes) 不可设置 recurring=true");
  } else if (recurring === undefined) {
    recurring = true;
  }
  if (maxRuns !== undefined && maxRuns !== null && (!Number.isInteger(Number(maxRuns)) || Number(maxRuns) < 1)) {
    throw new Error("maxRuns 必须是正整数");
  }
  if (mode && !["yolo", "ask"].includes(mode)) throw new Error("mode 只支持 yolo | ask");
  return { schedule: norm, recurring: norm.kind === "once" ? false : !!recurring, maxRuns: maxRuns ?? null, mode: mode || "yolo" };
}

/**
 * Scheduler tick: claim due automations and fire them via `fire(automation)`.
 * Claim (compare-and-set on nextRunAt) guarantees a single firer across
 * processes sharing the SQLite db.
 */
async function tick({ storage, now, maxRunsPerTick = 5, fire }) {
  const nowIso = (now || new Date()).toISOString();
  const due = storage.dueAutomations(nowIso);
  let fired = 0;
  for (const a of due) {
    if (fired >= maxRunsPerTick) break;
    const next = nextAfterRun(a, new Date());
    const claimed = storage.automationClaim(
      a.id,
      a.nextRunAt,
      next ? next.toISOString() : null
    );
    if (!claimed) continue; // another process took it

    // completion bookkeeping
    const runCount = (a.runCount || 0) + 1;
    const exhausted = a.maxRuns != null && runCount >= a.maxRuns;
    const completed = next === null || exhausted;
    storage.automationUpdate(a.id, {
      runCount,
      lastRunAt: nowIso,
      nextRunAt: completed ? null : next.toISOString(),
      status: completed ? "completed" : "active",
    });

    fired++;
    await fire({ ...a, runCount, _scheduledFor: a.nextRunAt });
  }
  return fired;
}

module.exports = { normalizeSchedule, firstRunAt, nextAfterRun, describeSchedule, validateInput, tick, id };

/**
 * Service binding storage + turn launcher. `launchTurn(sessionId, text, opts)`
 * returns a promise of the turn result {ok, ...}.
 */
function createService({ storage, workspace, launchTurn, emit }) {
  emit = emit || (() => {});

  function create(input) {
    const v = validateInput({
      name: input.name ?? input.title,
      prompt: input.prompt,
      schedule: { cron: input.cron, delayMinutes: input.delayMinutes, interval: input.interval, intervalUnit: input.intervalUnit, ...(input.schedule || {}) },
      recurring: input.recurring,
      maxRuns: input.maxRuns,
      mode: input.mode,
    });
    const next = firstRunAt(v.schedule);
    const row = storage.automationCreate({
      id: id("auto"),
      name: String(input.title || input.name).trim(),
      prompt: String(input.prompt),
      workspace,
      schedule: v.schedule,
      recurring: v.recurring,
      maxRuns: v.maxRuns,
      mode: v.mode,
      enabled: input.enabled !== false,
      status: "active",
      nextRunAt: next.toISOString(),
    });
    emit({ type: "automation_changed", id: row.id, action: "created" });
    return row;
  }

  function update(idAuto, fields = {}) {
    const a = storage.automationGet(idAuto);
    if (!a) throw new Error(`自动化不存在: ${idAuto}`);
    const patch = {};
    if (fields.name !== undefined || fields.title !== undefined) patch.name = String(fields.title ?? fields.name).trim();
    if (fields.prompt !== undefined) patch.prompt = String(fields.prompt);
    if (fields.mode !== undefined) { if (!["yolo", "ask"].includes(fields.mode)) throw new Error("mode 只支持 yolo|ask"); patch.mode = fields.mode; }
    if (fields.enabled !== undefined) patch.enabled = !!fields.enabled;
    if (fields.maxRuns !== undefined) patch.maxRuns = fields.maxRuns;
    const hasSchedule = fields.schedule || fields.cron || fields.delayMinutes !== undefined || fields.interval !== undefined || fields.intervalUnit;
    if (hasSchedule) {
      const src = fields.schedule || { cron: fields.cron, delayMinutes: fields.delayMinutes, interval: fields.interval, intervalUnit: fields.intervalUnit };
      const v = validateInput({ name: a.name, prompt: a.prompt || "x", schedule: src, recurring: fields.recurring });
      patch.schedule = v.schedule;
      patch.recurring = v.recurring;
      patch.nextRunAt = firstRunAt(v.schedule).toISOString();
      if (a.status === "completed") patch.status = "active";
    }
    const updated = storage.automationUpdate(idAuto, patch);
    emit({ type: "automation_changed", id: idAuto, action: "updated" });
    return updated;
  }

  function remove(idAuto) {
    storage.automationDelete(idAuto);
    emit({ type: "automation_changed", id: idAuto, action: "deleted" });
    return { deleted: idAuto };
  }

  async function fire(a) {
    const runId = id("run");
    const session = storage.createSession({ workspace, title: `[auto] ${a.name}`.slice(0, 40) });
    storage.automationRunStart({ id: runId, automationId: a.id, sessionId: session.id });
    emit({ type: "automation_started", automationId: a.id, name: a.name, sessionId: session.id });
    let result = { ok: false, error: "unknown" };
    try {
      result = await launchTurn(session.id, a.prompt, { yolo: a.mode === "yolo" });
    } catch (e) {
      result = { ok: false, error: e.message };
    }
    storage.automationRunFinish(runId, { sessionId: session.id, ok: result.ok, error: result.error });
    emit({ type: "automation_finished", automationId: a.id, name: a.name, sessionId: session.id, ok: result.ok, error: result.error });
    return result;
  }

  async function tickNow(now) {
    return tick({ storage, now, fire });
  }

  async function runNow(idAuto) {
    const a = storage.automationGet(idAuto);
    if (!a) throw new Error(`自动化不存在: ${idAuto}`);
    if (!a.nextRunAt || a.nextRunAt > new Date().toISOString()) {
      storage.automationUpdate(idAuto, { nextRunAt: new Date(Date.now() - 1).toISOString() });
    }
    const n = await tickNow(new Date(Date.now() + 50));
    if (!n) throw new Error("未能触发运行 (可能已被其他进程认领)");
    return { triggered: true };
  }

  /* ------- agent-tool shaped helpers (never throw) ------- */

  const fmt = (a) => `${a.enabled ? "" : "[已禁用] "}[${a.id}] ${a.name} — ${describeSchedule(a)} · 状态 ${a.status} · 已运行 ${a.runCount} 次${a.nextRunAt ? ` · 下次 ${a.nextRunAt.slice(0, 16).replace("T", " ")}` : ""}`;

  return {
    create, update, remove, fire, tickNow, runNow,
    list: ({ workspace: ws } = {}) => storage.automationList({ workspace: ws === undefined ? workspace : ws }),
    get: (idAuto) => storage.automationGet(idAuto),
    runs: (idAuto) => storage.automationRuns(idAuto),
    toggle: (idAuto) => {
      const a = storage.automationGet(idAuto);
      if (!a) throw new Error(`自动化不存在: ${idAuto}`);
      return update(idAuto, { enabled: !a.enabled });
    },
    serviceOf: (a) => fmt(a),

    createFromTool: async (input) => {
      try {
        const row = create({ ...input, name: input.title, title: input.title });
        return { ok: true, output: `自动化已创建: ${fmt(row)}\n提示词: ${row.prompt.slice(0, 200)}` };
      } catch (e) { return { ok: false, output: `创建失败: ${e.message}` }; }
    },
    listForTool: () => {
      const list = storage.automationList({ workspace: null });
      return { ok: true, output: list.length ? list.map(fmt).join("\n") : "(暂无自动化任务)" };
    },
    updateFromTool: (input) => {
      try {
        const { id: idAuto, ...fields } = input;
        const row = update(idAuto, fields);
        return { ok: true, output: `自动化已更新: ${fmt(row)}` };
      } catch (e) { return { ok: false, output: `更新失败: ${e.message}` }; }
    },
    deleteFromTool: (idAuto) => {
      const a = storage.automationGet(idAuto);
      if (!a) return { ok: false, output: `自动化不存在: ${idAuto}` };
      remove(idAuto);
      return { ok: true, output: `已删除自动化: ${a.name} (${idAuto})` };
    },
  };
}

module.exports.createService = createService;
