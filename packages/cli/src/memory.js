// Long-term memory store, mirrors the "memories" mechanism of the reference
// architecture: one .md file per memory (frontmatter name/description + body),
// plus a MEMORY.md index with one line per memory. Memories are scoped per
// workspace via <baseDir>/memories/<workspaceKey>/ where
// workspaceKey = <workspace basename>-<sha256(abs path)[0..7]>.
// Bodies support [[name]] links pointing at other memories.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { dirs } = require("./paths");

const INDEX_FILE = "MEMORY.md";
const DAILY_FILE = "daily.md";
const MAX_PROMPT_ENTRIES = 30;

// ---------------------------------------------------------------- helpers

function workspaceKey(workspace) {
  const abs = path.resolve(workspace || process.cwd());
  const hash = crypto.createHash("sha256").update(abs).digest("hex").slice(0, 8);
  return `${path.basename(abs)}-${hash}`;
}

function memoryRoot(workspace) {
  return path.join(dirs().base, "memories", workspaceKey(workspace));
}

// Keep \w, dot, hyphen; everything else (incl. path separators) becomes "-".
function safeName(name) {
  const raw = String(name || "").trim();
  if (!raw || raw === "." || raw === "..") return null;
  const cleaned = raw.replace(/[^\w.-]/g, "-").replace(/^[-.]+|[-.]+$/g, "") || "";
  if (!cleaned || cleaned === "." || cleaned === "..") return null;
  return cleaned;
}

function oneLine(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function truncate(text, max) {
  const s = String(text || "");
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

// Simplified frontmatter parser (same shape as skills.js): only flat
// `name:` / `description:` lines are honoured.
function parseFrontmatter(text) {
  const meta = {};
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta, body: text };
  const body = text.slice(m[0].length);
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^(name|description)\s*:\s*(.*)$/i.exec(line);
    if (kv) meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return { meta, body: body.trim() };
}

function extractLinks(body) {
  const out = [];
  for (const m of String(body || "").matchAll(/\[\[([^\[\]]+)\]\]/g)) {
    out.push(m[1].trim());
  }
  return out;
}

function availableNames(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".md") && f !== INDEX_FILE)
      .map((f) => path.basename(f, ".md"))
      .sort();
  } catch {
    return [];
  }
}

// ------------------------------------------------------------- index build

// Rebuild MEMORY.md from scratch: scan every .md in the memory dir, read its
// frontmatter (falling back to filename stem + first body line), emit one
// index line per memory. Idempotent.
function rebuildIndex(dir) {
  const lines = [];
  for (const entry of availableNames(dir).map((n) => `${n}.md`)) {
    let raw;
    try {
      raw = fs.readFileSync(path.join(dir, entry), "utf8");
    } catch {
      continue;
    }
    const { meta, body } = parseFrontmatter(raw);
    const name = oneLine(meta.name || path.basename(entry, ".md")).replace(/[\[\]]/g, "");
    let desc = oneLine(meta.description);
    if (!desc) {
      const first = (body || raw)
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l && !l.startsWith("#"));
      desc = first ? truncate(oneLine(first.replace(/^[-*>]+/, "")), 100) : "";
    }
    lines.push(`- [${name}](${entry})${desc ? " — " + desc : ""}`);
  }
  lines.sort((a, b) => a.localeCompare(b));
  fs.writeFileSync(path.join(dir, INDEX_FILE), lines.length ? lines.join("\n") + "\n" : "");
}

// ----------------------------------------------------------------- public

// Ensure the workspace memory dir exists; return its absolute path.
function memoryDir(workspace) {
  const dir = memoryRoot(workspace);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Parse MEMORY.md → [{ name, file, description }]
function listIndex(workspace) {
  const indexFile = path.join(memoryRoot(workspace), INDEX_FILE);
  let raw;
  try {
    raw = fs.readFileSync(indexFile, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = /^-\s*\[([^\]]+)\]\(([^)\s]+)\)\s*(?:[—–-]+\s*(.*))?$/.exec(line.trim());
    if (m) out.push({ name: m[1].trim(), file: m[2].trim(), description: (m[3] || "").trim() });
  }
  return out;
}

// Read a single memory; resolves [[links]] into a "相关记忆" list.
function read(workspace, name) {
  const key = safeName(name);
  if (!key) return { ok: false, output: "记忆名不能为空。" };
  if (key.toUpperCase() === "MEMORY") return { ok: false, output: '"MEMORY" 是索引保留名, 请指定具体记忆。' };
  const dir = memoryRoot(workspace);
  const file = path.join(dir, `${key}.md`);
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    const avail = availableNames(dir);
    const hint = avail.length
      ? `可用记忆: ${avail.join(", ")}。`
      : "该工作区还没有任何记忆, 可用 memory_write 创建。";
    return { ok: false, output: `未找到记忆 "${key}"。${hint}` };
  }
  const { meta, body } = parseFrontmatter(raw);
  let output = body || "";
  const seen = new Set();
  const related = [];
  for (const link of extractLinks(body)) {
    const lk = safeName(link);
    if (!lk || seen.has(lk)) continue;
    seen.add(lk);
    const linkFile = path.join(dir, `${lk}.md`);
    if (fs.existsSync(linkFile)) {
      let desc = "";
      try {
        desc = oneLine(parseFrontmatter(fs.readFileSync(linkFile, "utf8")).meta.description);
      } catch {}
      related.push(`- [[${lk}]]${desc ? " — " + desc : ""}`);
    } else {
      related.push(`- [[${lk}]] (尚未创建)`);
    }
  }
  if (related.length) output += `\n\n相关记忆:\n${related.join("\n")}`;
  void meta;
  return { ok: true, output };
}

// Write (or overwrite) <name>.md and rebuild the index.
function write(workspace, name, body, description) {
  const key = safeName(name);
  if (!key) return { ok: false, output: "记忆名不能为空 (非法字符会被替换为 -, 纯符号名将被拒绝)。" };
  if (key.toUpperCase() === "MEMORY") return { ok: false, output: '"MEMORY" 是索引保留名, 请换一个记忆名。' };
  const dir = memoryDir(workspace);
  const desc = truncate(oneLine(description), 200);
  const content = `---\nname: ${key}\ndescription: ${desc}\n---\n\n${String(body || "").trim()}\n`;
  try {
    fs.writeFileSync(path.join(dir, `${key}.md`), content);
    rebuildIndex(dir);
  } catch (e) {
    return { ok: false, output: `写入失败: ${e.message}` };
  }
  return { ok: true, output: `已保存记忆 "${key}" (${key}.md), 索引已更新。` };
}

// Quick capture: append a paragraph to daily.md under an auto date section.
function append(workspace, text) {
  const body = String(text || "").trim();
  if (!body) return { ok: false, output: "追加内容不能为空。" };
  const dir = memoryDir(workspace);
  const file = path.join(dir, DAILY_FILE);
  const today = new Date().toISOString().slice(0, 10);
  let content;
  try {
    content = fs.readFileSync(file, "utf8");
  } catch {
    content = "---\nname: daily\ndescription: 按日期追加的工作记忆流水\n---\n";
  }
  if (!content.includes(`## ${today}`)) {
    if (content && !content.endsWith("\n")) content += "\n";
    content += `\n## ${today}\n`;
  }
  content += `\n${body}\n`;
  try {
    fs.writeFileSync(file, content);
    rebuildIndex(dir);
  } catch (e) {
    return { ok: false, output: `追加失败: ${e.message}` };
  }
  return { ok: true, output: `已追加到 ${DAILY_FILE} (${today} 小节)。` };
}

// System-prompt section: "" when the workspace has no memories, otherwise the
// index (max 30 entries) as `- name: description` lines.
function promptSection(workspace) {
  const entries = listIndex(workspace).slice(0, MAX_PROMPT_ENTRIES);
  if (!entries.length) return "";
  const lines = entries.map((e) => `- ${e.name}${e.description ? ": " + e.description : ""}`);
  return (
    "# 长期记忆\n以下是该工作区的持久记忆索引, 用 memory_read 查看详情, memory_write 记录新记忆:\n" +
    lines.join("\n")
  );
}

// [[name]] resolution is just reading that memory.
const resolveLink = read;

module.exports = {
  workspaceKey,
  memoryRoot,
  memoryDir,
  listIndex,
  read,
  write,
  append,
  promptSection,
  resolveLink,
};
