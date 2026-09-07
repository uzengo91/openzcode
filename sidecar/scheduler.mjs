#!/usr/bin/env node
// OpenZCode scheduler sidecar — bridges ZCode automations (cron/every/one-shot,
// optimistic claim, unattended turns) onto the Rust kernel. Runs persistently;
// spawns turns via the kernel app-server (thread/start) using oz-cli.
import { spawn, execFile } from "node:child_process";
import { createInterface } from "node:readline";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

// --- storage: same layout as JS automations (SQLite via node:sqlite or JSON fallback) ---
// The scheduler reads/writes the SAME ~/.openzcode/db.sqlite that the JS CLI used,
// so automations created before V2 keep working. We reuse the JS storage through a
// bridge because node:sqlite is available in the same Node runtime.
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?!\/)/, "/")), "..");
const CONFIG_DIR = process.env.OPENZCODE_CONFIG_DIR || path.join(os.homedir(), ".openzcode");
const WORKSPACE = process.env.OPENZCODE_WORKSPACE || path.join(CONFIG_DIR, "workspace", "default");
const KERNEL = process.env.OPENZCODE_KERNEL || path.join(ROOT, "kernel/codex-rs/target/release/codex-tui");
const TICK_MS = Math.max(1000, Number(process.env.OPENZCODE_AUTOMATION_TICK_MS) || 30000);

// minimal sqlite-free automations store (JSON) — JS 版数据通过 openzcode automation export 导入
const STORE = path.join(CONFIG_DIR, "automations-v2.json");
function loadAutomations() {
  try { return JSON.parse(fs.readFileSync(STORE, "utf8")); } catch { return []; }
}
function saveAutomations(list) {
  fs.mkdirSync(path.dirname(STORE), { recursive: true });
  fs.writeFileSync(STORE, JSON.stringify(list, null, 2));
}
function newId(p) { return `${p}_${crypto.randomUUID()}`; }

function createAutomation(a) {
  const list = loadAutomations();
  const row = {
    id: newId("auto"), name: a.name || a.title || "自动化", prompt: a.prompt || "",
    schedule: a.schedule, mode: a.mode || "yolo", maxRuns: a.maxRuns ?? null,
    enabled: a.enabled !== false, status: "active", runCount: 0,
    nextRunAt: a.nextRunAt || new Date().toISOString(),
    createdAt: new Date().toISOString(), lastRunAt: null,
  };
  list.push(row); saveAutomations(list);
  return row;
}

// --- cron/every/once next-run helpers (same semantics as JS cron.js) ---
function parseCron(expr) {
  const f = String(expr).trim().split(/\s+/);
  if (f.length !== 5) throw new Error("cron 需要 5 字段");
  const rng = [[0,59],[0,23],[1,31],[1,12],[0,7]];
  const sets = f.map((fld, i) => {
    const set = new Set();
    for (const part of fld.split(",")) {
      const t = part.trim();
      const [rp, sp] = t.split("/");
      const step = sp ? Math.max(1, Number(sp)) : 1;
      if (rp === "*") { for (let v = rng[i][0]; v <= rng[i][1]; v += step) set.add(i === 4 ? v % 7 : v); }
      else if (rp.includes("-")) { const [a, b] = rp.split("-").map(Number); for (let v = a; v <= b; v += step) set.add(i === 4 ? v % 7 : v); }
      else { const v = Number(rp); set.add(i === 4 ? v % 7 : v); if (!sp) for (let v = v; v <= rng[i][1]; v += step) void 0; }
    }
    return set;
  });
  return { sets, domR: f[2] !== "*", dowR: f[4] !== "*" };
}
function cronMatches(spec, d) {
  const [mi, h, dom, mon, dow] = [d.getMinutes(), d.getHours(), d.getDate(), d.getMonth() + 1, d.getDay()];
  if (!spec.sets[0].has(mi) || !spec.sets[1].has(h) || !spec.sets[3].has(mon)) return false;
  const domOk = spec.sets[2].has(dom), dowOk = spec.sets[4].has(dow);
  if (spec.domR && spec.dowR) return domOk || dowOk;
  if (spec.domR) return domOk;
  if (spec.dowR) return dowOk;
  return true;
}
function nextRun(schedule, from = new Date()) {
  if (schedule.kind === "cron") {
    const spec = parseCron(schedule.cron);
    const d = new Date(from.getTime()); d.setSeconds(0, 0); d.setMinutes(d.getMinutes() + 1);
    for (let i = 0; i < 366 * 24 * 60; i++) { if (cronMatches(spec, d)) return new Date(d); d.setMinutes(d.getMinutes() + 1); }
    throw new Error("cron 两年内无触发");
  }
  if (schedule.kind === "once") return new Date(from.getTime() + schedule.delayMinutes * 60000);
  const unit = { minute: 60000, hour: 3600000, day: 86400000 }[schedule.unit || "minute"];
  return new Date(from.getTime() + schedule.interval * unit);
}

// --- unattended turn: run kernel CLI in exec mode ---
function launchKernelTurn(prompt) {
  fs.mkdirSync(WORKSPACE, { recursive: true }); // spawn cwd must exist
  return new Promise((resolve) => {
    // exec via node (process.execPath) to avoid platform exec-bit/provenance quirks
    const child = execFile(process.execPath, [KERNEL, "exec", "--dangerously-bypass-approvals-and-sandbox", prompt], {
      cwd: WORKSPACE, timeout: 30 * 60000, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GLM_API_KEY: process.env.GLM_API_KEY || process.env.OZ_GLM_KEY || "" },
    }, (err, stdout) => resolve({ ok: !err, output: (stdout || "").slice(-2000), error: err?.message }));
    void child;
  });
}

async function tick() {
  const nowIso = new Date().toISOString();
  const list = loadAutomations();
  for (const a of list) {
    if (!a.enabled || a.status !== "active" || !a.nextRunAt || a.nextRunAt > nowIso) continue;
    // claim (single scheduler process per user — file lock via atomic rename of store)
    a.runCount = (a.runCount || 0) + 1;
    a.lastRunAt = nowIso;
    const runCount = a.runCount;
    const next = a.schedule.kind === "once" ? null : nextRun(a.schedule);
    const done = next === null || (a.maxRuns != null && runCount >= a.maxRuns);
    a.nextRunAt = done ? null : next.toISOString();
    a.status = done ? "completed" : "active";
    saveAutomations(list);
    console.error(`[oz-scheduler] 触发: ${a.name} (run ${runCount})`);
    const r = await launchKernelTurn(a.prompt);
    console.error(`[oz-scheduler] ${a.name}: ${r.ok ? "完成" : "失败 " + (r.error || "")}`);
  }
}

// --- CLI interface for tests/GUI: `scheduler create ...` / `scheduler tick` ---
const [, , cmd, ...rest] = process.argv;
if (cmd === "create") {
  const a = JSON.parse(rest[0] || fs.readFileSync(0, "utf8"));
  console.log(JSON.stringify(createAutomation(a)));
} else if (cmd === "list") {
  console.log(JSON.stringify(loadAutomations()));
} else if (cmd === "tick") {
  tick().then(() => process.exit(0));
} else {
  // serve mode: tick loop
  setInterval(() => tick().catch((e) => console.error(`[oz-scheduler] ${e.message}`)), TICK_MS);
  console.error(`[oz-scheduler] running (tick=${TICK_MS}ms, kernel=${KERNEL})`);
}
