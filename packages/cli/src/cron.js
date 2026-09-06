// Minimal 5-field cron parser + next-run computation (local timezone).
// Supports: * , - / in minute(0-59) hour(0-23) dom(1-31) month(1-12) dow(0-7, 0/7=Sun).
// No dependencies. Deterministic and unit-testable.
"use strict";

const RANGES = [
  { min: 0, max: 59, names: null },                 // minute
  { min: 0, max: 23, names: null },                 // hour
  { min: 1, max: 31, names: null },                 // day of month
  { min: 1, max: 12, names: ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"] }, // month
  { min: 0, max: 7, names: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] }, // day of week
];

function parseField(field, idx) {
  const { min, max, names } = RANGES[idx];
  const values = new Set();
  const add = (lo, hi, step) => {
    if (!Number.isInteger(step) || step < 1) throw new Error(`cron 步长无效: "${field}"`);
    if (lo < min || hi > max || lo > hi) throw new Error(`cron 取值越界 (${min}-${max}): "${field}"`);
    for (let v = lo; v <= hi; v += step) values.add(idx === 4 ? v % 7 : v);
  };
  for (const part of field.split(",")) {
    const t = part.trim().toLowerCase();
    if (!t) throw new Error(`cron 字段为空: "${field}"`);
    if (t === "*") { add(min, max, 1); continue; }
    if (t.startsWith("*/")) { add(min, max, Number(t.slice(2))); continue; }
    const [rangePart, stepPart] = t.split("/");
    const step = stepPart !== undefined ? Number(stepPart) : 1;
    if (rangePart.includes("-")) {
      const [a, b] = rangePart.split("-");
      add(resolveVal(a, names), resolveVal(b, names), step);
    } else {
      const v = resolveVal(rangePart, names);
      add(v, stepPart !== undefined ? max : v, step);
    }
  }
  if (!values.size) throw new Error(`cron 字段为空: "${field}"`);
  return values;
}

function resolveVal(tok, names, min, max) {
  if (names && /^[a-z]{3}$/.test(tok)) {
    const i = names.indexOf(tok);
    if (i < 0) throw new Error(`cron 名称无效: "${tok}"`);
    return i; // month: 1-12 already match index+1? names[0]="jan" → 0; adjust below
  }
  const n = Number(tok);
  if (!Number.isInteger(n)) throw new Error(`cron 数字无效: "${tok}"`);
  return n;
}

// month names need +1 (Jan=1), dow names are already 0-6; resolveVal is generic, fix month in parseField
function parseFieldSafe(field, idx) {
  if (idx === 3 && /[a-z]/i.test(field)) {
    const values = new Set();
    for (const part of field.split(",")) {
      const t = part.trim().toLowerCase();
      const i = RANGES[3].names.indexOf(t);
      if (i >= 0) { values.add(i + 1); continue; }
      const n = Number(t);
      if (!Number.isInteger(n)) throw new Error(`cron 月份无效: "${part}"`);
      values.add(n);
    }
    return values;
  }
  return parseField(field, idx);
}

/** parse "m h dom mon dow" → {minutes:Set,hours:Set,doms:Set,months:Set,dows:Set|null} */
function parseCron(expr) {
  const fields = String(expr).trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`cron 表达式需要 5 个字段: "${expr}"`);
  const [mi, h, dom, mon, dow] = fields;
  const doms = parseFieldSafe(dom, 2);
  const dows = parseFieldSafe(dow, 4);
  // standard cron semantics: if both dom and dow are restricted, match either
  const domRestricted = dom !== "*";
  const dowRestricted = dow !== "*";
  return {
    minutes: parseFieldSafe(mi, 0),
    hours: parseFieldSafe(h, 1),
    doms,
    months: parseFieldSafe(mon, 3),
    dows,
    domRestricted,
    dowRestricted,
  };
}

function matches(spec, d) {
  if (!spec.minutes.has(d.getMinutes())) return false;
  if (!spec.hours.has(d.getHours())) return false;
  if (!spec.months.has(d.getMonth() + 1)) return false;
  const domOk = spec.doms.has(d.getDate());
  const dowOk = spec.dows.has(d.getDay());
  if (spec.domRestricted && spec.dowRestricted) return domOk || dowOk;
  if (spec.domRestricted) return domOk;
  if (spec.dowRestricted) return dowOk;
  return true;
}

/** next fire time strictly after `from` (Date), searching up to ~2 years ahead */
function nextRun(expr, from = new Date()) {
  const spec = parseCron(expr);
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < 366 * 24 * 60; i++) {
    if (matches(spec, d)) return new Date(d.getTime());
    d.setMinutes(d.getMinutes() + 1);
  }
  throw new Error(`cron 表达式在两年内无触发时间: "${expr}"`);
}

/** validate without computing */
function validate(expr) {
  try { parseCron(expr); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
}

/** human description, best effort, Chinese */
function describe(expr) {
  const fields = String(expr).trim().split(/\s+/);
  if (fields.length !== 5) return `cron: ${expr}`;
  const [mi, h, , , dow] = fields;
  if (mi.startsWith("*/") && h === "*" && dow === "*") return `每 ${mi.slice(2)} 分钟`;
  if (mi === "0" && h === "*" && dow === "*") return "每小时";
  if (dow === "*" && /^\d+$/.test(h) && /^\d+$/.test(mi)) return `每天 ${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
  const week = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  if (/^\d+$/.test(dow) && /^\d+$/.test(h) && /^\d+$/.test(mi)) return `每${week[Number(dow) % 7]} ${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
  return `cron: ${expr}`;
}

module.exports = { parseCron, nextRun, validate, describe };
