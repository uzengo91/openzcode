// Plugin registry — a plugin is a directory (user: ~/.openzcode/plugins/<name>,
// project: <workspace>/.openzcode/plugins/<name>) that may contribute:
//   plugin.json    metadata {name, version, description}
//   skills/        SKILL.md skills
//   commands/      slash-command markdown files
//   mcp.json       {"mcpServers": {...}} — MCP servers
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

function pluginRoots({ workspace }) {
  const roots = [];
  const userBase = process.env.OPENZCODE_CONFIG_DIR || path.join(os.homedir(), ".openzcode");
  roots.push({ base: path.join(userBase, "plugins"), scope: "user" });
  if (workspace) roots.push({ base: path.join(workspace, ".openzcode", "plugins"), scope: "project" });
  return roots;
}

function scanDir(base, scope) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(base, e.name);
    let meta = {};
    for (const f of ["plugin.json", "package.json"]) {
      try {
        meta = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
        break;
      } catch {}
    }
    const has = (p) => { try { return fs.existsSync(path.join(dir, p)); } catch { return false; } };
    out.push({
      name: meta.name || e.name,
      version: meta.version || "0.0.0",
      description: meta.description || "",
      dir,
      scope,
      skillsDir: has("skills") ? path.join(dir, "skills") : null,
      commandsDir: has("commands") ? path.join(dir, "commands") : null,
      mcpPath: has("mcp.json") ? path.join(dir, "mcp.json") : null,
    });
  }
  return out;
}

function discover({ workspace }) {
  const all = new Map();
  for (const { base, scope } of pluginRoots({ workspace })) {
    for (const p of scanDir(base, scope)) all.set(p.name, p); // project overrides user
  }
  return [...all.values()];
}

function install(srcPath, { workspace } = {}) {
  const src = path.resolve(srcPath);
  let st;
  try { st = fs.statSync(src); } catch { throw new Error(`路径不存在: ${src}`); }
  if (!st.isDirectory()) throw new Error("插件必须是目录");
  const metaFile = ["plugin.json", "package.json"].map((f) => path.join(src, f)).find((f) => fs.existsSync(f));
  if (!metaFile) throw new Error("缺少 plugin.json (或 package.json)");
  const meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
  const name = meta.name || path.basename(src);
  const userBase = process.env.OPENZCODE_CONFIG_DIR || path.join(os.homedir(), ".openzcode");
  const dest = path.join(userBase, "plugins", name);
  if (fs.existsSync(dest)) throw new Error(`插件已存在: ${dest}`);
  fs.cpSync(src, dest, { recursive: true });
  return { name, dest };
}

function remove(name, { workspace } = {}) {
  const userBase = process.env.OPENZCODE_CONFIG_DIR || path.join(os.homedir(), ".openzcode");
  const dest = path.join(userBase, "plugins", name);
  if (!fs.existsSync(dest)) throw new Error(`未找到用户级插件: ${name}`);
  fs.rmSync(dest, { recursive: true, force: true });
  return { name, removed: dest };
}

module.exports = { discover, install, remove, pluginRoots };
