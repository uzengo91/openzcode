// Slash commands — markdown files with frontmatter, from plugins
// (<plugin>/commands/<name>.md), user (~/.openzcode/commands) and
// project (<workspace>/.openzcode/commands). Body is a prompt template;
// $ARGUMENTS (or $1..$9) is substituted with what the user typed after
// the command name.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { parseFrontmatter } = require("./skills");

function commandDirs({ workspace, plugins }) {
  const dirs = [];
  const userBase = process.env.OPENZCODE_CONFIG_DIR || path.join(os.homedir(), ".openzcode");
  dirs.push({ dir: path.join(userBase, "commands"), scope: "user" });
  if (workspace) dirs.push({ dir: path.join(workspace, ".openzcode", "commands"), scope: "project" });
  for (const p of plugins || []) if (p.commandsDir) dirs.push({ dir: p.commandsDir, scope: `plugin:${p.name}` });
  return dirs;
}

function discover({ workspace, plugins }) {
  const out = new Map();
  for (const { dir, scope } of commandDirs({ workspace, plugins })) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isDirectory() || !e.name.endsWith(".md")) continue;
      const file = path.join(dir, e.name);
      let raw;
      try { raw = fs.readFileSync(file, "utf8"); } catch { continue; }
      const { meta, body } = parseFrontmatter(raw);
      const name = e.name.replace(/\.md$/, "");
      out.set(name, { name, description: meta.description || "", scope, file, template: body });
    }
  }
  return out;
}

function list({ workspace, plugins }) {
  return [...discover({ workspace, plugins }).values()].map((c) => ({
    name: c.name, description: c.description, scope: c.scope,
  }));
}

/** expand "/name args…" into the full prompt; returns null if not a known command */
function expand(inputText, { workspace, plugins }) {
  if (!inputText.startsWith("/")) return null;
  const m = /^\/([A-Za-z0-9_-]+)(?:\s+([\s\S]*))?$/.exec(inputText.trim());
  if (!m) return null;
  const cmd = discover({ workspace, plugins }).get(m[1]);
  if (!cmd) return null;
  const args = (m[2] || "").trim();
  let prompt = cmd.template || "";
  prompt = prompt.split("$ARGUMENTS").join(args);
  for (let i = 1; i <= 9; i++) prompt = prompt.split(`$${i}`).join(args.split(/\s+/)[i - 1] || "");
  return { name: cmd.name, prompt, description: cmd.description };
}

module.exports = { discover, list, expand };
