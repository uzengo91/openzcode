// Storage selection: prefer node:sqlite (matches the reference architecture),
// fall back to a JSON store when the builtin module is unavailable.
"use strict";

const path = require("node:path");
const { dirs } = require("../paths");

let instance = null;

function probeSqlite() {
  try {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE t(x)");
    db.prepare("INSERT INTO t VALUES (?)").run(1);
    const ok = db.prepare("SELECT x FROM t").get()?.x === 1;
    db.close();
    return ok;
  } catch {
    return false;
  }
}

function getStorage() {
  if (instance) return instance;
  const dbPath = path.join(dirs().base, "db.sqlite");
  if (probeSqlite()) {
    const { SqliteStorage } = require("./sqlite");
    instance = new SqliteStorage(dbPath);
  } else {
    const { JsonStorage } = require("./jsonstore");
    instance = new JsonStorage(path.join(dirs().base, "db.json"));
  }
  return instance;
}

module.exports = { getStorage };
