// Provider registry + preferences, persisted at <base>/config.json (0600).
// A provider describes one model endpoint: protocol ("openai" | "anthropic"),
// baseUrl (root including version segment, e.g. https://host/v1), apiKey, model.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { ensureDirs } = require("./paths");

const DEFAULT_PERMISSION_MODE = "ask"; // "ask" | "yolo"
const MAX_ITERATIONS = 40;

function configPath() {
  return path.join(ensureDirs().base, "config.json");
}

function load() {
  const p = configPath();
  let cfg = null;
  try {
    cfg = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    cfg = null;
  }
  if (!cfg || typeof cfg !== "object") {
    cfg = {
      version: 1,
      providers: [],
      defaultProviderId: null,
      permissionMode: DEFAULT_PERMISSION_MODE,
      maxIterations: MAX_ITERATIONS,
    };
  }
  if (!Array.isArray(cfg.providers)) cfg.providers = [];
  if (!cfg.permissionMode) cfg.permissionMode = DEFAULT_PERMISSION_MODE;
  if (!cfg.maxIterations || cfg.maxIterations < 1) cfg.maxIterations = MAX_ITERATIONS;
  return cfg;
}

function save(cfg) {
  const p = configPath();
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  try { fs.chmodSync(p, 0o600); } catch {}
  return cfg;
}

function newProviderId() {
  return "prov_" + crypto.randomUUID().slice(0, 8);
}

function normalizeProvider(input) {
  const protocol = String(input.protocol || "openai").toLowerCase();
  if (!["openai", "anthropic"].includes(protocol)) {
    throw new Error(`不支持的协议: ${input.protocol} (可选 openai | anthropic)`);
  }
  const baseUrl = String(input.baseUrl || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(baseUrl)) throw new Error("baseUrl 必须以 http(s):// 开头");
  const model = String(input.model || "").trim();
  if (!model) throw new Error("必须指定模型名 (model)");
  return {
    id: input.id || newProviderId(),
    name: String(input.name || model).trim() || model,
    protocol,
    baseUrl,
    apiKey: String(input.apiKey || "").trim(),
    model,
  };
}

function addProvider(input) {
  const cfg = load();
  const prov = normalizeProvider(input);
  const idx = cfg.providers.findIndex((x) => x.name === prov.name);
  if (idx >= 0) cfg.providers[idx] = { ...cfg.providers[idx], ...prov, id: cfg.providers[idx].id };
  else cfg.providers.push(prov);
  if (!cfg.defaultProviderId || input.setDefault) cfg.defaultProviderId = cfg.providers[idx >= 0 ? idx : cfg.providers.length - 1].id;
  save(cfg);
  return cfg;
}

function removeProvider(idOrName) {
  const cfg = load();
  const idx = cfg.providers.findIndex((x) => x.id === idOrName || x.name === idOrName);
  if (idx < 0) throw new Error(`未找到 provider: ${idOrName}`);
  const [removed] = cfg.providers.splice(idx, 1);
  if (cfg.defaultProviderId === removed.id) cfg.defaultProviderId = cfg.providers[0]?.id || null;
  save(cfg);
  return cfg;
}

function setDefaultProvider(idOrName) {
  const cfg = load();
  const prov = cfg.providers.find((x) => x.id === idOrName || x.name === idOrName);
  if (!prov) throw new Error(`未找到 provider: ${idOrName}`);
  cfg.defaultProviderId = prov.id;
  save(cfg);
  return cfg;
}

function getProviders() {
  return load().providers;
}

function getDefaultProvider() {
  const cfg = load();
  return cfg.providers.find((x) => x.id === cfg.defaultProviderId) || cfg.providers[0] || null;
}

function getProvider(idOrName) {
  const cfg = load();
  return cfg.providers.find((x) => x.id === idOrName || x.name === idOrName) || null;
}

function maskApiKey(key) {
  if (!key) return "(空)";
  if (key.length <= 8) return key.slice(0, 2) + "****";
  return key.slice(0, 5) + "****" + key.slice(-4);
}

function publicConfig() {
  const cfg = load();
  return {
    ...cfg,
    providers: cfg.providers.map((p) => ({ ...p, apiKey: maskApiKey(p.apiKey), hasKey: !!p.apiKey })),
  };
}

function setOptions({ permissionMode, maxIterations }) {
  const cfg = load();
  if (permissionMode !== undefined) {
    if (!["ask", "yolo"].includes(permissionMode)) throw new Error("permissionMode 只能是 ask | yolo");
    cfg.permissionMode = permissionMode;
  }
  if (maxIterations !== undefined) {
    const n = Number(maxIterations);
    if (!Number.isFinite(n) || n < 1 || n > 200) throw new Error("maxIterations 需在 1-200 之间");
    cfg.maxIterations = Math.round(n);
  }
  save(cfg);
  return cfg;
}

module.exports = {
  load, save, configPath,
  addProvider, removeProvider, setDefaultProvider,
  getProviders, getDefaultProvider, getProvider,
  publicConfig, setOptions, maskApiKey, normalizeProvider,
};
