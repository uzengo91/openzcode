// Skills — SKILL.md discovery + frontmatter parsing + the `skill` tool payload.
// Scopes: user ~/.openzcode/skills/<name>/SKILL.md,
//         project <workspace>/.openzcode/skills/<name>/SKILL.md,
//         plugins <pluginDir>/skills/<name>/SKILL.md (project > user > plugin).
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

/** minimal frontmatter parser: `key: value`, quotes, and `|-`/`|` block scalars */
function parseFrontmatter(text) {
  const meta = {};
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta, body: text };
  const body = text.slice(m[0].length);
  const lines = m[1].split(/\r?\n/);
  let key = null;
  for (const line of lines) {
    if (key && (line.startsWith("  ") || line.startsWith("\t"))) {
      meta[key] = (meta[key] ? meta[key] + "\n" : "") + line.trim();
      continue;
    }
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    key = kv[1].toLowerCase();
    let val = kv[2].trim();
    if (val === "|" || val === "|-" || val === ">" || val === ">-") { meta[key] = ""; continue; }
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    meta[key] = val;
    if (val === "") key = key; // block scalar may follow
  }
  return { meta, body: body.trim() };
}

function skillDirs({ workspace, plugins }) {
  const dirs = [];
  if (process.env.OPENZCODE_CONFIG_DIR) dirs.push({ dir: path.join(process.env.OPENZCODE_CONFIG_DIR, "skills"), scope: "user" });
  else dirs.push({ dir: path.join(os.homedir(), ".openzcode", "skills"), scope: "user" });
  if (workspace) dirs.push({ dir: path.join(workspace, ".openzcode", "skills"), scope: "project" });
  for (const p of plugins || []) {
    if (p.skillsDir) dirs.push({ dir: p.skillsDir, scope: `plugin:${p.name}` });
  }
  return dirs;
}

class SkillRegistry {
  constructor({ workspace, plugins }) {
    this.workspace = workspace;
    this.plugins = plugins || [];
    this.cache = null;
  }

  setContext({ workspace, plugins }) {
    this.workspace = workspace;
    this.plugins = plugins || [];
    this.cache = null;
  }

  _scanDir(base, scope, out) {
    let entries;
    try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const file = path.join(base, e.name, "SKILL.md");
      let raw;
      try { raw = fs.readFileSync(file, "utf8"); } catch { continue; }
      const { meta, body } = parseFrontmatter(raw);
      const name = (meta.name || e.name).trim();
      if (!name) continue;
      out.set(name, {
        name,
        description: meta.description || "",
        scope,
        dir: path.dirname(file),
        file,
        body,
        meta,
      });
    }
  }

  load() {
    if (this.cache) return this.cache;
    const out = new Map();
    for (const { dir, scope } of skillDirs({ workspace: this.workspace, plugins: this.plugins })) {
      this._scanDir(dir, scope, out); // later scopes overwrite earlier (project wins)
    }
    this.cache = out;
    return out;
  }

  list() {
    return [...this.load().values()].map((s) => ({
      name: s.name, description: s.description, scope: s.scope, file: s.file,
    }));
  }

  get(name) {
    return this.load().get(name) || null;
  }

  /** payload returned by the `skill` tool */
  loadForAgent(name, args) {
    const s = this.get(name);
    if (!s) {
      const names = [...this.load().keys()].join(", ") || "(无)";
      return { ok: false, output: `未找到技能 "${name}"。可用技能: ${names}` };
    }
    const header = `技能 "${s.name}" 已加载 (来源 ${s.scope}, 目录 ${s.dir})。请严格按照以下技能说明执行任务:\n\n`;
    const footer = args ? `\n\n用户附加参数: ${args}` : "";
    return { ok: true, output: header + s.body + footer, skill: { name: s.name, dir: s.dir } };
  }

  /** system-prompt section: names + descriptions only */
  promptSection() {
    const all = [...this.load().values()];
    if (!all.length) return "";
    const lines = all.map((s) => `- ${s.name}: ${s.description || "(无描述)"}`);
    return `\n# 可用技能 Skills\n` +
      `当用户任务匹配以下技能描述时,先调用 skill 工具(参数 name)加载完整说明,再按说明执行:\n${lines.join("\n")}`;
  }
}

module.exports = { SkillRegistry, parseFrontmatter };
