// Rollout logger: full model-io record per session (replayable/auditable),
// mirrors the reference "rollout/model-io-<sessionId>.jsonl" double-write.
"use strict";

const fs = require("node:fs");
const { rolloutPath, dirs } = require("./paths");

function appendRollout(sessionId, entry) {
  try {
    fs.mkdirSync(dirs().rollout, { recursive: true });
    fs.appendFileSync(rolloutPath(sessionId), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  } catch {}
}

module.exports = { appendRollout };
