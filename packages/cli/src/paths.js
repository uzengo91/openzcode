// Data-dir layout, mirrors the ~/.zcode tree of the reference architecture:
//   ~/.openzcode/
//   ├── config.json            providers + preferences
//   ├── db.sqlite | db.json    structured session store
//   ├── rollout/<sessId>.jsonl full model-io record per session (replayable)
//   ├── log/YYYY-MM-DD.log     structured log
//   └── workspace/default      default working directory for the agent
"use strict";

const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

function baseDir() {
  return process.env.OPENZCODE_CONFIG_DIR || path.join(os.homedir(), ".openzcode");
}

function dirs() {
  const base = baseDir();
  return {
    base,
    rollout: path.join(base, "rollout"),
    log: path.join(base, "log"),
    workspace: process.env.OPENZCODE_WORKSPACE || path.join(base, "workspace", "default"),
  };
}

function ensureDirs() {
  const d = dirs();
  for (const p of [d.base, d.rollout, d.log, d.workspace]) {
    fs.mkdirSync(p, { recursive: true });
  }
  return d;
}

function rolloutPath(sessionId) {
  return path.join(dirs().rollout, `${sessionId}.jsonl`);
}

module.exports = { baseDir, dirs, ensureDirs, rolloutPath };
