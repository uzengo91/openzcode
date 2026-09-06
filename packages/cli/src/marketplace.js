// Plugin marketplace — index sources + install pipeline.
// A marketplace source is either an https URL to marketplace.json or a local
// directory containing marketplace.json. Entries:
//   { name, version, description, localPath?, url?, sha256? }
// Installer prefers localPath when it exists (offline/monorepo), else downloads
// the zip archive, verifies sha256 when available, unpacks, installs to the
// user plugin dir.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const configStore = require("./config");
const pluginRegistry = require("./plugins");

const OFFICIAL_URL = "https://raw.githubusercontent.com/uzengo91/openzcode/main/marketplace/marketplace.json";

function sources() {
  const cfg = configStore.load();
  const list = Array.isArray(cfg.marketplaces) && cfg.marketplaces.length
    ? [...cfg.marketplaces]
    : [{ name: "official", url: OFFICIAL_URL }];
  return list;
}

function addSource({ name, url, path: localPath }) {
  const cfg = configStore.load();
  cfg.marketplaces = Array.isArray(cfg.marketplaces) ? cfg.marketplaces : [];
  const s = { name: name || path.basename(String(url || localPath)).replace(/\.json$/, ""), url, path: localPath };
  if (cfg.marketplaces.some((x) => x.url === s.url && x.path === s.path)) return s;
  cfg.marketplaces.push(s);
  configStore.save(cfg);
  return s;
}

function removeSource(name) {
  const cfg = configStore.load();
  cfg.marketplaces = (cfg.marketplaces || [{ name: "official", url: OFFICIAL_URL }]).filter((x) => x.name !== name);
  configStore.save(cfg);
  return cfg.marketplaces;
}

async function fetchIndex(source) {
  if (/^https?:\/\//i.test(source)) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error("获取市场索引超时")), 20000);
    try {
      const res = await fetch(source, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return JSON.parse(await res.text());
    } finally {
      clearTimeout(timer);
    }
  }
  const file = path.join(source, "marketplace.json");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** list all marketplaces: [{source:{name,url|path}, plugins:[...], error?}] */
async function listMarketplaces() {
  const out = [];
  for (const s of sources()) {
    const src = s.url || s.path;
    try {
      const idx = await fetchIndex(src);
      const baseDir = s.path || null;
      const plugins = (idx.plugins || []).map((p) => ({
        ...p,
        marketplace: s.name,
        // resolved local path (relative to the index dir) when present
        _localDir: p.localPath && baseDir ? path.resolve(baseDir, p.localPath) : (p.localPath || null),
        _installed: (() => {
          try { return fs.existsSync(path.join(userPluginRoot(), p.name)); } catch { return false; }
        })(),
      }));
      out.push({ name: s.name, source: src, plugins, error: null });
    } catch (e) {
      out.push({ name: s.name, source: src, plugins: [], error: e.message });
    }
  }
  return out;
}

function userPluginRoot() {
  const base = process.env.OPENZCODE_CONFIG_DIR || path.join(os.homedir(), ".openzcode");
  return path.join(base, "plugins");
}

function zipSha256(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    fs.createReadStream(file).on("data", (c) => hash.update(c)).on("end", () => resolve(hash.digest("hex"))).on("error", reject);
  });
}

function unzip(zip, destDir) {
  return new Promise((resolve, reject) => {
    execFile("unzip", ["-q", "-o", zip, "-d", destDir], (err) => (err ? reject(new Error(`解压失败: ${err.message}`)) : resolve()));
  });
}

function downloadTo(url, dest, { timeoutMs = 120000 } = {}) {
  return new Promise(async (resolve, reject) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error("下载超时")), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) return reject(new Error(`下载失败 HTTP ${res.status}: ${url}`));
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(dest, buf);
      resolve(dest);
    } catch (e) {
      reject(e);
    } finally {
      clearTimeout(timer);
    }
  });
}

/** install a plugin entry (from listMarketplaces output) */
async function installEntry(entry) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oz-mkt-"));
  try {
    let srcDir = null;
    if (entry._localDir && fs.existsSync(entry._localDir)) {
      srcDir = entry._localDir; // offline/monorepo path
    } else if (entry.url) {
      const zip = path.join(tmp, `${entry.name}.zip`);
      await downloadTo(entry.url, zip);
      if (entry.sha256) {
        const got = await zipSha256(zip);
        if (got.toLowerCase() !== String(entry.sha256).toLowerCase()) {
          throw new Error(`sha256 校验失败 (期望 ${String(entry.sha256).slice(0, 12)}…, 实际 ${got.slice(0, 12)}…)`);
        }
      }
      const unzipped = path.join(tmp, "unzipped");
      await unzip(zip, unzipped);
      // zip may wrap a single top-level dir
      const entries = fs.readdirSync(unzipped, { withFileTypes: true });
      srcDir = entries.length === 1 && entries[0].isDirectory() ? path.join(unzipped, entries[0].name) : unzipped;
    } else if (entry.localPath && !entry._localDir) {
      srcDir = entry.localPath;
    } else {
      throw new Error("该插件既无可用 localPath 也无下载 URL");
    }
    if (!fs.existsSync(path.join(srcDir, "plugin.json")) && !fs.existsSync(path.join(srcDir, "package.json"))) {
      throw new Error("插件包缺少 plugin.json");
    }
    const meta = JSON.parse(fs.readFileSync(
      [path.join(srcDir, "plugin.json"), path.join(srcDir, "package.json")].find((f) => fs.existsSync(f)), "utf8"
    ));
    const name = entry.name || meta.name;
    const dest = path.join(userPluginRoot(), name);
    if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true }); // reinstall/upgrade
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(srcDir, dest, { recursive: true });
    return { name, dest, version: meta.version || entry.version || "?" };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

module.exports = { OFFICIAL_URL, sources, addSource, removeSource, fetchIndex, listMarketplaces, installEntry, userPluginRoot };
